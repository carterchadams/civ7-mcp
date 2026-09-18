"""The agent-game driver's command construction and turn instructions.

The driver is a demo script rather than a package module, so it is loaded by path. Nothing here
starts a model, opens a game session or touches live state: it inspects the command that would be
run and the instructions that would be sent.
"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

DRIVER = Path(__file__).resolve().parents[1] / "demo" / "agent-game.py"


@pytest.fixture(scope="module")
def driver():
    spec = importlib.util.spec_from_file_location("agent_game_driver", DRIVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_the_seat_prompt_replaces_the_coding_prompt_rather_than_appending_to_it(driver):
    """Appending left the seat being Claude Code first and a player second: asked to follow an
    appended instruction it disagreed with, the client said so and ignored it."""
    source = DRIVER.read_text(encoding="utf-8")
    assert '"--system-prompt-file", str(system_path)' in source
    assert "--append-system-prompt-file" not in source
    # exactly one system-prompt mechanism reaches the client
    assert source.count("system-prompt") == 1


def test_the_driver_names_an_effort_level_and_can_be_told_to_omit_it(driver):
    parser_source = DRIVER.read_text(encoding="utf-8")
    assert '"--effort", default="medium"' in parser_source
    assert '*(("--effort", effort) if effort else ())' in parser_source
    assert '"low", "medium", "high", "xhigh", "max", "default"' in parser_source


def test_the_turn_instructions_ask_for_one_bounded_opportunity_check_not_bare_minimum_play(driver):
    text = driver.INSTRUCTIONS
    assert "one bounded check" in text
    for topic in ("scouting", "Independent Power", "Influence"):
        assert topic in text, f"the opportunity check must name {topic}"
    # the pause and offered-id rules survive the rewrite
    assert "`pause`" in text and "Never invent one" in text
    # and the seat is told the reconsideration bar, so it does not churn its plan
    assert "not merely because alternatives exist" in text


def test_the_instructions_stand_alone_now_that_the_default_prompt_is_gone(driver):
    text = driver.INSTRUCTIONS
    assert "no shell and no network" in text and "session directory" in text


def test_the_denied_tool_list_still_covers_the_shell_and_network_surface(driver):
    """Replacing the prompt is not permission enforcement; the flags still are. File tools are no
    longer denied outright: they are confined to the session directory by path-scoped rules."""
    for tool in ("Bash", "WebFetch", "WebSearch", "Task"):
        assert tool in driver.DENIED


def test_the_seat_gets_file_tools_confined_to_its_own_session_directory(driver):
    """Reads and writes anywhere else are refused by the client's path-scoped rules (verified live);
    the shell, the network and subagents stay denied outright."""
    source = DRIVER.read_text(encoding="utf-8")
    assert driver.FILE_TOOLS == ("Read", "Write", "Edit", "Glob", "Grep")
    assert '"--tools", ",".join(FILE_TOOLS)' in source
    assert "*session.permission_rules()" in source
    assert '"--add-dir", str(session.dir)' in source
    assert "cwd=session.dir" in source
    for tool in ("Bash", "WebFetch", "WebSearch", "Task"):
        assert tool in driver.DENIED
    for tool in driver.FILE_TOOLS:
        assert tool not in driver.DENIED


def test_the_game_tools_are_the_whole_mcp_surface_and_the_plan_comes_from_the_session(driver):
    assert "get_plan" not in driver.TOOLS and "update_plan" not in driver.TOOLS
    assert "report_friction" not in driver.TOOLS and "load_skill" not in driver.TOOLS
    source = DRIVER.read_text(encoding="utf-8")
    assert "session.plan_text()" in source
    assert "PLAN.md" in driver.INSTRUCTIONS and "FRICTION.md" in driver.INSTRUCTIONS
    assert "report_friction" not in driver.INSTRUCTIONS and "get_plan" not in driver.INSTRUCTIONS


def test_the_driver_injects_operator_directives_read_fresh_each_turn(driver):
    source = DRIVER.read_text(encoding="utf-8")
    assert '"--directives"' in source
    assert "operator_directives(state_dir() / \"sessions\")" in source
    assert "directives=directives, testing=" in source
    assert 'summary["directives"] = bool(directives)' in source


def test_the_driver_injects_testing_opportunities_and_grades_them_by_receipts(driver):
    source = DRIVER.read_text(encoding="utf-8")
    assert "ledger.opportunities(seat, offered, limit=opportunities)" in source and '"--test-opportunities"' in source
    assert "testing=TestLedger.note(cases)" in source
    assert "ledger.record_receipts(seat, rows, turn=turn)" in source, "passes come from receipts, not from the report"


# ---- recovery and controller acceptance (work package E): the driver's own guarantees, with stubs

def test_only_one_controller_owns_the_seats_however_two_starts_interleave(driver, tmp_path):
    import multiprocessing as mp
    lock = tmp_path / "driver.lock"
    ctx = mp.get_context("fork")
    barrier, queue = ctx.Barrier(2), ctx.Queue()

    def race():
        barrier.wait(timeout=5)   # both processes go for the lock at once
        try:
            c = driver.acquire_controller(lock, seats=[0, 1])
            queue.put({"acquired": c.record["pid"]})
            barrier.wait(timeout=5)   # the winner keeps holding while the loser reports
            c.release()
        except RuntimeError as exc:
            queue.put({"refused": str(exc)})
            try:
                barrier.wait(timeout=5)
            except Exception:
                pass
    workers = [ctx.Process(target=race) for _ in range(2)]
    for w in workers:
        w.start()
    results = [queue.get(timeout=10) for _ in workers]
    for w in workers:
        w.join(timeout=5)
    assert sum(1 for r in results if "acquired" in r) == 1 and sum(1 for r in results if "refused" in r) == 1, results
    assert "owns the seats" in next(r["refused"] for r in results if "refused" in r)


def test_a_dead_holder_releases_the_lock_and_a_release_never_clears_another_controllers_record(driver, tmp_path):
    import multiprocessing as mp
    lock = tmp_path / "driver.lock"
    ctx = mp.get_context("fork")
    ready = ctx.Event()

    def hold_then_die():
        driver.acquire_controller(lock, seats=[2])
        ready.set()
        os._exit(0)   # no release: the process simply dies holding the lock
    p = ctx.Process(target=hold_then_die)
    p.start()
    assert ready.wait(timeout=5)
    p.join(timeout=5)
    mine = driver.acquire_controller(lock, seats=[3])
    assert json.loads(lock.read_text())["seats"] == [3], "a dead holder's lock is simply free"
    # a second controller object in this process is refused while the first holds
    with pytest.raises(RuntimeError):
        driver.acquire_controller(lock, seats=[3])
    other = driver.Controller(lock)
    other.release()   # a controller that never acquired releases nothing
    assert json.loads(lock.read_text())["seats"] == [3]
    driver.release_controller(mine)
    driver.release_controller(mine)   # twice is harmless
    assert driver.acquire_controller(lock, seats=[0]).record["seats"] == [0]


def test_a_stop_file_is_honoured_once_at_a_boundary(driver, tmp_path):
    stop = tmp_path / "driver.stop"
    assert driver.stop_requested(stop) is False
    stop.write_text("")
    assert driver.stop_requested(stop) is True and not stop.exists()
    assert driver.stop_requested(stop) is False


def test_outcomes_are_named_and_an_unknown_receipt_outranks_everything(driver):
    c = driver.classify_outcome
    assert c(exit_code=0, timed_out=False, ended=True, unknown=[], result_msg={"subtype": "success"}) == ("turn_ended", None)
    assert c(exit_code=0, timed_out=False, ended=True, unknown=["r-1"], result_msg=None)[0] == "unknown_outcome"
    assert c(exit_code=-1, timed_out=True, ended=False, unknown=[], result_msg=None)[0] == "timeout"
    assert c(exit_code=1, timed_out=False, ended=False, unknown=[], result_msg={"subtype": "error_max_budget_usd"})[0] == "budget_exhausted"
    assert c(exit_code=1, timed_out=False, ended=False, unknown=[], result_msg={"subtype": "error_max_turns"})[0] == "turn_cap"
    assert c(exit_code=3, timed_out=False, ended=False, unknown=[], result_msg=None) == ("error", "the client exited with 3")
    assert c(exit_code=0, timed_out=False, ended=False, unknown=[], result_msg={"subtype": "success"})[0] == "not_ended"


def _stub(tmp_path, body: str) -> Path:
    p = tmp_path / "stub-claude"
    p.write_text("#!/bin/sh\n" + body)
    p.chmod(0o755)
    return p


def test_the_child_runner_reports_exit_codes_and_kills_a_hung_client(driver, tmp_path):
    ok = _stub(tmp_path, 'echo \'{"type":"result","subtype":"success","result":"done"}\'\nexit 0\n')
    code, err, timed_out = driver.run_child([str(ok)], transcript=tmp_path / "t1.jsonl", timeout=5, env=dict(os.environ), cwd=tmp_path)
    assert (code, timed_out) == (0, False) and json.loads((tmp_path / "t1.jsonl").read_text())["result"] == "done"
    bad = _stub(tmp_path, 'echo "boom" 1>&2\nexit 7\n')
    code, err, timed_out = driver.run_child([str(bad)], transcript=tmp_path / "t2.jsonl", timeout=5, env=dict(os.environ), cwd=tmp_path)
    assert (code, timed_out) == (7, False) and "boom" in err
    hung = _stub(tmp_path, 'echo \'{"type":"assistant"}\'\nsleep 30\n')
    t0 = time.monotonic()
    code, err, timed_out = driver.run_child([str(hung)], transcript=tmp_path / "t3.jsonl", timeout=1, env=dict(os.environ), cwd=tmp_path)
    assert (code, timed_out) == (-1, True) and "timeout after 1" in err and time.monotonic() - t0 < 10
    # what the client managed to write before it was killed stays on disk for the record
    assert '"assistant"' in (tmp_path / "t3.jsonl").read_text()


def test_timing_out_the_client_ends_its_descendants_too(driver, tmp_path):
    pid_file = tmp_path / "descendant.pid"
    program = ("import subprocess,sys,time; from pathlib import Path; "
               "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
               f"Path({str(pid_file)!r}).write_text(str(p.pid)); time.sleep(30)")
    code, err, timed_out = driver.run_child([sys.executable, "-c", program], transcript=tmp_path / "t4.jsonl", timeout=1, env=dict(os.environ), cwd=tmp_path)
    assert (code, timed_out) == (-1, True)
    descendant = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and driver._pid_alive(descendant):
        time.sleep(0.05)
    alive = driver._pid_alive(descendant)
    if alive:
        os.kill(descendant, 9)
    assert not alive, "the client's own children (its MCP servers) must be gone before the driver moves on"


def test_the_main_loop_stops_cleanly_when_the_game_is_gone_or_a_stop_is_requested(driver, tmp_path, monkeypatch):
    monkeypatch.setattr(driver, "context", lambda: (_ for _ in ()).throw(RuntimeError("nothing answering at 9444")))
    monkeypatch.setattr(driver, "RUNS", tmp_path)
    args = type("A", (), {"rounds": 1, "mode": "local-hotseat", "model": "sonnet", "budget_usd": 1.0, "timeout": 5.0, "raise_curtain": False, "effort": None, "directives": None, "test_opportunities": 2})()
    assert driver._run(args, [0, 1], tmp_path / "log.jsonl", tmp_path / "driver.stop") == 2, "a game that went away is a named stop, not a traceback"
    (tmp_path / "driver.stop").write_text("")
    assert driver._run(args, [0, 1], tmp_path / "log.jsonl", tmp_path / "driver.stop") == 0 and not (tmp_path / "driver.stop").exists()
