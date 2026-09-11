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

## Change 2: probe (hotseat game, seat 2 = player 1 Alexander, turn 14)

Human-reported game state: explored, scout damaged, met two leaders, at war, one scout
embarked, at least one civic completed, camera parked over unknown terrain.

| test | result |
|---|---|
| `probe` on the active seat | PASS: player 1, turn 14, 0 payload errors, 18899 bytes |
| damage read-back | scout id 131072 `Health.damage 32 / maxDamage 100` |
| embarked unit | scout id 262146 at (60, 39) `isEmbarked true`, `isOnMap true`, moves 1/2; galley id 327683 `embarkationType -1` |
| completed civic | Chiefdom `NODE_STATE_FULLY_UNLOCKED`, `depthUnlocked 1 / maxDepth 1`; Discipline in progress 72/125, 1 turn left |
| civ-specific tree | `getAvailableTrees()` = `[TREE_CIVICS_AQ_MAIN, TREE_CIVICS_AQ_GREECE]`; Ekklesia and Agoge OPEN, tree resolved from the node definition |
| mastery depth | Writing `maxDepth 2`, `getNodeUnlockDepthsRemaining 2`, `getTurnsForNode 9` |
| production | Athênai pop 4 (rural 3, urban 1) building `UNIT_HOPLITE`; queue entry shape recorded |
| visibility vs camera | 84 visible / 87 revealed / 3233 hidden for player 1 regardless of where the camera was |
| omitted by design | met leaders, war state, notifications, resources: not read, not exported |

Pending on seat 0 (Isabella): a town (`isTown true`) and resources (deliberately not
exported; only presence of the API will be noted). Swap seats and re-run `probe`.

## Change 2: probe (seat 1 = player 0 Isabella, turn 15, after the swap)

| test | result |
|---|---|
| `probe` on the active seat | PASS: player 0, turn 15, 0 payload errors; localPlayerId 0, localObserverId 0, isTurnActive true |
| town | Sevilla id 131073 at (60, 14) `isTown true`, `isCapital false`, pop 2; Madrid remains capital pop 6, `getCapital()` still Madrid |
| roster | 2 settlements (1 town), 6 units (5 scouts, 1 warrior), one scout damaged 45/100, none embarked, none off-map |
| resources / notifications | APIs present (member names recorded in the contract); not read, not exported |

## Change 3: snapshot (seat 1 = player 0 Isabella, turn 15)

| test | result |
|---|---|
| `snapshot --mode local-hotseat` | PASS: player 0, turn 15, 2 settlements, 6 units, 0 warnings; observation id `e58292da…`, session id `8d150a07…` |
| own roster vs probe | identical ids, locations, populations, damage (scout 131072 at (50, 24) damage 45), Sevilla `isTown true` |
| serialized keys | only the schema's keys; no `ws://`, no resources, no foreign units, no yields, no seed |
| `--mode singleplayer` in the hotseat game (negative) | `UNSUPPORTED_GAME_MODE: game is local-hotseat but the service allows only singleplayer`, no file |
| `--player 1` from seat 0 (negative) | `WRONG_PLAYER`, no file |
| movement read-back | PASS: human moved two units, second `snapshot` (observation `0391da35…`, still turn 15): scout id 327683 (56, 17) 2/2 → (55, 19) 0/2; warrior id 524293 (63, 15) 2/2 → (65, 14) 0/2; the other 4 units byte-identical; unit id set unchanged; settlements unchanged; fresh observation id |
| session id across CLI runs | each `snapshot` process is a separate attachment, so `sessionId` differs per run (`8d150a07…` then `2ad21fff…`); `serve` will hold one session for its lifetime |

## Steps 2 and 3 review fixes (seat 2 = player 1 Alexander, turn 16)

