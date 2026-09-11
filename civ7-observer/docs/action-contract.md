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
| `move_unit` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, {X, Y, Modifiers: 0})` after `canStart(...)` | the unit's `id.id` plus a target plot that is **adjacent** (via `getAdjacentPlotLocation`) and **not HIDDEN** for the bound player; `Modifiers` is pinned to NONE so a move can never become an attack, a war declaration, or a step into unexplored land (the shipped UI uses `ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION` for human clicks) | `canStart` immediately before send; adjacency and visibility re-checked inside the payload; **`Units.getPathTo(unitId, {x, y})` must return a non-empty path whose last `turns` entry is 1** | unit location equals the target (asynchronous) |
| `produce_unit` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {UnitType: hash})` after `canStart(...)` `Success` | the city's `id.id` (must be in the bound player's `Cities.getCities()`) and a unit definition hash; offers enumerate `GameInfo.Units` per city and keep only `canStart` successes | `canStart` immediately before send; purchases (`CityCommands`) and constructibles/projects (which need plot placement) are not offered | `BuildQueue.currentProductionTypeHash === hash` (asynchronous) |
| `end_turn` | `GameContext.sendTurnComplete()` | none | `Game.Notifications.getEndTurnBlockingType(pid) === EndTurnBlockingTypes.NONE (0)` and `!GameContext.hasSentTurnComplete()` | `hasSentTurnComplete() true`, then the seat/turn moves on |

Blocking types observed: `UNITS` (23669119) while any unit has moves and no order,
`RESEARCH` (-286188551) while no research is selected. `Game.Notifications.getTypeName`
does not name blocking types; the `EndTurnBlockingTypes` key does.

## Binding, identity and outcome rules (`actions.ActionRegistry`)

- **Match identity**: `Configuration.getGame().campaignSetupGUID` (the `gameGUIDHexString`
  field is empty on this build; it is used only as a fallback). Read by the context probe, so
  the doctor, session reopen, capture integrity and every action check compare it.
- **Offer binding**: each opaque id resolves host-side to (kind, args, seat, turn, age, match,
  precondition). `perform` refuses `ACTION_EXPIRED` unless the live session matches all of
  turn, age and match, and the payload re-checks match and the precondition inside the game.
- **Preconditions** (`pre`): research/civic = the current researching node at offer time;
  `skip_unit` = the unit's movement remaining; `move_unit` = the unit's plot index;
  `produce_unit` = the city's current production hash; `end_turn` = 0. A stale offer cannot
  overwrite a newer decision.
- **Serialization**: an interprocess `flock` on `<journal>.lock` covers reload + check + pending
  + dispatch + outcome, so overlapping CLI/MCP invocations sharing a journal cannot dispatch
  the same request twice; the second caller sees the first's result.
- **Journal**: `pending → confirmed | rejected | unknown`, each row carrying the full action
  identity (request id, action id, kind, args, precondition, seat, turn, age, match). A
  pending row without a final row after a restart becomes `unknown` with its identity intact;
  after human reconciliation an identical retry returns the recorded result without dispatch.
- **After dispatch, only an explicit, well-formed payload refusal proves nothing was sent.**
  Transport loss, malformed or shape-invalid responses, and missing `outcome` are `unknown`.
- **Read-back**: the in-payload read is a hint. A poll counts only when it reports the same
  match and integer turn/age/seat. `end_turn` confirms only on positively identified
  progression (completion flagged on the same seat and turn, the turn counter advanced, or a
  handoff to another seat); nulls never confirm. The poll that established success is stored
  as `confirmedBy` in the receipt.
- **Unit and city identity**: offers expose `unitId` / `cityId` matching the observation's
  `id.id`, plus `from` for unit offers, so a client can join offers to observed entities;
  mutation parameters stay host-side.
- **Move destinations**: currently VISIBLE plots only. REVEALED (fogged) plots are excluded
  because the native path preview could reflect hidden occupants; this is a policy choice to
  revisit with a derived-query leakage test, not a capability limit.
- No retry through any transport; `RECONCILIATION_REQUIRED` blocks every action while an
  `unknown` outcome exists.

## Lesson: `canStart(MOVE_TO)` does not validate the destination

Live (game 2, turn 13): `canStart` returned `Success: true` for an adjacent mountain plot;
`sendRequest` was accepted; the engine silently did nothing (unit unmoved, full movement, no
pending operation). The registry journaled the outcome `unknown`, blocked further actions,
and the human-verified reconciliation recorded it as `rejected`. The shipped UI relies on
`Units.getPathTo` (empty `plots` for unreachable, `turns` per plot otherwise); offers and
performs now require a one-turn native path. This is exactly why the plan insists on
read-back and reconciliation rather than trusting a transport acknowledgement.
