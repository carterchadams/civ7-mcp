"""Agent-vs-agent hotseat game driver.

Each seat's turn is played by an isolated, non-interactive `claude -p` session whose built-in tool
set is disabled and whose only tools are those of ONE civ7-observer MCP server bound to that seat
(`serve --player N --mode local-hotseat --allow-actions`). The session gets the same assembled
operating prompt the in-process runner gives its model (operating contract, routed skill cards,
friction card, the seat's own plan) and the seat's current brief.

The driver itself never acts on the game: it reads the seat context (read-only), takes the brief
(read-only), launches the session, then reads the seat's journal and friction backlog to report
what happened. It stops at the first pause, error, or turn that did not end, so a human can look.

Usage: python demo/agent-game.py [--seats 0 1 2 3] [--rounds N] [--model sonnet]
Writes runs/agent-game/t<turn>-seat<N>.{system.md,transcript.jsonl,report.txt} and log.jsonl.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from civ7_observer.actions import ActionRegistry
from civ7_observer.attachment import state_dir
from civ7_observer.brief import build_brief
from civ7_observer.curtain import tidy
from civ7_observer.runner import assemble_system_prompt
from civ7_observer.server import default_journal
from civ7_observer.service import open_game_session
from civ7_observer.workspace import Workspace

PY = sys.executable
ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs" / "agent-game"
SERVER = "civ7"
TOOLS = ("get_turn_brief", "list_actions", "get_unit_options", "perform_action", "get_action_result", "get_observation",
         "load_skill", "get_plan", "update_plan", "report_friction")

INSTRUCTIONS = """You are playing one seat of a Civilization VII game through the civ7 MCP tools. You control \
only that seat; nothing else is reachable, and every fact you have belongs to it.

Play this turn: read the brief, resolve the decision it marks required, read the brief again, and \
repeat until endTurn.canStart is true, then perform the end_turn action. Stop immediately if the \
brief sets `pause` and report it.

Choose only action ids the host has offered you in this turn. Never invent one, and never repeat an \
action whose receipt was an error or unknown. If a tool or a fact you need is missing, call \
report_friction rather than guessing, then continue with the least committal legal option if you \
can. get_observation is large: call it only when a specific decision needs map detail, and use \
get_unit_options(unit_id) rather than list_actions when you need one unit's choices.