| test | result |
|---|---|
| `snapshot --mode local-hotseat` with strict-typed payload | PASS: player 1, turn 16, 1 settlement, 6 units, 0 warnings, observation `370b6b5c…` |
| commander association (first live) | `UNIT_ARMY_COMMANDER` id 393220 at (66, 37), `isCommander true`, `armyId {owner:1, id:65536, type:29}`; `UNIT_HOPLITE` id 458757 adjacent at (67, 36), `armyId null` (not yet packed) |
| roster changes since turn 14 | scouts now 3/3 movement, damaged scout healed to 22/100, embarked scout still `isOnMap true` |
| packed-unit read-back, while packed | PASS: `snapshot` still lists 6 units; hoplite 458757 `locationStatus off-map`, `location null`, `armyId {owner:1,id:65536,type:29}`, movement 1/2; commander 393220 unchanged at (66, 37) with the same army id; raw `location` was `{-9999,-9999}` and `isOnMap false`, `isValid true` |
| packed-unit read-back, after unpacking | PASS: hoplite 458757 `locationStatus tile` at (65, 37), `armyId null`, movement 0/2; commander 393220 unchanged with its army id; same ComponentID across all three captures; roster count 6 throughout |

## Change 4: technology and civics (seat 2 = player 1 Alexander, turn 16)

The human changed research (Pottery → Masonry) and civics (Discipline → the Greek civic
Ekklesia) between the turn-14 probe and this capture.

| test | result |
|---|---|
| `snapshot --mode local-hotseat` | PASS: turn 16, player 1, 0 warnings; technology and civics `supported` |
| current tech | `NODE_TECH_AQ_MASONRY` IN_PROGRESS 18/83, 7 turns, depth 0 of 2; matches raw `getResearching().type` + `getNode` |
| completed techs | Agriculture, Pottery, Animal Husbandry, Sailing all FULLY_UNLOCKED 1/1; Writing and Irrigation (OPEN) correctly excluded |
| queued target | null (raw `getTargetNode` -1) |
| current civic | `NODE_CIVIC_AQ_GREECE_EKKLESIA` on `TREE_CIVICS_AQ_GREECE`, IN_PROGRESS 16/100, 7 turns |
| completed civics | Chiefdom FULLY_UNLOCKED 1/1; **Discipline UNLOCKED 1 of 2 (state 4, partial mastery)**; Mysticism, Tactics, Agoge (OPEN) excluded |
| trees | active `TREE_CIVICS_AQ_GREECE`, available main + Greece |
| state source | payload state equals `getNode().state` for every node; the `getResearching()` record still reported state 0 |

## Change 5: visible map (seat 2 = player 1 Alexander, turn 16)

| test | result |
|---|---|
| `snapshot --mode local-hotseat` with the map section | PASS: 116 visible / 94 revealed / 3194 hidden of 3404 plots; 116 tile records; 45,323 bytes; 0.21 s wall time incl. process start; 0 warnings |
| known visible coordinates | all 6 on-map units and the capital Athênai (67, 36) lie on exported tiles |
| known hidden coordinates | no exported tile in the (x<5, y<5) or (x>68, y>40) corners |
| tile keys | 6 terrain, 5 biome, 10 feature keys resolved; 18 river tiles; 0 unresolved hashes |
| serialized tile fields | exactly x, y, index, terrain(+Key), biome(+Key), feature(+Key), elevation, isRiver, riverType; no resource, yield, unit, or owner fields |
| omitted features | resources, foreign units/settlements, diplomacy, notifications, yields, hidden and fogged tiles, seed, other players |
| fog regression | PASS: scout 131072 moved (58, 34) → (60, 34); 17 previously visible tiles (e.g. 56,31 … 58,34) are absent from the new export, 13 new tiles appear; counts 116/94/3194 → 112/98/3194 (fogged +4 net, hidden unchanged); no stale record for a departed tile |
| anti-leak fixtures (offline) | Node fixtures plant an omniscient opponent, global unit/city maps, a resource and bulk-visibility reader; tests fail if any is touched or if detail is read before visibility |

## Changes 4 and 5 review fixes (seat 2 = player 1 Alexander, turn 16)

