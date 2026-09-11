"""`snapshot`: one validated observation of the bound player, written to a local file."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from civ7_observer import cdp, schema
from civ7_observer.attachment import SharedState
from civ7_observer.payloads import render_payload
from civ7_observer.probe import write_atomic
from civ7_observer.service import ObserverError, open_game_session

_session_id: str | None = None


def session_id() -> str:
    """One id per process attachment; a restart after loading another save yields a new one."""
    global _session_id
    if _session_id is None:
        _session_id = uuid.uuid4().hex
    return _session_id


@dataclass(frozen=True)
class SnapshotResult:
    path: Path
    session_id: str
    observation_id: str
    turn: int
    player_id: int
    settlement_count: int
    unit_count: int
    size_bytes: int

    def to_dict(self) -> dict[str, Any]:
        return {"path": str(self.path), "sessionId": self.session_id, "observationId": self.observation_id, "turn": self.turn,
                "playerId": self.player_id, "settlementCount": self.settlement_count, "unitCount": self.unit_count, "sizeBytes": self.size_bytes}


def capture(gs, *, player: int | None, mode: str) -> dict[str, Any]:
    """Run observe.js on an open GameSession and return a validated Observation dict.

    Captures take the game-wide lock so an observation is never interleaved with a dispatch."""
    if mode not in schema.MODES:
        raise ValueError(f"mode must be one of {schema.MODES}")
    local = gs.context.local_player_id
    bound = local if player is None else player
    if bound != local or gs.context.local_observer_id != local:
        raise ObserverError("WRONG_PLAYER", f"bound player {bound} is not the local seat (localPlayerId={local}, localObserverId={gs.context.local_observer_id})")
    shared = SharedState()
    with shared.locked():
        attachment = shared.attachment(gs, seat=bound, advance=True)
        obs = _capture_locked(gs, bound=bound, mode=mode)
    obs["attachment"] = {k: attachment[k] for k in ("match", "generation", "seat", "turn", "age")}
    return obs


def _capture_locked(gs, *, bound: int, mode: str) -> dict[str, Any]:
    local = gs.context.local_player_id
    expression = render_payload("observe.js", bound_player_id=bound, allowed_mode=mode)
    try:
        value = gs.session.evaluate_readonly(expression)
    except cdp.CdpError as exc:
        raise ObserverError(exc.code, exc.message) from exc
    if not isinstance(value, str):
        raise ObserverError("INVALID_OBSERVATION", f"observe payload returned {type(value).__name__}, expected JSON string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise ObserverError("INVALID_OBSERVATION", f"observe payload returned non-JSON: {exc}") from exc
    try:
        validated = schema.validate_payload(data, bound_player_id=bound)
    except schema.PayloadRefused as exc:
        raise ObserverError(exc.code, exc.message) from exc
    except schema.InvalidObservation as exc:
        raise ObserverError("INVALID_OBSERVATION", str(exc)) from exc
    after = gs.read_context()
    if not gs.context_is_live(after):
        raise ObserverError("CONTEXT_CHANGED", "game context changed during the capture; result discarded", after=after.to_dict())
    if validated["context"]["turn"] != gs.context.turn or validated["context"]["age"] != gs.context.age:
        raise ObserverError("CONTEXT_CHANGED", "payload observed a different turn or age than the session; result discarded")
    return schema.build_observation(
        validated, session_id=session_id(), observation_id=uuid.uuid4().hex,
        captured_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    )


def run_snapshot(
    *, port: int, timeout: float, out: Path, player: int | None, mode: str, target_id: str | None = None,
    discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
    session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession,
) -> SnapshotResult:
    if mode not in schema.MODES:
        raise ValueError(f"mode must be one of {schema.MODES}")
    out = Path(out)
    with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
        obs = capture(gs, player=player, mode=mode)
    text = json.dumps(obs, indent=2)
    write_atomic(out, text)
    return SnapshotResult(path=out, session_id=obs["sessionId"], observation_id=obs["observationId"], turn=obs["context"]["turn"],
                          player_id=obs["context"]["playerId"], settlement_count=len(obs["settlements"]), unit_count=len(obs["units"]),
                          size_bytes=len(text.encode()))
