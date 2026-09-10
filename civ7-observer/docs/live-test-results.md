# Live test results

Fill in per session. `doctor` output should be pasted verbatim (`--json`).

## Environment

| item | value |
|---|---|
| Date | 2026-09-10 |
| Game build (Steam `buildid`, in-game version string) | `buildid 24661151` as of 2026-09-10 install; in-game version: _pending first launch_ |
| Store / platform | Steam (snap), native Linux build `Base/Binaries/linux/Civ7_linux_Vulkan_FinalRelease` |
| OS | Linux 7.0.0-31-generic, snap Steam |
| Launch mode | native (no Proton) |
| DLC | |
| Active mods | |
| `AppOptions.txt` path actually used | `~/snap/steam/common/My Games/Sid Meier's Civilization VII/AppOptions.txt` (`;UIDebugger 1` still commented, debugger listening anyway) |
| Map settings of disposable save | 74 x 46 grid, Antiquity, Greece, single-player, turn 2 |

## Milestone A gate

| test | command | result | notes |
|---|---|---|---|
| Game absent | `doctor --json` with Civ closed | PASS before first launch and again after a clean shutdown: `DEBUGGER_UNAVAILABLE`, connection refused, `gameProcess: not-detected`, exit 1, 17 ms | port 9444 closed with the process |
| Debugger disabled | game running, `UIDebugger 0` | | expect `DEBUGGER_UNAVAILABLE`, `gameProcess: detected` |
| Menu context | game at main menu | PASS: `NOT_IN_GAME`, exit 1; target url became `fs://game/core/ui/shell/root-shell.html`; probe: inGame false, hasUI true, hasGameContext true, hasGame/hasPlayers/hasMap false, localPlayerId 0, localObserverId -1 | same single target id `0`; the realm is swapped, not added |
| Loaded single-player game | disposable save loaded | PASS: `IN_GAME`, turn 2, localPlayerId 0, localObserverId 0, exit 0; 10 consecutive runs identical, 60-71 ms each | human UI confirmation of turn/player still to be noted |
| Loaded hotseat game, seat 1 | new hotseat game, turn 1, no actions | PASS: `IN_GAME`, turn 1, localPlayerId 0, localObserverId 0; player 0 is human, Spain / Isabella, isTurnActive true, 1 unit at (63, 15), 0 cities; other human (id 1) isTurnActive false | first launch after shutdown: doctor rediscovered the new process without help (reconnection) |
| Loaded hotseat game, seat 2 | after pass-device curtain dismissed, turn 1 | PASS: `IN_GAME`, turn 1, localPlayerId 1, localObserverId 1; player 1 is human, Greece / Alexander, isTurnActive true, 1 unit at (66, 36), 0 cities; player 0 isTurnActive false | both ids follow the seat |
| Cross-seat visibility leak (negative) | from seat 2's realm, call `getRevealedState(0, x, y)` | **the API answers**: 19 tiles visible for player 0, 7 for player 1 | the debugger is omniscient across seats; seat binding must be enforced by the observer, not by the game |
| Target list | `curl --max-time 3 http://127.0.0.1:9444/json` | one target: id `0`, type `page`, title `127.0.0.1:9444/json`, url `fs://game/root-game.html` | Cohtml 2.2.3.0, protocol 1.3 |
| Client contention | doctor while a second CDP session is held open | PASS: `IN_GAME`; the held session kept working afterwards | this build accepts concurrent clients |
| Wrong `--target-id` | `doctor --target-id nope` | PASS: `NO_GAME_TARGET`, exit 1 | |
| Listen address | `ss -ltnp` | **9444 listens on 0.0.0.0** (all interfaces) | firewall the port or trust the LAN; not loopback-only |

## Turn 2 read-back (human played the rest of turn 2, not yet ended)

Same session, same target. Every value below came from read-only probes.

| item | before | after |
|---|---|---|
| Scout `{"owner":0,"id":131072,"type":26}` location / moves | (63, 7), 2/2, hasMoved false | (64, 8), 0/2, hasMoved true |
| Capital Athênai `{"owner":0,"id":65536,"type":1}` | pop 1, no production read | pop 1, producing hash 1872107673 = `UNIT_SCOUT` |
| Tech researching | `type -1` (none) | `NODE_TECH_AQ_POTTERY`, state 0, progress 0, 7 turns left |
| Civic researching | `NODE_CIVIC_AQ_MAIN_CHIEFDOM`, progress 10 | unchanged, 8 turns left |
| Visible / revealed / hidden tiles | 19 / 10 / 3375 | 33 / 5 / 3366 |
| Visible bounding box | | x 61-66, y 5-11 around the scout and capital |