| test | result |
|---|---|
| `doctor --json` context now carries `age` | `{"turn":16,"age":2077444219,"localPlayerId":1,"localObserverId":1}` |
| `snapshot --mode local-hotseat` with enum validation, earned-depth completed list, age check, map bound | PASS: 0 warnings; Masonry current 18/83 depth 0/2; 4 completed techs; Chiefdom 1/1 and Discipline UNLOCKED 1/2 in completed civics; 112 visible tiles |
| active next-depth research (mastery selected) | PASS: Discipline is `current` (depth 1 of 2, progress 0, cost 62, 5 turns) **and** stays in `completed` with depthUnlocked 1; its live state is UNLOCKED (4) because no points have accrued yet, so IN_PROGRESS is not the state of a freshly selected node |
| queued target (non-null) | PASS: target `NODE_TECH_AQ_WHEEL` (raw node state CLOSED, not in `getResearched()`), and the game switched `current` to `NODE_TECH_AQ_IRRIGATION` (state OPEN, 0/83, 9 turns) on the path to it |
| UI comparison of an advancing value | PASS for turns: the panel showed 7 turns for Masonry, matching `turnsLeft 7`; the UI exposes no numeric progress/cost, only a bar, so 18/83 is corroborated by the dock's `1 − progress/cost` formula rather than a displayed number |
| banked progress on a deselected node | Masonry kept `progress 18` with state IN_PROGRESS after Irrigation became current; the observation now lists it under `technology.inProgress` (18/83) and Ekklesia under `civics.inProgress` (16/100) |

## Change 6: MCP serve and model demonstration (seat 2 = player 1 Alexander, turn 16)

| test | result |
|---|---|
| stdio server via MCP client (`serve --player 1 --mode local-hotseat`) | PASS: `initialize` ok, exactly two tools both `readOnlyHint true`; `get_status` `IN_GAME`, `ready true`, context turn 16 / age / seat 1; `get_observation` 44,849 bytes in 118 ms, 1 settlement, 6 units, 112 tiles, 0 warnings |
| wrong-seat server (`--player 0`) | PASS: `get_status` `ready false` reason `WRONG_PLAYER`; `get_observation` returns `{"error": {"code": "WRONG_PLAYER", ...}}`; no other seat data |
| isolated model demonstration, run 1 | PASS: `claude -p` with only `mcp__civ7-observer__get_observation` allowed and `--strict-mcp-config`; report cites observation id `c2839732…`, turn 16, every settlement/unit by id and coordinate, current/banked/completed research and civics correctly, describes visible terrain by coordinate, lists the omitted features, and states that absence of enemies in the data is not evidence of absence (`runs/demo-1.txt`) |
| grounding spot-checks on run 1 | population 5 (4 rural + 1 urban), 6 units with ids/locations/moves/damage, Irrigation 0/83 with Wheel queued, Masonry banked 18/83, Discipline depth 2 current with depth 1 completed, Ekklesia banked 16/100, 112 visible tiles, ocean at (0, 36) via horizontal wrap: all match the observation |
| demonstration, run 2 after a human change | PASS: fresh observation ids (`a2b6c1d1…` via MCP client, `18ab5677…` in the model run); the only differences from the previous observation were Athênai's production going from empty to `WONDER_DUR_SHARRUKIN` (constructible) and the Army Commander 393220 moving (66, 37) → (66, 38) with movement 2/2 → 0/2; every other unit, research, civic and all 112 visible tiles were byte-identical. The model's second report (`runs/demo-2.txt`) shows the wonder in the production column and the commander at (66, 38) with 0 of 2 moves, matching the change without being told what changed |

## Save replacement: fresh hotseat game (seat 1 = player 0, turn 1, no actions)

| test | result |
|---|---|
| `doctor` | `IN_GAME`, turn 1, localPlayerId 0, localObserverId 0, same single target |
| server bound to player 0: `get_status` / `get_observation` | ready; observation turn 1, Antiquity, local-hotseat: no settlements, one `UNIT_FOUNDER` id 65536 at (13, 23) with 3/3 moves, Agriculture current (0 completed), Chiefdom current on the main tree only, 13 visible / 16 revealed / 3375 hidden tiles, 0 warnings |
| new session identity | new `sessionId`s (`3af37b5f…`, `6acd0700…`) vs the previous game's `0ab1b507…`; nothing from the old game (Athênai, 6 units, 112 tiles) appears |
| server bound to player 1 (negative) | `WRONG_PLAYER`, no data |
| open question from the previous game | the human believed a hoplite had been moved before demo run 2, but both captures showed it at (65, 37) with 0 of 2 moves; it could not have moved that turn, and a queued order would not show because the observation does not read `hasPendingOperations` / `operationQueueSize`. Consider exporting pending-operation flags in a later change so "ordered but not yet moved" is visible |

