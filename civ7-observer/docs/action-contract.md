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
| `produce_unit` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {UnitType: hash})` after `canStart(...)` `Success` | the city's `id.id` (must be in the bound player's `Cities.getCities()`) and a unit definition hash; offers enumerate `GameInfo.Units` per city and keep only `canStart` successes | `canStart` immediately before send; purchases (`CityCommands`) and constructibles/projects (which need plot placement) are not offered | the unit appears at the offered queue position (`cityQueues` in the read-back poll; asynchronous). **BUILD appends to the build queue** (live: three Warriors stacked before this was understood), so the offer is an enqueue: precondition = queue length, and each offer carries the city's `queue` |
| `found_city` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, {X: -9999, Y: -9999, UnitAbilityType: -1})` after `canStart(...)` `Success` (the shipped unit panel sends no target plot for this operation; the settlement is founded where the unit stands) | the unit's `id.id` (must be in the bound player's `Units.getUnits()`); offers enumerate every owned on-map unit and keep only `canStart` successes, binding the offer to the unit's current plot (`from`, plot index as precondition) | `canStart` immediately before send; the unit must still stand on the offered plot | a city owned by the bound player at the offered plot (`cityLocations` in the read-back poll; asynchronous, observed within 0.2–0.4 s live 2026-09-11 turn 1) |
| `expand_city` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, {X, Y})` after `canStart(cityId, EXPAND, {X, Y}, false)` `Success` (new-population placement, as the shipped acquire-tile mode does for a rural claim; specialists via `ASSIGN_WORKER` are not offered yet) | the city's `id.id` and a plot from `canStart(cityId, EXPAND, {}, false).Plots` (the shipped place-population model's query), with the improvement the plot would receive (`ConstructibleTypes`), terrain, feature, river flag and the plot's current yields (`GameplayMap.getYield(x, y, yieldHash, pid)`) | `canStart` immediately before send; the plot must still be in the city's native `Plots` list (precondition = plot index) | the plot index disappears from that city's `Plots` list (`expandPlots` in the read-back poll; asynchronous) |
| `produce_constructible` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {ConstructibleType: hash, X, Y})` after `canStart(...)` `Success` (the shipped production chooser plus its placement mode) | the city's `id.id`, a constructible hash, and a placement plot index (arg3; x/y derived in the payload): offers enumerate `GameInfo.Constructibles`, keep `canStart(BUILD, {ConstructibleType})` successes, and list one offer per plot in `Plots` (existing urban, `placement: urban`) and `ExpandUrbanPlots` (rural plots that would become urban, `placement: newUrban`), each re-checked with X/Y; cost from `Production.getConstructibleProductionCost`, turns from `BuildQueue.getTurnsLeft`, plus terrain, feature, river and current plot yields. Unit offers now carry cost and turns the same way | `canStart` with X/Y immediately before send; the city's queue length must equal the offer's precondition | the building appears at the offered queue position (`cityQueues`; asynchronous) |
| `activate_tradition` | `Game.PlayerOperations.sendRequest(pid, CHANGE_TRADITION, {TraditionType: $index, Action: PlayerOperationParameters.Activate})` after `canStart(...)` `Success` (the shipped policies screen, one card at a time) | a tradition's table index plus its hash (arg2); offers list `Culture.getUnlockedTraditions(slotType)` minus `isTraditionActive` for the tradition, policy and crisis slot types, with slot totals and free counts and the composed description | `canStart` immediately before send; the slot type's active count must equal the offer's precondition and the card must still be inactive | the hash appears in `getActiveTraditions` across slot types (`activeTraditions` in the read-back poll) |
| `confirm_traditions` | `Game.PlayerOperations.sendRequest(pid, CONSIDER_ASSIGN_TRADITIONS, {})` after `canStart` (the policies screen sends it on confirm; it is what clears the TRADITIONS blocker) | none; offered only while the end-turn blocker is TRADITIONS | `canStart` immediately before send | the end-turn blocker is no longer TRADITIONS (`endTurnBlocking` in the read-back poll) |
| `narrative_choice` | `Game.PlayerOperations.sendRequest(pid, CHOOSE_NARRATIVE_STORY_DIRECTION, {TargetType: linkKey, Target: storyId, Action: Activate})` after `canStart(...)` `Success` (the shipped narrative screen) | the first pending story (`Stories.getFirstPendingDiscoveryLastMetID()`, the story's `id.id` as arg, its type hash as precondition) and one answer per eligible link (`NarrativeStory_Links` from the story type, or `getOrderedLinks` for variable-link stories; `LINKED`, or `LINKED_*_REQUISITE` with `determineRequisiteLink`), the link's hash as arg2, or `-1` for the single CLOSE answer a story without links gets; text from `determineNarrativeInjection` (option, reward, imperative), cost and `canAfford` | `canStart` immediately before send; the story must still be pending with the same type; the key is re-derived from the hash inside the game | the story id leaves the pending list (`pendingStories` in the read-back poll) |
| `found_pantheon` | `Game.PlayerOperations.sendRequest(pid, FOUND_PANTHEON, {BeliefType: hash})` after `canStart(...)` `Success` (the shipped pantheon chooser) | a `GameInfo.Beliefs` row with `BeliefClassType` BELIEF_CLASS_PANTHEON that the native check accepts; name and description composed; precondition = `Religion.getNumPantheons()` | `canStart` immediately before send; the belief must still be a pantheon belief and the pantheon count unchanged | the hash appears in `Religion.getPantheons()` (`pantheons` in the read-back poll). Contract from the shipped script and a live read of the API; the PANTHEON blocker has not been observed live yet |
| `change_government` | `Game.PlayerOperations.sendRequest(pid, CHANGE_GOVERNMENT, {GovernmentType: $index, Action: Activate})` after `canStart(...)` `Success` (the shipped government chooser) | a `GameInfo.Governments` row (index as arg, hash as arg2), restricted to `GameInfo.StartingGovernments` while no government is held; name, description and celebration name composed; precondition = `Culture.getGovernmentType()` (-1 when none) | `canStart` immediately before send; identity and the current government re-checked | `Culture.getGovernmentType()` equals the row's hash or index (`governmentType` in the read-back poll; which of the two the engine reports is recorded in the effect) |
| `buy_attribute` | `Game.PlayerOperations.sendRequest(pid, BUY_ATTRIBUTE_TREE_NODE, {ProgressionTreeNodeType: hash})` after `canStart(...)` `Success` (the shipped attribute-tree screen) | nodes of the `TREE_ATTRIBUTE_*` trees the native check accepts, with the attribute, its available points, the wildcard points, the node description and cost; precondition = the node's `Game.ProgressionTrees.getNode` state | `canStart` immediately before send; the node's state must be unchanged | the node's state changes to unlocked (`attributeNodes` in the read-back poll) |
| `consider_attributes` | `Game.PlayerOperations.sendRequest(pid, CONSIDER_ASSIGN_ATTRIBUTE, {})` after `canStart` (the screen sends it on close) | none; offered only while `NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL` blocks the turn | `canStart` immediately before send | that notification is gone from the blocking list |
| `end_turn` | `GameContext.sendTurnComplete()` | none | `Game.Notifications.getEndTurnBlockingType(pid) === EndTurnBlockingTypes.NONE (0)` and `!GameContext.hasSentTurnComplete()` | `hasSentTurnComplete() true`, then the seat/turn moves on |

Blocking types observed: `UNITS` (23669119) while any unit has moves and no order,
`RESEARCH` (-286188551) while no research is selected, `PRODUCTION` while a city has no build,
`NEW_POPULATION` (442844772) while a city has grown and the new population is unplaced. Some
blockers are data-driven and absent from `EndTurnBlockingTypes` (live: `-2084516792` for a discovery
narrative); the payloads then name the blocker after the bound player's notification that has
`BlocksTurnAdvancement` true (`NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION`), and the brief maps
those names too. Live (turn 8) the civic blocker itself came back as a raw value and was named
`NOTIFICATION_CHOOSE_CULTURE_NODE`, so every supported decision is also mapped under its
notification name. Live (turn 8, seat 0) the blocker value was the enum's `CULTURE` while the
notifications that blocked were `NOTIFICATION_CHOOSE_GOVERNMENT`, `NOTIFICATION_COMMAND_UNITS` and
`NOTIFICATION_TRADITIONS_AVAILABLE`: the value is a category. The offers context therefore reports
`blockingNotifications` (the bound player's notifications with `BlocksTurnAdvancement`), the brief
marks every decision they map to as required, and pauses only when one of them is unmapped. `Game.Notifications.getTypeName`
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
  `produce_unit` / `produce_constructible` = the city's build-queue length; `found_city` = the unit's plot index (and
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
