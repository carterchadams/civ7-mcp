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
import fcntl
import json
import os
import signal
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
from civ7_observer.session import SeatSession, operator_directives
from civ7_observer.testing import TestLedger

PY = sys.executable
ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs" / "agent-game"
SERVER = "civ7"
TOOLS = ("get_turn_brief", "list_actions", "get_unit_options", "get_city_options", "perform_action", "get_action_result",
         "get_observation")
# The seat gets the client's file tools, confined by path-scoped rules to its own session directory
# (see SeatSession.permission_rules: reads and writes anywhere else are refused, verified live). No
# shell, no network, no subagents: a seat that could run a command could read another seat's mind.
FILE_TOOLS = ("Read", "Write", "Edit", "Glob", "Grep")
DENIED = ("Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite")

INSTRUCTIONS = """You are playing one seat of a Civilization VII game through the civ7 MCP tools. You control \
only that seat; nothing else is reachable, and every fact you have belongs to it.

Play this turn: read the brief, resolve the decision it marks required, read the brief again, and \
repeat until endTurn.canStart is true, then perform the end_turn action. Stop immediately if the \
brief sets `pause` and report it.

Resolve mandatory choices and follow the commitments already in your plan. Before ending, make one \
bounded check for useful scouting, known reward tiles, Independent Power threats or opportunities, \
and worthwhile Influence spending. Reconsider the plan when a threat, discovery, unlock, completed \
project, diplomatic event or Age transition changes it, not merely because alternatives exist. \
Choose a satisfactory routine action after a short comparison, and spend your attention instead on \
combat, settlement placement, major spending and diplomacy. Read the brief again when the facts \
relevant to your next choice have changed.

Choose only action ids the host has offered you in this turn. Never invent one, and never repeat an \
action whose receipt was an error or unknown. If a tool or a fact you need is missing, append an \
entry to FRICTION.md (the format is in its README) rather than guessing, then continue with the \
least committal legal option if you can. get_observation is large: call it only when a specific \
decision needs map detail, and use get_unit_options(unit_id) or get_city_options(city_id) rather \
than list_actions when you need one unit's or one settlement's choices.

Your working directory is your own session directory, and it is the only place on this machine you \
can read or write. PLAN.md there is your canonical plan: keep it short (the commitments you are \
pursuing, what each needs next, what would make you drop it) and keep it current, because its \
contents are placed in these instructions at the start of every turn and nothing else carries over. \
Update it when its contents change, not every turn. The skill cards below are your procedures; every \
other card is a file under skills/ that you can read when a decision is outside them.

Report strategic changes, missing capabilities and exceptions, and do not narrate routine moves. \
Finish with at most three short bullets. You have no shell and no network: the civ7 tools reach the \
game, your session directory holds your memory, and nothing else is yours to touch."""


def context(attempts: int = 40):
    """Read-only: who is seated and what turn it is.

    Right after a confirmed end turn the game is handing the seat over, so the context legitimately
    changes between the doctor probe and the session open. Retry rather than treating it as a fault.
    """
    last: Exception | None = None
    for i in range(attempts):
        try:
            with open_game_session(port=9444, timeout=5) as gs:
                c = gs.context
                return {"turn": c.turn, "age": c.age, "localPlayerId": c.local_player_id, "localObserverId": c.local_observer_id, "match": c.game_guid}
        except Exception as exc:  # noqa: BLE001 - a handoff in progress is expected here
            last = exc
            time.sleep(0.5 * (i + 1))
    raise last


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


