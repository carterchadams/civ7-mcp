"""The runner: one agent turn driven by a model that can only choose among offered actions."""
import json

import pytest

from civ7_observer import runner, service
from civ7_observer.runner import ProviderResponse, ToolCall
from test_actions import CTX, ctx_reply, open_session
from test_brief import RESEARCH, UNITS, offers_with
from test_targets import GAME, Factory, reply, target

PERFORMED = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent",
             "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": 701, "matches": True}}
ENDED = {"payloadVersion": 1, "refused": None, "context": CTX, "outcome": "sent",
         "readback": {"kind": "END_TURN", "arg": 0, "sentComplete": True}}


class FakeProvider:
    """Replays scripted responses and records what it was asked."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def complete(self, *, system, messages, tools):
        self.calls.append({"system": system, "messages": list(messages), "tools": [t["name"] for t in tools]})
        if not self.script:
            return ProviderResponse(text="out of script", tool_calls=[])
        item = self.script.pop(0)
        return item(self) if callable(item) else item


def session_scripts(*payloads):
    """Each tool call opens its own session: doctor, reopened context, then the tool's reads."""
    ctx = json.dumps(GAME)
    out = []
    for payload in payloads:
        out += [reply(1, ctx), reply(1, ctx)] + list(payload)
    return {"a": out}


def make(tmp_path, scripts, provider, **kw):
    f = Factory(scripts)
    r = runner.Runner(
        port=9444, timeout=1, player=1, mode="singleplayer", provider=provider,
        journal_path=tmp_path / "journal.jsonl", sessions_root=tmp_path / "ws",
        discover=lambda p, t: [target("a")], session_factory=f, **kw)
    return r, f


def offers_payload(entries, **kw):
    return [reply(2, json.dumps(offers_with(entries, **kw))), reply(3, json.dumps(GAME))]


def test_a_turn_runs_until_the_turn_is_ended(tmp_path):
    blocked = offers_payload(RESEARCH, end_can_start=False, blocking="RESEARCH")
    unblocked = offers_payload(RESEARCH)
    scripts = session_scripts(blocked,                       # brief 1
                              [reply(2, json.dumps(PERFORMED))],   # perform research
                              unblocked,                     # brief 2
                              [reply(2, json.dumps(ENDED))])       # perform end turn
    provider = FakeProvider([
        lambda p: ProviderResponse(text="", tool_calls=[ToolCall("1", "get_turn_brief", {})]),
        lambda p: ProviderResponse(text="", tool_calls=[ToolCall(
            "2", "perform_action", {"action_id": _first_option(p, "research"), "request_id": "r1"})]),
        lambda p: ProviderResponse(text="", tool_calls=[ToolCall("3", "get_turn_brief", {})]),
        lambda p: ProviderResponse(text="", tool_calls=[ToolCall(
            "4", "perform_action", {"action_id": _end_turn_id(p), "request_id": "r2"})]),
        ProviderResponse(text="Turn ended: chose Pottery, then ended.", tool_calls=[]),
    ])
    r, _ = make(tmp_path, scripts, provider)
    result = r.play_turn()
    assert result.status == "turn_ended"
    assert [a["kind"] for a in result.actions] == ["SET_TECH_TREE_NODE", "END_TURN"]
    assert all(a["status"] == "confirmed" for a in result.actions)
    assert "chose Pottery" in result.report
    transcript = [json.loads(l) for l in result.transcript_path.read_text().splitlines()]
    assert [e["type"] for e in transcript].count("tool_result") == 4


def _first_option(provider, kind):
    for call in reversed(provider.calls):
        for message in reversed(call["messages"]):
            for block in message.get("content", []):
                if block.get("type") == "tool_result":
                    doc = json.loads(block["content"])
                    for decision in doc.get("decisions", []):
                        if decision["kind"] == kind:
                            return decision["options"][0]["actionId"]
    raise AssertionError("no brief with that decision was returned yet")


def _end_turn_id(provider):
    for call in reversed(provider.calls):
        for message in reversed(call["messages"]):
            for block in message.get("content", []):
                if block.get("type") == "tool_result":
                    doc = json.loads(block["content"])
                    if doc.get("endTurn", {}).get("canStart"):
                        return doc["endTurn"]["actionId"]
    raise AssertionError("no brief allowed ending the turn yet")


def test_a_pause_stops_the_turn_without_acting(tmp_path):
    scripts = session_scripts(offers_payload(RESEARCH, end_can_start=False, blocking="RELIGION"))
    provider = FakeProvider([
        ProviderResponse(text="", tool_calls=[ToolCall("1", "get_turn_brief", {})]),
        ProviderResponse(text="Paused: the game wants a RELIGION decision I cannot make.", tool_calls=[]),
    ])
    r, f = make(tmp_path, scripts, provider)
    result = r.play_turn()
    assert result.status == "paused" and result.pause["reason"] == "UNSUPPORTED_DECISION"
    assert result.actions == []
    assert not any("sendRequest" in m for sock in f.all_sockets for m in sock.sent)


