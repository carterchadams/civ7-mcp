"""The live-test ledger: opportunities from what is offered, passes from receipts, never from prose."""
import json
from pathlib import Path

from civ7_observer.testing import TestLedger

DEFS = [
    {"case_id": "LT-attack", "action_family": "attack", "expected_kind": "ATTACK", "implementation_status": "offline_verified", "live_status": "not_seen", "eligibility": {"offered": ["attack"]}, "consequence_class": "high", "priority": 1, "procedure": "attack when it wins"},
    {"case_id": "LT-send_merchant", "action_family": "send_merchant", "expected_kind": "SEND_MERCHANT", "implementation_status": "offline_verified", "live_status": "not_seen", "eligibility": {"offered": ["send_merchant"]}, "consequence_class": "low", "priority": 2, "procedure": "send a merchant"},
    {"case_id": "LT-move_unit", "action_family": "move_unit", "expected_kind": "MOVE_UNIT", "implementation_status": "offline_verified", "live_status": "passed", "eligibility": {"offered": ["move_unit"]}, "consequence_class": "low", "priority": 3},
    {"case_id": "PLAN-A02", "action_family": "peace deals", "expected_kind": None, "implementation_status": "unimplemented", "live_status": "not_seen", "eligibility": {"offered": []}, "consequence_class": "medium", "priority": 1},
]


def ledger(tmp_path):
    return TestLedger("MATCH1", root=tmp_path / "testing", definitions=json.loads(json.dumps(DEFS)))


def test_opportunities_are_open_implemented_cases_whose_kinds_are_offered_cheapest_first(tmp_path):
    L = ledger(tmp_path)
    assert [c["case_id"] for c in L.opportunities(1, {"attack", "send_merchant", "move_unit"})] == ["LT-send_merchant", "LT-attack"]
    assert L.opportunities(1, {"move_unit"}) == [], "a passed case and an unoffered case are never suggested"
    assert L.opportunities(1, {"attack"}, limit=1)[0]["case_id"] == "LT-attack"
    assert L.opportunities(1, set()) == []


def test_a_confirmed_receipt_passes_the_case_and_removes_it_from_later_opportunities(tmp_path):
    L = ledger(tmp_path)
    rows = [{"kind": "SEND_MERCHANT", "status": "confirmed", "requestId": "r1", "turn": 57},
            {"kind": "MOVE_UNIT", "status": "confirmed", "requestId": "r2", "turn": 57}]
    changed = L.record_receipts(1, rows)
    assert changed == [{"case_id": "LT-send_merchant", "live_status": "passed", "seat": 1}]
    assert L.opportunities(1, {"send_merchant"}) == []
    assert L.opportunities(2, {"send_merchant"}) == [], "a pass in this match counts for every seat"
    rec = L.results(1)["LT-send_merchant"]
    assert rec["live_status"] == "passed" and rec["evidence"][0]["requestId"] == "r1" and rec["attempts"] == 1


def test_an_unknown_marks_the_case_inconclusive_and_a_rejection_only_counts_an_attempt(tmp_path):
    L = ledger(tmp_path)
    L.record_receipts(1, [{"kind": "ATTACK", "status": "rejected", "requestId": "a", "turn": 5}])
    assert L.results(1)["LT-attack"] == {"attempts": 1, "live_status": "not_seen", "evidence": [], "last_result": "rejected", "last_turn": 5}
    assert L.opportunities(1, {"attack"})[0]["case_id"] == "LT-attack", "still open after a rejection"
    changed = L.record_receipts(1, [{"kind": "ATTACK", "status": "unknown", "requestId": "b", "turn": 6}])
    assert changed == [{"case_id": "LT-attack", "live_status": "inconclusive", "seat": 1}]


def test_the_note_names_the_case_and_asks_for_the_receipt_not_a_claim():
    text = TestLedger.note(DEFS[:2])
    assert text.startswith("# Testing opportunities")
    assert "LT-attack" in text and "LT-send_merchant" in text and "`ATTACK`" not in text
    assert "judged by the receipt" in text and "TESTED:" in text
    assert TestLedger.note([]) is None


def test_results_are_per_match_and_per_seat_and_the_aggregate_carries_statuses_only(tmp_path):
    L = ledger(tmp_path)
    L.record_receipts(3, [{"kind": "SEND_MERCHANT", "status": "confirmed", "requestId": "r", "turn": 1}])
    assert (tmp_path / "testing" / "MATCH1" / "seat3.json").exists()
    assert not (tmp_path / "testing" / "MATCH1" / "seat1.json").exists()
    agg = L.aggregate()
    assert agg["live"] == {"passed": 2, "not_seen": 2} and agg["implementation"] == {"offline_verified": 3, "unimplemented": 1}
    assert agg["open"] == ["LT-attack"]
    assert "unitId" not in json.dumps(agg) and "requestId" not in json.dumps(agg)
    other = TestLedger("MATCH2", root=tmp_path / "testing", definitions=json.loads(json.dumps(DEFS)))
    assert other.opportunities(3, {"send_merchant"})[0]["case_id"] == "LT-send_merchant", "another match starts clean"
