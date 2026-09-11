"""Narrow stdio MCP server: two read-only tools over the same capture path as `snapshot`.

Only stderr may be written to by this process; stdout is the MCP transport.
The bound player and allowed mode are fixed at startup and cannot be changed by a client.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from civ7_observer import __version__, cdp, schema
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.payloads import render_payload
from civ7_observer.snapshot import capture, session_id

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

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


def build_server(
    *, port: int, timeout: float, player: int | None, mode: str, target_id: str | None = None,
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
        f"Observation-only access to Civilization VII player {bound} in a {mode} session. "
        "No actions can be taken through this server."
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

    return mcp


def serve(*, port: int, timeout: float, player: int, mode: str, target_id: str | None = None) -> int:
    server = build_server(port=port, timeout=timeout, player=player, mode=mode, target_id=target_id)
    log.info("civ7-observer serve: player %s, mode %s, port %s", player, mode, port)
    server.run(transport="stdio")
    return 0
