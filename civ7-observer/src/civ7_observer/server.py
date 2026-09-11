"""Narrow stdio MCP server over the same validated service the CLI uses.

Read-only by default. With `allow_actions`, the seat's constrained action catalog is exposed too:
the client sees opaque action ids and chooses among them, never raw engine operations or
arguments. The bound player and allowed mode are fixed at startup and cannot be changed by a
client. Only stderr may be written to by this process; stdout is the MCP transport.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from civ7_observer import __version__, cdp, schema, skills
from civ7_observer.actions import ACTION_ID, REQUEST_ID, ActionRegistry
from civ7_observer.attachment import state_dir
from civ7_observer.brief import build_brief
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.payloads import render_payload
from civ7_observer.snapshot import capture, session_id
from civ7_observer.workspace import PlanConflict, Workspace

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
MUTATING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
HOST_STATE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)   # writes the seat workspace, never the game


MAX_ENTITY_OPTIONS = 40


def _bounded(options: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Cap one entity's option list, showing every distinct thing it can do before repeating.

    A settlement offers one option per (building, placement plot), which ran to 93 options and
    52 KB for one city (live, turn 92) and exceeded the tool's own output limit, so the seat saw
    an error instead of its choices.
    """
    buckets: dict[Any, list[dict[str, Any]]] = {}
    for option in options:
        key = (option.get("kind"), option.get("constructibleKey") or option.get("unitTypeKey")
               or option.get("typeKey") or option.get("resourceKey") or option.get("to") is not None)
        buckets.setdefault(str(key), []).append(option)
    chosen: list[dict[str, Any]] = []
    lists = [list(v) for v in buckets.values()]
    while lists and len(chosen) < MAX_ENTITY_OPTIONS:
        for entries in list(lists):
            if len(chosen) >= MAX_ENTITY_OPTIONS:
                break
            chosen.append(entries.pop(0))
            if not entries:
                lists.remove(entries)
    return chosen, len(options) - len(chosen)


def default_journal(player: int) -> Path:
    """One journal per seat, in the host state directory next to the shared lock and barrier."""
    return state_dir() / "journals" / f"seat{player}.jsonl"

