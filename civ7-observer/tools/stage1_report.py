"""The Stage 1 (faster testing) comparison, rebuilt from the driver log.

Reads runs/agent-game/log.jsonl and the per-turn system prompts, groups seat turns into cohorts by
the settings they ran under, and writes docs/stage-1-performance-report.md. A row written from work
package E on carries its settings in `run` (a recorded cohort); an older row is placed by date into a
period whose settings are known only from the repository history and the operator's commands (an
inferred cohort), and the report says which is which.

Rounds are counted against evidenced membership: a seat is expected at turn T of an age when the log
shows it playing any turn at or after T in that age and match. Every numeric statement in the reading
section is computed from the cohorts shown, and quality claims cite representative turn tags. Unknown
outcomes are listed one by one with the action kind from the seat's journal and the contract lesson
the kind's repair was recorded under, or "no lesson found".

    python tools/stage1_report.py [--log PATH] [--out PATH] [--journals DIR]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "runs" / "agent-game" / "log.jsonl"
OUT = ROOT / "docs" / "stage-1-performance-report.md"
RUNS = ROOT / "runs" / "agent-game"
LESSONS = ROOT / "docs" / "action-contract.md"
JOURNALS = Path.home() / ".local" / "state" / "civ7-observer" / "journals"

# Settings per period for rows that carry none, from the repository history and the operator's
# commands. These are inferred, and the report labels them so.
STAGE1_COMMIT_AT = datetime(2026, 9, 11, 16, 40, 52, tzinfo=timezone.utc)   # a2ebad1: replacement prompt, --effort medium
LOW_EFFORT_FROM = datetime(2026, 9, 17, 0, 0, 0, tzinfo=timezone.utc)       # batches 68+: --effort low, 4 opportunities
PERIODS = [
    ("before", "before Stage 1 (inferred)", "default coding prompt appended; effort: client default (unknown); budget $1.50; opportunities: none; curtain raised", lambda t: t < STAGE1_COMMIT_AT),
    ("stage1", "Stage 1, medium effort (inferred)", "replacement system prompt; --effort medium; budget $1.50 then $2.00; up to 2 opportunities; curtain raised", lambda t: STAGE1_COMMIT_AT <= t < LOW_EFFORT_FROM),
    ("low", "Stage 1, low effort (inferred)", "replacement system prompt; --effort low; budget $2.00; 4 opportunities; curtain raised", lambda t: t >= LOW_EFFORT_FROM),
]
STATUS_ORDER = ["not_seen", "rejected", "inconclusive", "passed_historical", "retest", "passed"]


def parse_time(s: str | None) -> datetime | None:
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load(log: Path) -> list[dict]:
    rows = []
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def q(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = min(len(s) - 1, max(0, round(p * (len(s) - 1))))
    return s[k]


def prompt_bytes(tag: str | None) -> int | None:
    if not tag:
        return None
    p = RUNS / f"{tag}.system.md"
    try:
        return p.stat().st_size
    except OSError:
        return None


def age_of(row: dict) -> tuple[str, bool]:
    """The age a row played in and whether it is recorded (tag prefix) or inferred (rows before the
    prefix existed are Antiquity by turn number)."""
    tag = row.get("tag") or ""
    if "-" in tag and not tag.startswith("t"):
        return tag.split("-")[0], True
    return "antiquity", False


class Rounds(dict):
    """The round tally: `complete`, `incomplete` and `unknownMembership` lists. `len()` is the number of
    complete rounds, so a count reads as one."""

    def __len__(self) -> int:
        return len(self["complete"])

    def __bool__(self) -> bool:
        return True


def complete_rounds(rows: list[dict]) -> Rounds:
    """Rounds by (match, age, turn) against evidenced membership. A seat is expected at turn T when the
    log shows it playing any turn at or after T in that match and age; a round is complete when every
    expected seat ended turn T. Nothing is assumed complete: a turn with fewer than two evidenced seats
    is reported as unknown membership rather than counted."""
    by_turn: dict[tuple, list[dict]] = defaultdict(list)
    seat_turns: dict[tuple, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if not isinstance(r.get("turn"), int) or not isinstance(r.get("seat"), int):
            continue
        age, _ = age_of(r)
        key = (r.get("match"), age)
        by_turn[(*key, r["turn"])].append(r)
        seat_turns[key][r["seat"]].append(r["turn"])
    complete, incomplete, unknown = [], [], []
    for (match, age, turn), seat_rows in sorted(by_turn.items(), key=lambda kv: (str(kv[0][0]), kv[0][1], kv[0][2])):
        expected = {seat for seat, turns in seat_turns[(match, age)].items() if max(turns) >= turn}
        ended = {r.get("seat") for r in seat_rows if r.get("status") == "turn_ended"}
        entry = {"match": match, "age": age, "turn": turn, "expected": sorted(expected), "ended": sorted(ended)}
        if len(expected) < 2:
            unknown.append(entry)
        elif ended >= expected:
            complete.append(entry)
        else:
            incomplete.append(entry)
    return Rounds(complete=complete, incomplete=incomplete, unknownMembership=unknown)


def summarize(rows: list[dict]) -> dict:
    ended = [r for r in rows if r.get("status") == "turn_ended"]
    durations = [float(r["elapsedS"]) for r in ended if isinstance(r.get("elapsedS"), (int, float))]
    all_durations = [float(r["elapsedS"]) for r in rows if isinstance(r.get("elapsedS"), (int, float))]
    costs = [float(r["costUsd"]) for r in ended if isinstance(r.get("costUsd"), (int, float))]
    tools = Counter()
    per_turn_tools, per_turn_briefs, per_turn_receipts, kinds_per_turn, prompt_sizes = [], [], [], [], []
    receipt_kinds = Counter()
    scouting = 0
    for r in ended:
        tc = r.get("toolCalls") or {}
        tools.update(tc)
        per_turn_tools.append(sum(tc.values()))
        per_turn_briefs.append(tc.get("mcp__civ7__get_turn_brief", 0))
        rec = r.get("receipts") or []
        per_turn_receipts.append(len(rec))
        kinds = {x.get("kind") for x in rec}
        kinds_per_turn.append(len(kinds))
        receipt_kinds.update(x.get("kind") for x in rec)
        if "MOVE_UNIT" in kinds or "AUTOMATE_EXPLORE" in kinds:
            scouting += 1
        pb = prompt_bytes(r.get("tag"))
        if pb:
            prompt_sizes.append(pb)
    statuses = Counter(r.get("status") for r in rows)
    rounds = complete_rounds(rows)
    # representative turns for the quality reading: most distinct kinds, and the fewest, among ended turns
    ranked = sorted(ended, key=lambda r: len({x.get("kind") for x in (r.get("receipts") or [])}))
    representative = {"mostKinds": [r.get("tag") for r in ranked[-3:]][::-1], "fewestKinds": [r.get("tag") for r in ranked[:3]]}
    # wall clock over contiguous spans (a gap of more than 30 minutes is offline time, not throughput)
    spans, span_rounds = [], 0
    times = sorted((parse_time(r.get("startedAt")), float(r.get("elapsedS") or 0)) for r in rows if parse_time(r.get("startedAt")))
    if times:
        start, last_end = times[0][0], times[0][0]
        for t, e in times:
            if (t - last_end).total_seconds() > 1800:
                spans.append((start, last_end)); start = t
            last_end = max(last_end, t + timedelta(seconds=e))
        spans.append((start, last_end))
    wall_hours = sum((b - a).total_seconds() for a, b in spans) / 3600 if spans else 0
    return {
        "seatTurns": len(rows), "turnEnded": len(ended), "statuses": dict(statuses),
        "durationMedian": statistics.median(durations) if durations else None, "durationMean": statistics.mean(durations) if durations else None,
        "durationP90": q(durations, 0.9), "durationMax": max(durations) if durations else None,
        "allTurnsMean": statistics.mean(all_durations) if all_durations else None,
        "costMedian": statistics.median(costs) if costs else None, "costMean": statistics.mean(costs) if costs else None,
        "toolsPerTurn": statistics.mean(per_turn_tools) if per_turn_tools else None, "briefsPerTurn": statistics.mean(per_turn_briefs) if per_turn_briefs else None,
        "receiptsPerTurn": statistics.mean(per_turn_receipts) if per_turn_receipts else None, "distinctKindsPerTurn": statistics.mean(kinds_per_turn) if kinds_per_turn else None,
        "scoutingShare": scouting / len(ended) if ended else None, "toolMix": dict(tools.most_common(8)), "receiptMix": dict(receipt_kinds.most_common(10)),
        "promptBytesMedian": statistics.median(prompt_sizes) if prompt_sizes else None, "promptSamples": len(prompt_sizes),
        "completeRounds": len(rounds["complete"]), "incompleteRounds": len(rounds["incomplete"]), "unknownMembership": len(rounds["unknownMembership"]),
        "wallHours": wall_hours, "roundsPerHour": (len(rounds["complete"]) / wall_hours) if wall_hours else None,
        "representative": representative, "recorded": sum(1 for r in rows if isinstance(r.get("run"), dict)),
        "unknowns": statuses.get("unknown_outcome", 0), "pauses": statuses.get("paused", 0), "notEnded": statuses.get("not_ended", 0) + statuses.get("error", 0),
        "frictionEntries": sum(len(r.get("friction") or []) for r in rows),
    }


def journal_kinds(journals: Path | None) -> dict[str, tuple[str, int | None]]:
    """requestId -> (kind, turn) for every unknown row in the host's seat journals."""
    out: dict[str, tuple[str, int | None]] = {}
    if not journals or not journals.exists():
        return out
    for p in sorted(journals.glob("seat*.jsonl")):
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("status") == "unknown" and isinstance(r.get("requestId"), str):
                out[r["requestId"]] = (r.get("kind"), r.get("turn"))
    return out


