"""Build the live-test definitions, the human checklist and the coverage table from one source.

Seeds one case per implemented action kind (live status from the seat journals under the host state,
when present), plus one placeholder per item of the remaining-actions plan. Re-run after adding an
action; existing evidence in the JSON is kept.

    python tools/build_test_ledger.py [--journals DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from civ7_observer.actions import PUBLIC_KIND  # noqa: E402

DOCS = ROOT / "docs"
DEFS = DOCS / "action-live-test-todo.json"
CHECKLIST = DOCS / "action-live-test-checklist.md"
COVERAGE = DOCS / "action-coverage.md"

HIGH = {"attack", "declare_war", "disband_unit", "activate_great_person", "cancel_alliance"}
PLAN_ITEMS = {
    "A01": "Captured settlement keep/raze/liberate", "A02": "Peace deals: inspect, propose, accept, reject",
    "A03": "Ally at war / call to arms", "A04": "Choose city-state bonus", "A05": "Support/oppose ongoing diplomatic actions",
    "A06": "Diplomatic projects with secondary targets", "A07": "Advisor-warning acknowledgement",
    "A08": "Pillage, coastal raid, route plunder", "A09": "Religious spread and relics", "A10": "Production queue remove/reorder/move",
    "A11": "Policy deactivation and replacement", "A12": "Resource unassign/clear/swap", "A13": "Town return to growth mode",
    "A14": "Wake/cancel orders and unit swap", "A15": "Capital selection", "A16": "Syncretism choices", "A17": "Legacy deck revise and placement effects",
    "A18": "Resettle/migrant and alternate founding", "A19": "Army reinforcement, focused attacks, overrun", "A20": "Roads, rail, bases, rebase, cargo",
    "A21": "Civilization/unit-specific abilities", "A22": "Tile actions: repair, remove, plant, disperse", "A23": "Artifacts and great-work relocation",
    "A24": "Air and specialized naval attacks", "A25": "WMD and contamination cleanup", "A26": "City/district attacks and espionage units if player-facing",
    "A27": "Standing multi-turn movement and automate-explore", "A28": "Custom religion name and renaming",
}


# Which catalog kinds complete which plan item. An item is implemented once every kind is in the
# catalog; its live status is passed once every kind has a confirmed receipt.
PLAN_KINDS = {
    "A01": ["keep_captured_city", "raze_captured_city", "liberate_captured_city"], "A02": ["propose_peace", "accept_peace", "reject_peace"],
    "A03": ["join_ally_war"], "A04": ["choose_city_state_bonus"], "A05": ["support_diplomatic_action"],
    "A06": ["start_diplomatic_action"], "A07": ["acknowledge_advisor_warning"],
    "A08": ["pillage", "coastal_raid", "pillage_route", "plunder_trade_route"], "A09": ["spread_religion"],
    "A10": ["queue_remove", "queue_move_up", "queue_move_down"], "A11": ["deactivate_tradition"],
    "A12": ["unassign_resource", "swap_resources"], "A13": ["town_growth_mode"], "A14": ["wake_unit", "cancel_order"],
    "A15": ["select_capital"], "A16": ["syncretism_units", "syncretism_infrastructure", "syncretism_self"],
    "A17": ["drop_legacy_card", "place_legacy_settlement"], "A18": ["resettle"],
    "A19": ["reinforce_army", "upgrade_army", "army_overrun", "commander_attack", "focused_attack_land_melee", "focused_attack_land_ranged", "focused_attack_sea_melee", "focused_attack_sea_ranged", "focused_attack_air_to_air", "focused_attack_air_to_land", "focused_attack_air_bomb"],
    "A20": ["connect_with_road", "move_by_rail", "rebase", "teleport_to_city", "establish_base"],
    "A21": ["stone_trap", "treat_sick", "claim_resource", "embed_lookout", "search", "aerial_recon"],
    "A23": ["excavate", "research_artifacts", "move_great_work"], "A24": ["air_attack", "naval_attack", "cargo_drop", "unit_air_drop"],
    "A25": ["wmd_strike"], "A28": ["rename_unit", "rename_city", "found_religion"], "A26": ["start_diplomatic_action"], "A27": ["automate_explore", "move_unit"],
    "A22": ["repair", "remove_feature", "remove_improvement", "plant_forest", "harvest_resource", "build_improvement", "disperse_independent", "convert_independent_to_city_state", "scorched_earth", "disperse_clan", "call_reinforcements"],
}


def journal_counts(journals: Path | None) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    if not journals or not journals.exists():
        return out
    for p in journals.glob("seat*.jsonl"):
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            k, s = row.get("kind"), row.get("status")
            if k and s in ("confirmed", "rejected", "unknown"):
                out.setdefault(k, {"confirmed": 0, "rejected": 0, "unknown": 0})[s] += 1
    return out


def build(journals: Path | None) -> dict:
    prior = {}
    if DEFS.exists():
        prior = {c["case_id"]: c for c in json.loads(DEFS.read_text(encoding="utf-8"))["cases"]}
    counts = journal_counts(journals)
    cases = []
    for internal, public in PUBLIC_KIND.items():
        cid = f"LT-{public}"
        seen = counts.get(internal, {})
        old = prior.get(cid, {})
        live = "passed" if seen.get("confirmed") else old.get("live_status", "not_seen")
        cases.append({
            "case_id": cid, "action_family": public, "expected_kind": internal, "variant": "default",
            "priority": old.get("priority", 3), "implementation_status": old.get("implementation_status", "offline_verified"),
            "live_status": live, "eligibility": {"offered": [public]},
            "consequence_class": "high" if public in HIGH else old.get("consequence_class", "low"),
            "procedure": old.get("procedure", f"take a `{public}` offer when it is strategically sensible"),
            "expected_evidence": f"a confirmed `{internal}` receipt in the seat journal",
            "evidence_refs": {"journal": seen} if seen else old.get("evidence_refs", {}),
        })
    public_to_internal = {v: k for k, v in PUBLIC_KIND.items()}
    for aid, title in PLAN_ITEMS.items():
        cid = f"PLAN-{aid}"
        old = prior.get(cid, {})
        kinds = PLAN_KINDS.get(aid, [])
        implemented = bool(kinds) and all(k in public_to_internal for k in kinds)
        live_all = implemented and all(counts.get(public_to_internal[k], {}).get("confirmed") for k in kinds)
        cases.append({
            "case_id": cid, "action_family": title, "expected_kind": None, "variant": "plan-item",
            "priority": int(aid[1:]) // 7 + 1, "implementation_status": "offline_verified" if implemented else old.get("implementation_status", "unimplemented"),
            "live_status": "passed" if live_all else old.get("live_status", "not_seen"),
            "eligibility": {"offered": []}, "kinds": kinds,
            "consequence_class": old.get("consequence_class", "medium"), "procedure": old.get("procedure", title),
            "expected_evidence": "a confirmed receipt of each listed kind" if kinds else "see plans/remaining-player-actions-implementation.md",
            "evidence_refs": old.get("evidence_refs", {}),
        })
    return {"version": 1, "cases": cases}


def write_docs(data: dict) -> None:
    cases = data["cases"]
    lines = ["# Live-test checklist", "", "Generated by `tools/build_test_ledger.py` from `action-live-test-todo.json`; do not edit by hand.", "",
             "| case | family | implemented | live | consequence |", "|---|---|---|---|---|"]
    for c in cases:
        lines.append(f"| {c['case_id']} | {c['action_family']} | {c['implementation_status']} | {c['live_status']} | {c.get('consequence_class', '')} |")
    CHECKLIST.write_text("\n".join(lines) + "\n", encoding="utf-8")
    impl = [c for c in cases if c["variant"] == "default"]
    passed = [c for c in impl if c["live_status"] == "passed"]
    plan = [c for c in cases if c["variant"] == "plan-item"]
    cov = ["# Action coverage", "", "Generated by `tools/build_test_ledger.py`; the numbers are counts of catalog kinds, not of engine enums.", "",
           f"- Implemented kinds: {len(impl)}", f"- Live-verified (a confirmed receipt in this host's journals): {len(passed)}",
           f"- Implemented, awaiting a live opportunity: {len(impl) - len(passed)}",
           f"- Plan items not yet implemented: {sum(1 for c in plan if c['implementation_status'] == 'unimplemented')} of {len(plan)}", "",
           "| kind | engine operation | live | receipts (confirmed/rejected/unknown) |", "|---|---|---|---|"]
    for c in impl:
        j = (c.get("evidence_refs") or {}).get("journal") or {}
        cov.append(f"| `{c['action_family']}` | `{c['expected_kind']}` | {c['live_status']} | {j.get('confirmed', 0)}/{j.get('rejected', 0)}/{j.get('unknown', 0)} |")
    COVERAGE.write_text("\n".join(cov) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--journals", type=Path, default=Path.home() / ".local" / "state" / "civ7-observer" / "journals")
    args = ap.parse_args()
    data = build(args.journals)
    DEFS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_docs(data)
    passed = sum(1 for c in data["cases"] if c["variant"] == "default" and c["live_status"] == "passed")
    print(f"{len(data['cases'])} cases; {passed} live-verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
