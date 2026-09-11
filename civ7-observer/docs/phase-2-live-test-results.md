# Phase 2 live test results

Plan: `plans/claude-phase-2.md`. Same environment as Phase 1 (native Linux build, snap Steam,
buildid 24661151, CDP on 127.0.0.1:9444). Every mutation goes through `payloads/perform.js`
and is journaled in `runs/actions.jsonl` (git-ignored; rows copied here verbatim).

## Gate stage 1a: first native write, research selection (2026-09-11)

Fresh hotseat game, seat 1 = player 0, turn 11, curtain already dismissed by the human.

| step | result |
|---|---|
| `act list --player 0 --mode local-hotseat` | 2 research offers (Pottery 46 cost / 1 turn, Masonry 83 / 7), 3 civic offers (Mysticism, Discipline, Abbasid Origins), all `canStart true`; `end_turn` offer `canStart false`, blocker `UNITS` (units still need orders) |
| `act perform` Pottery, request `gate1-research-pottery` | `confirmed`: payload ran `canStart` then `sendRequest(SET_TECH_TREE_NODE)`, immediate read-back `getResearching().type` matched the argument |
| independent read-back via `snapshot` | technology current = `NODE_TECH_AQ_POTTERY`, IN_PROGRESS 39/46 (banked points retained), 1 turn left, no queued target |
| journal | `pending` then `confirmed` rows for the same request id |
| what the human saw | not separately recorded; the later snapshot confirmed Pottery |

Contract notes recorded on the way:

- `EndTurnBlockingTypes.NONE` is `0`; the hash `23669119` seen in Phase 1 is `UNITS`. `Game.Notifications.getTypeName` does not name blocking types; the enum key does.
- `Game.Notifications.hasEndTurnBlocking(pid)` returned `false` while `getEndTurnBlockingType(pid)` returned `UNITS`: the two are not equivalent; the shipped action panel uses the latter.
- Ending the agent's turn therefore requires giving every unit an order first. A unit skip action is the next catalog item.

## Gate stage 1b: end turn from a dismissed seat (player 0, turn 11)

| step | result |
|---|---|
| human gave every unit orders | `end_turn` offer became `canStart true` (blocker NONE = 0) |
| `act perform` end_turn, request `gate1-end-turn-p0-t11` | `confirmed`: `GameContext.sendTurnComplete()` then `hasSentTurnComplete() true` |
| 1 s later | seat = player 1, `isTurnActive` for player 0 false, **`curtainDisplayed true`** (the stock pass-device screen appeared for the next seat) |

## Gate stage 1c: a complete agent turn UNDER the curtain (player 1, turn 11)

Performed with `hotseat-screen-curtain` present in the DOM throughout (every row reported
`curtainDisplayed: true`). The human did not touch the game.

| step | result |
|---|---|
| `act list --player 1` | ok under the curtain: 2 research offers, 3 skip offers (scouts, 2 moves each), end_turn blocked by `RESEARCH` |
| research: Animal Husbandry | `confirmed`; immediate in-payload read-back still showed the old value, the bounded read-back poll (≤ 2 s) observed `techResearching` = Animal Husbandry: **player operations apply asynchronously**, the poll is required |
| skip scout ×3 | each `confirmed` via the poll (`unitsReadyToMove` shrank by one each time); each subsequent listing showed the skipped unit's offer as `canStart false` |
| end_turn | offer `canStart true` after the skips (blocker NONE); `confirmed` |
| 2 s later | **turn 12, seat = player 0, curtain displayed for the human**; player 1's research persisted (Animal Husbandry) |
| what the human saw | **confirmed by the human: only the curtain, no popups peeking through.** One quirk: the human had to click "Start turn" twice to reach player 1's interactivity |

Gate decision (stage 1): native operations execute under the curtain, the turn advances
through the normal hotseat flow, and no custom overlay was needed. Stage 2 (movement/camera,
a blocking popup, diplomacy, pause/disconnect, human input during automation) remains.

### Double-curtain quirk (observed once, explanation from the shipped script)