def lessons(path: Path | None) -> list[dict]:
    """The dated contract lessons: heading, the turn they cite (if any) and their text."""
    out = []
    if not path or not path.exists():
        return out
    text = path.read_text(encoding="utf-8")
    for m in re.finditer(r"^(## Lesson: .+|\*\*Lesson \(turn (\d+)[^)]*\):\*\*.*)$((?:\n(?!\n|## |\*\*Lesson).*)*)", text, re.M):
        heading = m.group(1).strip()
        turn = int(m.group(2)) if m.group(2) else None
        short = re.sub(r"^\*\*Lesson \((turn [^)]*)\):\*\*\s*", r"\1: ", heading)
        short = re.sub(r"^## Lesson: ", "contract lesson: ", short)
        out.append({"heading": short[:120].rstrip() + ("…" if len(short) > 120 else ""), "turn": turn, "text": (heading + m.group(3)).lower()})
    return out


def unknown_table(rows: list[dict], journals: Path | None, lessons_path: Path | None) -> list[dict]:
    """Every unknown-outcome seat turn, with the kind from the journal and the lesson its repair was
    recorded under: a lesson citing the same turn, or one naming the kind. Otherwise, no lesson found."""
    kinds = journal_kinds(journals)
    less = lessons(lessons_path)
    out = []
    for r in rows:
        if r.get("status") != "unknown_outcome":
            continue
        rids = r.get("unknown") or []
        found = [kinds.get(rid) for rid in rids if kinds.get(rid)]
        kind_names = sorted({k for k, _ in found if k})
        # best first: a lesson citing this turn and naming the kind; then one citing the turn; then one naming the kind
        ranked = []
        for L in less:
            same_turn = L["turn"] is not None and L["turn"] == r.get("turn")
            names_kind = any(k.lower() in L["text"] or k.lower().replace("_", " ") in L["text"] for k in kind_names)
            score = (2 if same_turn else 0) + (1 if names_kind else 0)
            if score:
                ranked.append((-score, L["heading"]))
        ranked.sort()
        best = ranked[0][0] if ranked else 0
        matched = [h for sc, h in ranked if sc == best][:2]
        out.append({"tag": r.get("tag"), "turn": r.get("turn"), "seat": r.get("seat"), "requestIds": rids, "kinds": kind_names or ["not in this host's journals"],
                    "lessons": matched or ["no lesson found"], "match": {-2: "same turn", -3: "same turn, names the kind", -1: "names the kind only"}.get(best, "none")})
    return out