OBSERVATION_DESCRIPTION = (
    "Read-only. Returns one validated observation of the single, pre-bound Civilization VII player: "
    "context (turn, age, seat, mode), owned settlements, owned units, technology and civics "
    "(current, queued target, banked in-progress nodes, completed nodes with earned depth), and the "
    "currently visible map tiles only. Deliberately omitted (see `omittedFeatures`): resources, yields, "
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
LIST_DESCRIPTION = (
    "Read-only. Every currently legal action for this seat, as opaque `actionId` handles with labels "
    "(research and civic nodes, per-unit skip and adjacent move, city production, end turn). Options come "
    "from the game's own legality check; `canStart` false means the game refused it. Use get_turn_brief "
    "first: this is the full list, which can be long. Takes no arguments."
)
PERFORM_DESCRIPTION = (
    "Performs ONE previously offered action for this seat. `action_id` must come from get_turn_brief or "
    "list_actions; `request_id` is a short id you choose (1-64 chars of A-Za-z0-9._-) that makes the call "
    "idempotent: repeating it returns the first outcome instead of acting twice. The host re-checks the "
    "game's own legality immediately before executing and reads the effect back. Returns a receipt with "
    "`status`: confirmed (the effect was observed), rejected (nothing was sent), or an error. An `unknown` "
    "outcome blocks all further actions until a human reconciles it. Never invent an action id."
)
UNIT_OPTIONS_DESCRIPTION = (
    "Read-only. Every currently legal action for ONE of this seat's units (moves with their destination and terrain, "
    "skip, found settlement, promotion), by `unit_id` as shown in a brief's `entities`. Use this when the brief's "
    "bounded options do not show what a particular unit can do; it is far smaller than list_actions."
)
CITY_OPTIONS_DESCRIPTION = (
    "Read-only. Every currently legal action for ONE of this seat's settlements (production of units and buildings "
    "with their placement plots, population placement, resource assignment), by `cityId` as shown in a brief option. "
    "Use this when the brief's bounded options do not show everything a settlement could build; far smaller than "
    "list_actions, which can run to hundreds of options."
)
RESULT_DESCRIPTION = (
    "Read-only. The recorded outcome of one of this seat's earlier actions by `request_id`: confirmed, "
    "rejected, unknown, or no_such_request. Use it after a transport failure rather than repeating the action."
)
SKILL_DESCRIPTION = (
    "Read-only. Loads one skill card by id (a procedure from the strategy guide, or this project's `friction` "
    "card) when the current decision is outside the cards already in your instructions. Ids are listed in the "
    "operating contract. Never touches the game."
)
PLAN_DESCRIPTION = (
    "Read-only. This seat's own multi-turn plan: revision, open commitments (at most three) and a short excerpt. "
    "Written only by update_plan; carried across turns. Never touches the game."
)
UPDATE_PLAN_DESCRIPTION = (
    "Edits this seat's own multi-turn plan atomically. `expected_revision` must equal the revision you were last "
    "shown (get_plan or a previous update), otherwise the edit is refused. `operations` is a list of objects with "
    "`op` one of add_commitment {id, objective, entities?, next_intent?, review?, reservation?, assumptions?}, "
    "revise_commitment {id, ...fields}, set_next_intent {id, next_intent}, cancel_commitment {id, reason}. "
    "Call get_turn_brief first in this session. Never touches the game."
)
FRICTION_DESCRIPTION = (
    "Records that a tool or a fact you needed is missing, instead of guessing. `kind` is one of missing_action, "
    "missing_information, unclear_option, blocked; `goal` is what you were trying to achieve; `needed` names the "
    "specific action, field or fact that would have let you decide; `note` is optional detail including what you "
    "did instead. One report per distinct problem per turn. This backlog drives what gets built next. Never "
    "touches the game."
)


def build_server(
    *, port: int, timeout: float, player: int | None, mode: str, target_id: str | None = None,
    allow_actions: bool = False, journal_path: Path | None = None, workspace_root: Path | None = None,
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
    def get_observation() -> dict[str, Any]:
        with lock:
            try:
                with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
                    obs = capture(gs, player=bound, mode=mode)
            except (ObserverError, cdp.CdpError) as exc:
                log.warning("get_observation failed: %s: %s", exc.code, exc.message)
                return {"error": exc.to_dict()}
            log.info("observation %s turn %s: %d settlements, %d units, %d tiles",
                     obs["observationId"], obs["context"]["turn"], len(obs["settlements"]), len(obs["units"]), len(obs["map"]["tiles"]))
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

    workspace = Workspace(root=workspace_root or state_dir() / "workspace", seat=bound)
    last: dict[str, Any] = {"attachment": None, "brief": None}   # what this seat was last shown, for plan and friction identity

    @mcp.tool(name="get_turn_brief", description=BRIEF_DESCRIPTION, annotations=READ_ONLY)
    def get_turn_brief() -> dict[str, Any]:
        brief = _with_session(lambda gs: build_brief(gs, registry, player=bound, mode=mode))
        if "error" not in brief and isinstance(brief.get("attachment"), dict):
            last["brief"], last["attachment"] = brief, brief["attachment"]
            if workspace.needs_reattachment(brief["attachment"]):
                workspace.reattach(brief["attachment"], note="the game's attachment generation changed")
        return brief

    @mcp.tool(name="list_actions", description=LIST_DESCRIPTION, annotations=READ_ONLY)
    def list_actions() -> dict[str, Any]:
        listing = _with_session(lambda gs: registry.list_offers(gs, player=bound, mode=mode))
        if "error" not in listing and isinstance(listing.get("attachment"), dict):
            last["attachment"] = listing["attachment"]
        return listing

    @mcp.tool(name="get_unit_options", description=UNIT_OPTIONS_DESCRIPTION, annotations=READ_ONLY)
    def get_unit_options(unit_id: int) -> dict[str, Any]:
        if isinstance(unit_id, bool) or not isinstance(unit_id, int):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "unit_id must be an integer, as shown in a brief's entities"}}
        listing = _with_session(lambda gs: registry.list_offers(gs, player=bound, mode=mode))
        if "error" in listing:
            return listing
        if isinstance(listing.get("attachment"), dict):
            last["attachment"] = listing["attachment"]
        options = [o for o in listing["offers"] if o.get("unitId") == unit_id]
        roster = listing.get("unitIds")
        # A unit can leave the roster between turns (destroyed, disbanded, converted). Say so, rather
        # than returning an empty list that reads the same as "no legal actions right now".
        present = (unit_id in roster) if isinstance(roster, list) else None
        note = None
        if present is False:
            note = "this unit is no longer in the seat's roster; it was lost, disbanded or converted since it was last seen"
        elif present is True and not options:
            note = "this unit is still yours but has no legal action this turn"
        shown, omitted = _bounded(options)
        return {"unitId": unit_id, "present": present, "note": note, "attachment": listing["attachment"],
                "count": len(options), "shown": len(shown), "omitted": omitted, "options": shown,
                "reconciliationRequired": listing["reconciliationRequired"]}

    @mcp.tool(name="get_city_options", description=CITY_OPTIONS_DESCRIPTION, annotations=READ_ONLY)
    def get_city_options(city_id: int) -> dict[str, Any]:
        if isinstance(city_id, bool) or not isinstance(city_id, int):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "city_id must be an integer, as shown in a brief option"}}
        listing = _with_session(lambda gs: registry.list_offers(gs, player=bound, mode=mode))
        if "error" in listing:
            return listing
        if isinstance(listing.get("attachment"), dict):
            last["attachment"] = listing["attachment"]
        options = [o for o in listing["offers"] if o.get("cityId") == city_id]
        shown, omitted = _bounded(options)
        return {"cityId": city_id, "attachment": listing["attachment"], "count": len(options), "shown": len(shown),
                "omitted": omitted, "options": shown,
                "note": ("one option per building and placement plot; every distinct thing this settlement can do is "
                         "shown once before any repeats" if omitted else None),
                "reconciliationRequired": listing["reconciliationRequired"]}

    @mcp.tool(name="perform_action", description=PERFORM_DESCRIPTION, annotations=MUTATING)
    def perform_action(action_id: str, request_id: str) -> dict[str, Any]:
        # Validate the handles before opening a session: a malformed id never reaches the game.
        if not isinstance(action_id, str) or not ACTION_ID.match(action_id):
            return {"error": {"code": "UNKNOWN_ACTION", "message": "action_id must be one offered by get_turn_brief or list_actions"}}
        if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
            return {"error": {"code": "INVALID_REQUEST_ID", "message": "request_id must be 1-64 chars of [A-Za-z0-9._-]"}}
        return _with_session(lambda gs: registry.perform(gs, action_id=action_id, request_id=request_id, player=bound, mode=mode))

    @mcp.tool(name="get_action_result", description=RESULT_DESCRIPTION, annotations=READ_ONLY)
    def get_action_result(request_id: str) -> dict[str, Any]:
        if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
            return {"error": {"code": "INVALID_REQUEST_ID", "message": "request_id must be 1-64 chars of [A-Za-z0-9._-]"}}
        try:
            result = registry.get_result(request_id)
        except (ObserverError, cdp.CdpError) as exc:
            return {"error": exc.to_dict()}
        return result if result is not None else {"requestId": request_id, "status": "no_such_request"}

    # ---- the runner's own tools: skill cards, the seat's plan, and the friction backlog.
    # None of these touch the game; they read packaged cards or write this seat's workspace.
    @mcp.tool(name="load_skill", description=SKILL_DESCRIPTION, annotations=READ_ONLY)
    def load_skill(skill_id: str) -> dict[str, Any]:
        try:
            return {"skillId": skill_id, "card": skills.card(skill_id)}
        except (KeyError, TypeError):
            return {"error": {"code": "UNKNOWN_SKILL", "message": f"no such skill card: {skill_id!r}; ids are listed in the operating contract"}}

    @mcp.tool(name="get_plan", description=PLAN_DESCRIPTION, annotations=READ_ONLY)
    def get_plan() -> dict[str, Any]:
        plan = workspace.plan()
        return {"revision": plan["revision"], "commitments": plan["commitments"], "attachment": plan.get("attachment"),
                "reattachedNote": plan.get("reattachedNote"), "excerpt": workspace.excerpt()}

    @mcp.tool(name="update_plan", description=UPDATE_PLAN_DESCRIPTION, annotations=HOST_STATE)
    def update_plan(expected_revision: int, operations: list[dict[str, Any]]) -> dict[str, Any]:
        if last["attachment"] is None:
            return {"error": {"code": "NO_ATTACHMENT", "message": "call get_turn_brief first so the plan can be bound to this match and turn"}}
        try:
            plan = workspace.apply(last["attachment"], expected_revision=expected_revision, operations=operations)
        except (PlanConflict, ValueError, TypeError) as exc:
            return {"error": {"code": "INVALID_ARGUMENT", "message": str(exc)}}
        return {"revision": plan["revision"], "commitments": plan["commitments"]}

    @mcp.tool(name="report_friction", description=FRICTION_DESCRIPTION, annotations=HOST_STATE)
    def report_friction(kind: str, goal: str, needed: str, note: str = "") -> dict[str, Any]:
        brief = last["brief"] or {}
        try:
            entry = workspace.record_friction(
                last["attachment"] or {}, kind=kind, goal=goal, needed=needed, note=note or "",
                blocking=(brief.get("endTurn") or {}).get("blocking"),
                decision=next((d["kind"] for d in brief.get("decisions", []) if d.get("required")), None))
        except (ValueError, TypeError) as exc:
            return {"error": {"code": "INVALID_ARGUMENT", "message": str(exc)}}
        log.info("friction (%s) seat %s turn %s: %s", entry["kind"], bound, entry.get("turn"), entry["needed"])
        return {"recorded": True, "kind": entry["kind"], "turn": entry.get("turn")}

    return mcp


def serve(*, port: int, timeout: float, player: int, mode: str, target_id: str | None = None,
          allow_actions: bool = False, journal_path: Path | None = None, workspace_root: Path | None = None) -> int:
    server = build_server(port=port, timeout=timeout, player=player, mode=mode, target_id=target_id,
                          allow_actions=allow_actions, journal_path=journal_path, workspace_root=workspace_root)
    log.info("civ7-observer serve: player %s, mode %s, port %s, actions %s", player, mode, port,
             "ENABLED" if allow_actions else "disabled")
    server.run(transport="stdio")
    return 0
