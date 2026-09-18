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


PERFORM = """  // ---- units
  if (KIND === "MOVE_UNIT") {
    if (!isInt(ARG)) return refuse("UNKNOWN_ACTION", "bad");
    GUARD
    send();
  }
  if (KIND === "OTHER") {
    other();
  }
"""
ACTIONS = """
    def _bind(self, kind):
            if kind == "MOVE_UNIT":
                rec["x"] = 1
                BIND
            if kind == "OTHER":
                rec["y"] = 2

    def _confirm(self, kind, rb):
                if kind == "MOVE_UNIT":
                    loc = rb.get("unitLocations")
                    CONFIRM
                elif kind == "OTHER":
                    rb.get("other")
"""
READBACK = """    unitLocations: player ? t(() => { LOC }) : null,
    other: player ? t(() => 1) : null,
"""


def test_fingerprint_covers_the_whole_branch_bodies_and_the_readback_they_consult(tmp_path, monkeypatch):
    p, a, r = tmp_path / "perform.js", tmp_path / "actions.py", tmp_path / "readback.js"
    def write(guard="", bind="", confirm="", loc="return m;", other_body="other();"):
        p.write_text(PERFORM.replace("GUARD", guard).replace("other();", other_body)); a.write_text(ACTIONS.replace("BIND", bind).replace("CONFIRM", confirm)); r.write_text(READBACK.replace("LOC", loc))
    monkeypatch.setattr(btl, "SOURCES", [p, a, r])
    write(); before = btl.fingerprint("MOVE_UNIT"); other = btl.fingerprint("OTHER")
    write(guard="if (!unit) return refuse();"); assert btl.fingerprint("MOVE_UNIT") != before, "a guard line inside the branch, naming no kind, changes the digest"
    write(bind="rec['pre'] = 0"); assert btl.fingerprint("MOVE_UNIT") != before, "the bind block body counts"
    write(confirm="if loc is None: pass"); assert btl.fingerprint("MOVE_UNIT") != before, "the confirm block body counts"
    write(loc="return {};"); assert btl.fingerprint("MOVE_UNIT") != before, "a read-back signal the confirm consults counts"
    write(other_body="changed();"); assert btl.fingerprint("MOVE_UNIT") == before and btl.fingerprint("OTHER") != other, "another kind's branch does not move this digest"
    write(); assert btl.fingerprint("MOVE_UNIT") == before, "the digest is a pure function of the sources"
    # a source the digest has no map for: the top-level statement naming the kind, body included
    other = tmp_path / "proof.js"; monkeypatch.setattr(btl, "SOURCES", [other])
    other.write_text('if (KIND === "PURCHASE_UNIT") {\n  matches = false;\n}\n'); b0 = btl.fingerprint("PURCHASE_UNIT")
    other.write_text('if (KIND === "PURCHASE_UNIT") {\n  matches = true;\n}\n'); assert btl.fingerprint("PURCHASE_UNIT") != b0


def test_the_package_digest_names_every_region_that_decides_a_kind():
    from civ7_observer.contract import regions
    got = regions("PURCHASE_UNIT")
    files = [g.split(":", 1)[0] for g in got]
    assert files.count("perform.js") == 1 and "offers.js" in files and "readback.js" in files
    perform = next(g for g in got if g.startswith("perform.js:"))
    assert perform.startswith('perform.js:  if (KIND === "PURCHASE_UNIT")') and "CityCommandTypes.PURCHASE" in perform and perform.count("if (KIND ===") == 1, "one whole branch, not a line"
    confirm = [g for g in got if g.startswith("actions.py:") and "unitTypeCounts" in g]
    assert confirm and "unitTypeCounts" in "".join(g for g in got if g.startswith("readback.js:")), "the confirm block and the signal it reads"
    # a kind handled through a table is covered by the branches that test the table
    table = regions("TREAT_SICK")
    assert any("kind in TABLE_OPERATION_KINDS or kind in TABLE_COMMAND_KINDS" in g for g in table)
    assert all(len(g) < 20000 for g in got + table), "regions are branches and tables, never a whole file"


