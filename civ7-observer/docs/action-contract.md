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
| `move_unit` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, {X, Y, Modifiers: 0})` after `canStart(...)` | the unit's `id.id` plus a target plot that is **adjacent** (via `getAdjacentPlotLocation`) and **currently VISIBLE** to the bound player; `Modifiers` is pinned to NONE so a move can never become an attack, a war declaration, or a step into unexplored land (the shipped UI uses `ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION` for human clicks) | `canStart` immediately before send; adjacency and visibility re-checked inside the payload; **`Units.getPathTo(unitId, {x, y})` must return a non-empty path whose last `turns` entry is 1** | unit location equals the target (asynchronous) |
| `produce_unit` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {UnitType: hash})` after `canStart(...)` `Success` | the city's `id.id` (must be in the bound player's `Cities.getCities()`) and a unit definition hash; offers enumerate `GameInfo.Units` per city and keep only `canStart` successes | `canStart` immediately before send; purchases (`CityCommands`) and constructibles/projects (which need plot placement) are not offered | `BuildQueue.currentProductionTypeHash === hash` (asynchronous) |
| `found_city` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, {X: -9999, Y: -9999, UnitAbilityType: -1})` after `canStart(...)` `Success` (the shipped unit panel sends no target plot for this operation; the settlement is founded where the unit stands) | the unit's `id.id` (must be in the bound player's `Units.getUnits()`); offers enumerate every owned on-map unit and keep only `canStart` successes, binding the offer to the unit's current plot (`from`, plot index as precondition) | `canStart` immediately before send; the unit must still stand on the offered plot | a city owned by the bound player at the offered plot (`cityLocations` in the read-back poll; asynchronous, observed within 0.2–0.4 s live 2026-09-11 turn 1) |
| `expand_city` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, {X, Y})` after `canStart(cityId, EXPAND, {X, Y}, false)` `Success` (new-population placement, as the shipped acquire-tile mode does for a rural claim; specialists via `ASSIGN_WORKER` are not offered yet) | the city's `id.id` and a plot from `canStart(cityId, EXPAND, {}, false).Plots` (the shipped place-population model's query), with the improvement the plot would receive (`ConstructibleTypes`), terrain, feature, river flag and the plot's current yields (`GameplayMap.getYield(x, y, yieldHash, pid)`) | `canStart` immediately before send; the plot must still be in the city's native `Plots` list (precondition = plot index) | the plot index disappears from that city's `Plots` list (`expandPlots` in the read-back poll; asynchronous) |
| `end_turn` | `GameContext.sendTurnComplete()` | none | `Game.Notifications.getEndTurnBlockingType(pid) === EndTurnBlockingTypes.NONE (0)` and `!GameContext.hasSentTurnComplete()` | `hasSentTurnComplete() true`, then the seat/turn moves on |

