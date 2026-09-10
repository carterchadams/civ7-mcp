"""Probe every discovered CDP target with the fixed context payload and select the in-game realm."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Callable

from civ7_observer import cdp
from civ7_observer.payloads import PayloadMissing, load_payload

__all__ = [
    "PayloadMissing", "RealmProbe", "RealmProbeInvalid", "RealmKind", "TargetProbe", "TargetSelection",
    "parse_realm_probe", "classify", "probe_target", "select_game_target",
]

PROBE_VERSION = 1
_BOOL_KEYS = ("hasUI", "hasGameContext", "hasGame", "hasPlayers", "hasMap")
_OPT_BOOL_KEYS = ("inGame",)
_OPT_INT_KEYS = ("localPlayerId", "localObserverId", "turn")
_OPT_STR_KEYS = ("href",)
_ALL_KEYS = frozenset(("probeVersion",) + _BOOL_KEYS + _OPT_BOOL_KEYS + _OPT_INT_KEYS + _OPT_STR_KEYS)


class RealmProbeInvalid(cdp.CdpError):
    code = "API_CONTRACT_MISMATCH"


@dataclass(frozen=True)
class RealmProbe:
    in_game: bool | None
    has_ui: bool
    has_game_context: bool
    has_game: bool
    has_players: bool
    has_map: bool
    local_player_id: int | None
    local_observer_id: int | None
    turn: int | None
    href: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "inGame": self.in_game, "hasUI": self.has_ui, "hasGameContext": self.has_game_context,
            "hasGame": self.has_game, "hasPlayers": self.has_players, "hasMap": self.has_map,
            "localPlayerId": self.local_player_id, "localObserverId": self.local_observer_id,
            "turn": self.turn, "href": self.href,
        }


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def parse_realm_probe(value: object) -> RealmProbe:
    if not isinstance(value, str):
        raise RealmProbeInvalid(f"context probe returned {type(value).__name__}, expected JSON string")
    try:
        data = json.loads(value)
    except ValueError as exc:
        raise RealmProbeInvalid(f"context probe returned non-JSON text: {exc}") from exc
    if not isinstance(data, dict):
        raise RealmProbeInvalid("context probe JSON is not an object")
    keys = set(data)
    if keys != _ALL_KEYS:
        missing, extra = sorted(_ALL_KEYS - keys), sorted(keys - _ALL_KEYS)
        raise RealmProbeInvalid(f"context probe keys mismatch (missing={missing}, extra={extra})")
    if data["probeVersion"] != PROBE_VERSION:
        raise RealmProbeInvalid(f"context probe version {data['probeVersion']!r} != {PROBE_VERSION}")
    for k in _BOOL_KEYS:
        if not isinstance(data[k], bool):
            raise RealmProbeInvalid(f"context probe field {k} must be boolean")
    for k in _OPT_BOOL_KEYS:
        if data[k] is not None and not isinstance(data[k], bool):
            raise RealmProbeInvalid(f"context probe field {k} must be boolean or null")
    for k in _OPT_INT_KEYS:
        if data[k] is not None and not _is_int(data[k]):
            raise RealmProbeInvalid(f"context probe field {k} must be integer or null")
    for k in _OPT_STR_KEYS:
        if data[k] is not None and not isinstance(data[k], str):
            raise RealmProbeInvalid(f"context probe field {k} must be string or null")
    return RealmProbe(
        in_game=data["inGame"], has_ui=data["hasUI"], has_game_context=data["hasGameContext"],
        has_game=data["hasGame"], has_players=data["hasPlayers"], has_map=data["hasMap"],
        local_player_id=data["localPlayerId"], local_observer_id=data["localObserverId"],
        turn=data["turn"], href=data["href"],
    )


class RealmKind(StrEnum):
    GAME = "game"
    MENU = "menu"
    NON_GAME = "non-game"
    INCONSISTENT = "inconsistent"
    ERROR = "error"


def _valid_context(probe: RealmProbe) -> bool:
    """A loaded game must report a non-negative turn and non-negative seat ids."""
    return all(_is_int(v) and v >= 0 for v in (probe.turn, probe.local_player_id, probe.local_observer_id))


def classify(probe: RealmProbe) -> RealmKind:
    if probe.in_game is True:
        if (probe.has_players and probe.has_map and probe.has_game_context and probe.has_game
                and _valid_context(probe)):
            return RealmKind.GAME
        return RealmKind.INCONSISTENT
    if probe.has_ui:
        return RealmKind.MENU
    return RealmKind.NON_GAME


@dataclass(frozen=True)
class TargetProbe:
    target: cdp.CdpTarget
    kind: RealmKind
    probe: RealmProbe | None
    error: dict[str, Any] | None
    contract: bool
    duration_ms: int

    def to_dict(self) -> dict[str, Any]:
        return {
            **self.target.identity(), "kind": str(self.kind),
            "probe": self.probe.to_dict() if self.probe else None,
            "error": self.error, "contractIssue": self.contract, "durationMs": self.duration_ms,
        }


@dataclass(frozen=True)
class TargetSelection:
    probes: list[TargetProbe]
    selected: TargetProbe | None
    game_candidates: list[TargetProbe]


SessionFactory = Callable[..., cdp.CdpSession]


def probe_target(target: cdp.CdpTarget, *, timeout: float, session_factory: SessionFactory = cdp.CdpSession) -> TargetProbe:
    started = time.monotonic()

    def done(kind: RealmKind, probe: RealmProbe | None, error: dict[str, Any] | None, contract: bool) -> TargetProbe:
        return TargetProbe(target, kind, probe, error, contract, int((time.monotonic() - started) * 1000))

    if target.ws_url is None:
        return done(RealmKind.ERROR, None, cdp.InvalidTargetUrl(target.ws_url_error or "no webSocketDebuggerUrl").to_dict(), False)
    expression = load_payload("context.js")
    try:
        with session_factory(target.ws_url, timeout=timeout) as session:
            value = session.evaluate_readonly(expression)
        probe = parse_realm_probe(value)
    except (RealmProbeInvalid, cdp.CdpEvaluateException) as exc:
        return done(RealmKind.ERROR, None, exc.to_dict(), True)
    except cdp.CdpError as exc:
        return done(RealmKind.ERROR, None, exc.to_dict(), False)
    return done(classify(probe), probe, None, False)


def select_game_target(
    targets: list[cdp.CdpTarget], *, timeout: float,
    session_factory: SessionFactory = cdp.CdpSession, target_id: str | None = None,
) -> TargetSelection:
    if target_id is not None:
        targets = [t for t in targets if t.id == target_id]
    probes = [probe_target(t, timeout=timeout, session_factory=session_factory) for t in targets]
    candidates = [p for p in probes if p.kind is RealmKind.GAME]
    return TargetSelection(probes=probes, selected=candidates[0] if len(candidates) == 1 else None, game_candidates=candidates)
