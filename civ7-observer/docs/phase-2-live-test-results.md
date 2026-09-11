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
