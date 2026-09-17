"""The live-test ledger: opportunities from what is offered, passes from receipts under the current
contract, never from prose; attempts counted once; failures kept; nothing about a seat's game in reports."""
import json
from pathlib import Path

from civ7_observer.testing import TestLedger, effect_keys

DEFS = [
    {"case_id": "LT-attack", "action_family": "attack", "expected_kind": "ATTACK", "variant": "default", "contract_fingerprint": "aaa111", "implementation_status": "offline_verified", "live_status": "not_seen", "eligibility": {"offered": ["attack"]}, "consequence_class": "high", "priority": 1, "procedure": "attack when it wins"},
    {"case_id": "LT-send_merchant", "action_family": "send_merchant", "expected_kind": "SEND_MERCHANT", "variant": "default", "contract_fingerprint": "bbb222", "implementation_status": "offline_verified", "live_status": "not_seen", "eligibility": {"offered": ["send_merchant"]}, "consequence_class": "low", "priority": 2, "procedure": "send a merchant"},
    {"case_id": "LT-move_unit", "action_family": "move_unit", "expected_kind": "MOVE_UNIT", "variant": "default", "expected_effect": "unitLocation", "contract_fingerprint": "ccc333", "passed_fingerprint": "ccc333", "implementation_status": "offline_verified", "live_status": "passed", "eligibility": {"offered": ["move_unit"]}, "consequence_class": "low", "priority": 3},
    {"case_id": "LT-move_unit-standing", "action_family": "move_unit", "expected_kind": "MOVE_UNIT", "variant": "standing", "expected_effect": "unitMoved", "contract_fingerprint": "ccc333", "implementation_status": "offline_verified", "live_status": "not_seen", "eligibility": {"offered": ["move_unit"]}, "consequence_class": "low", "priority": 3, "procedure": "take a multiTurn move"},
    {"case_id": "LT-old_pass", "action_family": "old_pass", "expected_kind": "OLD_PASS", "variant": "default", "contract_fingerprint": "new999", "passed_fingerprint": "old000", "implementation_status": "offline_verified", "live_status": "passed", "eligibility": {"offered": ["old_pass"]}, "consequence_class": "low", "priority": 2, "procedure": "the contract changed since the pass"},
]
FAMILIES = [{"family": "A02", "title": "peace", "status": "partial", "variants": []}]


def ledger(tmp_path):
    return TestLedger("MATCH1", root=tmp_path / "testing", definitions=json.loads(json.dumps(DEFS)), families=FAMILIES)


def row(kind, status, rid, *, effect=None, turn=5, generation=2):
    r = {"kind": kind, "status": status, "requestId": rid, "turn": turn, "generation": generation}
    if effect:
        r["confirmedBy"] = {"source": "poll", "effect": {effect: {}}}
    return r


def test_opportunities_are_open_implemented_cases_whose_kinds_are_offered_cheapest_first(tmp_path):
    L = ledger(tmp_path)
    got = [c["case_id"] for c in L.opportunities(1, {"attack", "send_merchant", "move_unit", "old_pass"}, limit=5)]
    # the seeded pass stays out; its standing variant is open; the pass under an old contract is open again
    assert got == ["LT-old_pass", "LT-send_merchant", "LT-move_unit-standing", "LT-attack"]
    assert [c["case_id"] for c in L.opportunities(1, {"attack"})] == ["LT-attack"]
    assert L.opportunities(1, {"research"}) == []
    assert len(L.opportunities(1, {"attack", "send_merchant", "move_unit"}, limit=2)) == 2, "the bound holds"


def test_a_pass_under_an_older_contract_reads_as_retest_and_a_fresh_receipt_repasses_it(tmp_path):
    L = ledger(tmp_path)
    assert L.live_status(L.by_id["LT-old_pass"]) == "retest"
    assert L.live_status(L.by_id["LT-move_unit"]) == "passed", "a pass under the current fingerprint stands"
    changed = L.record_receipts(1, [row("OLD_PASS", "confirmed", "r-1")])
    assert changed == [{"case_id": "LT-old_pass", "live_status": "passed", "seat": 1, "result": "confirmed"}]
    assert L.live_status(L.by_id["LT-old_pass"]) == "passed"
    assert L.results(1)["LT-old_pass"]["passed_fingerprint"] == "new999"
    # the contract changes again: the recorded pass is stale once more
    L.by_id["LT-old_pass"]["contract_fingerprint"] = "newer"
    assert L.live_status(L.by_id["LT-old_pass"]) == "retest"


def test_a_receipt_passes_only_the_variant_whose_effect_it_carries(tmp_path):
    L = ledger(tmp_path)
    L.record_receipts(1, [row("MOVE_UNIT", "confirmed", "arrive-1", effect="unitLocation")])
    assert L.live_status(L.by_id["LT-move_unit-standing"]) == "not_seen", "an arrival is not a standing move"
    changed = L.record_receipts(1, [row("MOVE_UNIT", "confirmed", "queue-1", effect="unitMoved")])
    assert [c["case_id"] for c in changed] == ["LT-move_unit-standing"]
    assert L.live_status(L.by_id["LT-move_unit-standing"]) == "passed"
    assert L.results(1)["LT-move_unit-standing"]["evidence"][0]["effect"] == ["unitMoved"]
    assert "LT-move_unit" not in L.results(1), "a case already proven does not accumulate routine receipts"


