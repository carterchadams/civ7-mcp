"""The agent-game driver's command construction and turn instructions.

The driver is a demo script rather than a package module, so it is loaded by path. Nothing here
starts a model, opens a game session or touches live state: it inspects the command that would be
run and the instructions that would be sent.
"""
import importlib.util
import sys
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
    assert "ledger.opportunities(seat, offered)" in source
    assert "testing=TestLedger.note(cases)" in source
    assert "ledger.record_receipts(seat, rows, turn=turn)" in source, "passes come from receipts, not from the report"