Blocking types observed: `UNITS` (23669119) while any unit has moves and no order,
`RESEARCH` (-286188551) while no research is selected, `PRODUCTION` while a city has no build,
`NEW_POPULATION` (442844772) while a city has grown and the new population is unplaced. `Game.Notifications.getTypeName`
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
  `produce_unit` = the city's current production hash; `found_city` = the unit's plot index (and
  the offer carries the plot's x, y, re-checked at execution); `expand_city` = the plot index, which must
  still be offered by the native query at execution; `end_turn` = 0. A stale offer cannot
  overwrite a newer decision.
- **Serialization (game-wide)**: one interprocess `flock` on `<state>/game.lock`, where `<state>`
  is `$CIV7_OBSERVER_STATE_DIR` or `~/.local/state/civ7-observer`, covers reload + check +
  pending + dispatch + outcome for every registry on the host regardless of journal, so
  seat-private journals still serialize against the shared game instance.
- **Unresolved-write barrier (game-wide)**: `<state>/unresolved.json` records every `unknown`
  outcome from any journal; every registry refuses `RECONCILIATION_REQUIRED` while it is
  non-empty, and reconciliation from the owning journal clears it.
- **Attachment generation**: `<state>/generations.json` keeps, per match id, a generation number
  and the highest turn observed. A session whose turn is lower than that maximum (a reload of
  an earlier save) bumps the generation and reports `reattached: true`; offers and receipts
  carry the generation and offers from an older generation are refused. This closes the
  same-campaign reload gap that a campaign id alone cannot: live, `campaignSetupGUID` stayed
  the same across a reload of an earlier save and the generation bumped from 1 to 2.
  Whichever call first observes the regression (list or perform) performs the bump and is the
  one that reports `reattached: true`.
- **Journal**: `pending → confirmed | rejected | unknown`, each row carrying the full action
  identity (request id, action id, kind, args, precondition, seat, turn, age, match). A
  pending row without a final row after a restart becomes `unknown` with its identity intact;
  after human reconciliation an identical retry returns the recorded result without dispatch.
- **After dispatch, only an explicit, well-formed payload refusal proves nothing was sent.**
  Transport loss, malformed or shape-invalid responses, and missing `outcome` are `unknown`.
- **Read-back**: the in-payload read is a hint. A poll counts only when it reports the same
  match and integer turn/age/seat/observer. Ordinary actions additionally require the complete
  originating context (turn, age, player and observer equal to the offer's). `end_turn`
  confirms only on positively identified progression (completion flagged on the same seat and
  turn, the turn counter advanced, or a handoff to another seat); nulls never confirm. The
  poll that established success is stored as `confirmedBy` with the specific matched
  `effect` (e.g. `{"techResearching": hash}`), never the whole roster.
- **Unit and city identity**: offers expose `unitId` / `cityId` matching the observation's
  `id.id`, plus `from` for unit offers, so a client can join offers to observed entities;
  mutation parameters stay host-side.
- **Move destinations**: currently VISIBLE plots only, enforced at enumeration **and** at
  execution (the payload requires an integer `RevealedStates.VISIBLE` and an exact match before
  the path lookup and the send). REVEALED (fogged) plots are excluded because the native path
  preview could reflect hidden occupants; a policy choice to revisit with a leakage test.
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

## Authoritative lifecycle (project-wide review, 2026-09-11)

`attachment.SharedState` owns the game-wide facts every participant must agree on, and lives in
one host state directory (`$CIV7_OBSERVER_STATE_DIR` or `~/.local/state/civ7-observer`):

| file | contents |
|---|---|
| `game.lock` | the single interprocess lock. **Captures take it too**, so an observation can never interleave with a dispatch |
| `generations.json` | `{match: {generation, maxTurn}}` — the attachment generation |
| `inflight.json` | durable reservation of the complete resolved intent, written **before** dispatch |
| `unresolved.json` | game-wide barrier of uncertain outcomes |

Ordering guarantee for a mutation: reserve game-wide → journal `pending` in the seat journal →
dispatch → outcome row → release the reservation. A process that dies at any point after the
reservation leaves an entry that the *next* caller sees while holding the lock, whichever journal
it uses; `needs_reconciliation()` is the union of local unknowns, the shared barrier and stale
reservations. Corrupt shared state raises `STATE_CORRUPT` and refuses to proceed rather than
reading as empty and silently lifting the barrier.

Attachment identity travels with everything: observations carry `attachment`, offers carry
`attachment` and `generation`, and journal rows carry `match` and `generation`.

**Reload detection is partial and must be described as such.** Turn regression is the only signal
the game gives us (`campaignSetupGUID` survives a reload of the same campaign, verified live). A
same-turn or forward reload is undetectable, so the host provides an explicit
`act rebind --note "..."`, which bumps the generation and kills every outstanding offer for that
match. After any load, rebind before resuming.

## Lesson: `canStart(FOUND_CITY)` says only yes or no

Live (agent game, seat 2, turn 2): a founder moved onto a navigable-river tile could not found
there; `canStart(..., false)` returned `{Success: false}` with no reason field, so no offer
appeared and the seat skipped the unit, waiting for an action that would never come. Settler-class
units (those whose `canStart(..., true)` existence check succeeds, exactly the shipped panel's
button test) are now listed even when founding is refused, `canStart: false` with a generic reason,
and the brief shows them as entities with `canFoundHere: false` so the seat moves them.
