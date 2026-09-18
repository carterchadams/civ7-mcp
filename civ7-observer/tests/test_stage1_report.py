"""The Stage 1 report counts rounds against evidenced membership, keeps recorded and inferred settings apart,
computes its reading from the cohorts shown, and lists unknown outcomes one by one against the journals and lessons."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("stage1_report", ROOT / "tools" / "stage1_report.py")
s1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s1)


def row(seat, turn, status="turn_ended", *, age="exploration", match="M", at="2026-09-17T01:00:00Z", run=None, receipts=(), elapsed=60.0, unknown=None):
    r = {"seat": seat, "turn": turn, "status": status, "match": match, "tag": f"{age}-t{turn}-seat{seat}" if age else f"t{turn}-seat{seat}",
         "startedAt": at, "elapsedS": elapsed, "costUsd": 0.5, "toolCalls": {"mcp__civ7__perform_action": 3}, "receipts": [{"kind": k} for k in receipts]}
    if run:
        r["run"] = run
    if unknown:
        r["unknown"] = unknown
    return r


def test_rounds_need_every_evidenced_seat_and_are_keyed_by_match_age_and_turn():
    rows = [row(0, 10), row(1, 10), row(3, 10),            # complete: three seats evidenced, three ended
            row(0, 11), row(1, 11), row(3, 12), row(0, 12), row(1, 12),   # seat 3 is evidenced at 11 (it plays 12) but did not end 11
            row(0, 5, age="antiquity"), row(1, 5, age="antiquity"), row(3, 5, age="antiquity"),   # the same turn number in another age is another round
            row(0, 40, match="OTHER")]                    # a lone seat: membership unknown, not a round
    r = s1.complete_rounds(rows)
    assert len(r) == 3, "len() counts complete rounds"
    assert len(s1.complete_rounds([{"match": "m", "turn": 8, "seat": s, "status": "turn_ended"} for s in (0, 1)])) == 1 and \
        len(s1.complete_rounds([{"match": "m", "turn": 8, "seat": s, "status": "turn_ended"} for s in (0, 1)] + [{"match": "m", "turn": 9, "seat": 3, "status": "turn_ended"}])) == 0, \
        "two seats make a round only when no third seat is evidenced at that turn"
    assert [(e["age"], e["turn"]) for e in r["complete"]] == [("antiquity", 5), ("exploration", 10), ("exploration", 12)]
    assert [(e["turn"], e["expected"], e["ended"]) for e in r["incomplete"]] == [(11, [0, 1, 3], [0, 1])]
    assert [(e["match"], e["turn"]) for e in r["unknownMembership"]] == [("OTHER", 40)]
    # two seats out of three do not make a round when the third is evidenced later
    two = s1.complete_rounds([row(0, 20), row(1, 20), row(3, 21)])
    assert two["complete"] == [] and two["incomplete"][0]["expected"] == [0, 1, 3]
    # a seat eliminated before this turn is not expected at it, while seats seen later were active at the earlier turn too
    gone = s1.complete_rounds([row(2, 8), row(0, 9), row(1, 9), row(3, 9)])
    assert [e["turn"] for e in gone["complete"]] == [9] and gone["incomplete"][0]["turn"] == 8 and gone["incomplete"][0]["expected"] == [0, 1, 2, 3]


def test_cohorts_keep_recorded_settings_apart_from_inferred_periods():
    run = {"model": "sonnet", "effort": "low", "budgetUsd": 2.0, "opportunities": 4, "raiseCurtain": True, "revision": "abc1234"}
    rows = [row(0, 1, at="2026-09-11T05:00:00Z"), row(0, 2, at="2026-09-12T05:00:00Z"), row(0, 3, at="2026-09-17T05:00:00Z"), row(0, 4, run=run), row(1, 4, run=run)]
    got = s1.cohorts(rows)
    titles = [t for _, t, _, _ in got]
    assert titles == ["before Stage 1 (inferred)", "Stage 1, medium effort (inferred)", "Stage 1, low effort (inferred)", "recorded: sonnet, effort low (recorded)"]
    assert "abc1234" in got[-1][2] and "--effort low" in got[-1][2] and len(got[-1][3]) == 2


def test_the_reading_is_computed_and_names_representative_turns(tmp_path):
    run = {"model": "sonnet", "effort": "low", "budgetUsd": 2.0, "opportunities": 4, "raiseCurtain": True}
    rows = []
    for t in range(1, 8):
        rows += [row(0, t, at=f"2026-09-12T0{t}:00:00Z", receipts=("MOVE_UNIT", "END_TURN"), elapsed=100.0), row(1, t, at=f"2026-09-12T0{t}:10:00Z", receipts=("END_TURN",), elapsed=100.0)]
        rows += [row(0, 20 + t, at=f"2026-09-17T0{t}:00:00Z", run=run, receipts=("MOVE_UNIT", "FOUND_CITY", "END_TURN", "SKIP_UNIT"), elapsed=50.0), row(1, 20 + t, at=f"2026-09-17T0{t}:10:00Z", run=run, receipts=("END_TURN",), elapsed=50.0)]
    report = s1.build(rows, journals=None, lessons_path=None)
    assert "median duration x0.50" in report and "receipts per turn x1.67" in report, "ratios come from the cohorts, not prose"
    assert "`exploration-t21-seat0`" in report or "`exploration-t27-seat0`" in report, "a representative turn is named"
    assert "| — | — | — | none in the log | — |" in report
    assert "(recorded)" in report and "(inferred)" in report
    assert "Decision: keep Stage 1" in report


def test_unknown_outcomes_are_listed_with_their_journal_kind_and_the_matching_lesson(tmp_path):
    journals = tmp_path / "journals"; journals.mkdir()
    (journals / "seat3.jsonl").write_text(json.dumps({"kind": "WAKE", "status": "unknown", "requestId": "t63-wake", "turn": 63}) + "\n" +
                                          json.dumps({"kind": "MOVE_UNIT", "status": "confirmed", "requestId": "t63-mv", "turn": 63}) + "\n")
    lessons = tmp_path / "contract.md"
    lessons.write_text("# doc\n\n**Lesson (turn 63, live):** a wake applied after the read-back window closed.\nMore text.\n\n**Lesson (turn 9, live):** something about promotions.\n\n## Lesson: `canStart(FOUND_CITY)` says only yes or no\n\nbody\n")
    rows = [row(3, 63, status="unknown_outcome", unknown=["t63-wake"]), row(0, 70, status="unknown_outcome", unknown=["missing-id"]), row(1, 9, status="unknown_outcome", unknown=["t9-x"])]
    table = s1.unknown_table(rows, journals, lessons)
    assert table[0]["kinds"] == ["WAKE"] and table[0]["lessons"] == ["turn 63, live: a wake applied after the read-back window closed."] and table[0]["match"] == "same turn, names the kind"
    assert table[1]["kinds"] == ["not in this host's journals"] and table[1]["lessons"] == ["no lesson found"] and table[1]["match"] == "none"
    assert table[2]["lessons"] == ["turn 9, live: something about promotions."] and table[2]["match"] == "same turn"
    report = s1.build(rows, journals=journals, lessons_path=lessons)
    assert "3 unknown-outcome seat turns; 2 matched to a recorded lesson by turn or kind, 1 with no lesson found" in report
