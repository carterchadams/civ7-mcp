"""The live-test ledger: which actions have been exercised in real play, and what to try next.

Implementation status and live status are kept apart. An action is implemented when its code and
offline tests exist; it is live-verified only when a real receipt for it has been confirmed in a
running game, under the contract that is current now. The definitions live in the repository
(`docs/action-live-test-todo.json`, built by `tools/build_test_ledger.py`); results live per match
and per seat under the host state, and never cross seats.

A case names an action kind and, where one receipt shape is not enough, the effect that proves its
variant (`expected_effect`, a key of the confirming effect): a queued move and an arrival are two
cases of one kind. Each kind case carries a `contract_fingerprint` of the source lines that name it;
a pass recorded under an older fingerprint reads as `retest`, so a changed implementation is never
validated by a receipt it did not earn. Attempts are counted once per request (a re-read journal is
not another attempt) and every rejected or unknown outcome is kept even after a later pass.

The driver asks, for one seat and one turn, for a bounded number of open cases whose action kinds the
seat is being offered right now, and puts a short note in that seat's prompt. Passing is decided by
receipts, never by what the agent said it did.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from civ7_observer.attachment import state_dir
from civ7_observer.probe import write_atomic

IMPLEMENTED = ("offline_verified", "available_for_live_test", "partial")
PASSED, RETEST, INCONCLUSIVE, REJECTED, NOT_SEEN = "passed", "retest", "inconclusive", "rejected", "not_seen"
DEFINITIONS_NAME = "action-live-test-todo.json"
OUTCOMES = ("confirmed", "rejected", "unknown")


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


def load_document(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or definitions_path()).read_text(encoding="utf-8"))
    if isinstance(data, list):
        data = {"version": 1, "cases": data}
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list):
        raise ValueError("definitions must hold a list of cases")
    return data


def load_definitions(path: Path | None = None) -> list[dict[str, Any]]:
    return load_document(path)["cases"]


def effect_keys(row: dict[str, Any]) -> list[str]:
    """The names of the effects a journal row was confirmed by, as the host recorded them."""
    by = row.get("confirmedBy")
    effect = by.get("effect") if isinstance(by, dict) else None
    return sorted(effect.keys()) if isinstance(effect, dict) else []


def _empty_record(case: dict[str, Any]) -> dict[str, Any]:
    return {"attempts": 0, "live_status": NOT_SEEN, "evidence": [], "failures": [], "attempt_ids": [],
            "outcomes": {k: 0 for k in OUTCOMES}, "variant": case.get("variant", "default")}


class TestLedger:
    def __init__(self, match: str, *, root: Path | None = None, definitions: list[dict[str, Any]] | None = None,
                 families: list[dict[str, Any]] | None = None) -> None:
        self.match = match
        self.dir = (root or state_dir() / "testing") / match
        if definitions is None:
            doc = load_document()
            definitions, families = doc["cases"], doc.get("families") if families is None else families
        self.cases = definitions
        self.families = families or []
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

    @staticmethod
    def _passed_under(case: dict[str, Any], passed_fingerprint: str | None) -> str:
        """A pass counts only under the current contract; an older fingerprint asks for a retest.
        A pass with no fingerprint on record predates fingerprints and is kept as historical."""
        current = case.get("contract_fingerprint")
        if current and passed_fingerprint and passed_fingerprint != current:
            return RETEST
        return PASSED

    def live_status(self, case: dict[str, Any], seat: int | None = None) -> str:
        """Aggregated across the match's seats: a current pass anywhere wins; else a pass that needs
        retesting; else an inconclusive attempt; else a rejected one; else the definition's seed."""
        seats = [seat] if seat is not None else self._seats()
        seen: set[str] = set()
        for s in seats:
            rec = self.results(s).get(case["case_id"])
            if not rec:
                continue
            st = rec.get("live_status")
            if st == PASSED:
                seen.add(self._passed_under(case, rec.get("passed_fingerprint")))
            elif st in (INCONCLUSIVE, REJECTED):
                seen.add(st)
        for st in (PASSED, RETEST, INCONCLUSIVE, REJECTED):
            if st in seen:
                return st
        seed = case.get("live_status", NOT_SEEN)
        if seed == PASSED:
            return self._passed_under(case, case.get("passed_fingerprint"))
        return seed

    # ---- what to suggest
    def opportunities(self, seat: int, offered_kinds: set[str], *, limit: int = 2) -> list[dict[str, Any]]:
        """Open cases this seat could take right now: implemented, not currently passed anywhere in this
        match (a case needing a retest is open again), every kind the case needs offered to this seat,
        cheapest consequence first."""
        rank = {"low": 0, "medium": 1, "high": 2}
        found = []
        for case in self.cases:
            if case.get("implementation_status") not in IMPLEMENTED or not case.get("expected_kind"):
                continue
            # a war, a razing, a strike or a disbanding is never suggested to fill a checklist; such a
            # case passes only when play calls for the action anyway
            if case.get("consequence_class") == "high":
                continue
            if self.live_status(case) == PASSED:
                continue
            need = set((case.get("eligibility") or {}).get("offered") or [])
            if not need or not need <= offered_kinds:
                continue
            found.append(case)
        found.sort(key=lambda c: (rank.get(c.get("consequence_class", "medium"), 1), c.get("priority", 5), c["case_id"]))
        return found[: max(0, limit)]

    @staticmethod
    def note(cases: list[dict[str, Any]]) -> str | None:
        if not cases:
            return None
        lines = ["# Testing opportunities", "",
                 "These actions are implemented but have not been exercised in a real game under their current "
                 "implementation. If one is strategically sensible this turn, prefer it over an equivalent routine "
                 "choice; never take one that harms your position. Passing is judged by the receipt, so simply perform "
                 "it. In your closing summary, one line `TESTED: <case id>` for each you took.", ""]
        for c in cases:
            proof = f"a confirmed `{c['action_family']}` receipt" + (f" whose effect is `{c['expected_effect']}`" if c.get("expected_effect") else "")
            lines.append(f"- {c['case_id']}: {c.get('procedure', c['action_family'])} (needs {proof}"
                         + (f"; consequence {c['consequence_class']}" if c.get("consequence_class") else "") + ")")
        return "\n".join(lines)

    # ---- what happened
    def record_receipts(self, seat: int, rows: list[dict[str, Any]], *, turn: int | None = None) -> list[dict[str, Any]]:
        """Correlate a seat's journal rows with the cases. Each request counts once; a confirmed receipt
        whose effect matches the case's variant passes it, an unknown leaves it inconclusive, a rejection
        leaves it rejected; failures are kept even after a later pass. Returns what changed or failed."""
        data = self.results(seat)
        changed = []
        for row in rows:
            kind, status, rid = row.get("kind"), row.get("status"), row.get("requestId")
            if status not in OUTCOMES or not isinstance(rid, str):
                continue
            effects = effect_keys(row)
            for case in self.cases:
                if case.get("expected_kind") != kind:
                    continue
                want = case.get("expected_effect")
                if want and status == "confirmed" and want not in effects:
                    continue   # a receipt of this kind, but another variant's
                if status == "confirmed" and self.live_status(case) == PASSED:
                    continue   # already proven under the current contract: routine receipts are not re-recorded
                rec = data.setdefault(case["case_id"], _empty_record(case))
                for k, v in _empty_record(case).items():
                    rec.setdefault(k, v)
                key = f"{row.get('generation')}:{rid}"
                if key in rec["attempt_ids"]:
                    continue   # a journal read twice, or a replayed receipt, is not another attempt
                rec["attempt_ids"].append(key)
                rec["attempts"] += 1
                rec["outcomes"][status] = rec["outcomes"].get(status, 0) + 1
                rec["last_result"], rec["last_turn"] = status, row.get("turn", turn)
                ref = {"requestId": rid, "turn": row.get("turn", turn), "seat": seat, "generation": row.get("generation"),
                       "variant": case.get("variant", "default"), "fingerprint": case.get("contract_fingerprint"),
                       "effect": effects or None, "at": _now()}
                before = rec["live_status"]
                if status == "confirmed":
                    rec["evidence"].append(ref)
                    rec["live_status"] = PASSED
                    rec["passed_fingerprint"] = case.get("contract_fingerprint")
                else:
                    rec["failures"].append({**ref, "status": status})
                    if rec["live_status"] != PASSED:
                        rec["live_status"] = INCONCLUSIVE if status == "unknown" else REJECTED
                if rec["live_status"] != before or status != "confirmed":
                    changed.append({"case_id": case["case_id"], "live_status": rec["live_status"], "seat": seat, "result": status})
        if changed or rows:
            self._save(seat, data)
        return changed

    # ---- the sanitized picture for reporting: statuses and counts only, nothing about any seat's game
    def aggregate(self) -> dict[str, Any]:
        kinds = [c for c in self.cases if c.get("expected_kind")]
        counts: dict[str, int] = {}
        impl: dict[str, int] = {}
        per_case: dict[str, dict[str, Any]] = {}
        for case in kinds:
            st = self.live_status(case)
            counts[st] = counts.get(st, 0) + 1
            i = case.get("implementation_status", "unimplemented")
            impl[i] = impl.get(i, 0) + 1
            outcomes = {k: 0 for k in OUTCOMES}
            attempts = 0
            for s in self._seats():
                rec = self.results(s).get(case["case_id"]) or {}
                attempts += int(rec.get("attempts", 0))
                for k in OUTCOMES:
                    outcomes[k] += int((rec.get("outcomes") or {}).get(k, 0))
            per_case[case["case_id"]] = {"live": st, "variant": case.get("variant", "default"), "attempts": attempts, "outcomes": outcomes}
        families = {f["family"]: f.get("status", "unknown") for f in self.families if isinstance(f, dict) and "family" in f}
        out = {"match": self.match, "at": _now(), "live": counts, "implementation": impl,
               "variants": sum(1 for c in kinds if c.get("variant", "default") != "default"),
               "families": families, "cases": per_case,
               "open": [c["case_id"] for c in kinds if c.get("implementation_status") in IMPLEMENTED and self.live_status(c) != PASSED]}
        self.dir.mkdir(parents=True, exist_ok=True)
        write_atomic(self.dir / "status.json", json.dumps(out, indent=2))
        return out