def test_an_invented_action_id_is_refused_without_reaching_the_game(tmp_path):
    scripts = session_scripts(offers_payload(RESEARCH))
    provider = FakeProvider([
        ProviderResponse(text="", tool_calls=[ToolCall("1", "get_turn_brief", {})]),
        ProviderResponse(text="", tool_calls=[ToolCall("2", "perform_action", {"action_id": "made-up-id", "request_id": "r"})]),
        ProviderResponse(text="I could not act.", tool_calls=[]),
    ])
    r, f = make(tmp_path, scripts, provider)
    result = r.play_turn()
    assert result.status == "stopped" and result.actions == []
    last_result = json.loads(provider.calls[-1]["messages"][-1]["content"][0]["content"])
    assert last_result["error"]["code"] == "UNKNOWN_ACTION"
    assert not any("sendRequest" in m for sock in f.all_sockets for m in sock.sent)


def test_an_unknown_tool_is_refused(tmp_path):
    scripts = session_scripts(offers_payload(RESEARCH))
    provider = FakeProvider([
        ProviderResponse(text="", tool_calls=[ToolCall("1", "read_the_other_seat", {})]),
        ProviderResponse(text="no", tool_calls=[]),
    ])
    r, _ = make(tmp_path, scripts, provider)
    r.play_turn()
    payload = json.loads(provider.calls[-1]["messages"][-1]["content"][0]["content"])
    assert payload["error"]["code"] == "UNKNOWN_TOOL"


def test_the_tool_call_budget_stops_the_turn(tmp_path):
    scripts = session_scripts(*[offers_payload(RESEARCH) for _ in range(4)])
    provider = FakeProvider([ProviderResponse(text="", tool_calls=[ToolCall(str(i), "get_turn_brief", {})]) for i in range(10)])
    r, _ = make(tmp_path, scripts, provider, max_tool_calls=3)
    result = r.play_turn()
    assert result.status == "budget_exhausted" and result.tool_calls == 3


def test_the_runner_has_no_tool_for_plans_skills_or_friction(tmp_path):
    """Those live in the agent's own session directory; a model that asks for them is told so."""
    from civ7_observer.runner import TOOLS
    assert {t["name"] for t in TOOLS} == {"get_turn_brief", "list_actions", "perform_action"} | {t["name"] for t in TOOLS if t["name"].startswith("get_")}
    assert not any(t["name"] in ("load_skill", "update_plan", "report_friction") for t in TOOLS)
    scripts = session_scripts(offers_payload(RESEARCH))
    provider = FakeProvider([
        ProviderResponse(text="", tool_calls=[ToolCall("1", "get_turn_brief", {})]),
        ProviderResponse(text="", tool_calls=[ToolCall("2", "update_plan", {"expected_revision": 0, "operations": []})]),
        ProviderResponse(text="stop", tool_calls=[]),
    ])
    r, _ = make(tmp_path, scripts, provider)
    r.play_turn()
    refusal = json.loads(provider.calls[2]["messages"][-1]["content"][0]["content"])
    assert refusal["error"]["code"] == "UNKNOWN_TOOL"


def test_the_prompt_carries_the_contract_the_routed_card_and_the_plan(tmp_path):
    scripts = session_scripts(offers_payload(RESEARCH, end_can_start=False, blocking="RESEARCH"))
    provider = FakeProvider([
        ProviderResponse(text="", tool_calls=[ToolCall("1", "get_turn_brief", {})]),
        ProviderResponse(text="stop", tool_calls=[]),
    ])
    r, _ = make(tmp_path, scripts, provider)
    r.session.plan_path.write_text("# Plan\n\n- Reach Writing\n", encoding="utf-8")
    r.play_turn()
    system = provider.calls[-1]["system"]
    assert "## The turn loop" in system                      # operating contract
    assert "Technology, civics, masteries" in system         # the card routed for the required decision
    assert "Reach Writing" in system                         # the agent's own PLAN.md, injected verbatim
    assert "friction — Report friction" in system            # the catalog it can load from
    assert "civ7-naval-and-overseas" in system, "the rest of the catalog is listed by id"
    assert "amphibious attack" not in system, "a card that was not routed is listed, not loaded"
    assert len(system) < 20000


def test_a_provider_failure_stops_the_turn_without_acting(tmp_path):
    class Broken:
        def complete(self, **kw):
            raise RuntimeError("provider down")
    scripts = session_scripts(offers_payload(RESEARCH))
    r, f = make(tmp_path, scripts, Broken())
    result = r.play_turn()
    assert result.status == "error" and "provider down" in result.error
    assert not any("sendRequest" in m for sock in f.all_sockets for m in sock.sent)


def test_operator_directives_go_in_above_the_contract_the_cards_and_the_plan():
    from test_brief import RESEARCH, offers_with
    from civ7_observer.runner import assemble_system_prompt
    from civ7_observer.brief import build_brief  # noqa: F401  (the brief shape below is what build_brief produces)
    brief = {"decisions": [{"kind": "research", "required": True}]}
    system = assemble_system_prompt(brief, "- Reach Writing", directives="- Open a trade route as soon as one is available.")
    i_dir = system.index("# Operator directives"); i_goal = system.index("Open a trade route")
    i_contract = system.index("## The turn loop"); i_plan = system.index("# Your plan")
    assert i_dir < i_goal < i_contract < i_plan
    assert "take priority over your own plan" in system and "check every turn" in system
    assert "# Operator directives" not in assemble_system_prompt(brief, "- Reach Writing")
