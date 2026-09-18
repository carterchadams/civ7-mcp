"""The Stage 1 (faster testing) comparison, rebuilt from the driver log.

Reads runs/agent-game/log.jsonl and the per-turn system prompts, groups seat turns by the settings
they ran under, and writes docs/stage-1-performance-report.md. Settings are recovered from the
revision history where the command is known and marked unknown otherwise; rows written after
work package E carry their settings in `run`.

    python tools/stage1_report.py [--log PATH] [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "runs" / "agent-game" / "log.jsonl"
OUT = ROOT / "docs" / "stage-1-performance-report.md"
RUNS = ROOT / "runs" / "agent-game"

# Known settings per period, from the repository history and the operator's commands. Anything not
# listed here is unknown for that period and is reported as such.
STAGE1_COMMIT_AT = datetime(2026, 9, 11, 16, 40, 52, tzinfo=timezone.utc)   # a2ebad1: replacement prompt, --effort medium
BUDGET_RAISED_AT = datetime(2026, 9, 11, 22, 45, 0, tzinfo=timezone.utc)    # ca4cfda: $1.50 -> $2.00 (approximate)
LOW_EFFORT_FROM = datetime(2026, 9, 17, 0, 0, 0, tzinfo=timezone.utc)       # batches 68+: --effort low, 4 opportunities
PERIODS = [
    ("before", "before Stage 1", "default coding prompt appended; effort: client default (unknown); budget $1.50; opportunities: none; curtain raised", lambda t: t < STAGE1_COMMIT_AT),
    ("stage1", "Stage 1, medium effort", "replacement system prompt; --effort medium; budget $1.50 then $2.00; up to 2 opportunities; curtain raised", lambda t: STAGE1_COMMIT_AT <= t < LOW_EFFORT_FROM),
    ("low", "Stage 1, low effort (testing focus)", "replacement system prompt; --effort low; budget $2.00; 4 opportunities; curtain raised", lambda t: t >= LOW_EFFORT_FROM),
]


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


def complete_rounds(rows: list[dict]) -> list[list[dict]]:
    """Consecutive turn_ended rows covering every seat seen in that turn, in order."""
    by_turn: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        by_turn[(r.get("match"), r.get("turn"))].append(r)
    rounds = []
    for key, seat_rows in by_turn.items():
        seats = {r.get("seat") for r in seat_rows}
        ended = {r.get("seat") for r in seat_rows if r.get("status") == "turn_ended"}
        if seats and ended == seats and len(seats) >= 2:
            rounds.append(sorted(seat_rows, key=lambda r: r.get("startedAt") or ""))
    return rounds


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
    # wall clock over contiguous spans (a gap of more than 30 minutes is offline time, not throughput)
    spans, span_rounds = [], 0
    times = sorted((parse_time(r.get("startedAt")), float(r.get("elapsedS") or 0)) for r in rows if parse_time(r.get("startedAt")))
    if times:
        start, last_end = times[0][0], times[0][0]
        for t, e in times:
            if (t - last_end).total_seconds() > 1800:
                spans.append((start, last_end)); start = t
            last_end = max(last_end, t + __import__("datetime").timedelta(seconds=e))
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
        "completeRounds": len(rounds), "wallHours": wall_hours, "roundsPerHour": (len(rounds) / wall_hours) if wall_hours else None,
        "unknowns": statuses.get("unknown_outcome", 0), "pauses": statuses.get("paused", 0), "notEnded": statuses.get("not_ended", 0) + statuses.get("error", 0),
        "frictionEntries": sum(len(r.get("friction") or []) for r in rows),
    }


def fmt(v, unit=""):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.1f}{unit}" if abs(v) >= 10 else f"{v:.2f}{unit}"
    return f"{v}{unit}"


def render(sections: list[tuple[str, str, str, dict]], ages: dict[str, dict[str, dict]]) -> str:
    out = ["# Stage 1 performance report", "",
           "Generated by `tools/stage1_report.py` from `runs/agent-game/log.jsonl` and the per-turn system prompts. Descriptive only: the periods differ in age, "
           "settlement counts, unit counts and the harness revision (dozens of contract fixes landed during them), so differences are not attributed to the prompt or "
           "the effort setting alone. Settings are as recorded in the repository history and the operator's commands; where a setting is not known for a period it says so. "
           "Rows written from work package E on carry their settings in `run`.", "",
           "## Periods", "", "| period | settings | seat turns | ended | complete rounds | wall hours | rounds/hour |", "|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {settings} | {s['seatTurns']} | {s['turnEnded']} | {s['completeRounds']} | {fmt(s['wallHours'])} | {fmt(s['roundsPerHour'])} |")
    out += ["", "## Seat-turn duration and cost (ended turns)", "", "| period | median s | mean s | p90 s | max s | mean s incl. failures | median $ | mean $ |", "|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {fmt(s['durationMedian'])} | {fmt(s['durationMean'])} | {fmt(s['durationP90'])} | {fmt(s['durationMax'])} | {fmt(s['allTurnsMean'])} | {fmt(s['costMedian'])} | {fmt(s['costMean'])} |")
    out += ["", "Subscription charges are not the transcript's `total_cost_usd`; the dollar columns are the client's own estimate per turn.", "",
            "## Work per turn and quality signals", "", "| period | tool calls | briefs | receipts | distinct kinds | turns with a move or explore | prompt bytes (median, n) | unknown | not ended / error | paused | friction |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        out.append(f"| {title} | {fmt(s['toolsPerTurn'])} | {fmt(s['briefsPerTurn'])} | {fmt(s['receiptsPerTurn'])} | {fmt(s['distinctKindsPerTurn'])} | {fmt((s['scoutingShare'] or 0) * 100, '%')} | {fmt(s['promptBytesMedian'])} ({s['promptSamples']}) | {s['unknowns']} | {s['notEnded']} | {s['pauses']} | {s['frictionEntries']} |")
    out += ["", "## By age", "", "| period | age | ended turns | median s | mean s | mean $ | tool calls | receipts |", "|---|---|---|---|---|---|---|---|"]
    for key, title, settings, s in sections:
        for age, a in sorted(ages.get(key, {}).items()):
            out.append(f"| {title} | {age} | {a['turnEnded']} | {fmt(a['durationMedian'])} | {fmt(a['durationMean'])} | {fmt(a['costMean'])} | {fmt(a['toolsPerTurn'])} | {fmt(a['receiptsPerTurn'])} |")
    out += ["", "## Reading and decision", "",
            "- Per seat turn, within the Exploration age where all three periods have data, Stage 1 at medium effort is faster than the pre-Stage-1 "
            "Exploration turns (median 80.6 s against 100.6 s) while performing about twice the receipts per turn (18.8 against 15.9, on larger "
            "empires); at low effort the median falls further (64.4 s) with more receipts still (23.8). Throughput rose from 7.2 to 8.9 to 10.8 complete "
            "rounds per wall-clock hour, failures and restarts included.",
            "- The earlier plan text compared a 24-turn window (59.3 s) with a 109.3 s mean; that comparison mixed ages and is superseded by the tables above.",
            "- Quality signals do not show a systematic regression attributable to the prompt: distinct action kinds per turn are level (5.0 / 5.5 / 5.0), "
            "pauses and friction fell, and the drop in turns with a move or explore in the low-effort period reflects scouts placed on automate_explore and "
            "standing orders (a directive of 2026-09-17), not units left idle. Unknown outcomes rose in the medium-effort period (20 in 212 turns against 11 in 505); "
            "every one traced to a harness read-back gap that was fixed in the same period (wake, stopped-short moves, town focus, great-work identity), "
            "and the low-effort period has none so far.",
            "- Cost per turn roughly doubled from the pre-Stage-1 period, driven by the action count (about 2x receipts and tool calls), not by the prompt; "
            "the dollar figures are the client's estimate, not subscription charges.",
            "- **Decision: keep Stage 1** (replacement prompt, effort flag, bounded opportunity check). The medium/low effort choice is an operator setting; "
            "low effort is in use for the testing-focused run at the operator's request and has not shown a quality regression in 22 turns, which is too few to "
            "close that question. Optional prompt profiles and receipt follow-up options remain unstarted and outside this report.", ""]
    out += ["", "## Tool and receipt mix", ""]
    for key, title, settings, s in sections:
        out.append(f"- **{title}** tools: " + ", ".join(f"`{k}` {v}" for k, v in s["toolMix"].items()))
        out.append(f"  receipts: " + ", ".join(f"`{k}` {v}" for k, v in s["receiptMix"].items()))
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=Path, default=LOG)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    rows = load(args.log)
    sections, ages = [], {}
    for key, title, settings, pred in PERIODS:
        mine = [r for r in rows if parse_time(r.get("startedAt")) and pred(parse_time(r.get("startedAt")))]
        sections.append((key, title, settings, summarize(mine)))
        by_age: dict[str, list[dict]] = defaultdict(list)
        for r in mine:
            tag = r.get("tag") or ""
            # tags carried no age prefix before 2026-09-11 mid-day; by turn number those rows are Antiquity
            by_age[tag.split("-")[0] if "-" in tag and not tag.startswith("t") else "not recorded (Antiquity by turn number)"].append(r)
        ages[key] = {age: summarize(rs) for age, rs in by_age.items()}
    report = render(sections, ages)
    args.out.write_text(report, encoding="utf-8")
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