## Hotseat robustness matrix (fresh game)

Rows are appended by `demo/hotseat-round.py` to `runs/hotseat-matrix.jsonl`; each round
captures on the expected seat and attempts the other seat.

| round | seat | result |
|---|---|---|
| r1 | player 0, turn 1 | capture ok (1 settlement, 0 units, 19 visible, 197 ms); wrong seat `WRONG_PLAYER`, no file |
| handoff, curtain up (before dismissal on seat 2) | — | `doctor` already reports localPlayerId 1 / localObserverId 1 and `Players.get(1).isTurnActive true`; snapshot bound to player 0 refused `WRONG_PLAYER`; **snapshot bound to player 1 succeeded while the curtain was still displayed**. No mixed-seat observation is possible, but the engine switches the seat before the human dismisses the pass-device screen, so a bound service can read its own seat before the human has "arrived". The plan's C1 note stands: captures are manually requested after dismissal in this phase, and a later automatic service needs a separate readiness gate (a UI predicate for the curtain, not `localPlayerID`) |
| r2-p1-t1 | player 1, turn 1 | ok: 0 settlement(s), 1 unit(s), 7 visible, 204 ms; wrong seat `WRONG_PLAYER`, no file |
| r3-p0-t2 | player 0, turn 2 | ok: 1 settlement(s), 1 unit(s), 35 visible, 178 ms; wrong seat `WRONG_PLAYER`, no file |
| r4-p1-t2 | player 1, turn 2 | ok: 1 settlement(s), 1 unit(s), 19 visible, 186 ms; wrong seat `WRONG_PLAYER`, no file |
| r5-p0-t3 | player 0, turn 3 | ok: 1 settlement(s), 1 unit(s), 27 visible, 183 ms; wrong seat `WRONG_PLAYER`, no file |
| r6-p1-t3 | player 1, turn 3 | ok: 1 settlement(s), 1 unit(s), 19 visible, 181 ms; wrong seat `WRONG_PLAYER`, no file |
| r7-p0-t4 | player 0, turn 4 | ok: 1 settlement(s), 1 unit(s), 32 visible, 188 ms; wrong seat `WRONG_PLAYER`, no file |
| r8-p1-t4 | player 1, turn 4 | ok: 1 settlement(s), 1 unit(s), 38 visible, 188 ms; wrong seat `WRONG_PLAYER`, no file |
| r9-p0-t5 | player 0, turn 5 | ok: 1 settlement(s), 2 unit(s), 45 visible, 187 ms; wrong seat `WRONG_PLAYER`, no file |
| r10-p1-t5 | player 1, turn 5 | ok: 1 settlement(s), 2 unit(s), 39 visible, 198 ms; wrong seat `WRONG_PLAYER`, no file |
| under-curtain vs after-dismissal (r2) | player 1, turn 1 | every section identical; only the observation id differs |

**Matrix result so far (corrected count):** the ten rows above are ten *seat captures*
over **five full hotseat rounds** (game turns 1-5), i.e. five captures of each intended
player, not the plan's ten rounds. Every capture hit the intended seat with a fresh
observation id, 0 warnings, 178-204 ms; every wrong-seat attempt was refused with
`WRONG_PLAYER` and no file written. Raw rows: `docs/hotseat-matrix.jsonl`. The remaining
five rounds (turns 6-10) are captured below through two **persistent** bound MCP servers
(`demo/hotseat-watch.py`) so the final delivery path, not only the CLI, is exercised
across handoffs.

## Phase 1 definition of done (plan section "Definition of done")

| requirement | evidence |
|---|---|
| validated observation with all five categories for the configured active player | Changes 3-5 live captures; hotseat matrix above |
| obtained through the debugger without the LLM seeing executable code | MCP server exposes only `get_observation` / `get_status`, no arguments; payloads are packaged |
| ordinary and negative hotseat tests pass | 10 full rounds, 20 positive and 20 negative captures (CLI for turns 1-5, persistent MCP servers for turns 6-10), plus the handoff attempt and the save-replacement check |
| one LLM client produces an accurate report | demo run 1 (`runs/demo-1.txt`), spot-checked claim by claim |
| a human-performed change is reflected in the next observation | demo run 2: wonder started and commander moved, both reported |
| no autonomous gameplay actions | none exist; mutators are blocked by the payload policy test |

