"""Narrow stdio MCP server over the same validated service the CLI uses.

Read-only by default. With `allow_actions`, the seat's constrained action catalog is exposed too:
the client sees opaque action ids and chooses among them, never raw engine operations or
arguments. The bound player and allowed mode are fixed at startup and cannot be changed by a
client. Only stderr may be written to by this process; stdout is the MCP transport.
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from civ7_observer import __version__, cdp, schema
from civ7_observer.actions import ACTION_ID, PUBLIC_KIND, REQUEST_ID, ActionRegistry
from civ7_observer.attachment import state_dir
from civ7_observer.brief import build_brief
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.payloads import render_payload
from civ7_observer.snapshot import capture, session_id

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
MUTATING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


MAX_ENTITY_OPTIONS = 40


def _ordered(options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One entity's options with every distinct thing it can do before any repeats.

    A settlement offers one option per (building, placement plot), which ran to 93 options and
    52 KB for one city (live, turn 92) and exceeded the tool's own output limit, so the seat saw
    an error instead of its choices. The order is deterministic, so a page cut anywhere in it
    continues without repeating or skipping an option.
    """
    buckets: dict[Any, list[dict[str, Any]]] = {}
    for option in options:
        key = (option.get("kind"), option.get("constructibleKey") or option.get("unitTypeKey")
               or option.get("typeKey") or option.get("resourceKey") or option.get("to") is not None)
        buckets.setdefault(str(key), []).append(option)
    ordered: list[dict[str, Any]] = []
    lists = [list(v) for v in buckets.values()]
    while lists:
        for entries in list(lists):
            ordered.append(entries.pop(0))
            if not entries:
                lists.remove(entries)
    return ordered


