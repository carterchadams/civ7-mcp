"""`probe`: developer-only capability diagnostics for the bound player, written to a local file."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from civ7_observer import cdp
from civ7_observer.payloads import render_payload
from civ7_observer.service import ObserverError, open_game_session

REQUIRED_KEYS = ("probeVersion", "boundPlayerId", "seatMismatch", "context", "errors")


@dataclass(frozen=True)
class ProbeResult:
    path: Path
    bound_player_id: int
    turn: int
    error_count: int
    size_bytes: int

    def to_dict(self) -> dict[str, Any]:
        return {"path": str(self.path), "boundPlayerId": self.bound_player_id, "turn": self.turn,
                "errorCount": self.error_count, "sizeBytes": self.size_bytes}


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run_probe(
    *, port: int, timeout: float, out: Path, player: int | None, target_id: str | None = None,
    discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
    session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession,
) -> ProbeResult:
    out = Path(out)
    with open_game_session(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory) as gs:
        local = gs.context.local_player_id
        bound = local if player is None else player
        if bound != local or gs.context.local_observer_id != local:
            raise ObserverError("WRONG_PLAYER", f"bound player {bound} is not the local seat (localPlayerId={local}, localObserverId={gs.context.local_observer_id})")
        expression = render_payload("capabilities.js", bound_player_id=bound)
        try:
            value = gs.session.evaluate_readonly(expression)
        except cdp.CdpError as exc:
            raise ObserverError(exc.code, exc.message) from exc
        data = _validate(value, bound)
        after = gs.read_context()
    if after.turn != gs.context.turn or after.local_player_id != local or after.local_observer_id != local:
        raise ObserverError("CONTEXT_CHANGED", "game context changed during the probe; result discarded")
    if data["context"].get("turn") != gs.context.turn:
        raise ObserverError("CONTEXT_CHANGED", "payload observed a different turn than the session; result discarded")
    text = json.dumps(data, indent=2, sort_keys=True)
    write_atomic(out, text)
    return ProbeResult(path=out, bound_player_id=bound, turn=gs.context.turn, error_count=len(data["errors"]), size_bytes=len(text.encode()))


def _validate(value: object, bound: int) -> dict[str, Any]:
    if not isinstance(value, str):
        raise ObserverError("API_CONTRACT_MISMATCH", f"capabilities payload returned {type(value).__name__}, expected JSON string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise ObserverError("API_CONTRACT_MISMATCH", f"capabilities payload returned non-JSON: {exc}") from exc
    if not isinstance(data, dict) or any(k not in data for k in REQUIRED_KEYS):
        raise ObserverError("API_CONTRACT_MISMATCH", "capabilities payload missing required keys")
    if data["probeVersion"] != 1 or data["boundPlayerId"] != bound:
        raise ObserverError("API_CONTRACT_MISMATCH", "capabilities payload version or bound player mismatch")
    if data["seatMismatch"] is True:
        raise ObserverError("WRONG_PLAYER", "payload refused: bound player is not the local seat inside the game")
    if not isinstance(data["errors"], list) or not isinstance(data["context"], dict):
        raise ObserverError("API_CONTRACT_MISMATCH", "capabilities payload has malformed errors/context")
    return data