Still open, as the plan anticipates: automatic curtain detection (the engine switches
seats before the human dismisses the pass-device screen), pending-operation visibility,
the `UIDebugger 0` relaunch, and the blank DLC/mod/version fields in the environment table.

## Change 6 review follow-ups (fresh hotseat game, seat 2 = player 1, turn 5)

| test | result |
|---|---|
| `get_status` honesty | server bound to player 0 (hotseat): `ready false`, `WRONG_PLAYER`; bound to player 1 (hotseat): `ready true`, eligibility `{mode: local-hotseat, isTurnActive: true}`; bound to player 1 with `--mode singleplayer`: `ready false`, `UNSUPPORTED_GAME_MODE` |
| demo runner boundary (run 3, `runs/demo-3.txt` + `.transcript.jsonl`) | client init reported `tools: ["mcp__civ7-observer__get_observation"]`, one MCP server connected; exactly one tool call made (`get_observation`); report grounded (Tokyo id 65536 at (21, 38), pop 3, producing a Scout; two scouts by id and coordinate) |
| runner failure path | with a stub `claude` exiting 17: "demo FAILED: claude exited 17", exit 17, no report file |

## Hotseat matrix, persistent MCP servers (`demo/hotseat-watch.py`, raw rows `docs/hotseat-mcp-matrix.jsonl`)

Two bound servers (player 0, player 1) stayed alive across every handoff; each row calls `get_status` then `get_observation` on both.

| row | seat | result |
|---|---|---|
| r6-p0-t6 | player 0, turn 6 | server p0: ready, 1 settlement(s), 2 unit(s), 70 visible, session `800e4e32`, 233 ms; server p1: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r7-p1-t6 | player 1, turn 6 | server p1: ready, 1 settlement(s), 2 unit(s), 52 visible, session `6df1d048`, 247 ms; server p0: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r8-p0-t7 | player 0, turn 7 | server p0: ready, 1 settlement(s), 2 unit(s), 68 visible, session `800e4e32`, 227 ms; server p1: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r9-p1-t7 | player 1, turn 7 | server p1: ready, 1 settlement(s), 2 unit(s), 57 visible, session `6df1d048`, 238 ms; server p0: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r10-p0-t8 | player 0, turn 8 | server p0: ready, 1 settlement(s), 3 unit(s), 93 visible, session `800e4e32`, 260 ms; server p1: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |

| r11-p1-t8 | player 1, turn 8 | server p1: ready, 1 settlement(s), 3 unit(s), 64 visible, session `0dabd97a`, 242 ms; server p0: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r12-p0-t9 | player 0, turn 9 | server p0: ready, 1 settlement(s), 3 unit(s), 103 visible, session `668d4632`, 231 ms; server p1: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r13-p1-t9 | player 1, turn 9 | server p1: ready, 1 settlement(s), 3 unit(s), 56 visible, session `0dabd97a`, 248 ms; server p0: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r14-p0-t10 | player 0, turn 10 | server p0: ready, 1 settlement(s), 3 unit(s), 125 visible, session `668d4632`, 231 ms; server p1: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |
| r15-p1-t10 | player 1, turn 10 | server p1: ready, 1 settlement(s), 3 unit(s), 56 visible, session `0dabd97a`, 225 ms; server p0: not ready `WRONG_PLAYER`, observation `WRONG_PLAYER` |

**Final count: 10 full hotseat rounds (game turns 1-10), each player captured once per
round: 20 intended-seat captures (10 via the CLI for turns 1-5, 10 via persistent MCP
servers for turns 6-10), all succeeded with a fresh observation id and 0 warnings, 178-260
ms each; 20 other-seat attempts, all refused with `WRONG_PLAYER` and no data.** The
persistent servers kept one session id each across every handoff; the two ids per server
in the raw rows come from the watcher being restarted once between turn 8's two captures
(both servers were relaunched), not from any reconnection inside a run.