# ---- controller ownership and stops. One driver at a time owns the seats it plays: two drivers would
# each pass per-action checks and still race over whose turn it is. The lock is the driver's own, held
# for its whole run, and separate from the short-lived game-action lock the registry takes per write.
CONTROLLER_LOCK = "driver.lock"
STOP_FILE = "driver.stop"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Controller:
    """Ownership of the seats for one driver run: an OS advisory lock on the lock file, held open for
    the run's lifetime. Two processes cannot both hold it however they interleave (the kernel decides),
    a holder that dies releases it on its own, and the record inside names the holder for a human."""

    def __init__(self, path: Path, *, seats: list[int] | None = None) -> None:
        self.path, self.seats, self.fd, self.record = path, list(seats or []), None, None

    def acquire(self) -> dict:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            held = ""
            try:
                held = os.read(fd, 4096).decode("utf-8", errors="replace")
            except OSError:
                pass
            os.close(fd)
            try:
                who = json.loads(held) if held.strip() else {}
            except ValueError:
                who = {"record": held[:200]}
            raise RuntimeError(f"another driver owns the seats ({who.get('pid', 'unknown pid')}, started {who.get('startedAt', '?')}); stop it at a boundary first")
        self.fd = fd
        self.record = {"pid": os.getpid(), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seats": self.seats}
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, json.dumps(self.record).encode("utf-8"))
        return self.record

    def release(self) -> None:
        if self.fd is None:
            return
        try:
            os.ftruncate(self.fd, 0)
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)
            self.fd = None


def acquire_controller(path: Path, *, seats: list[int] | None = None) -> Controller:
    """Take the controller lock or raise RuntimeError naming the live holder."""
    c = Controller(path, seats=seats)
    c.acquire()
    return c


def release_controller(controller: Controller) -> None:
    controller.release()


def stop_requested(path: Path) -> bool:
    """An operator asks for a stop at the next seat boundary by creating the stop file; it is consumed."""
    if path.exists():
        path.unlink()
        return True
    return False


