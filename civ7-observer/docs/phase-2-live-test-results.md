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
| what the human saw | to be recorded by the human (the research panel should now show Pottery) |

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
| what the human saw | to be confirmed by the human: expected only the stock "pass device" screen for Alexander followed by the "pass device" screen for Isabella |

Gate decision (stage 1): native operations execute under the curtain, the turn advances
through the normal hotseat flow, and no custom overlay was needed. Stage 2 (movement/camera,
a blocking popup, diplomacy, pause/disconnect, human input during automation) remains.
