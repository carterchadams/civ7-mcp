"""`doctor`: classify the local debugger connection into one machine-readable status."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Callable

from civ7_observer import __version__, cdp
from civ7_observer.targets import RealmKind, TargetSelection, select_game_target

_PROC = "/proc"
_GAME_PROCESS_MARKERS = ("civ7", "civilizationvii", "civilization vii")


class DoctorStatus(StrEnum):
    IN_GAME = "IN_GAME"
    NOT_IN_GAME = "NOT_IN_GAME"
    NO_GAME_TARGET = "NO_GAME_TARGET"
    AMBIGUOUS_GAME_TARGET = "AMBIGUOUS_GAME_TARGET"
    DEBUGGER_UNAVAILABLE = "DEBUGGER_UNAVAILABLE"
    DISCOVERY_INVALID = "DISCOVERY_INVALID"
    TARGET_PROBE_FAILED = "TARGET_PROBE_FAILED"
    API_CONTRACT_MISMATCH = "API_CONTRACT_MISMATCH"


@dataclass(frozen=True)
class DoctorResult:
    status: DoctorStatus
    ok: bool
    summary: str
    discovery: dict[str, Any]
    targets: list[dict[str, Any]]
    selected: dict[str, Any] | None
    context: dict[str, Any] | None
    game_process: str
    adapter_version: str
    duration_ms: int
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version, "status": str(self.status), "ok": self.ok, "summary": self.summary,
            "discovery": self.discovery, "targets": self.targets, "selected": self.selected, "context": self.context,
            "gameProcess": self.game_process, "adapterVersion": self.adapter_version, "durationMs": self.duration_ms,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=False)

    def exit_code(self) -> int:
        return 0 if self.status is DoctorStatus.IN_GAME else 1


def detect_game_process() -> str:
    """Best-effort Linux hint. Never raises; 'unknown' where /proc is unavailable."""
    try:
        entries = os.listdir(_PROC)
    except OSError:
        return "unknown"
    saw_any = False
    for pid in entries:
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(_PROC, pid, "comm"), "rb") as fh:
                comm = fh.read(64).decode("utf-8", "replace").strip().lower()
        except OSError:
            continue
        saw_any = True
        if any(m in comm for m in _GAME_PROCESS_MARKERS):
            return "detected"
    return "not-detected" if saw_any else "unknown"


def _classify(selection: TargetSelection, target_id: str | None) -> tuple[DoctorStatus, str]:
    probes = selection.probes
    n_game = len(selection.game_candidates)
    if n_game == 1:
        p = selection.selected
        assert p is not None and p.probe is not None
        return DoctorStatus.IN_GAME, (
            f"in-game realm found (target {p.target.id}): turn {p.probe.turn}, "
            f"localPlayerId {p.probe.local_player_id}, localObserverId {p.probe.local_observer_id}"
        )
    if n_game > 1:
        ids = ", ".join(str(p.target.id) for p in selection.game_candidates)
        return DoctorStatus.AMBIGUOUS_GAME_TARGET, f"{n_game} in-game realms answered ({ids}); refusing to guess. Re-run with --target-id <id>."
    if any(p.kind is RealmKind.INCONSISTENT or p.contract for p in probes):
        return DoctorStatus.API_CONTRACT_MISMATCH, "a realm answered but the context probe contract did not hold; see targets[].error"
    if any(p.kind is RealmKind.MENU for p in probes):
        return DoctorStatus.NOT_IN_GAME, "game UI reachable but no loaded game (main menu or loading screen)"
    if any(p.kind is RealmKind.ERROR and p.target.ws_url is not None for p in probes):
        return DoctorStatus.TARGET_PROBE_FAILED, "targets exist but every usable one failed at the transport level (another debugger client attached?)"
    if target_id is not None and not probes:
        return DoctorStatus.NO_GAME_TARGET, f"no target with id {target_id!r} in the discovery list"
    return DoctorStatus.NO_GAME_TARGET, "debugger answered but no target is a game UI realm"


def run_doctor(
    *, port: int, timeout: float, target_id: str | None = None,
    discover: Callable[[int, float], list[cdp.CdpTarget]] = cdp.discover_targets,
    session_factory: Callable[..., cdp.CdpSession] = cdp.CdpSession,
) -> DoctorResult:
    started = time.monotonic()
    url = cdp.discovery_url(port)
    game_process = detect_game_process()

    def finish(status: DoctorStatus, summary: str, *, discovery_error: dict[str, Any] | None = None,
               target_count: int = 0, targets: list[dict[str, Any]] | None = None,
               selected: dict[str, Any] | None = None, context: dict[str, Any] | None = None) -> DoctorResult:
        return DoctorResult(
            status=status, ok=status is DoctorStatus.IN_GAME, summary=summary,
            discovery={"url": url, "targetCount": target_count, "error": discovery_error},
            targets=targets or [], selected=selected, context=context, game_process=game_process,
            adapter_version=__version__, duration_ms=int((time.monotonic() - started) * 1000),
        )

    try:
        target_list = discover(port, timeout)
    except cdp.DiscoveryUnavailable as exc:
        hint = " The game process is running, so check that AppOptions.txt has `UIDebugger 1`." if game_process == "detected" else ""
        return finish(DoctorStatus.DEBUGGER_UNAVAILABLE, f"nothing answering at {url}.{hint}", discovery_error=exc.to_dict())
    except cdp.DiscoveryInvalid as exc:
        return finish(DoctorStatus.DISCOVERY_INVALID, f"{url} answered but not with a CDP target list", discovery_error=exc.to_dict())

    selection = select_game_target(target_list, timeout=timeout, session_factory=session_factory, target_id=target_id)
    status, summary = _classify(selection, target_id)
    selected = context = None
    if status is DoctorStatus.IN_GAME:
        assert selection.selected is not None and selection.selected.probe is not None
        selected = selection.selected.target.identity()
        pr = selection.selected.probe
        context = {"turn": pr.turn, "age": pr.age, "localPlayerId": pr.local_player_id, "localObserverId": pr.local_observer_id}
    return finish(status, summary, target_count=len(target_list), targets=[p.to_dict() for p in selection.probes],
                  selected=selected, context=context)
