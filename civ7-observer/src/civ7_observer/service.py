"""Shared orchestration: open one validated session to the in-game realm."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from civ7_observer import cdp
from civ7_observer.doctor import DoctorResult, DoctorStatus, run_doctor
from civ7_observer.payloads import load_payload
from civ7_observer.targets import RealmProbe, parse_realm_probe


class ObserverError(Exception):
    """Typed failure surfaced to the CLI / MCP layer."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}


@dataclass
class GameSession:
    doctor: DoctorResult
    target: cdp.CdpTarget
    context: RealmProbe
    session: cdp.CdpSession

    def __enter__(self) -> "GameSession":
        return self

    def __exit__(self, *exc: object) -> None:
        self.session.close()

    def read_context(self) -> RealmProbe:
        return parse_realm_probe(self.session.evaluate_readonly(load_payload("context.js")))


def open_game_session(
    *, port: int, timeout: float, target_id: str | None = None,
    discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
    session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession,
) -> GameSession:
    """Run the doctor, then open a fresh session to the selected target and re-verify its context."""
    result = run_doctor(port=port, timeout=timeout, target_id=target_id, discover=discover, session_factory=session_factory)
    if result.status is not DoctorStatus.IN_GAME:
        raise ObserverError(str(result.status), result.summary, doctor=result.to_dict())
    assert result.selected is not None and result.context is not None
    targets = discover(port, timeout)
    matching = [t for t in targets if t.id == result.selected["id"] and t.ws_url is not None]
    if len(matching) != 1:
        raise ObserverError("NO_GAME_TARGET", "selected target disappeared between discovery and connection")
    target = matching[0]
    session = session_factory(target.ws_url, timeout=timeout)
    try:
        session.connect()
        context = parse_realm_probe(session.evaluate_readonly(load_payload("context.js")))
    except cdp.CdpError as exc:
        session.close()
        raise ObserverError(exc.code, exc.message) from exc
    expected = result.context
    if (context.turn, context.local_player_id, context.local_observer_id) != (
            expected["turn"], expected["localPlayerId"], expected["localObserverId"]):
        session.close()
        raise ObserverError("CONTEXT_CHANGED", "game context changed between doctor and session open",
                            before=expected, after=context.to_dict())
    return GameSession(doctor=result, target=target, context=context, session=session)
