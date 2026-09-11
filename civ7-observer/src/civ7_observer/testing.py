"""The live-test ledger: which actions have been exercised in real play, and what to try next.

Implementation status and live status are kept apart. An action is implemented when its code and
offline tests exist; it is live-verified only when a real receipt for it has been confirmed in a
running game. The definitions live in the repository (`docs/action-live-test-todo.json`); results
live per match and per seat under the host state, and never cross seats.

The driver asks, for one seat and one turn, for at most two open cases whose action kinds the seat is
being offered right now, and puts a short note in that seat's prompt. After the turn it correlates
the seat's receipts with the cases: a confirmed receipt of the case's kind passes it, and a passed case
leaves the prompts. Passing is decided by receipts, never by what the agent said it did.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any

from civ7_observer.attachment import state_dir
from civ7_observer.probe import write_atomic

IMPLEMENTED = ("offline_verified", "available_for_live_test")
PASSED = "passed"
DEFINITIONS_NAME = "action-live-test-todo.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def definitions_path() -> Path:
    """The repository's definitions, found next to this package's docs when run from a checkout."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / DEFINITIONS_NAME
        if candidate.exists():
            return candidate
    raise FileNotFoundError(DEFINITIONS_NAME)


def load_definitions(path: Path | None = None) -> list[dict[str, Any]]:
    data = json.loads((path or definitions_path()).read_text(encoding="utf-8"))
    cases = data.get("cases") if isinstance(data, dict) else data
    if not isinstance(cases, list):
        raise ValueError("definitions must hold a list of cases")
    return cases


class TestLedger:
    def __init__(self, match: str, *, root: Path | None = None, definitions: list[dict[str, Any]] | None = None) -> None:
        self.match = match
        self.dir = (root or state_dir() / "testing") / match
        self.cases = definitions if definitions is not None else load_definitions()
        self.by_id = {c["case_id"]: c for c in self.cases}

    # ---- per-seat results
    def _path(self, seat: int) -> Path:
        return self.dir / f"seat{seat}.json"

    def results(self, seat: int) -> dict[str, Any]:
        p = self._path(seat)
        if not p.exists():
            return {}
        return json.loads(p.read_text(encoding="utf-8"))

    def _save(self, seat: int, data: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        write_atomic(self._path(seat), json.dumps(data, indent=2, ensure_ascii=False))

    def live_status(self, case: dict[str, Any], seat: int | None = None) -> str:
        """The seed status from the definitions, overridden by anything this match has recorded."""
        seats = [seat] if seat is not None else self._seats()
        for s in seats:
            rec = self.results(s).get(case["case_id"])
            if rec and rec.get("live_status") == PASSED:
                return PASSED
        return case.get("live_status", "not_seen")

    def _seats(self) -> list[int]:
        if not self.dir.exists():
            return []
        out = []
        for p in self.dir.glob("seat*.json"):
            try:
                out.append(int(p.stem[4:]))
            except ValueError:
                continue
        return sorted(out)

    # ---- what to suggest
    def opportunities(self, seat: int, offered_kinds: set[str], *, limit: int = 2) -> list[dict[str, Any]]:
        """Open cases this seat could take right now: implemented, not yet passed anywhere in this match,
        every kind the case needs currently offered to this seat, cheapest consequence first."""
        rank = {"low": 0, "medium": 1, "high": 2}
        found = []
        for case in self.cases:
            if case.get("implementation_status") not in IMPLEMENTED:
                continue
            if self.live_status(case) == PASSED:
                continue
            need = set((case.get("eligibility") or {}).get("offered") or [])
            if not need or not need <= offered_kinds:
                continue
            found.append(case)
        found.sort(key=lambda c: (rank.get(c.get("consequence_class", "medium"), 1), c.get("priority", 5), c["case_id"]))
        return found[:limit]

    @staticmethod
    def note(cases: list[dict[str, Any]]) -> str | None:
        if not cases:
            return None
        lines = ["# Testing opportunities", "",
                 "These actions are implemented but have never been exercised in a real game. If one is strategically "
                 "sensible this turn, prefer it over an equivalent routine choice; never take one that harms your position. "
                 "Passing is judged by the receipt, so simply perform it. In your closing summary, one line `TESTED: <case id>` "
                 "for each you took.", ""]
        for c in cases:
            lines.append(f"- {c['case_id']}: {c.get('procedure', c['action_family'])} (needs a confirmed `{c['action_family']}` receipt"
                         + (f"; consequence {c['consequence_class']}" if c.get("consequence_class") else "") + ")")
        return "\n".join(lines)

    # ---- what happened
    def record_receipts(self, seat: int, rows: list[dict[str, Any]], *, turn: int | None = None) -> list[dict[str, Any]]:
        """Correlate a seat's journal rows with open cases. Returns the cases whose status changed."""
        data = self.results(seat)
        changed = []
        for row in rows:
            kind, status = row.get("kind"), row.get("status")
            if status not in ("confirmed", "rejected", "unknown"):
                continue
            for case in self.cases:
                if case.get("expected_kind") != kind:
                    continue
                rec = data.setdefault(case["case_id"], {"attempts": 0, "live_status": case.get("live_status", "not_seen"), "evidence": []})
                if rec.get("live_status") == PASSED:
                    continue
                rec["attempts"] += 1
                rec["last_result"] = status
                rec["last_turn"] = row.get("turn", turn)
                if status == "confirmed":
                    rec["live_status"] = PASSED
                    rec["evidence"] = (rec.get("evidence") or []) + [{"requestId": row.get("requestId"), "turn": row.get("turn", turn), "seat": seat, "at": _now()}]
                    changed.append({"case_id": case["case_id"], "live_status": PASSED, "seat": seat})
                elif status == "unknown":
                    rec["live_status"] = "inconclusive"
                    changed.append({"case_id": case["case_id"], "live_status": "inconclusive", "seat": seat})
        if changed or rows:
            self._save(seat, data)
        return changed

    # ---- the sanitized picture for reporting: statuses only, nothing about any seat's game
    def aggregate(self) -> dict[str, Any]:
        counts: dict[str, int] = {}
        impl: dict[str, int] = {}
        for case in self.cases:
            st = self.live_status(case)
            counts[st] = counts.get(st, 0) + 1
            i = case.get("implementation_status", "unimplemented")
            impl[i] = impl.get(i, 0) + 1
        out = {"match": self.match, "at": _now(), "live": counts, "implementation": impl,
               "open": [c["case_id"] for c in self.cases if c.get("implementation_status") in IMPLEMENTED and self.live_status(c) != PASSED]}
        self.dir.mkdir(parents=True, exist_ok=True)
        write_atomic(self.dir / "status.json", json.dumps(out, indent=2))
        return out
