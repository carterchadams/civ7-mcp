"""Game-wide attachment identity shared by observation, actions, CLI and MCP.

One host state directory holds: the game lock, attachment generations per match, the
in-flight write reservations and the unresolved-outcome barrier. Everything that reads
or writes them does so under the lock. Corrupt state pauses; it never reads as empty.
"""

from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from civ7_observer.probe import write_atomic
from civ7_observer.service import GameSession, ObserverError


def state_dir() -> Path:
    return Path(os.environ.get("CIV7_OBSERVER_STATE_DIR") or Path.home() / ".local" / "state" / "civ7-observer")


class SharedState:
    def __init__(self) -> None:
        self.dir = state_dir()
        self.lock_path = self.dir / "game.lock"
        self.generations_path = self.dir / "generations.json"
        self.inflight_path = self.dir / "inflight.json"
        self.unresolved_path = self.dir / "unresolved.json"

    @contextmanager
    def locked(self):
        """One interprocess lock for the whole game instance."""
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def read(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ObserverError("STATE_CORRUPT", f"host state file {path.name} is not valid JSON; refusing to proceed until it is repaired: {exc}")
        if not isinstance(data, dict):
            raise ObserverError("STATE_CORRUPT", f"host state file {path.name} is not an object; refusing to proceed")
        return data

    def write(self, path: Path, data: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        write_atomic(path, json.dumps(data))

    # ---- attachment generation
    def generation(self, gs: GameSession, *, advance: bool) -> tuple[int, bool]:
        """Per-match host generation. Bumps on turn regression (an earlier save was loaded) or
        on explicit rebind. Turn regression is the only automatic signal the game exposes; a
        same-turn reload of the same campaign needs `rebind`."""
        gens = self.read(self.generations_path)
        key = str(gs.context.game_guid)
        rec = gens.get(key) if isinstance(gens.get(key), dict) else None
        reattached = False
        if rec is None:
            rec = {"generation": 1, "maxTurn": gs.context.turn}
            reattached = True
        elif gs.context.turn < rec.get("maxTurn", gs.context.turn):
            rec = {"generation": rec["generation"] + 1, "maxTurn": gs.context.turn}
            reattached = True
        elif gs.context.turn > rec.get("maxTurn", 0):
            rec = {**rec, "maxTurn": gs.context.turn}
        if advance or reattached:
            gens[key] = rec
            self.write(self.generations_path, gens)
        return rec["generation"], reattached

    def rebind(self, match: str, *, note: str) -> int:
        """Explicit host rebind after a reload the game cannot signal (same campaign, same turn)."""
        gens = self.read(self.generations_path)
        rec = gens.get(match) if isinstance(gens.get(match), dict) else {"generation": 0, "maxTurn": 0}
        rec = {"generation": rec["generation"] + 1, "maxTurn": 0, "rebindNote": note}
        gens[match] = rec
        self.write(self.generations_path, gens)
        return rec["generation"]

    def attachment(self, gs: GameSession, *, seat: int, advance: bool) -> dict[str, Any]:
        generation, reattached = self.generation(gs, advance=advance)
        return {"match": gs.context.game_guid, "generation": generation, "seat": seat, "turn": gs.context.turn, "age": gs.context.age, "reattached": reattached}