def cohorts(rows: list[dict]) -> list[tuple[str, str, str, list[dict]]]:
    """Recorded cohorts (rows carrying `run`) keyed by their settings, then inferred periods for the rest."""
    recorded: dict[tuple, list[dict]] = defaultdict(list)
    rest = []
    for r in rows:
        run = r.get("run")
        if isinstance(run, dict) and run.get("effort") is not None:
            recorded[(run.get("model"), run.get("effort"), run.get("budgetUsd"), run.get("opportunities"), bool(run.get("raiseCurtain")))].append(r)
        else:
            rest.append(r)
    out = []
    for key, title, settings, pred in PERIODS:
        mine = [r for r in rest if parse_time(r.get("startedAt")) and pred(parse_time(r.get("startedAt"))) ]
        if mine:
            out.append((key, title, settings, mine))
    for (model, effort, budget, opp, curtain), mine in sorted(recorded.items(), key=lambda kv: min(str(r.get("startedAt")) for r in kv[1])):
        revs = sorted({(r.get("run") or {}).get("revision") for r in mine if (r.get("run") or {}).get("revision")})
        out.append((f"rec-{model}-{effort}-{opp}", f"recorded: {model}, effort {effort} (recorded)",
                    f"--model {model}; --effort {effort}; budget ${budget}; {opp} opportunities; curtain {'raised' if curtain else 'left'}; revisions {', '.join(str(x) for x in revs) or 'unrecorded'}", mine))
    return out


