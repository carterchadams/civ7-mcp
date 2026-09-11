"""Narrow stdio MCP server: two read-only tools over the same capture path as `snapshot`.

Only stderr may be written to by this process; stdout is the MCP transport.
The bound player and allowed mode are fixed at startup and cannot be changed by a client.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from civ7_observer import cdp, schema
from civ7_observer.doctor import DoctorStatus, run_doctor
from civ7_observer.service import ObserverError, open_game_session
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
        with lock:
            result = run_doctor(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory)
        st: dict[str, Any] = {
            "status": str(result.status), "summary": result.summary, "ready": False, "reason": None,
            "boundPlayerId": bound, "allowedMode": mode, "sessionId": session_id(), "context": result.context,
            "adapterVersion": result.adapter_version,
        }
        if result.status is DoctorStatus.IN_GAME:
            ctx = result.context or {}
            if ctx.get("localPlayerId") == bound and ctx.get("localObserverId") == bound:
                st["ready"] = True
            else:
                st["reason"] = "WRONG_PLAYER"
        else:
            st["reason"] = str(result.status)
        return st

    return mcp


def serve(*, port: int, timeout: float, player: int, mode: str, target_id: str | None = None) -> int:
    server = build_server(port=port, timeout=timeout, player=player, mode=mode, target_id=target_id)
    log.info("civ7-observer serve: player %s, mode %s, port %s", player, mode, port)
    server.run(transport="stdio")
    return 0