def _end_group(proc: subprocess.Popen, *, grace: float = 3.0) -> None:
    """Terminate the client and everything it started (its MCP servers included): the client runs as
    the leader of its own process group, so the whole tree is addressed at once. TERM, a grace, KILL."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass


def run_child(cmd: list[str], *, transcript: Path, timeout: float, env: dict[str, str], cwd: Path) -> tuple[int, str, bool]:
    """Run one seat's client process as its own process group. Returns (exit code, stderr tail, timed
    out). On a timeout, or on the driver being interrupted, the client AND its descendants are ended
    before this returns; -1 is the exit code for a timeout. Whatever the client dispatched before that
    is on its journal and reconciled through the usual barrier, never resent."""
    with open(transcript, "w", encoding="utf-8") as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.PIPE, text=True, env=env, cwd=cwd, start_new_session=True)
        try:
            _, err = proc.communicate(timeout=timeout)
            return proc.returncode, (err or "")[-2000:], False
        except subprocess.TimeoutExpired:
            _end_group(proc)
            err = ""
            try:
                err = (proc.stderr.read() if proc.stderr else "") or ""
            except (OSError, ValueError):
                pass
            return -1, f"timeout after {timeout}s: {err[-1000:]}", True
        except BaseException:
            _end_group(proc)
            raise


def classify_outcome(*, exit_code: int, timed_out: bool, ended: bool, unknown: list, result_msg: dict | None) -> tuple[str, str | None]:
    """The named outcome of a seat turn and why it stopped. An unknown receipt outranks everything:
    the barrier must be reconciled before any seat acts again."""
    subtype = (result_msg or {}).get("subtype")
    if unknown:
        return "unknown_outcome", "an action's outcome is unknown; reconcile before continuing"
    if ended:
        return "turn_ended", None
    if timed_out:
        return "timeout", "the client did not finish within the wall-clock cap"
    if isinstance(subtype, str) and "budget" in subtype:
        return "budget_exhausted", f"the client stopped at the spend cap ({subtype})"
    if isinstance(subtype, str) and "max_turns" in subtype:
        return "turn_cap", f"the client stopped at its turn cap ({subtype})"
    if exit_code != 0:
        return "error", f"the client exited with {exit_code}"
    return "not_ended", "the client returned without ending the turn"


def _revision() -> str | None:
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=5).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def journal_rows(seat: int) -> list[dict]:
    path = default_journal(seat)
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def tidy_curtains(*, raise_curtain: bool) -> dict:
    """UI only: drop stale curtain instances (or all of them when watching) and confirm the advisor popup."""
    with open_game_session(port=9444, timeout=5) as gs:
        return tidy(gs, mode="raise" if raise_curtain else "prune")


def play_seat(seat: int, *, mode: str, model: str, budget: float, timeout: float, raise_curtain: bool = False,
              effort: str | None = None, directives_path: Path | None = None, opportunities: int = 2) -> dict:
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
    age_type = str((brief.get("context") or {}).get("ageType") or "")
    if age_type.startswith("AGE_") and age_type != "AGE_ANTIQUITY":
        tag = f"{age_type[4:].lower()}-{tag}"
        summary["tag"] = tag
    if brief.get("pause"):
        return {**summary, "status": "paused", "pause": brief["pause"], "brief": brief}
    session = SeatSession(root=state_dir() / "sessions", seat=seat)
    session.prepare()
    friction_before = len(session.friction_entries())
    journal_before = len(journal_rows(seat))
    # The operator's standing testing goals, read fresh each turn so an edit lands at the next seat.
    directives = None
    if directives_path is not None:
        directives = directives_path.read_text(encoding="utf-8").strip() or None if directives_path.exists() else None
    else:
        directives = operator_directives(state_dir() / "sessions")
    summary["directives"] = bool(directives)
    # Live-test opportunities: a bounded number of open cases whose kinds this seat is being offered
    # right now (two by default; --test-opportunities raises it for a testing-focused run).
    ledger = TestLedger(ctx["match"])
    offered = {o.get("kind") for d in brief.get("decisions", []) for o in d.get("options", []) if o.get("kind")}
    cases = ledger.opportunities(seat, offered, limit=opportunities)
    summary["testing"] = [c["case_id"] for c in cases]
    system = assemble_system_prompt(brief, session.plan_text(), instructions=INSTRUCTIONS, skills_location=str(session.skills_dir),
                                    directives=directives, testing=TestLedger.note(cases))
    system_path = RUNS / f"{tag}.system.md"
    system_path.write_text(system, encoding="utf-8")
    transcript = RUNS / f"{tag}.transcript.jsonl"
    prompt = f"Play this turn for seat {seat}. Current brief:\n\n{json.dumps(brief, ensure_ascii=False)}"

    cmd = ["claude", "-p", prompt, "--model", model, "--tools", ",".join(FILE_TOOLS),
           "--mcp-config", str(mcp_config(seat, mode)), "--strict-mcp-config",
           "--allowedTools", *[f"mcp__{SERVER}__{t}" for t in TOOLS], *session.permission_rules(),
           "--disallowedTools", *DENIED,
           "--add-dir", str(session.dir),
           # Replaces the default coding prompt instead of appending to it. Appending left the seat
           # being Claude Code first and a player second: asked to follow an appended instruction it
           # conflicted with, the model said so and ignored it (verified against this client).
           "--system-prompt-file", str(system_path),
           "--max-budget-usd", str(budget),
           *(("--effort", effort) if effort else ()),
           "--output-format", "stream-json", "--verbose"]
    t0 = time.monotonic()
    exit_code, stderr, timed_out = run_child(cmd, transcript=transcript, timeout=timeout, env=clean_env(), cwd=session.dir)
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
    # Passing is decided by receipts, never by the agent's narrative.
    summary["testingChanged"] = ledger.record_receipts(seat, rows, turn=turn)
    ledger.aggregate()
    receipts = [{"kind": r.get("kind"), "status": r.get("status"), "requestId": r.get("requestId")} for r in rows if r.get("status") != "pending"]
    ended = any(r.get("kind") == "END_TURN" and r.get("status") == "confirmed" and r.get("turn") == turn for r in rows)
    unknown = [r["requestId"] for r in rows if r.get("status") == "unknown"]
    friction = session.friction_entries()[friction_before:]
    after = context()
    counts: dict[str, int] = {}
    for name in tool_calls:
        counts[name] = counts.get(name, 0) + 1
    status, stop_reason = classify_outcome(exit_code=exit_code, timed_out=timed_out, ended=ended, unknown=unknown, result_msg=result_msg)
    # the settings this turn ran under, so a later comparison never has to guess them (work package F)
    run = {"model": model, "effort": effort, "budgetUsd": budget, "timeoutS": timeout, "raiseCurtain": raise_curtain, "opportunities": opportunities,
           "promptBytes": len(system.encode("utf-8")), "revision": _revision()}
    return {**summary, "status": status, "stopReason": stop_reason, "run": run, "exitCode": exit_code, "elapsedS": elapsed, "toolCalls": counts,
            "receipts": receipts, "friction": friction, "unknown": unknown, "report": report,
            "costUsd": (result_msg or {}).get("total_cost_usd"), "numTurns": (result_msg or {}).get("num_turns"),
            "isError": (result_msg or {}).get("is_error"), "stderr": stderr if exit_code != 0 else "",
            "init": init, "contextAfter": after}


def wait_for_seat_change(seat: int, turn: int, *, seconds: float = 180.0) -> dict:
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
    # a turn cut off by the cap wastes everything it spent (live: $1.56 on turn 85, aborted mid-action)
    ap.add_argument("--budget-usd", type=float, default=2.0, help="per seat-turn spend cap passed to claude")
    ap.add_argument("--timeout", type=float, default=1200.0, help="per seat-turn wall clock cap in seconds")
    ap.add_argument("--test-opportunities", type=int, default=2, help="open live-test cases offered per seat-turn (bounded; raise for a testing-focused run)")
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max", "default"],
                    help="reasoning effort passed to claude for each seat turn; 'default' omits the flag and takes the client's own setting")
    ap.add_argument("--directives", type=Path, default=None,
                    help="operator directives injected at the top of every seat's prompt (default: <state>/sessions/DIRECTIVES.md; read fresh each turn)")
    ap.add_argument("--raise-curtain", action="store_true", help="remove the hotseat curtain before each seat turn so play can be watched (default: only stale curtains are pruned)")
    args = ap.parse_args()
    if args.effort == "default":
        args.effort = None
    RUNS.mkdir(parents=True, exist_ok=True)
    log = RUNS / "log.jsonl"
    seats = list(args.seats)
    lock_path, stop_path = state_dir() / CONTROLLER_LOCK, state_dir() / STOP_FILE
    try:
        controller = acquire_controller(lock_path, seats=seats)
    except RuntimeError as exc:
        print(str(exc), flush=True)
        return 3
    try:
        return _run(args, seats, log, stop_path)
    finally:
        release_controller(controller)


def _run(args, seats: list[int], log: Path, stop_path: Path) -> int:
    # Follow whoever the game has seated rather than a fixed rotation: a civilization can be
    # eliminated mid-game (live: the Russian Empire on turn 69) and the game then skips its seat.
    planned = args.rounds * len(seats)
    played: dict[int, int] = {}
    for _ in range(planned):
        # a seat boundary: the only place a stop is honoured, and the only place a game that has gone
        # away is reported as such rather than as a crash
        if stop_requested(stop_path):
            print("stop requested; stopping at the seat boundary", flush=True)
            return 0
        try:
            live = context()["localPlayerId"]
        except Exception as exc:  # noqa: BLE001 - the game closed or the debugger went away
            print(json.dumps({"status": "game_unavailable", "error": str(exc)[:400]}), flush=True)
            return 2
        if live not in seats:
            print(f"the live seat is {live}, which is not in {seats}; stopping", flush=True)
            return 1
        seat = live
        if True:
            res = play_seat(seat, mode=args.mode, model=args.model, budget=args.budget_usd, timeout=args.timeout,
                            raise_curtain=args.raise_curtain, effort=args.effort, directives_path=args.directives, opportunities=args.test_opportunities)
            played[seat] = played.get(seat, 0) + 1
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(res, ensure_ascii=False) + "\n")
            cur = res.get("curtain") or {}
            line = (f"[{res['tag']}] {res['status']}" + (" [directives]" if res.get("directives") else "")
                    + (f" [test: {','.join(res['testing'])}]" if res.get("testing") else "")
                    + (f" [test-result: {','.join(c['case_id'] + '=' + (c['live_status'] if c.get('result', 'confirmed') == 'confirmed' else c['result']) for c in res['testingChanged'])}]" if res.get("testingChanged") else "")
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
    print(f"played {sum(played.values())} seat turns: {dict(sorted(played.items()))}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