def test_each_request_counts_once_even_when_the_journal_is_read_again(tmp_path):
    L = ledger(tmp_path)
    rows = [row("SEND_MERCHANT", "rejected", "m-1"), row("SEND_MERCHANT", "confirmed", "m-2")]
    L.record_receipts(1, rows)
    L.record_receipts(1, rows)   # the driver re-reads the seat's journal after the next turn
    L.record_receipts(1, [row("SEND_MERCHANT", "confirmed", "m-2", generation=2)])   # a replayed receipt
    rec = L.results(1)["LT-send_merchant"]
    assert rec["attempts"] == 2 and rec["outcomes"] == {"confirmed": 1, "rejected": 1, "unknown": 0}
    assert rec["attempt_ids"] == ["2:m-1", "2:m-2"]
    # a new attachment generation is a different attempt of the same request id
    L.record_receipts(1, [row("SEND_MERCHANT", "rejected", "m-1", generation=3)])
    assert L.results(1)["LT-send_merchant"]["attempts"] == 3


def test_unknown_and_rejected_outcomes_are_kept_and_reported_even_after_a_later_pass(tmp_path):
    L = ledger(tmp_path)
    c1 = L.record_receipts(1, [row("ATTACK", "unknown", "a-1")])
    assert c1 == [{"case_id": "LT-attack", "live_status": "inconclusive", "seat": 1, "result": "unknown"}]
    assert L.live_status(L.by_id["LT-attack"]) == "inconclusive"
    c2 = L.record_receipts(2, [row("ATTACK", "rejected", "a-2")])
    assert c2[0]["result"] == "rejected" and L.live_status(L.by_id["LT-attack"], seat=2) == "rejected"
    assert L.live_status(L.by_id["LT-attack"]) == "inconclusive", "an unknown anywhere outranks a rejection elsewhere"
    L.record_receipts(1, [row("ATTACK", "confirmed", "a-3")])
    assert L.live_status(L.by_id["LT-attack"]) == "passed"
    rec = L.results(1)["LT-attack"]
    assert [f["status"] for f in rec["failures"]] == ["unknown"] and rec["outcomes"]["unknown"] == 1, "the failure survives the pass"
    # a later unknown after the pass is recorded as a failure and reported, but does not unpass the case
    c3 = L.record_receipts(1, [row("ATTACK", "unknown", "a-4")])
    assert c3 == [{"case_id": "LT-attack", "live_status": "passed", "seat": 1, "result": "unknown"}]
    assert len(L.results(1)["LT-attack"]["failures"]) == 2 and L.live_status(L.by_id["LT-attack"]) == "passed"


def test_the_note_names_the_case_its_variant_proof_and_asks_for_the_receipt_not_a_claim():
    note = TestLedger.note([DEFS[1], DEFS[3]])
    assert "LT-send_merchant" in note and "send a merchant" in note and "consequence low" in note
    assert "whose effect is `unitMoved`" in note
    assert "TESTED:" in note and "judged by the receipt" in note
    assert TestLedger.note([]) is None


def test_results_are_per_match_and_per_seat_and_the_aggregate_carries_statuses_and_counts_only(tmp_path):
    L = ledger(tmp_path)
    L.record_receipts(1, [row("SEND_MERCHANT", "confirmed", "m-1")])
    L.record_receipts(2, [row("ATTACK", "unknown", "a-1")])
    assert (tmp_path / "testing" / "MATCH1" / "seat1.json").exists() and (tmp_path / "testing" / "MATCH1" / "seat2.json").exists()
    other = TestLedger("MATCH2", root=tmp_path / "testing", definitions=json.loads(json.dumps(DEFS)), families=FAMILIES)
    assert other.live_status(other.by_id["LT-send_merchant"]) == "not_seen", "another match starts from the definitions"
    agg = L.aggregate()
    assert agg["live"] == {"passed": 2, "retest": 1, "inconclusive": 1, "not_seen": 1}
    assert agg["variants"] == 1 and agg["families"] == {"A02": "partial"}
    assert agg["cases"]["LT-attack"] == {"live": "inconclusive", "variant": "default", "attempts": 1, "outcomes": {"confirmed": 0, "rejected": 0, "unknown": 1}}
    assert set(agg["open"]) == {"LT-attack", "LT-move_unit-standing", "LT-old_pass"}
    text = json.dumps(agg)
    for private in ("requestId", "effect", "turn", "arg", "location", "seat1"):
        assert private not in text, f"the aggregate must not carry {private}"
    assert json.loads((tmp_path / "testing" / "MATCH1" / "status.json").read_text())["match"] == "MATCH1"


def test_effect_keys_read_the_confirming_effect_and_nothing_else():
    assert effect_keys({"confirmedBy": {"source": "poll", "effect": {"unitMoved": {"unitId": 5}, "queued": True}}}) == ["queued", "unitMoved"]
    assert effect_keys({"confirmedBy": {"source": "readback"}}) == [] and effect_keys({}) == []
