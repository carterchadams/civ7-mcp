"""The ledger generator keeps catalog presence, family completion and live evidence apart."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_test_ledger", ROOT / "tools" / "build_test_ledger.py")
btl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btl)


def test_family_status_is_partial_when_any_variant_is_and_never_implemented_from_names_alone():
    assert btl.family_status([{"disposition": "implemented"}, {"disposition": "already_covered"}]) == "implemented"
    assert btl.family_status([{"disposition": "implemented"}, {"disposition": "partial"}]) == "partial"
    assert btl.family_status([{"disposition": "native_dormant"}, {"disposition": "excluded"}]) == "no_catalog_kind"


def test_every_family_variant_names_evidence_and_only_catalog_kinds():
    public = set(btl.PUBLIC_KIND.values())
    for aid, (title, variants) in btl.FAMILIES.items():
        assert aid.startswith("A") and title
        for name, disposition, kinds, note in variants:
            assert disposition in ("implemented", "partial", "already_covered", "native_dormant", "excluded")
            assert note, f"{aid}/{name}: a disposition needs its evidence or revisit condition"
            if disposition in ("implemented", "already_covered"):
                assert kinds and set(kinds) <= public, f"{aid}/{name} names a kind the catalog lacks"
            if disposition in ("native_dormant", "excluded", "partial"):
                assert not kinds or set(kinds) <= public


def test_fingerprint_changes_when_a_line_naming_the_kind_changes(tmp_path, monkeypatch):
    a = tmp_path / "perform.js"; a.write_text('if (KIND === "MOVE_UNIT") { send(); }\nif (KIND === "OTHER") {}\n')
    monkeypatch.setattr(btl, "SOURCES", [a])
    before = btl.fingerprint("MOVE_UNIT")
    a.write_text('if (KIND === "MOVE_UNIT") { check(); send(); }\nif (KIND === "OTHER") {}\n')
    assert btl.fingerprint("MOVE_UNIT") != before
    a.write_text('if (KIND === "MOVE_UNIT") { check(); send(); }\nif (KIND === "OTHER") { changed(); }\n')
    assert btl.fingerprint("MOVE_UNIT") == btl.fingerprint("MOVE_UNIT") and btl.fingerprint("OTHER") != before, "another kind's lines do not move this fingerprint"


def test_build_seeds_variants_from_effects_keeps_prior_pass_fingerprints_and_flags_retests(tmp_path, monkeypatch):
    journals = tmp_path / "journals"; journals.mkdir()
    rows = [{"kind": "MOVE_UNIT", "status": "confirmed", "requestId": "a", "confirmedBy": {"effect": {"unitLocation": {}}}},
            {"kind": "MOVE_UNIT", "status": "unknown", "requestId": "b"},
            {"kind": "SEND_MERCHANT", "status": "confirmed", "requestId": "c", "confirmedBy": {"effect": {"merchantSent": {}}}}]
    (journals / "seat0.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    defs = tmp_path / "defs.json"
    prior = {"version": 2, "cases": [{"case_id": "LT-send_merchant", "live_status": "passed", "passed_fingerprint": "stale00", "priority": 1}]}
    defs.write_text(json.dumps(prior))
    monkeypatch.setattr(btl, "DEFS", defs)
    data = btl.build(journals)
    by = {c["case_id"]: c for c in data["cases"]}
    assert by["LT-move_unit"]["live_status"] == "passed" and by["LT-move_unit"]["expected_effect"] == "unitLocation"
    assert by["LT-move_unit"]["passed_fingerprint"] == by["LT-move_unit"]["contract_fingerprint"], "a newly seeded pass is baselined at this build"
    assert by["LT-move_unit"]["evidence_refs"] == {"journal": {"confirmed": 1, "rejected": 0, "unknown": 1}, "effects": {"unitLocation": 1}}
    assert by["LT-move_unit-standing"]["live_status"] == "not_seen", "an arrival receipt does not seed the standing variant"
    assert by["LT-send_merchant"]["passed_fingerprint"] == "stale00" and by["LT-send_merchant"]["priority"] == 1, "prior evidence and metadata are kept"
    assert by["LT-attack"]["live_status"] == "not_seen" and by["LT-attack"]["consequence_class"] == "high"
    assert by["LT-wmd_strike"]["consequence_class"] == "high" and by["LT-purchase_unit"]["consequence_class"] == "medium"
    fams = {f["family"]: f for f in data["families"]}
    assert fams["A02"]["status"] == "partial" and fams["A28"]["status"] == "implemented"
    assert {v["disposition"] for v in fams["A20"]["variants"]} == {"implemented", "already_covered", "native_dormant"}
    # regeneration is stable
    assert btl.build(journals) == data
