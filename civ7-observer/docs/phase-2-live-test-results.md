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