Keep a short plan across turns with get_plan / update_plan (at most three commitments). Keep your \
visible output short: a line per decision saying what you chose and why, and a closing summary under \
150 words. The skill cards below are your procedures; the rest of the catalog can be loaded on demand."""


def context():
    """Read-only: who is seated and what turn it is."""
    with open_game_session(port=9444, timeout=5) as gs:
        c = gs.context
        return {"turn": c.turn, "age": c.age, "localPlayerId": c.local_player_id, "localObserverId": c.local_observer_id, "match": c.game_guid}


def brief_for(seat: int, mode: str) -> dict:
    """Read-only: the brief the session will start from, through the seat's own journal so the
    offer ids stay valid inside the MCP server (same sidecar, same turn, same generation)."""
    registry = ActionRegistry(journal_path=default_journal(seat))
    with open_game_session(port=9444, timeout=5) as gs:
        return build_brief(gs, registry, player=seat, mode=mode)


def mcp_config(seat: int, mode: str) -> Path:
    path = RUNS / f"mcp-seat{seat}.json"
    path.write_text(json.dumps({"mcpServers": {SERVER: {"type": "stdio", "command": PY,
                                                          "args": ["-m", "civ7_observer", "serve", "--player", str(seat), "--mode", mode, "--allow-actions"]}}}, indent=2))
    return path


def clean_env() -> dict[str, str]:
    """A child claude session must not think it is nested inside this one."""
    return {k: v for k, v in os.environ.items() if not (k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_") or k == "CLAUDE_PID")}


def journal_rows(seat: int) -> list[dict]:
    path = default_journal(seat)
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def tidy_curtains(*, raise_curtain: bool) -> dict:
    """UI only: drop stale curtain instances (or all of them when watching) and confirm the advisor popup."""
    with open_game_session(port=9444, timeout=5) as gs:
        return tidy(gs, mode="raise" if raise_curtain else "prune")


def play_seat(seat: int, *, mode: str, model: str, budget: float, timeout: float, raise_curtain: bool = False) -> dict:
    ctx = context()
    turn = ctx["turn"]
    tag = f"t{turn}-seat{seat}"
    summary: dict = {"seat": seat, "turn": turn, "match": ctx["match"], "tag": tag, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if ctx["localPlayerId"] != seat or ctx["localObserverId"] != seat:
        return {**summary, "status": "wrong_seat", "context": ctx}
    try:
        summary["curtain"] = tidy_curtains(raise_curtain=raise_curtain)
    except Exception as exc:  # noqa: BLE001 - a UI tidy-up failure must not stop the seat
        summary["curtain"] = {"error": str(exc)}

    brief = brief_for(seat, mode)
    if brief.get("pause"):
        return {**summary, "status": "paused", "pause": brief["pause"], "brief": brief}
    workspace = Workspace(root=state_dir() / "workspace", seat=seat)
    friction_before = len(workspace.friction())
    journal_before = len(journal_rows(seat))
    system = assemble_system_prompt(brief, workspace, instructions=INSTRUCTIONS)
    system_path = RUNS / f"{tag}.system.md"
    system_path.write_text(system, encoding="utf-8")
    transcript = RUNS / f"{tag}.transcript.jsonl"
    prompt = f"Play this turn for seat {seat}. Current brief:\n\n{json.dumps(brief, ensure_ascii=False)}"

    cmd = ["claude", "-p", prompt, "--model", model, "--tools", "",
           "--mcp-config", str(mcp_config(seat, mode)), "--strict-mcp-config",
           "--allowedTools", *[f"mcp__{SERVER}__{t}" for t in TOOLS],
           "--append-system-prompt-file", str(system_path),
           "--max-budget-usd", str(budget),
           "--output-format", "stream-json", "--verbose"]
    t0 = time.monotonic()
    with open(transcript, "w", encoding="utf-8") as out:
        try:
            proc = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, text=True, env=clean_env(), timeout=timeout, cwd=ROOT)
            exit_code, stderr = proc.returncode, proc.stderr[-2000:]
        except subprocess.TimeoutExpired as exc:
            exit_code, stderr = -1, f"timeout after {timeout}s: {str(exc.stderr or '')[-1000:]}"
    elapsed = round(time.monotonic() - t0, 1)

    result_msg, tool_calls, init = None, [], None
    for line in transcript.read_text(encoding="utf-8").splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("type") == "result":
            result_msg = msg
        elif msg.get("type") == "system" and msg.get("subtype") == "init":
            init = {"tools": msg.get("tools"), "mcp_servers": msg.get("mcp_servers")}
        elif msg.get("type") == "assistant":
            for block in (msg.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    tool_calls.append(block.get("name"))
    report = (result_msg or {}).get("result") or ""
    (RUNS / f"{tag}.report.txt").write_text(report, encoding="utf-8")

    rows = journal_rows(seat)[journal_before:]
    receipts = [{"kind": r.get("kind"), "status": r.get("status"), "requestId": r.get("requestId")} for r in rows if r.get("status") != "pending"]
    ended = any(r.get("kind") == "END_TURN" and r.get("status") == "confirmed" and r.get("turn") == turn for r in rows)
    unknown = [r["requestId"] for r in rows if r.get("status") == "unknown"]
    friction = workspace.friction()[friction_before:]
    after = context()
    counts: dict[str, int] = {}
    for name in tool_calls:
        counts[name] = counts.get(name, 0) + 1
    status = "turn_ended" if ended else ("error" if exit_code != 0 else "not_ended")
    if unknown:
        status = "unknown_outcome"
    return {**summary, "status": status, "exitCode": exit_code, "elapsedS": elapsed, "toolCalls": counts,
            "receipts": receipts, "friction": friction, "unknown": unknown, "report": report,
            "costUsd": (result_msg or {}).get("total_cost_usd"), "numTurns": (result_msg or {}).get("num_turns"),
            "isError": (result_msg or {}).get("is_error"), "stderr": stderr if exit_code != 0 else "",
            "init": init, "contextAfter": after}


def wait_for_seat_change(seat: int, turn: int, *, seconds: float = 20.0) -> dict:
    deadline = time.monotonic() + seconds
    ctx = context()
    while time.monotonic() < deadline and (ctx["localPlayerId"], ctx["turn"]) == (seat, turn):
        time.sleep(1.0)
        ctx = context()
    return ctx


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seats", type=int, nargs="+", default=[0, 1, 2, 3])
    ap.add_argument("--from-current", action="store_true",
                    help="rotate the seat list so the round starts at whichever seat the game currently has active "
                         "(so a restart after a stop is always the same command)")
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--mode", default="local-hotseat")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--budget-usd", type=float, default=1.5, help="per seat-turn spend cap passed to claude")
    ap.add_argument("--timeout", type=float, default=1200.0, help="per seat-turn wall clock cap in seconds")
    ap.add_argument("--raise-curtain", action="store_true", help="remove the hotseat curtain before each seat turn so play can be watched (default: only stale curtains are pruned)")
    args = ap.parse_args()
    RUNS.mkdir(parents=True, exist_ok=True)
    log = RUNS / "log.jsonl"
    seats = list(args.seats)
    if args.from_current:
        live = context()["localPlayerId"]
        if live in seats:
            i = seats.index(live)
            seats = seats[i:] + seats[:i]
            print(f"starting at the live seat {live}: {seats}", flush=True)
        else:
            print(f"the live seat is {live}, which is not in {seats}; nothing to play", flush=True)
            return 1

    for round_no in range(args.rounds):
        for seat in seats:
            res = play_seat(seat, mode=args.mode, model=args.model, budget=args.budget_usd, timeout=args.timeout, raise_curtain=args.raise_curtain)
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(res, ensure_ascii=False) + "\n")
            cur = res.get("curtain") or {}
            line = (f"[{res['tag']}] {res['status']}"
                    + (f" (curtains {cur.get('curtainsBefore')}->{cur.get('curtainsAfter')}" + (", advisor popup confirmed" if (cur.get('advisorPopup') or {}).get('confirmed') else "") + ")" if cur and "curtainsBefore" in cur else "")
                    + (f" in {res['elapsedS']}s, ${res.get('costUsd') or 0:.2f}, tools {res['toolCalls']}, receipts "
                       f"{[(r['kind'], r['status']) for r in res['receipts']]}, friction {len(res['friction'])}" if "elapsedS" in res else ""))
            print(line, flush=True)
            for fr in res.get("friction", []):
                print(f"    friction/{fr['kind']}: {fr['goal']} -> needs {fr['needed']}", flush=True)
            if res["status"] != "turn_ended":
                print(json.dumps({k: v for k, v in res.items() if k in ("status", "pause", "context", "stderr", "isError", "report", "unknown", "contextAfter")}, indent=2, ensure_ascii=False)[:4000])
                return 1
            nxt = wait_for_seat_change(seat, res["turn"])
            if (nxt["localPlayerId"], nxt["turn"]) == (seat, res["turn"]):
                print(f"    seat did not change after the confirmed end turn: {nxt}")
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
