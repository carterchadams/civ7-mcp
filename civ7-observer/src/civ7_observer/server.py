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

from civ7_observer import __version__, cdp, schema
from civ7_observer.actions import ACTION_ID, REQUEST_ID, ActionRegistry
from civ7_observer.attachment import state_dir
from civ7_observer.brief import build_brief
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.payloads import render_payload
from civ7_observer.snapshot import capture, session_id

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
MUTATING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


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

    @mcp.tool(name="get_turn_brief", description=BRIEF_DESCRIPTION, annotations=READ_ONLY)
    def get_turn_brief() -> dict[str, Any]:
        return _with_session(lambda gs: build_brief(gs, registry, player=bound, mode=mode))

    @mcp.tool(name="list_actions", description=LIST_DESCRIPTION, annotations=READ_ONLY)
    def list_actions() -> dict[str, Any]:
        return _with_session(lambda gs: registry.list_offers(gs, player=bound, mode=mode))

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

    return mcp


def serve(*, port: int, timeout: float, player: int, mode: str, target_id: str | None = None,
          allow_actions: bool = False, journal_path: Path | None = None) -> int:
    server = build_server(port=port, timeout=timeout, player=player, mode=mode, target_id=target_id,
                          allow_actions=allow_actions, journal_path=journal_path)
    log.info("civ7-observer serve: player %s, mode %s, port %s, actions %s", player, mode, port,
             "ENABLED" if allow_actions else "disabled")
    server.run(transport="stdio")
    return 0