def test_build_judges_receipts_by_their_own_stamps_and_baselines_nothing(tmp_path, monkeypatch):
    journals = tmp_path / "journals"; journals.mkdir()
    fp = btl.fingerprint("MOVE_UNIT")
    rows = [{"kind": "MOVE_UNIT", "status": "confirmed", "requestId": "a", "contract": fp, "confirmedBy": {"effect": {"unitLocation": {}}}},
            {"kind": "MOVE_UNIT", "status": "unknown", "requestId": "b"},
            {"kind": "SEND_MERCHANT", "status": "confirmed", "requestId": "c", "confirmedBy": {"effect": {"merchantSent": {}}}},
            {"kind": "ATTACK", "status": "confirmed", "requestId": "d", "contract": "stale00", "confirmedBy": {"effect": {"attacked": {}}}}]
    (journals / "seat0.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    defs = tmp_path / "defs.json"
    prior = {"version": 2, "cases": [{"case_id": "LT-send_merchant", "live_status": "passed", "passed_fingerprint": "stale00", "priority": 1}]}
    defs.write_text(json.dumps(prior))
    monkeypatch.setattr(btl, "DEFS", defs)
    data = btl.build(journals)
    by = {c["case_id"]: c for c in data["cases"]}
    assert by["LT-move_unit"]["live_status"] == "passed" and by["LT-move_unit"]["expected_effect"] == "unitLocation"
    assert by["LT-move_unit"]["passed_fingerprint"] == fp, "the pass is under the stamp the receipt carries"
    assert by["LT-move_unit"]["evidence_refs"] == {"journal": {"confirmed": 1, "rejected": 0, "unknown": 1, "matched": 1, "stamps": [fp]}}
    assert by["LT-move_unit-standing"]["live_status"] == "inconclusive", "an arrival receipt does not seed the standing variant; the kind's unknown attempt leaves it inconclusive, as the ledger would"
    assert by["LT-send_merchant"]["live_status"] == "passed_historical" and by["LT-send_merchant"]["passed_fingerprint"] is None, "an unstamped receipt is historical, never baselined to the current contract"
    assert by["LT-send_merchant"]["priority"] == 1, "prior metadata is kept"
    assert by["LT-attack"]["live_status"] == "retest", "a receipt stamped by a superseded implementation asks for a retest"
    fams = {f["family"]: f for f in data["families"]}
    live = {v["variant"]: v["live"] for v in fams["A01"]["variants"]} if "A01" in fams else {}
    assert all(v in (None, "passed", "retest", "passed_historical", "not_seen", "rejected", "inconclusive") for v in live.values())
    for f in data["families"]:
        for v in f["variants"]:
            if v["kinds"]:
                assert v["live"] == min((by[f"LT-{k}"]["live_status"] for k in v["kinds"]), key=lambda st: ["not_seen", "rejected", "inconclusive", "passed_historical", "retest", "passed"].index(st)), "a family variant is as live as the least live of its kinds, under the same evaluator"
    assert by["LT-wmd_strike"]["live_status"] == "not_seen" and by["LT-attack"]["consequence_class"] == "high"
    assert by["LT-wmd_strike"]["consequence_class"] == "high" and by["LT-purchase_unit"]["consequence_class"] == "medium"
    assert by["LT-start_diplomatic_action-war"]["consequence_class"] == "high" and by["LT-start_diplomatic_action"]["consequence_class"] == "medium", "a variant carries its own consequence"
    fams = {f["family"]: f for f in data["families"]}
    assert fams["A02"]["status"] == "partial" and fams["A28"]["status"] == "implemented"
    assert {v["disposition"] for v in fams["A20"]["variants"]} == {"implemented", "already_covered", "native_dormant"}
    # regeneration is stable
    assert btl.build(journals) == data