def reading(sections: list[tuple[str, str, str, dict]], ages: dict[str, dict[str, dict]]) -> list[str]:
    """The conclusions, computed from the cohorts shown. Compares the age with data in the most cohorts."""
    common = Counter()
    for key, _, _, _ in sections:
        for age, a in ages.get(key, {}).items():
            if a["turnEnded"] >= 5:
                common[age] += 1
    if not common:
        return ["- Too few ended turns share an age across cohorts for a like-for-like comparison."]
    age = max(common, key=lambda k: (common[k], k))
    lines = [f"- Like-for-like comparison within the **{age}** age (the age with at least 5 ended turns in the most cohorts):"]
    base = None
    for key, title, _, s in sections:
        a = ages.get(key, {}).get(age)
        if not a or a["turnEnded"] < 5:
            continue
        rep = a["representative"]
        lines.append(f"  - {title}: {a['turnEnded']} ended turns, median {fmt(a['durationMedian'])} s, {fmt(a['receiptsPerTurn'])} receipts and {fmt(a['distinctKindsPerTurn'])} distinct kinds per turn, "
                     f"{fmt(a['costMean'])} $ mean; most varied turns {', '.join(f'`{t}`' for t in rep['mostKinds'] if t)}; least varied {', '.join(f'`{t}`' for t in rep['fewestKinds'] if t)}.")
        if base is None:
            base = (title, a)
        elif base[1]["durationMedian"] and a["durationMedian"]:
            ratio_t = a["durationMedian"] / base[1]["durationMedian"]
            ratio_r = (a["receiptsPerTurn"] or 0) / base[1]["receiptsPerTurn"] if base[1]["receiptsPerTurn"] else None
            lines.append(f"    Against {base[0]}: median duration x{ratio_t:.2f}" + (f", receipts per turn x{ratio_r:.2f}" if ratio_r else "") + ".")
    lines.append("- Throughput (complete rounds per wall-clock hour, failures and restarts included), all ages: " +
                 "; ".join(f"{title} {fmt(s['roundsPerHour'])} ({s['completeRounds']} complete, {s['incompleteRounds']} incomplete, {s['unknownMembership']} with unknown membership)" for _, title, _, s in sections) + ".")
    lines.append("- Unknown outcomes per ended turn: " + "; ".join(f"{title} {s['unknowns']}/{s['turnEnded']}" for _, title, _, s in sections) +
                 ". Each is listed below with the kind and the lesson its repair was recorded under; a row marked \"no lesson found\" is an unexplained unknown.")
    lines.append("- **Decision: keep Stage 1** (replacement prompt, effort flag, bounded opportunity check) on the numbers above; effort is an operator setting. "
                 "The cohorts differ in age, empire size and harness revision, so no difference is attributed to the prompt or effort alone. A defence or commitment "
                 "quality assessment needs a reviewer reading the representative turns' transcripts; this report names them and does not judge them.")
    return lines


def fmt(v, unit=""):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.1f}{unit}" if abs(v) >= 10 else f"{v:.2f}{unit}"
    return f"{v}{unit}"


