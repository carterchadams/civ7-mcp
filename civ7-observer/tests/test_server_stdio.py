"""End-to-end: spawn `python -m civ7_observer serve` over stdio and talk MCP to it, against the fake CDP server."""
import json
import sys

import anyio
import pytest
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from fake_cdp import FakeCdpServer, echo_value
from test_schema import GOOD
from test_targets import GAME, MENU

OBS = {**GOOD, "context": {**GOOD["context"], "turn": GAME["turn"]}}


@pytest.fixture
def server():
    s = FakeCdpServer().start()
    yield s
    s.stop()


async def _call(port, player, mode, name):
    params = StdioServerParameters(command=sys.executable, args=["-m", "civ7_observer", "serve", "--player", str(player), "--mode", mode, "--port", str(port), "--timeout", "3"])
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