`hotseat-curtain.js` mounts one curtain component per turn activation, suspends the display
queue while mounted, and only sends `ACKNOWLEDGE_TURN_START` and resumes the queue when the
human dismisses it. When the agent seat's turn is played and ended *under* its curtain, that
component is never dismissed: it stays mounted, its label follows `localPlayerID` to the human's
name, and the human's own curtain is queued behind it. The human's first click dismisses the
stale instance (acknowledging turn start for the now-local human seat), the queue resumes, and
the human's real curtain appears for a second click. Consequences: harmless for concealment,
mildly confusing. Candidate fixes, deferred: (a) accept and document; (b) a tiny UI mod that
auto-dismisses a curtain whose seat has already ended its turn; (c) investigate whether
sending `ACKNOWLEDGE_TURN_START` for the agent seat before acting changes the behaviour
(untested; it is a player operation and would need the allowlist extended).

## Gate stage 2: movement, input and takeover under the curtain (player 1, turn 12)

Human watched and listened throughout, and deliberately clicked around and pressed keys
while the agent acted.

| item | result |
|---|---|
| `move_unit` scout 131072 → (19, 42) under the curtain | `confirmed` via read-back poll; the human saw **no camera movement, no map** — only the curtain |
| `skip_unit` × 3 | `confirmed` |
| `end_turn` | offer `canStart false`, blocker `PRODUCTION` (Athênai had no build); host refused the perform with `ACTION_NOT_STARTABLE` before anything was sent |
| human input during automation | clicks and key presses had no visible effect; the only change was the music becoming more noticeable (curtain audio context); no sound effects, no popups |
| takeover | the human dismissed the curtain, chose production and ended the turn manually: the named-pause path works with the stock UI and no companion code |
| popups / diplomacy during an agent turn | none occurred yet; to be logged when the game produces one |
| pause / disconnect mid-turn | pending (companion killed between actions at a later handoff) |

Gate stage 2 decision so far: concealment holds for research, skip, move and end turn; the
unsupported-decision path degrades to a human takeover with no leak beyond the human's own
choice to dismiss the curtain. Production selection is the next catalog item the declared
scenario needs.

## Game 2 (different save, player 0, turn 13, curtain up): unknown-outcome path exercised

| step | result |
|---|---|
| `move_unit` to an adjacent **mountain** plot that `canStart` had accepted | `sendRequest` accepted; read-back poll never saw the unit move; outcome `unknown`; journal `pending → unknown` |
| next `act perform` | refused `RECONCILIATION_REQUIRED` (nothing sent) |
| verification | unit still at (19, 32), 2/2 moves, `hasPendingOperations false`, `operationQueueSize 0`; `Units.getPathTo` returns an empty path for the mountain and a 1-turn path for a coast neighbour |
| `act reconcile --status rejected` | accepted with the note above; actions unblocked |
| fix | move offers/performs now require a native one-turn path (tests added) |

## Game 2, player 0, turn 13: complete agent turn under the curtain, no takeover

With `hotseat-screen-curtain` present throughout:

| step | result |
|---|---|
| `move_unit` scout → (19, 31) flat, native path 1 turn | `confirmed` (read-back poll) |
| `skip_unit` × 3 | `confirmed` |
| `produce_unit` Scout in the Abbasid capital (offers listed Scout, Settler, Warrior, Slinger from native `canStart(BUILD)`) | `confirmed` via poll (`BuildQueue.currentProductionTypeHash`); end-turn blocker went from `PRODUCTION` to none |
| `end_turn` | `confirmed`; 2 s later seat = player 1, turn 13 |

This is the first turn where every mandatory decision the game raised (research already set,
units, production) was handled by the action catalog alone.

## Preliminary action-layer review fixes verified live (game 2, player 1, turn 13, curtain up)

| check | result |
|---|---|
| doctor / offers context | `gameGuid` = campaign setup GUID `83853C0C…` present in the doctor context and every offers context |
| offers | skip and move offers carry `unitId` and `from`; end turn blocked by `UNITS` |
| `skip_unit` perform | `confirmed` with `confirmedBy: {source: poll, gameGuid: 83853C0C…, turn: 13, localPlayerId: 1}` |
| files | `actions.jsonl`, `actions.offers.json`, `actions.lock` |

## Action-layer fix review verified live (game 2, player 1, turn 13, curtain up)

