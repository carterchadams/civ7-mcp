"""Persistent-server hotseat matrix. Keeps two bound MCP servers (player 0 and player 1)
alive across seat handoffs and, on each trigger, calls get_status and get_observation on
both, appending a row to runs/hotseat-mcp-matrix.jsonl.

Trigger: write "<expected_player> <label>" to runs/round-trigger. Stop: write "stop".
Run in the background: python demo/hotseat-watch.py
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

PY = sys.executable
RUNS = Path("runs"); RUNS.mkdir(exist_ok=True)
TRIGGER = RUNS / "round-trigger"
LOG = RUNS / "hotseat-mcp-matrix.jsonl"


async def call(session, name):
    res = await session.call_tool(name, {})
    return json.loads(res.content[0].text)


async def main():
    servers = {}
    from contextlib import AsyncExitStack
    async with AsyncExitStack() as stack:
        for player in (0, 1):
            params = StdioServerParameters(command=PY, args=["-m", "civ7_observer", "serve", "--player", str(player), "--mode", "local-hotseat"])
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            servers[player] = session
        print("watching for rounds; both servers up", flush=True)
        while True:
            if not TRIGGER.exists():
                await asyncio.sleep(0.5)
                continue
            cmd = TRIGGER.read_text().strip()
            TRIGGER.unlink()
            if cmd == "stop":
                print("stopping", flush=True)
                return
            expected_s, _, label = cmd.partition(" ")
            expected = int(expected_s)
            row = {"label": label, "expectedPlayer": expected, "servers": {}}
            for player, session in servers.items():
                t0 = time.monotonic()
                st = await call(session, "get_status")
                obs = await call(session, "get_observation")
                ms = int((time.monotonic() - t0) * 1000)
                entry = {"ready": st["ready"], "reason": st["reason"], "eligibility": st.get("eligibility"), "sessionId": st["sessionId"][:8], "ms": ms}
                if "error" in obs:
                    entry["observation"] = {"error": obs["error"]["code"]}
                else:
                    entry["observation"] = {"id": obs["observationId"][:8], "sessionId": obs["sessionId"][:8], "turn": obs["context"]["turn"], "playerId": obs["context"]["playerId"],
                                            "settlements": len(obs["settlements"]), "units": len(obs["units"]), "visible": obs["map"]["counts"]["visible"], "warnings": len(obs["warnings"])}
                row["servers"][str(player)] = entry
            with open(LOG, "a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(json.dumps(row), flush=True)


asyncio.run(main())