def render(sections: list[tuple[str, str, str, dict]], ages: dict[str, dict[str, dict]], unknowns: list[dict]) -> str:
    out = ["# Stage 1 performance report", "",
           "Generated by `tools/stage1_report.py` from `runs/agent-game/log.jsonl`, the per-turn system prompts, the host's seat journals and the contract lessons. Descriptive only: "
           "the cohorts differ in age, settlement counts, unit counts and the harness revision, so differences are not attributed to the prompt or the effort setting alone. "
           "A cohort marked *recorded* groups rows by the settings the driver wrote into each row; one marked *inferred* is a date period whose settings come from the repository history "
           "and the operator's commands. A round is complete when every seat evidenced as active at that turn of that age ended it; turns with fewer than two evidenced seats are "
           "reported as unknown membership, not counted.", "",
           "## Cohorts", "", "| cohort | settings | seat turns | ended | rounds complete / incomplete / unknown membership | wall hours | rounds/hour |", "|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {settings} | {s['seatTurns']} | {s['turnEnded']} | {s['completeRounds']} / {s['incompleteRounds']} / {s['unknownMembership']} | {fmt(s['wallHours'])} | {fmt(s['roundsPerHour'])} |")
    out += ["", "## Seat-turn duration and cost (ended turns)", "", "| cohort | median s | mean s | p90 s | max s | mean s incl. failures | median $ | mean $ |", "|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {fmt(s['durationMedian'])} | {fmt(s['durationMean'])} | {fmt(s['durationP90'])} | {fmt(s['durationMax'])} | {fmt(s['allTurnsMean'])} | {fmt(s['costMedian'])} | {fmt(s['costMean'])} |")
    out += ["", "Subscription charges are not the transcript's `total_cost_usd`; the dollar columns are the client's own estimate per turn.", "",
            "## Work per turn and quality signals", "", "| cohort | tool calls | briefs | receipts | distinct kinds | turns with a move or explore | prompt bytes (median, n) | unknown | not ended / error | paused | friction |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {fmt(s['toolsPerTurn'])} | {fmt(s['briefsPerTurn'])} | {fmt(s['receiptsPerTurn'])} | {fmt(s['distinctKindsPerTurn'])} | {fmt((s['scoutingShare'] or 0) * 100, '%')} | {fmt(s['promptBytesMedian'])} ({s['promptSamples']}) | {s['unknowns']} | {s['notEnded']} | {s['pauses']} | {s['frictionEntries']} |")
    out += ["", "## By age", "", "| cohort | age | ended turns | median s | mean s | mean $ | tool calls | receipts |", "|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        for age, a in sorted(ages.get(key, {}).items()):
            out.append(f"| {title} | {age} | {a['turnEnded']} | {fmt(a['durationMedian'])} | {fmt(a['durationMean'])} | {fmt(a['costMean'])} | {fmt(a['toolsPerTurn'])} | {fmt(a['receiptsPerTurn'])} |")
    out += ["", "## Reading and decision", "", *reading(sections, ages), ""]
    out += ["", "## Unknown outcomes, one by one", "", "| seat turn | kind (from the seat journal) | request ids | lesson | how matched |", "|---|---|---|---|---|"]
    for u in unknowns:
        out.append(f"| `{u['tag']}` | {', '.join(f'`{k}`' for k in u['kinds'])} | {', '.join(f'`{r}`' for r in u['requestIds'])} | {'; '.join(u['lessons'])} | {u['match']} |")
    if not unknowns:
        out.append("| — | — | — | none in the log | — |")
    unexplained = sum(1 for u in unknowns if u["match"] == "none")
    out.append("")
    out.append(f"{len(unknowns)} unknown-outcome seat turns; {len(unknowns) - unexplained} matched to a recorded lesson by turn or kind, {unexplained} with no lesson found. "
               "A match by turn or kind is a pointer to the repair record, not proof that the repair explains that row.")
    out += ["", "## Tool and receipt mix", ""]
    for key, title, settings, s in sections:
        out.append(f"- **{title}** tools: " + ", ".join(f"`{k}` {v}" for k, v in s["toolMix"].items()))
        out.append(f"  receipts: " + ", ".join(f"`{k}` {v}" for k, v in s["receiptMix"].items()))
    return "\n".join(out) + "\n"


def build(rows: list[dict], journals: Path | None = JOURNALS, lessons_path: Path | None = LESSONS) -> str:
    sections, ages = [], {}
    for key, title, settings, mine in cohorts(rows):
        sections.append((key, title, settings, summarize(mine)))
        by_age: dict[str, list[dict]] = defaultdict(list)
        for r in mine:
            age, recorded = age_of(r)
            by_age[age if recorded else "antiquity (inferred by turn number)"].append(r)
        ages[key] = {age: summarize(rs) for age, rs in by_age.items()}
    return render(sections, ages, unknown_table(rows, journals, lessons_path))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=Path, default=LOG)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--journals", type=Path, default=JOURNALS)
    args = ap.parse_args()
    report = build(load(args.log), args.journals, LESSONS)
    args.out.write_text(report, encoding="utf-8")
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
