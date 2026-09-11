"""End-to-end: spawn `python -m civ7_observer serve` over stdio and talk MCP to it, against the fake CDP server."""
import json
import os
import sys

import anyio
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from fake_cdp import FakeCdpServer, SharedScript, echo_value
from test_schema import GOOD
from test_targets import GAME, MENU

OBS = {**GOOD, "context": {**GOOD["context"], "turn": GAME["turn"]}}


def _child_env() -> dict[str, str]:
    """Hand the spawned server our isolated host state; the stdio client would otherwise give it a
    minimal default environment and it would fall back to the machine's real state directory."""
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "PYTHONPATH", "VIRTUAL_ENV")}
    env["CIV7_OBSERVER_STATE_DIR"] = os.environ["CIV7_OBSERVER_STATE_DIR"]
    return env


@pytest.fixture
def server():
    s = FakeCdpServer().start()
    yield s
    s.stop()


async def _call(port, player, mode, name):
    params = StdioServerParameters(command=sys.executable, args=["-m", "civ7_observer", "serve", "--player", str(player), "--mode", mode, "--port", str(port), "--timeout", "3"], env=_child_env())
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            result = await session.call_tool(name, {})
            return [t.name for t in tools.tools], result


def test_stdio_lists_two_tools_and_returns_observation(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [echo_value(json.dumps(GAME)), echo_value(json.dumps(OBS)), echo_value(json.dumps(GAME))]}  # replayed per connection: doctor reads 1; reopen reads 1,2,3
    names, result = anyio.run(_call, server.port, 1, "singleplayer", "get_observation")
    assert sorted(names) == ["get_observation", "get_status"]
    assert result.isError is False
    doc = json.loads(result.content[0].text)
    assert doc["schemaVersion"] == 1 and doc["context"]["playerId"] == 1


def test_stdio_typed_error_when_at_menu(server):
    server.targets = [server.target("g", "/p/g")]
    server.ws_scripts = {"/p/g": [echo_value(json.dumps(MENU))]}
    _, result = anyio.run(_call, server.port, 1, "singleplayer", "get_observation")
    doc = json.loads(result.content[0].text)
    assert doc["error"]["code"] == "NOT_IN_GAME"


def test_stdio_closed_loop_brief_then_act(server, tmp_path):
    """The milestone loop over a real MCP client: brief -> choose -> act -> receipt."""
    from test_brief import RESEARCH, offers_with
    ctx = json.dumps(GAME)
    payload = json.dumps(offers_with(RESEARCH, end_can_start=False, blocking="RESEARCH"))
    performed = json.dumps({"payloadVersion": 1, "refused": None, "context": None, "outcome": "sent",
                            "readback": {"kind": "SET_TECH_TREE_NODE", "arg": 701, "observedType": 701, "matches": True}})
    server.targets = [server.target("g", "/p/g")]
    # one script consumed across the connections the two tool calls open:
    # brief: doctor ctx | reopen ctx, offers, after-ctx ; perform: doctor ctx | reopen ctx, mutation
    server.ws_scripts = {"/p/g": SharedScript([
        echo_value(ctx),                                    # brief: doctor probe
        echo_value(ctx), echo_value(payload), echo_value(ctx),   # brief: reopen, offers, after
        echo_value(ctx),                                    # perform: doctor probe
        echo_value(ctx), echo_value(performed),             # perform: reopen, mutation
    ])}
    result = anyio.run(_closed_loop, server.port, 1, "singleplayer", str(tmp_path / "seat1.jsonl"))
    names, brief_doc, receipt = result
    assert sorted(names) == ["get_action_result", "get_city_options", "get_observation", "get_plan", "get_status", "get_turn_brief", "get_unit_options", "list_actions", "load_skill", "perform_action", "report_friction", "update_plan"]
    assert brief_doc["endTurn"]["blocking"] == "RESEARCH"
    assert [d["kind"] for d in brief_doc["decisions"] if d["required"]] == ["research"]
    assert receipt["status"] == "confirmed" and receipt["kind"] == "SET_TECH_TREE_NODE"


async def _closed_loop(port, player, mode, journal):
    params = StdioServerParameters(command=sys.executable, args=[
        "-m", "civ7_observer", "serve", "--player", str(player), "--mode", mode,
        "--port", str(port), "--timeout", "3", "--allow-actions", "--journal", journal], env=_child_env())
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            brief_doc = json.loads((await session.call_tool("get_turn_brief", {})).content[0].text)
            required = next(d for d in brief_doc["decisions"] if d["required"])
            action_id = required["options"][0]["actionId"]
            receipt = json.loads((await session.call_tool("perform_action", {"action_id": action_id, "request_id": "loop-1"})).content[0].text)
            return [t.name for t in tools.tools], brief_doc, receipt
