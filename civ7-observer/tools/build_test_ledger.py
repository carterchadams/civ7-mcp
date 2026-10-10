"""Build the live-test definitions, the human checklist and the coverage report from one source.

Three things are kept apart, because a list of names in the catalog proves none of the others:

- catalog presence: one case per public kind (plus variant cases where one receipt shape is not
  enough), with a `contract_fingerprint` of the source lines that name the kind, so a pass under an
  older implementation reads as `retest`;
- family completion: each item of the remaining-actions plan, as variants with an explicit
  disposition (implemented, partial, already_covered, native_dormant, excluded) and the source
  evidence or revisit condition behind it;
- live evidence: seeded from the seat journals under the host state (kept when the file is rebuilt),
  and refined per match by the ledger at play time.

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
from civ7_observer.contract import compute_fingerprint  # noqa: E402
from civ7_observer.testing import evaluate  # noqa: E402

DOCS = ROOT / "docs"
DEFS = DOCS / "action-live-test-todo.json"
CHECKLIST = DOCS / "action-live-test-checklist.md"
COVERAGE = DOCS / "action-coverage.md"
SOURCES = [ROOT / "src" / "civ7_observer" / "payloads" / "offers.js", ROOT / "src" / "civ7_observer" / "payloads" / "perform.js",
           ROOT / "src" / "civ7_observer" / "payloads" / "readback.js", ROOT / "src" / "civ7_observer" / "actions.py"]

# Consequence classes drive the order testing opportunities are offered in and how the note reads.
# High: destroys or commits something the seat cannot take back, or changes a relationship.
HIGH = {"attack", "declare_war", "join_ally_war", "disband_unit", "activate_great_person", "cancel_alliance", "raze_captured_city",
        "liberate_captured_city", "wmd_strike", "air_attack", "naval_attack", "scorched_earth", "disperse_independent",
        "convert_independent_to_city_state", "disperse_clan", "army_overrun", "commander_attack",
        "focused_attack_land_melee", "focused_attack_land_ranged", "focused_attack_sea_melee", "focused_attack_sea_ranged",
        "focused_attack_air_to_air", "focused_attack_air_to_land", "focused_attack_air_bomb", "pillage", "coastal_raid",
        "pillage_route", "plunder_trade_route", "remove_improvement", "harvest_resource", "remove_feature"}
# Medium: spends a scarce resource or makes a one-way choice within the seat's own affairs.
MEDIUM = {"purchase_unit", "purchase_constructible", "upgrade_army", "upgrade_unit", "found_city", "promote_town_to_city",
          "finish_legacy_deck", "finish_age_transition", "syncretism_units", "syncretism_infrastructure", "syncretism_self",
          "select_capital", "found_religion", "add_belief", "found_pantheon", "change_government", "buy_attribute",
          "start_diplomatic_action", "support_diplomatic_action", "propose_peace", "accept_peace", "reject_peace",
          "keep_captured_city", "place_legacy_settlement", "resettle", "reinforce_army", "greet_new_civilization",
          "choose_age_civilization", "promote_unit", "make_trade_route", "rename_city", "rename_unit"}

# Variant cases: one kind, more than one thing a receipt can prove. `expected_effect` is a key of the
# confirming effect recorded on the journal row; the default case of these kinds names its own key
# too, so an arrival never passes a queued-move case and a war never passes an influence case.
VARIANTS = {
    "move_unit": [("default", "unitLocation", "move a unit to a plot it reaches this turn"),
                  ("standing", "unitMoved", "take a `multiTurn` move toward one of the seat's own settlements (confirmed as queued or under way, not arrival)")],
    "start_diplomatic_action": [("default", "diplomaticActionStarted", "start an influence-priced diplomatic project"),
                                ("free", "diplomaticProjectStarted", "start a free diplomatic project (its own event is the proof)"),
                                ("war", "warDeclared", "declare war through a diplomatic action (only in a war the seat would fight anyway)", "high"),
                                ("alliance", "allianceFormed", "form an alliance through a diplomatic action")],
}

# Family completion, per item of plans/v1-ideas/remaining-player-actions-implementation.md. Each variant has a
# disposition and the evidence behind it; a family is `implemented` only when no variant is partial.
# Dispositions: implemented (kinds in the catalog), already_covered (reachable through another kind),
# native_dormant (no player-facing call site in the shipped UI; evidence cited), excluded (a deliberate
# limit with a revisit condition), partial (a requirement the catalog does not yet meet).
FAMILIES = {
    "A01": ("Captured settlement keep/raze/liberate", [
        ("keep, raze, liberate", "implemented", ["keep_captured_city", "raze_captured_city", "liberate_captured_city"], "CityCommandTypes.DESTROY with Directive 2/3/0")]),
    "A02": ("Peace deals: inspect, propose, accept, reject", [
        ("plain proposal", "implemented", ["propose_peace"], "PROPOSE_PEACE with the engine's drafted terms"),
        ("inspect and answer an incoming proposal", "implemented", ["accept_peace", "reject_peace"], "sendWorkingDeal(shape, ACCEPTED|REJECTED) on whichever working-deal shape holds the proposal (the shipped manager reads a switched OUTGOING deal); terms listed from getWorkingDealItem; the shape itself is unverified live until a war with a major occurs"),
        ("terms and counteroffer", "partial", [], "the shipped panel adds CITIES (CEDE_OCCUPIED / OFFER), GOLD and INFLUENCE lump items and resends ADJUSTED; RESOURCES, UNITS, TECHNOLOGY, GREATWORK, CAPTIVE and per-turn gold have no UI call site. possibleTerms are read for inspection; sending terms awaits a disposable war scenario")]),
    "A03": ("Ally at war / call to arms", [("join the ally's war", "implemented", ["join_ally_war"], "DECLARE_WAR via Game.Diplomacy.getNextCallToArms")]),
    "A04": ("Choose city-state bonus", [("choose bonus", "implemented", ["choose_city_state_bonus"], "CHOOSE_CITY_STATE_BONUS {OtherPlayer, CityStateBonusType}")]),
    "A05": ("Support/oppose ongoing diplomatic actions", [
        ("support a side with one token", "implemented", ["support_diplomatic_action"], "SUPPORT_DIPLOMATIC_ACTION {ID, Type: DIPLOMACY_TOKEN_GLOBAL, Amount: 1, SubType}"),
        ("oppose a side", "already_covered", ["support_diplomatic_action"], "SubType picks the side backed (true initiator, false target); opposing the initiator is supporting the target, as the shipped details screen does"),
        ("retract support, larger amounts", "native_dormant", [], "no OPPOSE/RETRACT/WITHDRAW operation in any shipped .js.map; Amount is 1 at every call site; SUPPORT_/OPPOSE_LAND_CLAIMS rows are commented out of diplomacy-actions.xml")]),
    "A06": ("Diplomatic projects with secondary targets", [
        ("influence-priced projects, secondary targets", "implemented", ["start_diplomatic_action"], "the engine's own getProjectDataForUI listing supplies operation, price and targetList2"),
        ("free projects", "implemented", ["start_diplomatic_action"], "confirmed by the project's own event among the seat's actions against the target (Game.Diplomacy.getPlayerEvents, initialPlayer = seat), as the shipped panel reads it back")]),
    "A07": ("Advisor-warning acknowledgement", [("acknowledge", "implemented", ["acknowledge_advisor_warning"], "VIEWED_ADVISOR_WARNING")]),
    "A08": ("Pillage, coastal raid, route plunder", [("pillage, raid, plunder", "implemented", ["pillage", "coastal_raid", "pillage_route", "plunder_trade_route"], "plot-target operations from canStart(op, {}).Plots; PLUNDER_TRADE_ROUTE command")]),
    "A09": ("Religious spread and relics", [
        ("spread religion", "implemented", ["spread_religion"], "SPREAD_RELIGION on the unit's activation plots"),
        ("relics", "already_covered", ["move_great_work"], "a relic is a great work; it is placed with move_great_work (shipped UI has no separate relic action)")]),
    "A10": ("Production queue remove/reorder/move", [("remove, move up, move down", "implemented", ["queue_remove", "queue_move_up", "queue_move_down"], "BUILD with InsertMode RemoveAt/Swap")]),
    "A11": ("Policy deactivation and replacement", [
        ("deactivate", "implemented", ["deactivate_tradition"], "CHANGE_TRADITION into an empty slot"),
        ("replace", "already_covered", ["deactivate_tradition", "activate_tradition"], "a replacement is a deactivation then an activation")]),
    "A12": ("Resource unassign/clear/swap", [("unassign, swap", "implemented", ["unassign_resource", "swap_resources"], "ASSIGN_RESOURCE with no city / two sends")]),
    "A13": ("Town return to growth mode", [("growth mode", "implemented", ["town_growth_mode"], "CHANGE_GROWTH_MODE {Type: EXPAND, ProjectType: NO_PROJECT}")]),
    "A14": ("Wake/cancel orders and unit swap", [
        ("wake, cancel", "implemented", ["wake_unit", "cancel_order"], "UnitCommandTypes.WAKE / CANCEL"),
        ("unit swap", "partial", [], "UNITOPERATION_SWAP_UNITS exists in the shipped click-to-move dispatcher (world-input.ts); not implemented, revisit as a plot-target operation")]),
    "A15": ("Capital selection", [("select capital", "implemented", ["select_capital"], "SELECT_CAPITAL {Player1, City, Swap} during the legacies decision")]),
    "A16": ("Syncretism choices", [("units, infrastructure, self", "implemented", ["syncretism_units", "syncretism_infrastructure", "syncretism_self"], "CHOOSE_SYNCRETISM_* {CivilizationType}")]),
    "A17": ("Legacy deck revise and placement effects", [
        ("put a card back, place a settlement", "implemented", ["drop_legacy_card", "place_legacy_settlement"], "ADVANCED_START_MODIFY_DECK REMOVE; ADVANCED_START_PLACE_SETTLEMENT {ID, X, Y}"),
        ("rewards applied once, at the finish", "implemented", ["finish_legacy_deck"], "ADVANCED_START_USE_EFFECT per effect at MARK_COMPLETED, as the shipped confirm does")]),
    "A18": ("Resettle/migrant and alternate founding", [
        ("resettle a migrant", "implemented", ["resettle"], "UnitCommandTypes.RESETTLE with the engine's Plots"),
        ("alternate founding placement", "already_covered", ["found_city", "place_legacy_settlement"], "founding is where the settler stands; the legacies placement covers the age-start settlement")]),
    "A19": ("Army reinforcement, focused attacks, overrun", [
        ("reinforce, upgrade army, overrun, commander and focused attacks", "implemented", ["reinforce_army", "upgrade_army", "army_overrun", "commander_attack", "focused_attack_land_melee", "focused_attack_land_ranged", "focused_attack_sea_melee", "focused_attack_sea_ranged", "focused_attack_air_to_air", "focused_attack_air_to_land", "focused_attack_air_bomb"], "table-driven operations/commands with the shipped interface modes' shapes"),
        ("commander promotions", "already_covered", ["promote_unit"], "the shipped panel reuses UNITCOMMAND_PROMOTE with commander disciplines")]),
    "A20": ("Roads, rail, bases, rebase, cargo", [
        ("road, rail move, rebase, teleport, base", "implemented", ["connect_with_road", "move_by_rail", "rebase", "teleport_to_city", "establish_base"], "UNITCOMMAND_CONNECT_WITH_ROAD, MOVE_BY_RAIL; UNITOPERATION_REBASE, TELEPORT_TO_CITY, ESTABLISH_BASE"),
        ("cargo delivery / treasure fleet", "already_covered", ["disband_unit"], "the shipped UI unloads a treasure fleet with UNITCOMMAND_DISBAND (getDisbandBaseAmount is the payout)"),
        ("build road operation, embark/disembark", "native_dormant", [], "UNITOPERATION_BUILD_ROUTE is commented out of unit-operations.xml; EMBARK/DISEMBARK are VisibleInUI=false with no handler")]),
    "A21": ("Civilization/unit-specific abilities", [
        ("stone trap, treat sick, claim resource, lookout, search, aerial recon", "implemented", ["stone_trap", "treat_sick", "claim_resource", "embed_lookout", "search", "aerial_recon"], "gated natively via ChargedUnitAbilities/RequiresAbility; sent with UnitAbilityType -1 as the shipped loop does"),
        ("passive abilities", "native_dormant", [], "most UnitAbilities rows are Inactive stat modifiers with no command or operation")]),
    "A22": ("Tile actions: repair, remove, plant, disperse", [
        ("repair, remove, plant, harvest, build, disperse, convert, scorch, disperse clan, call reinforcements", "implemented", ["repair", "remove_feature", "remove_improvement", "plant_forest", "harvest_resource", "build_improvement", "disperse_independent", "convert_independent_to_city_state", "scorched_earth", "disperse_clan", "call_reinforcements"], "generic no-target/plot-target operation path; canStart decides which")]),
    "A23": ("Artifacts and great-work relocation", [
        ("excavate, research artifacts, move a great work", "implemented", ["excavate", "research_artifacts", "move_great_work"], "UNITOPERATION_EXCAVATE / RESEARCH_ARTIFACTS; MOVE_GREAT_WORK with DestinationBuilding as the building type"),
        ("display/claim artifact", "native_dormant", [], "no such operation in the shipped UI; placing an artifact is move_great_work")]),
    "A24": ("Air and specialized naval attacks", [
        ("air attack, naval attack, cargo drop, air drop", "implemented", ["air_attack", "naval_attack", "cargo_drop", "unit_air_drop"], "dedicated interface modes with the plot-target shape"),
        ("intercept, patrol, naval bombardment", "native_dormant", [], "no call site anywhere in the shipped modules (grep of every .js.map)")]),
    "A25": ("WMD and contamination cleanup", [
        ("nuclear strike", "implemented", ["wmd_strike"], "UNITOPERATION_WMD_STRIKE with Type WMD_NUCLEAR_DEVICE hard-coded as the shipped mode does; confirmation added here"),
        ("contamination cleanup", "native_dormant", [], "no player operation; fallout is a plot effect that decays")]),
    "A26": ("City/district attacks and espionage units if player-facing", [
        ("city or district attack", "already_covered", ["attack"], "ranged or melee into the city's plot; no separate operation"),
        ("espionage", "already_covered", ["start_diplomatic_action"], "the four espionage projects are diplomatic actions the engine lists like any other")]),
    "A27": ("Standing multi-turn movement and automate-explore", [
        ("standing move to an own settlement", "implemented", ["move_unit"], "MOVE_TO with a multi-turn path, accepted only toward the seat's own settlements"),
        ("automate explore", "implemented", ["automate_explore"], "UNITOPERATION_AUTOMATE_EXPLORE; cancelled with cancel_order"),
        ("fog / frontier destinations", "excluded", [], "moves are offered to visible plots only, so no hidden terrain leaks through path previews; revisit with a knowledge contract that validates without revealing")]),
    "A28": ("Custom religion name and renaming", [("religion name, unit and city renaming", "implemented", ["found_religion", "rename_unit", "rename_city"], "ReligionCustomName on FOUND_RELIGION; NAME_UNIT / NAME_CITY {Name}, text validated host-side")]),
}


def fingerprint(internal: str) -> str:
    """The kind's contract digest over whole offer, dispatch, bind, confirm and read-back regions
    (see `civ7_observer.contract`), computed from SOURCES so a test may point it elsewhere."""
    return compute_fingerprint(internal, SOURCES)


def journal_rows(journals: Path | None) -> dict[str, list[dict]]:
    """Every final journal row on this host, grouped by kind."""
    out: dict[str, list[dict]] = {}
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
                out.setdefault(k, []).append(row)
    return out


def consequence(public: str) -> str:
    return "high" if public in HIGH else "medium" if public in MEDIUM else "low"


def family_status(variants: list[dict]) -> str:
    if any(v["disposition"] == "partial" for v in variants):
        return "partial"
    if all(v["disposition"] in ("native_dormant", "excluded") for v in variants):
        return "no_catalog_kind"
    return "implemented"


def build(journals: Path | None) -> dict:
    prior = {}
    if DEFS.exists():
        old = json.loads(DEFS.read_text(encoding="utf-8"))
        prior = {c["case_id"]: c for c in (old.get("cases") if isinstance(old, dict) else old)}
    rows_by_kind = journal_rows(journals)
    public_to_internal = {v: k for k, v in PUBLIC_KIND.items()}
    cases = []
    by_case: dict[str, dict] = {}
    for internal, public in PUBLIC_KIND.items():
        fp = fingerprint(internal)
        variants = VARIANTS.get(public, [("default", None, None)])
        for name, effect, procedure, *rest in variants:
            klass = rest[0] if rest else consequence(public)
            cid = f"LT-{public}" if name == "default" else f"LT-{public}-{name}"
            old = prior.get(cid, {})
            # one evaluator for what the journals prove, the same the ledger applies at play time: a
            # confirmed receipt stamped with the current digest passes, another stamp is a retest, an
            # unstamped one is historical evidence; nothing is baselined at build time
            ev = evaluate({"expected_kind": internal, "expected_effect": effect, "contract_fingerprint": fp}, rows_by_kind.get(internal, []))
            live, passed_fp = ev["status"], ev["passed_fingerprint"]
            seen = {**ev["outcomes"], "matched": ev["matched"], "stamps": ev["stamps"]} if any(ev["outcomes"].values()) else {}
            by_case[cid] = live
            cases.append({
                "case_id": cid, "action_family": public, "expected_kind": internal, "variant": name,
                "expected_effect": effect, "contract_fingerprint": fp, "passed_fingerprint": passed_fp,
                "priority": old.get("priority", 3), "implementation_status": old.get("implementation_status", "offline_verified"),
                "live_status": live, "eligibility": {"offered": [public]},
                "consequence_class": klass,
                "procedure": procedure or old.get("procedure", f"take a `{public}` offer when it is strategically sensible"),
                "expected_evidence": f"a confirmed `{internal}` receipt" + (f" whose effect is `{effect}`" if effect else "") + " in the seat journal",
                "evidence_refs": {"journal": seen} if seen else {},
            })
    families = []
    for aid, (title, variants) in FAMILIES.items():
        rows = []
        for name, disposition, kinds, note in variants:
            missing = [k for k in kinds if k not in public_to_internal]
            # a family variant is as live as the least live of its kinds' default cases, under the same evaluator
            statuses = [by_case.get(f"LT-{k}", "not_seen") for k in kinds]
            order = ["not_seen", "rejected", "inconclusive", "passed_historical", "retest", "passed"]
            live = None if not kinds else min(statuses, key=lambda st: order.index(st) if st in order else 0)
            rows.append({"variant": name, "disposition": disposition if not missing else "partial", "kinds": kinds, "evidence": note,
                         **({"missing_kinds": missing} if missing else {}), "live": live})
        families.append({"family": aid, "title": title, "status": family_status(rows), "variants": rows})
    return {"version": 2, "cases": cases, "families": families}


def write_docs(data: dict) -> None:
    cases, families = data["cases"], data["families"]
    lines = ["# Live-test checklist", "", "Generated by `tools/build_test_ledger.py` from `action-live-test-todo.json`; do not edit by hand.", "",
             "| case | family | variant | implemented | live | consequence |", "|---|---|---|---|---|---|"]
    for c in cases:
        lines.append(f"| {c['case_id']} | {c['action_family']} | {c['variant']} | {c['implementation_status']} | {c['live_status']} | {c.get('consequence_class', '')} |")
    lines += ["", "| family | title | status | variants |", "|---|---|---|---|"]
    for f in families:
        lines.append(f"| {f['family']} | {f['title']} | {f['status']} | " + "; ".join(f"{v['variant']}: {v['disposition']}" for v in f["variants"]) + " |")
    CHECKLIST.write_text("\n".join(lines) + "\n", encoding="utf-8")
    kinds = {c["expected_kind"] for c in cases}
    defaults = [c for c in cases if c["variant"] == "default"]
    variants = [c for c in cases if c["variant"] != "default"]
    passed_kinds = {c["expected_kind"] for c in cases if c["live_status"] == "passed"}
    historical_kinds = {c["expected_kind"] for c in cases if c["live_status"] in ("passed_historical", "retest")} - passed_kinds
    tally = {}
    for c in cases:
        tally[c["live_status"]] = tally.get(c["live_status"], 0) + 1
    cov = ["# Action coverage", "", "Generated by `tools/build_test_ledger.py`. Three counts that must not be confused: catalog kinds "
           "(what the MCP can dispatch), variants (what a receipt of a kind can prove), and plan families (what the remaining-actions plan "
           "asked for, each variant with a disposition and its evidence). A confirmed receipt proves the exercised variant under the "
           "implementation it was earned with (`contract_fingerprint`); it does not certify a family.", "",
           f"- Catalog kinds: {len(kinds)}; live-verified under the current contract: {len(passed_kinds)}; with only historical or superseded receipts: {len(historical_kinds)}",
           f"- Cases: {len(cases)} ({len(defaults)} default, {len(variants)} variants); by live status: " + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())),
           "- `passed` needs a confirmed receipt of the case's variant stamped with the kind's current contract digest; `passed_historical` is a receipt from before "
           "stamping (kept, not current); `retest` a receipt from a superseded implementation; both are offered again as opportunities.",
           f"- Families: {len(families)}; implemented: {sum(1 for f in families if f['status'] == 'implemented')}; partial: {sum(1 for f in families if f['status'] == 'partial')}", "",
           "## Kinds and variants", "", "| case | engine operation | variant (effect) | live | receipts (matching the variant, of confirmed/rejected/unknown) | consequence |", "|---|---|---|---|---|---|"]
    for c in cases:
        j = (c.get("evidence_refs") or {}).get("journal") or {}
        var = c["variant"] + (f" (`{c['expected_effect']}`)" if c.get("expected_effect") else "")
        cov.append(f"| `{c['case_id']}` | `{c['expected_kind']}` | {var} | {c['live_status']} | {j.get('matched', 0)} matching of {j.get('confirmed', 0)}/{j.get('rejected', 0)}/{j.get('unknown', 0)} | {c['consequence_class']} |")
    cov += ["", "## Families", "", "| family | title | status | variant | disposition | kinds | evidence |", "|---|---|---|---|---|---|---|"]
    for f in families:
        for v in f["variants"]:
            cov.append(f"| {f['family']} | {f['title']} | {f['status']} | {v['variant']} | {v['disposition']} | {', '.join(f'`{k}`' for k in v['kinds']) or '—'} | {v['evidence']} |")
    COVERAGE.write_text("\n".join(cov) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--journals", type=Path, default=Path.home() / ".local" / "state" / "civ7-observer" / "journals")
    args = ap.parse_args()
    data = build(args.journals)
    DEFS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_docs(data)
    tally = {}
    for c in data["cases"]:
        tally[c["live_status"]] = tally.get(c["live_status"], 0) + 1
    fams = data["families"]
    print(f"{len(data['cases'])} cases; " + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())) + f"; families implemented {sum(1 for f in fams if f['status'] == 'implemented')}, partial {sum(1 for f in fams if f['status'] == 'partial')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