Unit ID stayed stable across the move. Previously visible tiles that fell out of sight
moved to REVEALED and are no longer exported; no fresh state was read for them.

## Verbatim doctor reports (copied from the terminal during the 2026-09-10 session)

Game closed, before first launch and again after shutdown (`doctor --json`, exit 1):

```json
{"status":"DEBUGGER_UNAVAILABLE","ok":false,"gameProcess":"not-detected","discovery":{"url":"http://127.0.0.1:9444/json","targetCount":0,"error":{"code":"DEBUGGER_UNAVAILABLE","message":"no UI debugger answering at http://127.0.0.1:9444/json: [Errno 111] Connection refused"}}}
```

Single-player, turn 2 (`doctor --json`, exit 0):

```json
{
  "schemaVersion": 1,
  "status": "IN_GAME",
  "ok": true,
  "summary": "in-game realm found (target 0): turn 2, localPlayerId 0, localObserverId 0",
  "discovery": {"url": "http://127.0.0.1:9444/json", "targetCount": 1, "error": null},
  "targets": [{"index": 0, "id": "0", "title": "127.0.0.1:9444/json", "type": "page", "url": "fs://game/root-game.html", "kind": "game",
    "probe": {"inGame": true, "hasUI": true, "hasGameContext": true, "hasGame": true, "hasPlayers": true, "hasMap": true, "localPlayerId": 0, "localObserverId": 0, "turn": 2, "href": "fs://game/root-game.html"},
    "error": null, "contractIssue": false, "durationMs": 32}],
  "selected": {"index": 0, "id": "0", "title": "127.0.0.1:9444/json", "type": "page", "url": "fs://game/root-game.html"},
  "context": {"turn": 2, "localPlayerId": 0, "localObserverId": 0},
  "gameProcess": "detected", "adapterVersion": "0.1.0", "durationMs": 61
}
```

Main menu (`doctor`, exit 1):

```text
status: NOT_IN_GAME
summary: game UI reachable but no loaded game (main menu or loading screen)
discovery: http://127.0.0.1:9444/json (1 targets)
  [0] id=0 kind=menu title='127.0.0.1:9444/json' url='fs://game/core/ui/shell/root-shell.html' inGame=False turn=None localPlayerId=0 localObserverId=-1
game process: detected; adapter 0.1.0; 60 ms
```

Hotseat, seat 1, turn 1 (`doctor --json | jq '{status, context}'`, exit 0):

```json
{"status":"IN_GAME","context":{"turn":1,"localPlayerId":0,"localObserverId":0}}
```

Hotseat, seat 2, turn 1 after the pass-device curtain (`doctor --json | jq '{status, context}'`, exit 0):

```json
{"status":"IN_GAME","context":{"turn":1,"localPlayerId":1,"localObserverId":1}}
```

## Still pending human action

- Debugger-disabled run (`UIDebugger 0`, relaunch) to learn whether the option controls the listener.
- Human confirmation that the in-game turn counter and the active leader matched the doctor's turn/localPlayerId for the single-player and hotseat captures.

## Change 2: probe (hotseat game, seat 1, turn 2)

| test | result |
|---|---|
| `probe --out runs/capabilities.json` | PASS: player 0, turn 2, 0 payload errors, 16061 bytes; Spain / Isabella, capital Madrid pop 1 idle, scout at (63, 15) 2/2 moves 0/100 damage, tech tree `TREE_TECHS_AQ` nothing selected (turnsLeft -1), Agriculture FULLY_UNLOCKED depth 1, civic Chiefdom IN_PROGRESS 10/60 6 turns, sample tile (63,15) VISIBLE `TERRAIN_FLAT`/`BIOME_PLAINS` elevation 554 |
| `probe --player 1` from seat 0 | PASS (negative): `WRONG_PLAYER: bound player 1 is not the local seat (localPlayerId=0, localObserverId=0)`, exit 1, no file written |