| check | result |
|---|---|
| offers | `generation 1`, `reattached true` on first sight of match `83853C0C…`; `~/.local/state/civ7-observer/generations.json` = `{"83853C0C…": {"generation": 1, "maxTurn": 13}}` |
| `skip_unit` 196609 | `confirmed`, `confirmedBy.effect = {"unitNoLongerReady": 196609}` with match/turn/age/player/observer |
| load of a **different** game (single-player, turn 2, match `E8D5748A…`) | PASS: doctor context shows the new match id; performing an offer id from the previous game was refused (`WRONG_PLAYER`, the old offer belonged to seat 1; a same-seat id would fail `ACTION_EXPIRED`) with nothing dispatched; listing registered the new match with `generation 1`, `reattached true`; `generations.json` now holds both matches; the previous game's 14 stale offers were pruned |
| reload of an earlier save of the **same** campaign (saved at turn 2, played to turn 3, loaded turn 2) | PASS: `campaignSetupGUID` **unchanged** across the reload (`E8D5748A…`), so the native id alone would not have detected it; the host generation did: performing a turn-3 offer after the reload was refused `ACTION_EXPIRED` with nothing dispatched, `generations.json` moved to `generation 2, maxTurn 2`, and the pre-reload journal rows keep `generation 1`. Note: the regression was first observed by the `perform` call, which consumed the `reattached` flag; the following `list` reported `reattached false` with generation 2 |

## Closed loop through MCP (game 2, player 0, turn 13, curtain up)

A real MCP client (not our CLI) asked for a brief, chose from the offered options, acted, and read
the receipt back. Same validated service the CLI uses; the client never saw an engine operation
name or argument.

| step | result |
|---|---|
| tool surface with `--allow-actions` | `get_observation`, `get_status`, `get_turn_brief`, `list_actions` (read-only) and `perform_action` (readOnlyHint false), `get_action_result` |
| `get_turn_brief` | **148 ms, 3,911 bytes** (the full observation is ~45 KB); named the required decision `produce_unit` from the native blocker `PRODUCTION`, with 4 legal options, plus 3 optional decisions and 19 unit options summarised to 6 with `omitted: 13` |
| `perform_action` (Warrior in Baghdād) | **334 ms**, `confirmed`, `confirmedBy.effect = {cityProduction: {cityId: 65536, unitType: …}}` with match, turn, age, seat and observer |
| repeating the same `request_id` | returned the identical receipt; nothing was sent twice |
| brief again | end turn still blocked, now on `UNITS`: the loop advances to the next decision |
| `get_action_result` | `confirmed` |

Fixed on the way: city names in offers were raw localization keys (now composed, "Baghdād"), and
the offers context now carries `ageType`.

### Test isolation defect found and fixed

The suite was writing to the machine's real host state directory: a fixture's uncertain write had
left an entry in `unresolved.json` that would have blocked the live game's actions. Every test now
gets its own state directory via an autouse fixture, spawned MCP servers inherit it explicitly
(the stdio client otherwise gives a child a minimal default environment), and a guard test asserts
the real directory is never used. The stale entry was removed from the live state.

## A model played a whole agent turn behind the curtain (game 2, player 0, turn 13)

`demo/play-turn.sh`: a separate non-interactive Claude session with the built-in tool set disabled
(`--tools ""`), one MCP server, and only the four action tools allowed. It was told to resolve the
required decision repeatedly and end the turn, to stop on any `pause`, and never to invent an
action id. The human did not touch the game; the pass-device curtain was displayed throughout.

| measure | value |
|---|---|
| effective tools at init | exactly `get_turn_brief`, `list_actions`, `perform_action`, `get_action_result` |
| tool calls made | 6 × `get_turn_brief`, 6 × `perform_action`, nothing else |
| actions | 5 scout moves and end turn, every receipt `confirmed` |
| pauses / errors / unknown outcomes | none |
| game after | seat advanced to player 1, same turn, curtain shown for the next seat |
| wall time | 33.5 s for the whole turn (13 model turns) |
| tokens | 1,679 output; 23,488 cache-creation and 181,746 cache-read input (the brief itself is ~4 KB) |
| cost | $0.37 for the turn on a frontier model |

Its own summary of the reasoning: it treated each required decision in turn, spent scout movement
on land rather than skipping, and deliberately left the optional civic, research and production
decisions alone because the brief did not mark them required.

This is the closed loop the project-wide review asked for, minus the agent-owned plan file: a
compact pending decision went to a tool-only client, execution went through the same validated
service the CLI uses, receipts came back, and control returned to the human at the next curtain.

**Cost note:** the cached input dominates because a general-purpose client resends its whole system
prompt each model turn. A purpose-built runner sending only the brief and a short skill card should
be far cheaper; that measurement is still missing.