def _bounded(options: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    ordered = _ordered(options)
    return ordered[:MAX_ENTITY_OPTIONS], max(0, len(ordered) - MAX_ENTITY_OPTIONS)


# Continuation over a captured option set. A page is the catalog as it stood when the first call
# enumerated it, bound to the seat, the turn, the attachment generation, the entity and the kind
# filter; every option is returned exactly once across pages. Nothing here re-enumerates or reads
# more of the game than the first call did, and every handle is still revalidated at perform time.
PAGE_TTL_S = 15 * 60
PAGE_STORE_MAX = 64
PAGE_BYTES_MAX = 512 * 1024
CURSOR_ERROR = "REFRESH_REQUIRED"


class PageStore:
    def __init__(self, *, ttl: float = PAGE_TTL_S, capacity: int = PAGE_STORE_MAX, clock=time.monotonic) -> None:
        self.ttl, self.capacity, self.clock = ttl, capacity, clock
        self.pages: dict[str, dict[str, Any]] = {}

    def _sweep(self) -> None:
        now = self.clock()
        for token in [t for t, p in self.pages.items() if now - p["created"] > self.ttl]:
            del self.pages[token]
        while len(self.pages) > self.capacity:
            oldest = min(self.pages, key=lambda t: self.pages[t]["created"])
            del self.pages[oldest]

    def put(self, scope: dict[str, Any], options: list[dict[str, Any]]) -> str | None:
        self._sweep()
        if len(json.dumps(options)) > PAGE_BYTES_MAX:
            return None
        token = secrets.token_urlsafe(12)
        self.pages[token] = {"scope": scope, "options": options, "created": self.clock() + 1e-9}
        self._sweep()   # the newest page is kept; the oldest make room
        return token

    def get(self, token: str) -> dict[str, Any] | None:
        self._sweep()
        return self.pages.get(token)


def _page(store: PageStore, scope: dict[str, Any], options: list[dict[str, Any]] | None, cursor: str | None,
          *, size: int = MAX_ENTITY_OPTIONS) -> dict[str, Any]:
    """First call: capture and order `options`, return page 0 and a cursor. Continuation: the stored
    page at the cursor's offset, only while the scope it was captured under still holds."""
    if cursor is None:
        ordered = _ordered(options or [])
        token = store.put(scope, ordered) if len(ordered) > size else None
        page = ordered[:size]
        return {"count": len(ordered), "shown": len(page), "omitted": len(ordered) - len(page), "options": page,
                "cursor": f"{token}.{size}" if token and len(ordered) > size else None, "page": 0}
    try:
        token, offset_text = cursor.rsplit(".", 1)
        offset = int(offset_text)
    except (ValueError, AttributeError):
        return {"error": {"code": "INVALID_ARGUMENT", "message": "cursor is not one this seat was given"}}
    entry = store.get(token)
    if entry is None:
        return {"error": {"code": CURSOR_ERROR, "message": "the cursor has expired or was never issued here; call again without a cursor"}}
    if entry["scope"] != scope:
        return {"error": {"code": CURSOR_ERROR, "message": "the game, seat, entity or filter changed since these options were captured; call again without a cursor",
                          "captured": {k: v for k, v in entry["scope"].items() if k in ("turn", "generation", "entity", "kind")}}}
    ordered = entry["options"]
    if offset < 0 or offset > len(ordered) or offset % size != 0:
        return {"error": {"code": "INVALID_ARGUMENT", "message": "cursor offset is not a page boundary of these options"}}
    page = ordered[offset: offset + size]
    return {"count": len(ordered), "shown": len(page), "omitted": max(0, len(ordered) - offset - len(page)), "options": page,
            "cursor": f"{token}.{offset + size}" if offset + size < len(ordered) else None, "page": offset // size}


def default_journal(player: int) -> Path:
    """One journal per seat, in the host state directory next to the shared lock and barrier."""
    return state_dir() / "journals" / f"seat{player}.jsonl"

OBSERVATION_DESCRIPTION = (
    "Read-only. Returns one validated observation of the single, pre-bound Civilization VII player: "
    "context (turn, age, seat, mode), owned settlements, owned units, technology and civics "
    "(current, queued target, banked in-progress nodes, completed nodes with earned depth), and the "
    "currently visible map tiles only when `include_map` is true (default false: the tile list is large and "
    "rarely needed; `map.tilesOmitted` counts it). Deliberately omitted (see `omittedFeatures`): resources, yields, "
    "foreign units and settlements, diplomacy, notifications, fogged and hidden tiles, other players, seeds. "
    "Absence of an enemy or resource in this observation is NOT evidence of its absence in the game. "
    "Takes no arguments. On failure returns {\"error\": {\"code\", \"message\"}} with codes such as "
    "NOT_IN_GAME, WRONG_PLAYER, UNSUPPORTED_GAME_MODE, TURN_NOT_READY, CONTEXT_CHANGED, DEBUGGER_UNAVAILABLE."
)
STATUS_DESCRIPTION = (
    "Read-only. Reports whether an observation can be taken right now: debugger connectivity, whether a game "
    "is loaded, the bound player id, the allowed session mode, and the current turn/age/seat when in game. "
    "Never reports any other seat's state. Takes no arguments."
)
BRIEF_DESCRIPTION = (
    "Read-only. The compact view of what this seat must decide now: turn context, attachment identity, "
    "whether the turn can be ended and what the game is blocking on, and the pending decisions with a few "
    "legal options each (every option carries an `actionId` for perform_action). `pause` is non-null when a "
    "human must intervene: either the required decision is one this catalog cannot make "
    "(reason UNSUPPORTED_DECISION) or an earlier action has an unknown outcome (RECONCILIATION_REQUIRED). "
    "Start every turn here rather than with get_observation. Takes no arguments."
)
PAGING_NOTE = (
    "Results are pages of at most 40 over the catalog this seat's host enumerated (the game's own legality check "
    "decides what is in it): `count` is that catalog's size, `shown`/`omitted` describe this page, and `cursor`, when "
    "present, fetches the next page of the same captured set with every option appearing exactly once. A cursor is "
    "bound to this seat, turn, attachment and filter; when any of those changed the call returns REFRESH_REQUIRED and "
    "you call again without a cursor. Every action is still re-checked when performed."
)
LIST_DESCRIPTION = (
    "Read-only. The currently legal actions for this seat, as opaque `actionId` handles with labels "
    "(research and civic nodes, per-unit skip and move, city production, end turn). Options come "
    "from the game's own legality check; `canStart` false means the game refused it. Use get_turn_brief "
    "first. Without arguments this is a survey capped at a few options per kind and per settlement or unit "
    "(`countByKind` and `omittedByKind` say what was left out); get_city_options(cityId) and get_unit_options(unitId) "
    "list everything for one settlement or unit. With `kind` (a public action kind, e.g. start_diplomatic_action) it "
    "lists every option of that kind seat-wide in pages, which is the route to omitted options that belong to no "
    "unit or settlement. " + PAGING_NOTE
)
# list_actions is a survey, not the catalog: a seat with eight settlements listed 1,073 offers (376 KB),
# which the client spilled to a file the agent then searched sixteen times, and the turn ran out of
# budget mid-action. The per-settlement and per-unit tools carry the full set.
# 12 per kind and 3 per entity still made 183 offers and 59 KB, which the client spilled to a file
LIST_PER_ENTITY = 2
LIST_PER_KIND = 6


def compact_listing(listing: dict[str, Any]) -> dict[str, Any]:
    offers = listing.get("offers")
    if not isinstance(offers, list):
        return listing
    kept, by_kind, kept_by_kind, by_entity, omitted = [], {}, {}, {}, {}
    for o in offers:
        kind = o.get("kind")
        entity = (kind, o.get("cityId", o.get("unitId")))
        by_kind[kind] = by_kind.get(kind, 0) + 1
        if kept_by_kind.get(kind, 0) < LIST_PER_KIND and by_entity.get(entity, 0) < LIST_PER_ENTITY:
            # the guidance paragraph rides on the brief and on the confirmation refusal, not on every row
            kept.append({k: v for k, v in o.items() if k != "guidance"} if "guidance" in o else o)
            kept_by_kind[kind] = kept_by_kind.get(kind, 0) + 1
            by_entity[entity] = by_entity.get(entity, 0) + 1
        else:
            omitted[kind] = omitted.get(kind, 0) + 1
    out = dict(listing)
    out["offers"] = kept
    out["countByKind"] = by_kind
    if omitted:
        out["omittedByKind"] = omitted
        out["note"] = ("capped at a few options per kind and per settlement or unit; get_city_options(cityId) and "
                       "get_unit_options(unitId) list everything for one settlement or unit")
    return out
PERFORM_DESCRIPTION = (
    "Performs ONE previously offered action for this seat. `action_id` must come from get_turn_brief or "
    "list_actions; `request_id` is a short id you choose (1-64 chars of A-Za-z0-9._-) that makes the call "
    "idempotent: repeating it returns the first outcome instead of acting twice. The host re-checks the "
    "game's own legality immediately before executing and reads the effect back. Returns a receipt with "
    "`status`: confirmed (the effect was observed), rejected (nothing was sent), or an error. An `unknown` "
    "outcome blocks all further actions until a human reconciles it. Never invent an action id. "
    "`text` (1-32 printable characters) is the name for an option marked `needsText` (rename_unit, rename_city) and "
    "may accompany found_religion as its custom name; it is stored as given and never interpreted. "
    "A few offers are marked `destructive` and carry `requiresConfirmation` plus a `guidance` line "
    "saying what is lost; those are refused unless you also pass `confirm=true`. Read the guidance "
    "before you do: an action marked that way is almost never the right move."
)
UNIT_OPTIONS_DESCRIPTION = (
    "Read-only. The currently legal actions for ONE of this seat's units (moves with their destination and terrain, "
    "skip, found settlement, promotion, orders), by `unit_id` as shown in a brief's `entities`. Use this when the brief's "
    "bounded options do not show what a particular unit can do. Optional `kind` (a public action kind) narrows the set. "
    + PAGING_NOTE
)
CITY_OPTIONS_DESCRIPTION = (
    "Read-only. The currently legal actions for ONE of this seat's settlements (production and purchase of units and "
    "buildings with their placement plots, population placement, resource assignment, queue edits, town focus), by "
    "`city_id` as shown in a brief option. Use this when the brief's bounded options do not show everything a "
    "settlement could do. Optional `kind` narrows the set. " + PAGING_NOTE
)
RESULT_DESCRIPTION = (
    "Read-only. The recorded outcome of one of this seat's earlier actions by `request_id`: confirmed, "
    "rejected, unknown, or no_such_request. Use it after a transport failure rather than repeating the action."
)


def build_server(
    *, port: int, timeout: float, player: int | None, mode: str, target_id: str | None = None,
    allow_actions: bool = False, journal_path: Path | None = None,
    discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
    session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession,
) -> FastMCP:
    if isinstance(player, bool) or not isinstance(player, int) or player < 0:
        raise ValueError("serve requires an explicit non-negative engine player id (--player)")
    if mode not in schema.MODES:
        raise ValueError(f"serve requires --mode one of {schema.MODES}")
    bound = player
    lock = threading.Lock()
    mcp = FastMCP("civ7-observer", instructions=(
        f"Access to Civilization VII player {bound} in a {mode} session. Everything you see belongs to that "
        "seat; no other player's state is reachable through this server."
        + (" You may act for that seat by choosing among the offered action ids. Start each turn with "
           "get_turn_brief, act on the required decision, then end the turn. If `pause` is set, stop and "
           "report it: a human must intervene." if allow_actions else
           " This server is observation-only; no actions can be taken through it.")
    ))

    @mcp.tool(name="get_observation", description=OBSERVATION_DESCRIPTION, annotations=READ_ONLY)
    def get_observation(include_map: bool = False) -> dict[str, Any]:
        if not isinstance(include_map, bool):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "include_map must be true or false"}}
        with lock:
            try:
                with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
                    obs = capture(gs, player=bound, mode=mode)
            except (ObserverError, cdp.CdpError) as exc:
                log.warning("get_observation failed: %s: %s", exc.code, exc.message)
                return {"error": exc.to_dict()}
            log.info("observation %s turn %s: %d settlements, %d units, %d tiles",
                     obs["observationId"], obs["context"]["turn"], len(obs["settlements"]), len(obs["units"]), len(obs["map"]["tiles"]))
            # The visible-tile list is nine tenths of the document (live: 66 KB of 72 KB); a seat
            # asking about its settlements got a file it then searched seventeen times. Tiles are
            # sent only when asked for; everything else about the map stays.
            if not include_map:
                tiles = obs["map"].get("tiles", [])
                obs["map"] = {**obs["map"], "tiles": [], "tilesOmitted": len(tiles),
                              "note": "visible tiles omitted; pass include_map=true for the tile list"}
            return obs

    @mcp.tool(name="get_status", description=STATUS_DESCRIPTION, annotations=READ_ONLY)
    def get_status() -> dict[str, Any]:
        st: dict[str, Any] = {
            "status": None, "summary": None, "ready": False, "reason": None, "eligibility": None,
            "boundPlayerId": bound, "allowedMode": mode, "sessionId": session_id(), "context": None,
            "adapterVersion": __version__,
        }
        with lock:
            try:
                with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
                    st["status"] = str(gs.doctor.status)
                    st["summary"] = gs.doctor.summary
                    st["context"] = gs.doctor.context
                    if gs.context.local_player_id != bound or gs.context.local_observer_id != bound:
                        st["reason"] = "WRONG_PLAYER"
                        return st
                    # The capture's own guards (seat, mode flags, active turn, in-game), with no roster read.
                    value = gs.session.evaluate_readonly(render_payload("observe.js", bound_player_id=bound, allowed_mode=mode, guards_only=True))
                data = json.loads(value) if isinstance(value, str) else None
                elig = schema.validate_eligibility(data, bound_player_id=bound)
            except ObserverError as exc:
                doctor = exc.extra.get("doctor") if isinstance(exc.extra, dict) else None
                if doctor:
                    st["status"], st["summary"], st["context"] = doctor["status"], doctor["summary"], doctor["context"]
                else:
                    st["status"] = st["status"] or exc.code
                    st["summary"] = st["summary"] or exc.message
                st["reason"] = exc.code
                return st
            except schema.PayloadRefused as exc:
                st["reason"] = exc.code
                return st
            except cdp.CdpError as exc:
                st["status"] = st["status"] or exc.code
                st["reason"] = exc.code
                return st
            except (schema.InvalidObservation, ValueError, TypeError):
                st["reason"] = "API_CONTRACT_MISMATCH"
                return st
        st["ready"] = True
        st["eligibility"] = {"mode": elig["mode"], "isTurnActive": elig["isTurnActive"]}
        return st

    if not allow_actions:
        return mcp

    registry = ActionRegistry(journal_path=journal_path or default_journal(bound))

    def _with_session(fn):
        """Every action tool uses the same validated session the CLI uses, and never raises."""
        with lock:
            try:
                with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
                    return fn(gs)
            except (ObserverError, cdp.CdpError) as exc:
                log.warning("%s: %s", exc.code, exc.message)
                return {"error": exc.to_dict()}
            except ValueError as exc:
                return {"error": {"code": "INVALID_ARGUMENT", "message": str(exc)}}

    @mcp.tool(name="get_turn_brief", description=BRIEF_DESCRIPTION, annotations=READ_ONLY)
    def get_turn_brief() -> dict[str, Any]:
        return _with_session(lambda gs: build_brief(gs, registry, player=bound, mode=mode))

    pages = PageStore()
    public_kinds = set(PUBLIC_KIND.values())

    def _scope(gs, listing: dict[str, Any] | None, *, entity: Any, kind: str | None) -> dict[str, Any]:
        generation = listing["generation"] if listing is not None else registry.shared.generation(gs, advance=False)[0]
        return {"seat": bound, "match": gs.context.game_guid, "turn": gs.context.turn, "age": gs.context.age,
                "generation": generation, "entity": entity, "kind": kind}

    def _entity_options(gs, *, key: str, entity_id: int, kind: str | None, cursor: str | None, size: int = MAX_ENTITY_OPTIONS) -> dict[str, Any]:
        if cursor is not None:
            # a continuation re-reads nothing: the captured page is served while its scope still holds
            return {**_page(pages, _scope(gs, None, entity=(key, entity_id), kind=kind), None, cursor, size=size), "attachment": None, "listing": None}
        listing = registry.list_offers(gs, player=bound, mode=mode)
        options = [o for o in listing["offers"] if o.get(key) == entity_id and (kind is None or o.get("kind") == kind)]
        return {**_page(pages, _scope(gs, listing, entity=(key, entity_id), kind=kind), options, None, size=size), "attachment": listing["attachment"], "listing": listing}

    @mcp.tool(name="list_actions", description=LIST_DESCRIPTION, annotations=READ_ONLY)
    def list_actions(kind: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        if kind is not None and kind not in public_kinds:
            return {"error": {"code": "INVALID_ARGUMENT", "message": "kind must be a public action kind as shown in a brief option"}}
        if cursor is not None and not isinstance(cursor, str):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "cursor must be the string a previous page returned"}}
        if kind is None and cursor is None:
            return _with_session(lambda gs: compact_listing(registry.list_offers(gs, player=bound, mode=mode)))
        out = _with_session(lambda gs: _entity_options(gs, key="kind", entity_id=kind, kind=kind, cursor=cursor))
        if "error" in out:
            return out
        listing = out.pop("listing")
        return {"kind": kind, **{k: v for k, v in out.items() if k != "attachment"}, "attachment": out["attachment"],
                "reconciliationRequired": listing["reconciliationRequired"] if listing else None}

    def _entity_tool(key: str, id_name: str, entity_id: Any, kind: str | None, cursor: str | None) -> dict[str, Any]:
        if isinstance(entity_id, bool) or not isinstance(entity_id, int):
            return {"error": {"code": "INVALID_ARGUMENT", "message": f"{id_name} must be an integer, as shown in a brief"}}
        if kind is not None and kind not in public_kinds:
            return {"error": {"code": "INVALID_ARGUMENT", "message": "kind must be a public action kind as shown in a brief option"}}
        if cursor is not None and not isinstance(cursor, str):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "cursor must be the string a previous page returned"}}
        return _with_session(lambda gs: _entity_options(gs, key=key, entity_id=entity_id, kind=kind, cursor=cursor))

    @mcp.tool(name="get_unit_options", description=UNIT_OPTIONS_DESCRIPTION, annotations=READ_ONLY)
    def get_unit_options(unit_id: int, kind: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        out = _entity_tool("unitId", "unit_id", unit_id, kind, cursor)
        if "error" in out:
            return out
        listing = out.pop("listing")
        present, note = None, None
        if listing is not None:
            roster = listing.get("unitIds")
            # A unit can leave the roster between turns (destroyed, disbanded, converted). Say so, rather
            # than returning an empty list that reads the same as "no legal actions right now".
            present = (unit_id in roster) if isinstance(roster, list) else None
            if present is False:
                note = "this unit is no longer in the seat's roster; it was lost, disbanded or converted since it was last seen"
            elif present is True and out["count"] == 0:
                note = "this unit is still yours but has no legal action this turn" + (f" of kind {kind}" if kind else "")
        return {"unitId": unit_id, "present": present, "note": note, **{k: v for k, v in out.items() if k != "attachment"},
                "attachment": out["attachment"], "reconciliationRequired": listing["reconciliationRequired"] if listing else None}

    @mcp.tool(name="get_city_options", description=CITY_OPTIONS_DESCRIPTION, annotations=READ_ONLY)
    def get_city_options(city_id: int, kind: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        out = _entity_tool("cityId", "city_id", city_id, kind, cursor)
        if "error" in out:
            return out
        listing = out.pop("listing")
        return {"cityId": city_id, **{k: v for k, v in out.items() if k != "attachment"}, "attachment": out["attachment"],
                "note": ("one option per building and placement plot; every distinct thing this settlement can do is "
                         "shown once before any repeats; `cursor` continues" if out.get("omitted") else None),
                "reconciliationRequired": listing["reconciliationRequired"] if listing else None}

    @mcp.tool(name="perform_action", description=PERFORM_DESCRIPTION, annotations=MUTATING)
    def perform_action(action_id: str, request_id: str, confirm: bool = False, text: str | None = None) -> dict[str, Any]:
        # Validate the handles before opening a session: a malformed id never reaches the game.
        if not isinstance(action_id, str) or not ACTION_ID.match(action_id):
            return {"error": {"code": "UNKNOWN_ACTION", "message": "action_id must be one offered by get_turn_brief or list_actions"}}
        if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
            return {"error": {"code": "INVALID_REQUEST_ID", "message": "request_id must be 1-64 chars of [A-Za-z0-9._-]"}}
        if not isinstance(confirm, bool):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "confirm must be true or false"}}
        if text is not None and not isinstance(text, str):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "text must be a string"}}
        return _with_session(lambda gs: registry.perform(gs, action_id=action_id, request_id=request_id, player=bound, mode=mode, confirm=confirm, text=text))

    @mcp.tool(name="get_action_result", description=RESULT_DESCRIPTION, annotations=READ_ONLY)
    def get_action_result(request_id: str) -> dict[str, Any]:
        if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
            return {"error": {"code": "INVALID_REQUEST_ID", "message": "request_id must be 1-64 chars of [A-Za-z0-9._-]"}}
        try:
            result = registry.get_result(request_id)
        except (ObserverError, cdp.CdpError) as exc:
            return {"error": exc.to_dict()}
        return result if result is not None else {"requestId": request_id, "status": "no_such_request"}

    # Nothing else. The server is a pure game interface: what the agent playing this seat intends,
    # remembers or could not do lives in its own session directory, outside the game and outside
    # this process (see civ7_observer.session).

    return mcp


def serve(*, port: int, timeout: float, player: int, mode: str, target_id: str | None = None,
          allow_actions: bool = False, journal_path: Path | None = None) -> int:
    server = build_server(port=port, timeout=timeout, player=player, mode=mode, target_id=target_id,
                          allow_actions=allow_actions, journal_path=journal_path)
    log.info("civ7-observer serve: player %s, mode %s, port %s, actions %s", player, mode, port,
             "ENABLED" if allow_actions else "disabled")
    server.run(transport="stdio")
    return 0
