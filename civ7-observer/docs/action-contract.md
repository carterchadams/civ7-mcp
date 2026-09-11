# Action contract (Phase 2, first catalog)

All mutations go through `payloads/perform.js`, the only mutation payload, held to an exact
engine-call allowlist by `tests/test_payload_policy.py`. Offers come from `payloads/offers.js`
(read-only; uses the native `canStart` query as the shipped choosers do). Read-back uses
`payloads/readback.js` (read-only) with a bounded poll (10 × 0.2 s).

| public kind | engine call (verified live 2026-09-11) | argument | native legality | read-back |
|---|---|---|---|---|
| `research` | `Game.PlayerOperations.sendRequest(pid, PlayerOperationTypes.SET_TECH_TREE_NODE, {ProgressionTreeNodeType: hash})` after `canStart(...)` `Success` | node hash from `Techs.getAllAvailableNodeTypes()` | `canStart` immediately before send | `Techs.getResearching().type === hash` (asynchronous; observed within 0.2–0.4 s) |
| `civic` | same with `SET_CULTURE_TREE_NODE` and `Culture` | node hash | same | `Culture.getResearching().type` |
| `skip_unit` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.SKIP_TURN, {})` after `canStart(unitId, SKIP_TURN, {}, false)` | the unit's `id.id`; the unit must be in the bound player's `Units.getUnits()` (ownership enforced there, `Units.get` never used) | `canStart` immediately before send | unit no longer in `unitsReadyToMove` (asynchronous) |
| `end_turn` | `GameContext.sendTurnComplete()` | none | `Game.Notifications.getEndTurnBlockingType(pid) === EndTurnBlockingTypes.NONE (0)` and `!GameContext.hasSentTurnComplete()` | `hasSentTurnComplete() true`, then the seat/turn moves on |

Blocking types observed: `UNITS` (23669119) while any unit has moves and no order,
`RESEARCH` (-286188551) while no research is selected. `Game.Notifications.getTypeName`
does not name blocking types; the `EndTurnBlockingTypes` key does.

Host-side rules (`actions.ActionRegistry`): opaque ids bound to (seat, turn, age) and persisted
next to the journal; a request id is idempotent and may not be reused for a different action;
`pending → confirmed | rejected | unknown` journal rows; an `unknown` outcome (transport loss
after send, or read-back never matching) blocks further actions until a human reconciles it;
no retry through any transport.
