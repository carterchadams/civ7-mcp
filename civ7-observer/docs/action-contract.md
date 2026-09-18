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
| `unit_order` | `Game.UnitOperations.sendRequest(unitId, operationHash, {X: -9999, Y: -9999, UnitAbilityType: -1})` after `canStart(...)` `Success` (the shipped unit panel's own loop over `GameInfo.UnitOperations`) | the standing orders a unit can take with no target: **Fortify, Alert, Sleep, Heal** (`UNITOPERATION_REST_UNTIL_HEALED`). The operation travels as its table hash and **the payload itself restricts it to that fixed set**, so nothing needing a plot (attack, pillage, teleport) is reachable through this kind. Offers carry the order's name and description and the unit's `damage` / `maxDamage`, which is what makes healing a visible choice; skip and move offers carry `damage` too. Precondition = the unit's movement remaining | `canStart` immediately before send; the operation must still be in the standing set and the unit's movement unchanged | the unit leaves `unitsReadyToMove`, exactly as a skip does |
| `move_unit` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, {X, Y, Modifiers: 0})` after `canStart(...)` | the unit's `id.id` plus a target plot **anywhere the unit can reach this turn** (breadth-first over adjacency out to its remaining movement, capped at four rings and eighteen offers per unit; each offer carries `steps`) that is **currently VISIBLE** to the bound player; `Modifiers` is pinned to NONE so a move can never become an attack, a war declaration, or a step into unexplored land (the shipped UI uses `ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION` for human clicks) | `canStart` immediately before send; visibility and a one-turn native path re-checked inside the payload; **`Units.getPathTo(unitId, {x, y})` must return a non-empty path whose last `turns` entry is 1** | unit location equals the target (asynchronous) |
| `produce_unit` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {UnitType: hash})` after `canStart(...)` `Success` | the city's `id.id` (must be in the bound player's `Cities.getCities()`) and a unit definition hash; offers enumerate `GameInfo.Units` per city and keep only `canStart` successes | `canStart` immediately before send; purchases (`CityCommands`) and constructibles/projects (which need plot placement) are not offered | the unit appears at the offered queue position (`cityQueues` in the read-back poll; asynchronous). **BUILD appends to the build queue** (live: three Warriors stacked before this was understood), so the offer is an enqueue: precondition = queue length, and each offer carries the city's `queue` |
| `purchase_unit` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.PURCHASE, {UnitType: hash})` after `canStart(...)` `Success` (the shipped production chooser's purchase path) | the city's `id.id` and a unit hash the native check accepts; the check's own result carries the gold `Cost`, which the offer reports alongside the seat's floored gold balance. Precondition = the seat's unit count, so one purchase expires the rest of the listing | `canStart` immediately before send; the unit count must be unchanged | the seat's unit count rises (`unitCount` in the read-back poll) |
| `purchase_constructible` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.PURCHASE, {ConstructibleType: hash, X, Y})` after `canStart(...)` `Success` | the city's `id.id`, a constructible hash and the plot index of a placement the BUILD query offered (`Plots` = existing urban, `ExpandUrbanPlots` = rural that would become urban); the purchase check's own `Cost` is reported with the seat's gold and an `affordable` flag. Precondition = the seat's floored gold balance | `canStart` with the plot immediately before send; the treasury must be unchanged | the treasury is lighter than the offer's balance (`goldBalance` in the read-back poll). Buying never touches the build queue |
| `produce_project` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {ProjectType: hash})` after `canStart(...)` `Success` | the city's `id.id` and a project hash the native check accepts; projects take no plot and no gold. Precondition = the city's build queue length, so the offer is an enqueue like the other two | `canStart` immediately before send; the queue length must be unchanged | the project is the queue item at the offered position (`cityQueues` in the read-back poll) |
| `disband_unit` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.DELETE, {X: -9999, Y: -9999, UnitAbilityType: -1})` after `canStart(...)` `Success` (the shipped unit-action list's no-target argument shape) | the unit's own id. **Destructive**: the offer carries `destructive`, `requiresConfirmation` and the engine's own `ConfirmDialogBody` warning, plus a `guidance` line saying what is lost. `perform_action` refuses it outright unless the caller also passes `confirm=true`. Precondition = the seat's unit count | the confirmation flag on the offer is checked before anything is rendered or dispatched; then `canStart` immediately before send and the roster size must be unchanged | the unit is no longer in `unitLocations` in the read-back poll |
| `promote_town_to_city` | `Game.CityCommands.sendRequest(townId, CityCommandTypes.PURCHASE, {Directive: OrderTypes.ORDER_TOWN_UPGRADE})` after `canStart(...)` `Success` (the shipped production chooser's `ConvertToCity`) | the town's `id.id` only; the price comes from the settlement's own `Gold.getTownUpgradeCost()`, since this check returns no `Cost`. Precondition = the seat's floored gold balance | `canStart` immediately before send; the settlement must still be a town and the treasury unchanged | the settlement is no longer a town (`townFlags` in the read-back poll) |
| `research_goal` / `civic_goal` | `SET_TECH_TREE_TARGET_NODE` / `SET_CULTURE_TREE_TARGET_NODE` `{ProgressionTreeNodeType: hash}` after `canStart` `Success` (the shipped tree screens' "set as target") | any node of the seat's own active tree, however far off, that the native check accepts as a target, other than the one already held. Reported with its cost, its turn estimate and the goal currently held. Precondition = the node currently held (`-1` for none) | `canStart` immediately before send; the held goal must be unchanged | `Techs.getTargetNode()` / `Culture.getTargetNode()` equals the offered node (`techTargetNode` / `civicTargetNode` in the read-back poll). Setting a goal does **not** also set the current research: that stays the seat's separate `research` / `civic` choice, one operation per action |
| `start_diplomatic_action` | `Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, <the listing's own operationType>, {Amount: 1, Player1, Type: actionType, Player2 or ID: target})` after `canStart(...)` `Success` (the shipped diplomacy panel's quick-start) | a met civilization's id and an action type from `Game.Diplomacy.getProjectDataForUI(seat, target, ...)` whose `projectStatus` is `PROJECT_AVAILABLE` and whose `targetList1` entry for that target carries a price. A project whose listing carries `targetList2` is offered once per secondary target the engine accepts, with the entry's `parameterName` (Player3, Amount2, Unit, City, else ID2) deciding which argument carries it, exactly as the shipped target-select screen builds it; the offer shows the secondary target and the payload re-reads the parameter name from the engine's listing at dispatch. The offer's `expect` says what would prove it: `influence` for a priced action, `war` or `alliance` for a free one. A free action that changes no relationship leaves no signal and is withheld. Declaring war carries `destructive` and `requiresConfirmation`, so `perform_action` needs `confirm=true`. The offer names the target and reports the influence cost, the seat's balance and the action's group. Precondition = the seat's floored influence balance | the listing is re-read and the project matched again by action type; the target must still be met, the treasury unchanged, and the engine's check must accept one of the two target shapes | for `influence`, the balance is lighter than the offer's; for `war` or `alliance`, this seat's relationship with that civilization has flipped (`influenceBalance` and `diplomaticRelations` in the read-back poll) |
| `cancel_alliance` | `Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes.CANCEL_ALLIANCE, {Player1, Player2, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_FORM_ALLIANCE})` after `canStart` `Success` | the allied civilization's id only. There is no project row for ending an alliance: the shipped panel sends the cancel operation carrying the **alliance** action type once the seat is already allied. Offered only while an alliance exists. Precondition = 1 | `canStart` immediately before send; the seat must still be allied with that civilization | the seat is no longer allied with it (`diplomaticRelations` in the read-back poll) |
| `respond_to_proposal` | `Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes.RESPOND_DIPLOMATIC_ACTION, {ID: eventId, Type: DiplomaticResponseTypes.DIPLOMACY_RESPONSE_ACCEPT or _REJECT})` after `canStart` `Success` (the shipped reaction panel) | one of this seat's own diplomatic events (`Game.Diplomacy.getPlayerEvents`) where it is the target, offered twice, once per answer, with the proposer's name and the action's description. The turn will not end until each is answered. Precondition = 1 | the event must still be pending for this seat and the response must be accept or reject; `canStart` immediately before send | the event's own `responseType` equals the answer sent (`proposalResponses` in the read-back poll). The engine's check keeps accepting a second answer after the first, so it is no signal |
| `send_merchant` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.MOVE_TO, {X, Y, Modifiers: MOVE_IGNORE_UNEXPLORED_DESTINATION})` after `canStart` `Success` (the shipped trade chooser's own "Send Merchant" fallback) | a merchant (a unit whose definition has `MakeTradeRoute`) with movement left and a route the seat's own `Trade.projectPossibleTradeRoutes()` marks `SUCCESS` whose target city is out of range; the destination is the nearest of that city's plots a native path reaches. Precondition = the merchant's plot | `canStart` immediately before send; the merchant must still stand where it did and a path must still exist | the merchant is somewhere other than where it stood (`unitLocations` in the read-back poll). Arrival is a later turn's business; the route is then made with `make_trade_route`, which is offered only in range |
| `keep_captured_city`, `raze_captured_city`, `liberate_captured_city` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.DESTROY, {Directive: 2 / 3 / 0})` after `canStart` `Success` (the shipped capture chooser; 1 is declared but never sent) | a settlement whose `isJustConqueredFrom` is set, once per directive the engine accepts, with population and wonder count. Raze and liberate carry `requiresConfirmation`. Precondition = 1 | `canStart` immediately before send; the choice must still be pending | keep: the city is still owned, no longer pending and not razing; raze: `isBeingRazed`; liberate: the city has left the roster (`capturedPending`, `razing`, `cityIds` in the read-back poll) |
| `choose_city_state_bonus` | `CHOOSE_CITY_STATE_BONUS {OtherPlayer: cityState, CityStateBonusType: hash}` after `canStart` `Success` (the shipped bonus chooser) | while `Game.CityStates.getCityStateBonusToSelect(seat)` names a city-state, each `GameInfo.CityStateBonuses` row `canHaveBonus` allows. Precondition = that city-state's id | `canStart` immediately before send; the same city-state must still be the one pending | no bonus is pending for that city-state any more (`cityStateBonusPending`) |
| `support_diplomatic_action` | `SUPPORT_DIPLOMATIC_ACTION {ID: eventId, Type: DIPLOMACY_TOKEN_GLOBAL, Amount: 1, SubType: side}` after `canStart` `Success` (the shipped action-details screen; opposing is supporting the other side, and there is no shipped operation to withdraw support) | one token toward either side of one of the seat's own diplomatic events, per side the engine allows, with the token's influence price from `getInfluenceForNextSupport`. Precondition = the seat's floored influence | `canStart` immediately before send; the event must still exist and the treasury be unchanged | the influence balance is lighter (`influenceBalance`) |
| `acknowledge_advisor_warning` | `VIEWED_ADVISOR_WARNING {Target: notificationId}` after `canStart` `Success` (the shipped notification handler's dismiss) | each pending `NOTIFICATION_ADVISOR_WARNING_*`. Never blocks the turn; it expires at end of turn on its own. Precondition = 1 | the notification must still be pending | the notification has left the seat's list (`advisorWarnings`) |
| `join_ally_war` | `DECLARE_WAR {Player1, Player2: enemy, Type: DIPLOMACY_ACTION_DECLARE_WAR}` after `canStart` `Success` (the shipped call-to-arms screen's accept) | while `Game.Diplomacy.getNextCallToArms(seat)` names a war and the seat is allied with one side, the other side's civilization as the enemy. Carries `requiresConfirmation`. Staying out is the existing `cancel_alliance` with the ally, as the shipped screen does it. Precondition = the call's event id | `canStart` immediately before send; the same call must still be pending and the seat not yet at war | the seat is at war with the enemy (`diplomaticRelations`) |
| `propose_peace` | the shipped peace screen's bounded workflow: `Game.DiplomacyDeals.clearWorkingDeal({direction: OUTGOING, player1: seat, player2: other})`, `addItemToWorkingDeal(id, {type: AGREEMENTS, agreementType: MAKE_PEACE})`, then `sendWorkingDeal(id, PROPOSED)`, each step checked before the next (the draft must hold exactly the one agreement before it is sent) | a met civilization the seat is at war with, when `Diplomacy.canMakePeaceWith` allows and no deal is on the table. A plain peace with no further terms; terms are not offered. Precondition = 0 | the war, the permission and the empty table are re-checked; a draft that does not hold the agreement is never sent | `DiplomacyDeals.hasPendingDeal(seat, other)` is true (`pendingDeal` in the read-back's relations). Acceptance is the other side's, and is never inferred |
| `accept_peace`, `reject_peace` | `sendWorkingDeal({direction: INCOMING, player1: other, player2: seat}, ACCEPTED / REJECTED)` | a met civilization the seat is at war with when a deal is on the table and the incoming working deal holds at least one term. **Offline-verified only**: the incoming deal id's shape is taken from the shipped screen's outgoing form mirrored, and no live war has yet let it be checked. Precondition = 1 | the table and the terms are re-checked | accept: the war is over (`atWar` false); reject: the table is clear and the war still on |
| `pillage`, `coastal_raid`, `pillage_route` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes[<kind>], {X, Y})` after `canStart` `Success` (the shipped pillage modes) | the plots `canStart(op, {})` lists for the unit, each re-checked with its coordinates. Precondition = the unit's moves | the unit must still have the same moves and the plot must still pass | the unit's moves have fallen (`unitMoves`); the attack is spent whatever the outcome |
| `plunder_trade_route`, `wake_unit`, `cancel_order` | the generic unit command with the shipped no-target shape | as the other generic unit commands. Wake and cancel prove themselves by the unit becoming ready to move; plunder by the unit's moves falling | as the generic unit commands | `unitsReadyToMove` gains the unit; `unitMoves` falls |
| `spread_religion` | `SPREAD_RELIGION {X, Y, UnitAbilityType: -1}` after `canStart` `Success` | the unit's own activation plots (`getActivationOperationPlots`), as the shipped button highlights them; charges come from the check's `ChargesRemaining`, since no unit accessor exists. Precondition = the charges left | charges unchanged and the plot still accepted | a charge fewer (`unitCharges`) |
| `town_growth_mode` | `CHANGE_GROWTH_MODE {Type: GrowthTypes.EXPAND, ProjectType: NO_PROJECT, City}` after `canStart` `Success` (the shipped focus list's growth entry) | a town running a project. Precondition = that project | the same project must still be running | the town's project is cleared (`townProjects`) |
| `queue_remove`, `queue_move_up`, `queue_move_down` | `BUILD {InsertMode: RemoveAt, QueueLocation}` or `{InsertMode: Swap, QueueSourceLocation, QueueDestinationLocation}` after `canStart` `Success` (the shipped build-queue panel) | each queued item, by position and item type. Precondition = the queue length | the item must still be at that position and the length unchanged | the queue is one shorter, or the item sits at its destination (`cityQueues`) |
| `deactivate_tradition` | `CHANGE_TRADITION {TraditionType, Action: Deactivate}` after `canStart` `Success` (the shipped policies screen; a swap is a deactivation then an activation) | each active card per slot type the engine will release. The engine refuses outside a policy window, so this appears only when activation does. Precondition = active count | the card must still be active | the card has left the active list (`activeTraditions`) |
| `unassign_resource`, `swap_resources` | `ASSIGN_RESOURCE {Location, City, Action: Deactivate}` and `SWAP_RESOURCES {Location, Location2}` after `canStart` `Success` (the shipped commerce screen) | each assigned resource, and each cross-settlement pair the engine accepts. Refused outside a resource window, so these appear when assignment does. Precondition = the resource's settlement | the resource must still be where it was | it has no settlement, or a different one (`resourceAssignments`) |
| `found_religion` | `FOUND_RELIGION {ReligionType: hash}` after `canStart` `Success` (the shipped belief picker) | any named religion in `GameInfo.Religions` the engine's check still allows (one another civilization holds is refused); the custom ones need a typed name and are not offered. Precondition = `-1`, the seat's current religion | `canStart` immediately before send; the seat must still hold no religion | `Religion.getReligionType()` equals the offered hash (`religionType` in the read-back poll) |
| `add_belief` | `ADD_BELIEF {BeliefType: hash}` after `canStart` `Success` | any belief the engine's check allows, once the seat holds a religion, with its class. Precondition = the number of beliefs held (`Religion.getBeliefs().length`) | `canStart` immediately before send; the held beliefs must be unchanged | the belief appears in `Religion.getBeliefs()` (`beliefsHeld` in the read-back poll). `getNumBeliefsEarned` counts slots, not beliefs, and never moves |
| `attack` | ranged: `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.RANGE_ATTACK, {X, Y})`; melee: `...MOVE_TO, {X, Y, Modifiers: ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION}` — the engine's own `Game.Combat.testAttackInto` picks which, exactly as the shipped dispatcher does | one of this unit's own reachable targets (`Units.getReachableTargets`, falling back to adjacency) that is currently visible, holds a defender, and the native check accepts. The offer carries the attacker's strength and health, the defender's unit type and how hurt it is, and `startsWar`. An attack that would start a war carries `destructive` and `requiresConfirmation`, so `perform_action` needs `confirm=true`. Precondition = the unit's `attacksRemaining` | `canStart` for the chosen operation immediately before send; the plot must still be visible and the attack count unchanged | the unit's `attacksRemaining` has fallen (`unitAttacks` in the read-back poll). A strike spends the attack whatever its outcome, and nothing else spends it |
| `upgrade_unit`, `pack_army`, `join_army`, `leave_army`, `unpack_army`, `activate_great_person` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes[<kind>], args)` after `canStart` `Success`, where args is the shipped no-target shape `{X: -9999, Y: -9999, UnitAbilityType: -1}` or `{X, Y, UnitAbilityType: -1}` for the four that take a plot | the unit's id, and for a plot command one of the plots the engine's own `Plots` list names for it. The kind **is** the engine's command name, validated host-side, so no caller text reaches the enum. Upgrade's gold price and target arrive pre-composed in the check's `AdditionalDescription`, reported as `description`. Each offer says in `expect` what would prove it. Activating a great person consumes the unit and carries `requiresConfirmation` | `canStart` with the same args immediately before send; the unit's relevant state (type, army, army size) must be unchanged | `type`: the unit's type changed (`unitTypes`); `army`: its army id changed (`unitArmies`); `armySize`: its army's unit count changed (`armySizes`); `gone`: the unit left `unitLocations` |
| `assign_specialist` | `Game.PlayerOperations.sendRequest(BOUND_PLAYER_ID, PlayerOperationTypes.ASSIGN_WORKER, {Location: plotIndex, Amount: 1})` after `canStart` `Success` (the shipped tile picker) | the settlement's `id.id` and a plot from its own `Workers.GetAllPlacementInfo()` that is not `IsBlocked`, offered only while the settlement's `Growth.isReadyToPlacePopulation` is true (live: without a population point pending, the engine's check accepts the request and then drops it). Note this is a **player** operation taking a plot **index**, not a city operation taking x/y. The offer carries the yields the plot makes now and would make with one more specialist, and the upkeep each way, which is the whole trade. Precondition = that plot's `NumWorkers` | the placement info is re-read and the plot matched again; it must still be unblocked with the same worker count | the plot's `NumWorkers` has risen (`specialistPlots` in the read-back poll) |
| `found_city` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes.FOUND_CITY, {X: -9999, Y: -9999, UnitAbilityType: -1})` after `canStart(...)` `Success` (the shipped unit panel sends no target plot for this operation; the settlement is founded where the unit stands) | the unit's `id.id` (must be in the bound player's `Units.getUnits()`); offers enumerate every owned on-map unit and keep only `canStart` successes, binding the offer to the unit's current plot (`from`, plot index as precondition) | `canStart` immediately before send; the unit must still stand on the offered plot | a city owned by the bound player at the offered plot (`cityLocations` in the read-back poll; asynchronous, observed within 0.2–0.4 s live 2026-09-11 turn 1) |
| `expand_city` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, {X, Y})` after `canStart(cityId, EXPAND, {X, Y}, false)` `Success` (new-population placement, as the shipped acquire-tile mode does for a rural claim; specialists via `ASSIGN_WORKER` are not offered yet) | the city's `id.id` and a plot from `canStart(cityId, EXPAND, {}, false).Plots` (the shipped place-population model's query), with the improvement the plot would receive (`ConstructibleTypes`), terrain, feature, river flag and the plot's current yields (`GameplayMap.getYield(x, y, yieldHash, pid)`) | `canStart` immediately before send; the plot must still be in the city's native `Plots` list (precondition = plot index) | the plot index disappears from that city's `Plots` list (`expandPlots` in the read-back poll; asynchronous) |
| `town_project` | `Game.CityCommands.sendRequest(cityId, CityCommandTypes.CHANGE_GROWTH_MODE, {Type: GrowthTypes.PROJECT, ProjectType: hash, City: cityId})` after `canStart(...)` `Success` | a town (`isTown`) and a `GameInfo.Projects` row the native check accepts, with its name, description and cost; precondition = the town's current `Growth.projectType` (-1 when none) | `canStart` immediately before send; the settlement must still be a town and its project unchanged | `Growth.projectType` equals the chosen hash (`townProjects` in the read-back poll) |
| `produce_constructible` | `Game.CityOperations.sendRequest(cityId, CityOperationTypes.BUILD, {ConstructibleType: hash, X, Y})` after `canStart(...)` `Success` (the shipped production chooser plus its placement mode) | the city's `id.id`, a constructible hash, and a placement plot index (arg3; x/y derived in the payload): offers enumerate `GameInfo.Constructibles`, keep `canStart(BUILD, {ConstructibleType})` successes, and list one offer per plot in `Plots` (existing urban, `placement: urban`) and `ExpandUrbanPlots` (rural plots that would become urban, `placement: newUrban`), each re-checked with X/Y; cost from `Production.getConstructibleProductionCost`, turns from `BuildQueue.getTurnsLeft`, plus terrain, feature, river and current plot yields. Unit offers now carry cost and turns the same way | `canStart` with X/Y immediately before send; the city's queue length must equal the offer's precondition | the building appears at the offered queue position (`cityQueues`; asynchronous) |
| `activate_tradition` | `Game.PlayerOperations.sendRequest(pid, CHANGE_TRADITION, {TraditionType: $index, Action: PlayerOperationParameters.Activate})` after `canStart(...)` `Success` (the shipped policies screen, one card at a time) | a tradition's table index plus its hash (arg2); offers list `Culture.getUnlockedTraditions(slotType)` minus `isTraditionActive` for the tradition, policy and crisis slot types, with slot totals and free counts and the composed description | `canStart` immediately before send; the slot type's active count must equal the offer's precondition and the card must still be inactive | the hash appears in `getActiveTraditions` across slot types (`activeTraditions` in the read-back poll) |
| `confirm_traditions` | `Game.PlayerOperations.sendRequest(pid, CONSIDER_ASSIGN_TRADITIONS, {})` after `canStart` (the policies screen sends it on confirm; it is what clears the TRADITIONS blocker) | none; offered only while the end-turn blocker is TRADITIONS | `canStart` immediately before send | the end-turn blocker is no longer TRADITIONS (`endTurnBlocking` in the read-back poll) |
| `narrative_choice` | `Game.PlayerOperations.sendRequest(pid, CHOOSE_NARRATIVE_STORY_DIRECTION, {TargetType: linkKey, Target: storyId, Action: Activate})` after `canStart(...)` `Success` (the shipped narrative screen) | the first pending story (`Stories.getFirstPendingDiscoveryLastMetID()`, the story's `id.id` as arg, its type hash as precondition) and one answer per eligible link (`NarrativeStory_Links` from the story type, or `getOrderedLinks` for variable-link stories; `LINKED`, or `LINKED_*_REQUISITE` with `determineRequisiteLink`), the link's hash as arg2, or `-1` for the single CLOSE answer a story without links gets; text from `determineNarrativeInjection` (option, reward, imperative), cost and `canAfford` | `canStart` immediately before send; the story must still be pending with the same type; the key is re-derived from the hash inside the game | the story id leaves the pending list (`pendingStories` in the read-back poll) |
| `found_pantheon` | `Game.PlayerOperations.sendRequest(pid, FOUND_PANTHEON, {BeliefType: hash})` after `canStart(...)` `Success` (the shipped pantheon chooser) | a `GameInfo.Beliefs` row with `BeliefClassType` BELIEF_CLASS_PANTHEON that the native check accepts; name and description composed; precondition = `Religion.getNumPantheons()` | `canStart` immediately before send; the belief must still be a pantheon belief and the pantheon count unchanged | the hash appears in `Religion.getPantheons()` (`pantheons` in the read-back poll). Contract from the shipped script and a live read of the API; the PANTHEON blocker has not been observed live yet |
| `greet_new_civilization` | `Game.PlayerOperations.sendRequest(pid, RESPOND_DIPLOMATIC_FIRST_MEET, {Player1: pid, Player2: other, Type: greeting})` after `canStart(...)` `Success` | the three `DiplomacyPlayerFirstMeets` greetings (friendly, neutral, unfriendly) with the influence cost from `Game.Diplomacy.getFirstMeetResponseCostAndRelDelta` and the seat's own influence balance. **The other player's id comes from the seat's own blocking `NOTIFICATION_PLAYER_MET`**, whose summary reads "You have met [PlayerName:N] of ...": no roster is enumerated and no other player object is looked up. arg2 is that id, arg3 and the precondition are the notification id | the notification must still exist, still block, and still name the same player, all re-derived inside the game; `canStart` immediately before send (it accepts any `Player2`, including -1, so it is not the check that matters) | `NOTIFICATION_PLAYER_MET` leaves the live blocking list |
| `change_government` | `Game.PlayerOperations.sendRequest(pid, CHANGE_GOVERNMENT, {GovernmentType: $index, Action: Activate})` after `canStart(...)` `Success` (the shipped government chooser) | a `GameInfo.Governments` row (index as arg, hash as arg2), restricted to `GameInfo.StartingGovernments` while no government is held; name, description and celebration name composed; precondition = `Culture.getGovernmentType()` (-1 when none) | `canStart` immediately before send; identity and the current government re-checked | `Culture.getGovernmentType()` equals the row's hash or index (`governmentType` in the read-back poll; which of the two the engine reports is recorded in the effect) |
| `buy_attribute` | `Game.PlayerOperations.sendRequest(pid, BUY_ATTRIBUTE_TREE_NODE, {ProgressionTreeNodeType: hash})` after `canStart(...)` `Success` (the shipped attribute-tree screen) | nodes of the `TREE_ATTRIBUTE_*` trees the native check accepts, with the attribute, its available points, the wildcard points, the node description and cost; precondition = the node's `Game.ProgressionTrees.getNode` state | `canStart` immediately before send; the node's state must be unchanged | the node's state changes to unlocked (`attributeNodes` in the read-back poll) |
| `assign_resource` | `Game.PlayerOperations.sendRequest(pid, ASSIGN_RESOURCE, {Location: {x, y}, City: cityId})` after `canStart(...)` `Success` (the shipped allocation screen) | one offer per (owned resource, settlement) pair the native check accepts, with the resource's class, effect text and origin, the settlement's capacity and count; precondition = `Resources.getCountResourcesToAssign()`. Assignments are read from each settlement's own `Resources.getAssignedResources()` (live: `Resources.getCityIDAssigned` returns nothing usable) | `canStart` immediately before send; the pending count unchanged | the plot index appears in the target settlement's assigned list (`resourceAssignments` in the read-back poll) |
| `consider_resources` | `CONSIDER_ASSIGN_RESOURCE {}` after `canStart` | none; offered only while `NOTIFICATION_ASSIGN_NEW_RESOURCES` blocks and not startable while a resource can still be assigned | `canStart` immediately before send | that notification is gone from the blocking list |
| `choose_celebration` | `CHOOSE_GOLDEN_AGE {GoldenAgeType: hash}` after `canStart` (the shipped celebration chooser hashes the type string) | `Culture.getGoldenAgeChoices()` (type strings) resolved to `GameInfo.GoldenAges` rows, with name and description; precondition = the number of choices | `canStart` immediately before send; the choice must still be listed | the choice list empties or the notification leaves |
| `choose_age_civilization` | `GameSetup.setPlayerParameterValue(pid, "AgeTransitionPlayerCivilization", civilizationType)`: **the only non-operation mutation in the catalog**, exactly what the shipped in-game transition screen does (`civ-select-model.js` writes the parameter; `age-transition-screen.js` finishes with the operation below) | the bound seat's `AgeTransitionPlayerCivilization` setup parameter's domain, one offer per civilization with the game's own validity reason (0 valid, 3 locked content, 4 not valid for this transition), name, full name, unique ability text, and `historical` when `CivilizationUnlocks` (config database) lists it as a successor of the seat's current civilization; RANDOM is never offered; the civilization hash is the argument and the row's type key is re-derived in the game. Precondition = the currently selected civilization (its hash, or -1 for none/RANDOM). Offered only while `NOTIFICATION_CHOOSE_CIVILIZATION` blocks | the value must still be in the domain with reason 0 and the current selection unchanged; the write is reversible until the finish | the parameter's value equals the chosen type (`ageTransitionCivilization` in the read-back poll) |
| `finish_age_transition` | `Game.PlayerOperations.sendRequest(pid, SET_AGE_TRANSITION_DATA, {Finished: true})` after `canStart` | none; **not startable until a concrete civilization is selected** (never RANDOM); precondition = the selected civilization's hash | `canStart` immediately before send; the selection unchanged | like an end turn: the choose-civilization notification gone on the same seat, or the age, turn or seat moving on. **One-way**: once every seat has finished, the next age begins. Mementos (`AgeTransitionPlayerMemento*`) are left untouched |
| `pick_legacy_card` | `ADVANCED_START_MODIFY_DECK {Type: "ADD", ID: cardId}` after `canStart`; the card's rewards are applied by `finish_legacy_deck`, as the shipped confirm does | `AdvancedStart.getAvailableCards()` minus the deck, with name, description, cost and the seat's legacy points; a card with a placement effect is listed with `needsPlacement`. A deck entry wraps its card (`{id: instance, info: card}`); ids are strings, so `Database.makeHash(id)` is the integer handle. Precondition = deck size | `canStart` immediately before each send; the card must still be available and not already in the deck | the card's hash appears in the deck (`legacyDeck` in the read-back poll). **Taking a card takes its reward**: the engine never reports an effect as spent, so this is the only point at which each lands exactly once |
| `finish_legacy_deck` | `ADVANCED_START_USE_EFFECT {ID: effectId}` once per `amount` for every non-placement effect of every card in the deck, then `ADVANCED_START_MARK_COMPLETED {}`, all after `canStart` | none; precondition = deck size. Finishing forfeits unspent legacy points and turns an unplaced settlement (`pendingPlacements`) into a plain settler (`DidNotPlaceEffectType`) | `canStart` immediately before each send | `NOTIFICATION_AGE_TRANSITION` leaves the live blocking list |
| `drop_legacy_card` | `ADVANCED_START_MODIFY_DECK {Type: "REMOVE", ID: cardId}` after `canStart` | a card in `AdvancedStart.getCards()`; precondition = deck size | `canStart` immediately before send | the card's hash leaves `legacyDeck` |
| `place_legacy_settlement` | `ADVANCED_START_PLACE_SETTLEMENT {ID: effectId, X, Y}` after `canStart` (the shipped placement mode's exact shape) | a placement effect (`isPlacementEffect`, `amount > 0`) of a card in the deck, and a plot: the engine's `Plots` list for `{ID}` when it returns one, otherwise every plot within six of the seat's own settlements that `canStart` accepts, capped at 24 per effect; precondition = the effect's remaining `amount` | `canStart` immediately before send | the effect's remaining amount in `legacyPlacements` falls below the precondition |
| `select_capital` | `SELECT_CAPITAL {Player1: pid, City: cityId, Swap}` after `canStart`, where `Swap` (rename) is true only when `previousAgeCivilizationType !== civilizationType`, as the shipped confirm sends it | a city id from `Cities.getPotentialSwitchCapitalCityIds()` other than the current capital, offered while the legacies decision blocks; precondition = the current capital's id; `arg2` binds the naming flag | `canStart` immediately before send; the city must still be in the legal set | `Cities.getCapital().id.id` equals the choice |
| `syncretism_units`, `syncretism_infrastructure`, `syncretism_self` | `CHOOSE_SYNCRETISM_{UNITS,INFRASTRUCTURE,SELF} {CivilizationType: hash}` after `canStart` (the shipped syncretism screen) | a civilization hash from `Game.Unlocks.getSyncreticCivUnlocksForChoice(pid, SyncreticChoiceTypes.X)` for that choice kind, offered while `Identity.getSyncreticCivType()` names no civilization; `unlocks` lists what the choice gives (`getUnitChoiceSyncreticUnlocks` and its siblings) | `canStart` immediately before send; the hash must still be in that kind's list | `Identity.getSyncreticCivType()` equals the choice |
| `reinforce_army`, `rebase`, `teleport_to_city`, `establish_base`, `disperse_independent`, `convert_independent_to_city_state`, `repair`, `remove_feature`, `remove_improvement`, `plant_forest`, `harvest_resource`, `build_improvement`, `embed_lookout`, `search`, `aerial_recon`, `call_reinforcements` | `Game.UnitOperations.sendRequest(unitId, UnitOperationTypes[kind], {X, Y})` for a plot action, or `{X: -9999, Y: -9999, UnitAbilityType: -1}` for a no-target one, after `canStart` (the shipped unit-action loop's two shapes; every interface mode under `interface-modes/` commits `{X, Y}` from `canStart(unitId, op, {}).Plots`) | which shape applies is read off the engine: the sentinel probe must succeed, and a `Plots` list (from the probe or the empty-argument listing) makes it a plot action with one offer per accepted plot (capped at eight), otherwise a no-target offer bound as `arg2 = arg3 = -1`. Precondition per row: moves (`used`), the unit's plot index (`moved`: rebase, teleport), on-map flag (`offmap`: reinforce), or the treasury (`gold`). `disperse_independent` and `convert_independent_to_city_state` require `confirm=true` | `canStart` immediately before send with the bound shape; the unit's precondition unchanged | `used`: the unit left the roster or its moves fell; `moved`: its location changed; `offmap`: `unitsOnMap` reads 0 (a reinforcement travels off the map but stays in the roster); `gold`: `goldBalance` fell |
| `connect_with_road`, `move_by_rail`, `upgrade_army`, `focused_attack_land_melee`, `focused_attack_land_ranged`, `focused_attack_sea_melee`, `focused_attack_sea_ranged`, `focused_attack_air_to_air`, `focused_attack_air_to_land`, `focused_attack_air_bomb`, `army_overrun`, `commander_attack`, `stone_trap`, `treat_sick`, `claim_resource`, `scorched_earth`, `disperse_clan` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes[kind], ...)` with the same two shapes | as above; `upgrade_army` is sent to the commander with the sentinel and the engine fans it out (no client-side cost: the price is only in `canStart`'s `AdditionalDescription`, carried as `description`); the unique-unit abilities (`stone_trap`, `treat_sick`, `claim_resource`) are gated natively through `ChargedUnitAbilities` and `RequiresAbility`, with `UnitAbilityType` -1 exactly as the shipped loop sends them since no `UnitAbilities` row names their command. `scorched_earth` and `disperse_clan` require `confirm=true` | as above | as above |
| `excavate`, `research_artifacts`, `air_attack`, `naval_attack`, `cargo_drop`, `unit_air_drop`, `automate_explore`, `wmd_strike` | the same table-driven `Game.UnitOperations` path (rows in `offers.js`); `wmd_strike` carries `Type: Database.makeHash("WMD_NUCLEAR_DEVICE")` on every probe and the send, exactly as the shipped strike mode hard-codes it | as above. `automate_explore` is a no-target send whose proof is the unit ceasing to be ready to move (`asleep`); `air_attack`, `naval_attack` and `wmd_strike` require `confirm=true` (the shipped strike mode has no confirmation dialog at all; this harness adds one) | as above | `asleep`: `unitAwake` reads 0 for a unit that read 1 when offered; the rest as above |
| `move_unit` (standing) | the same `MOVE_TO {X, Y, Modifiers: 0}` | additionally, for every one of the seat's own settlements with a native path of two or more turns, one `multiTurn` offer (`pathTurns`, `cityName`); the destination is the seat's own ground and nothing between is exposed | the longer path is accepted only when the target plot is one of the seat's own settlements; every other target keeps the one-turn rule | queued or under way (`unitMoved`), never arrival |
| `move_great_work` | `MOVE_GREAT_WORK {Player1, GreatWorkIndex, SourceCity?, DestinationCity, DestinationBuilding}` after `canStart` (the shipped great-works screen's `selectEmptySlot`); `DestinationBuilding` is the building's constructible **type** hash, which the shipped screen writes into the slot's attribute as `building.type` | works from each own city's `Constructibles.getGreatWorkBuildings()` slots and the archive (`Culture.getNumWorksInArchive` / `getArchivedGreatWork`; no `SourceCity` then), one offer per building with an empty slot, capped at 24; precondition = the source city (-1 archive) | `canStart` immediately before send; the work must still be where it was and the destination must still have an empty slot | the work's index appears in the destination city's `greatWorkSlots` |
| `rename_unit`, `rename_city`, `found_religion` (custom name) | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.NAME_UNIT, {Name})`, `Game.CityCommands.sendRequest(cityId, CityCommandTypes.NAME_CITY, {Name})` (upper-cased as the shipped header sends it), and `FOUND_RELIGION {ReligionType, ReligionCustomName}`, all after `canStart` | units and settlements whose `canStart` accepts a placeholder name (in practice commanders, and every settlement), marked `needsText`; the name arrives as `text` on perform_action: 1-32 printable characters, no quotes or backslashes, validated host-side and JSON-encoded into the payload as a string the payload passes through as data. A founding may carry a name (`acceptsText`) | `canStart` immediately before send with the real name | `unitNames` / `cityNames` contain the name (case-insensitive); the religion by its type as before |
| `resettle` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.RESETTLE, {X, Y})` after `canStart(unitId, RESETTLE, {X, Y}, false)` (the shipped acquire-tile mode sends the plot alone) | a migrant (`UNIT_MIGRANT`, the only `UNIT_CLASS_POPULATION` unit) and a plot from `canStart(unitId, RESETTLE, {}, false).Plots`, each carrying the parallel `ConstructibleTypes` entry as `constructibleKey`, capped at ten | `canStart` immediately before send | the unit leaves the roster (it is spent settling) || `promote_unit` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.PROMOTE, {PromotionType: hash, PromotionDisciplineType: hash})` after `canStart(...)` `Success` (the shipped promotion panel) | a (discipline, promotion) pair from `GameInfo.UnitPromotionDisciplineDetails` that `Experience.canEarnPromotion(disciplineType, promotionType, false)` accepts, for a unit whose `Experience.canPromote` is true; both hashes are passed as integers (`row.$hash` equals `Database.makeHash(type)` on this build, verified live), with the discipline and promotion names, the description, the commendation flag, stored promotion and commendation points and the unit's level. Precondition = the seat's floored gold balance | `canStart` immediately before send; the pair must still belong to the same discipline, still be earnable, and the promotion count unchanged | the promotion appears in the unit's held set (`unitPromotions` in the read-back poll, a list of held promotion hashes per unit) |
| `make_trade_route` | `Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, {X, Y})` for the destination settlement's plot, after `canStart` (the shipped trade route chooser) | the seat's **own** `Trade.projectPossibleTradeRoutes()` entries whose status is `TradeRouteStatus.SUCCESS`, paired with each unit whose `canStart(MAKE_TRADE_ROUTE, …, true)` existence check passes (merchants). The target settlement is resolved only for the plot the command needs and its composed name; nothing about its owner is exposed. The offers context also reports `tradeRoutes: {possible, merchants, active}` so a seat with an idle merchant learns that the game currently projects no route. Precondition = the unit's plot | the destination must still be projected as a successful route and the unit still on its plot; `canStart` immediately before send | the seat's active route count rises (`tradeRoutes` in the read-back poll) |
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

*Superseded in part: a move that leaves the unit in place with a newly queued operation is now
confirmed as accepted and queued (turn 66 lesson); an unmoved unit with no pending operation is still
unknown, as here.*

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

## Lesson: `Experience.canPromote` is a class flag, not an entitlement

Live (turn 27): an Army Commander reported `canPromote: true` with zero stored promotion points and
no discipline accepting a promotion. `canPromote` says the unit is of a promotable class; whether a
promotion can actually be taken is `canEarnPromotion(disciplineType, promotionType, false)` per pair,
which is what the offers gate on. Note also that `getStoredPromotionPoints`, `getLevel`,
`getNumPromotions`, `getStoredCommendations` and `getTotalPromotionsEarned` are **properties, not
methods**, on this build; calling them returns nothing.

## Lesson: a move into an occupied plot is silently dropped

Live (turn 34): a warrior's `MOVE_TO` with `Modifiers: NONE` into an adjacent visible plot passed
`canStart` and had a one-turn native path, yet nothing happened; the unit kept its position, its
movement and no pending operation, so the outcome was `unknown` and the seat halted. The plot held a
unit owned by another player (`Game.Combat.getBestDefender({x, y}, unitId)` reported owner 13, an
independent). Move offers now withhold any plot whose best defender belongs to someone else. Only
that boolean is used: the occupant's owner and id never reach a client, and a plot held by the bound
player's own unit is still offered.

## Lesson: the ATTACK modifier is not a target test either

Live (turn 28): `canStart(unitId, MOVE_TO, {X, Y, Modifiers: UnitOperationMoveModifiers.ATTACK})`
returned `Success: true` for every adjacent **empty** visible plot, exactly as the plain move does.
The discriminator the shipped UI relies on is `Game.Combat.testAttackInto(unitId, {x, y})`, which
returned `-1` for every such plot. An attack action must therefore gate on that preview, not on
`canStart`, and the positive shape of `testAttackInto` has not been observed yet: attack is
deliberately **not implemented** until a seat is adjacent to a real target and the return value can
be read. `UnitOperationMoveModifiers` on this build: NONE 0, TERRITORY_NO_UNEXPLORED 1,
TERRITORY_NO_ENEMY 2, IGNORE_STACKING 4, IGNORE_DANGER 8, ATTACK 16, DECLARE_WAR 32,
MAXIMIZE_EXPLORE 64, STAY_ON_LAND 128, ANY_ROUTE 512, ROUTE_ALLOW_UNEXPLORED 1024, IGNORE_ZOC 2048,
IGNORE_STACKING_AFTER_TURN 4096, MOVE_IGNORE_UNEXPLORED_DESTINATION 16384.

## Lesson: a town specialises through the growth mode, not the build queue

Live (turn 43): every `CityOperations BUILD {ProjectType}` was refused for a town and accepted for a
city, while `CityCommands CHANGE_GROWTH_MODE {Type: GrowthTypes.PROJECT, ProjectType, City}` was
accepted for the town. `GrowthTypes` on this build: INVALID 0, EXPAND -1126871330, MIGRATE 1308026452,
PROJECT -284569333. Eleven projects were offered for one town the first time the blocker appeared.

## Lesson: a crisis is answered with the ordinary tradition operation

Live (turn 66): `NOTIFICATION_CRISIS` blocked the turn with three activatable cards in the crisis
culture slot. Crisis cards are `GameInfo.Traditions` rows with `IsCrisis` true and are activated by
the same `CHANGE_TRADITION` operation as any policy, so no new engine call was needed: the blocker
simply had no mapping, and the brief now routes cards by their `isCrisis` flag so a crisis decision
is answered with crisis cards and ordinary policies stay separate.

The traditions confirm is gated **per slot type**, not globally: that seat had 14 free slots overall
but only crisis cards pending, and a global gate would have held the confirm back forever.

## Lesson: the age-transition civilization is a setup parameter, not an operation

Live (turn 93): `NOTIFICATION_CHOOSE_CIVILIZATION` blocked the turn and there is no
`CHOOSE_CIVILIZATION` player operation on this build (`PlayerOperationTypes.CHOOSE_CIVILIZATION` is
undefined). The shipped in-game transition screen (ui-next `age-transition-screen.js`, screens
civ-choice → civ-select → civ-details → memento-select) writes the choice through the game-setup
parameter system, which **is** reachable from the in-game realm: `GameSetup.findPlayerParameter(pid,
"AgeTransitionPlayerCivilization")` returns the domain with `invalidReason` per value
(`GameSetupDomainValueInvalidReason`: 0 Valid, 1 NotValid, 2 NotValidOwnership, 3 NotValidLocked,
4 NotValidAgeTransition); `setPlayerParameterValue` writes it; `SET_AGE_TRANSITION_DATA {Finished:
true}` (legal as soon as the notification appears, even with RANDOM selected) finishes. The shell's
single-player transition (`age-transition-civ-select.js`) instead writes `PlayerCivilization` and
calls `engine.call("startGame")`; that path is not used in hotseat. Persia's valid successors were
Abbasid and Mongolia (historical), Chola, Norman and Persia itself; 19 civilizations were reason 4
and 6 reason 3 (content not owned). The payload policy now forbids every `GameSetup` write except
this one exact call.

## Lesson: the new age opens with the legacy deck, and the transition turn counter resets

Live: after every seat finished the transition the game loaded the Exploration age at **turn 1**,
which the host treats as a turn regression and bumps the attachment generation (offers expire, plans
are marked for review). `NOTIFICATION_AGE_TRANSITION` then blocks every seat until the legacy deck is
completed: `AdvancedStart.getAvailableCards()` listed four default cards costing one legacy point
each against three points, `ADVANCED_START_USE_EFFECT` refused every effect until its card was in
the deck and then **kept reporting startable after the effect had been applied** (verified: the seat
that applied the extra-policy-slot card had three culture slots against the other seats' two), so
there is no observable "already spent" signal and applying is folded into the pick. The choose-civilization notification records kept
`BlocksTurnAdvancement` true after the finish while `Game.Notifications.getBlocksTurnAdvancement(id)`
said false: that per-id query is the live verdict and is what every blocking check uses now.

## Not exercised live, with the contract established

**Attack.** `canStart(MOVE_TO, {Modifiers: ATTACK})` accepts every empty adjacent plot and
`Game.Combat.testAttackInto` returned `-1` even for a plot holding a foreign unit, so neither is the
target test; `Game.Combat.getBestDefender({x, y}, unitId)` is (it names the owner, which is why move
offers use only its boolean). The positive shape of an attack preview has not been observed, so no
attack action exists and moves into occupied plots are withheld instead.

**Trade routes are implemented but have never had a live route to take.** Four seats asked for this
across the Exploration age. Even after first contact (turn 13), with trade capacity available and the
other civilization met, `projectPossibleTradeRoutes()` returns an empty list for every seat: no met
civilization's settlement is in range, and the query omits out-of-range candidates rather than
returning them with a DISTANCE status. The action is enumerated and gated from that same query, so it
appears the moment a route exists; **its send path has not been exercised live**. The source is the seat's own component: `Trade.projectPossibleTradeRoutes()` returns
entries with `targetCityId`, `status` and `domain`, and the shipped chooser sends
`Game.UnitCommands.sendRequest(unitId, UnitCommandTypes.MAKE_TRADE_ROUTE, {X, Y})` for the target
city's plot after `canStart`. `TradeRouteStatus` on this build: INVALID 0, SUCCESS -327245337,
AT_WAR -503474736, DISTANCE -1224148699, NEED_MORE_FRIENDSHIP 543324911, NO_RESOURCES 575990753,
ALREADY_EXISTS 854558881, OVER_OCEAN 45420062, NO_URBAN_SEA_ROUTE 262580538. It is **not implemented**
because no seat has met another civilization yet, so the query returns an empty list for every seat
and the populated shape cannot be verified; resolving a `targetCityId` also means reading a foreign
city, which needs the same care the occupied-plot check took.

**Lesson (turn 35, live):** a promotion that really had applied was reported `unknown` and blocked the
seat. Neither `getNumPromotions` nor `getTotalPromotionsEarned` moves when a unit takes a promotion:
the commander held four before and four after, while the game showed Defilade on it. `Experience.hasPromotion`
is the only positive signal, and it takes the discipline and promotion **type strings**, not hashes;
called with a hash it silently answers `false`, which is what made the payload's own inline read-back
agree with the broken counter. The read-back poll now carries the held promotion set per unit.

**Lesson (turn 35, live):** buying a constructible and promoting a town both ride `CityCommandTypes.PURCHASE`,
the same command as buying a unit; the constructible takes a placement plot and the town upgrade takes
`OrderTypes.ORDER_TOWN_UPGRADE` (value 8 on this build) in a `Directive` field. A `Database.makeHash`
of the order name is refused, so the enum is not interchangeable with a hash here.

**Lesson (turn 36, live):** the whole diplomacy family runs through one path. `Game.Diplomacy.getProjectDataForUI(seat, target, NO_TARGET, NO_GROUP, -1, NO_TARGET)` returns every project against that
target, each carrying its own `operationType` **as an integer**, so the payload never has to name an
engine operation: it re-reads the listing and uses the operation the engine itself supplies for a
project it still reports available. A major power is addressed as `Player2` and an independent as `ID`;
the wrong one is refused rather than misapplied, so the payload offers both shapes to `canStart` and
sends the one accepted. Only actions that cost influence are offered, because influence moving is the
only positive signal available: declaring war and forming an alliance are free and would read as
`unknown`. Enumerating targets needs the one vetted exception to the read-only leak policy, a block in
`offers.js` pinned character for character by the policy test, which may read only a met player's id,
civilization name and major flag.

**Lesson (turn 38, live):** a standing tree goal removes a recurring turn blocker. `getAllAvailableNodeTypes`
lists only what can be researched right now, but the target operation accepts any unfinished node of
the active tree, including ones several steps away (state `CLOSED`), and the game then researches its
way there on its own. The shipped screen sends the current-node operation and the target operation
back to back; the catalog sends only the target, keeping one operation per action, and leaves the
immediate choice to the action that already exists for it.

**Lesson (turn 43, live):** the engine flags destructive commands itself. `canStart(DELETE, ...)` returns
`RequiresConfirmation: true` alongside `ConfirmDialogBody`, an array of already-composed warning
strings, which is exactly the signal the shipped UI uses to put a confirm dialog in the player's way.
The catalog honours it in the same spirit rather than inventing its own rule: the offer is marked
`destructive`, the engine's warning rides along with a `guidance` line saying what is lost, and
`perform_action` refuses the action unless the caller passes `confirm=true`. The refusal repeats the
guidance, so a seat that tries it once learns why it is almost never right.

**Lesson (turn 46, live):** specialists are not a city operation. `CityOperationTypes.EDUCATE` looked
like the candidate and refuses everywhere; the shipped tile picker uses the **player** operation
`ASSIGN_WORKER` with `{Location: <plot index>, Amount: 1}`, and the eligible plots come from the
settlement's own `Workers.GetAllPlacementInfo()`, each carrying `NumWorkers`, `MaxWorkers`, `IsBlocked`
and four positional yield arrays. Those arrays are positional over `GameInfo.Yields`, so they are
meaningless until named; once named they state the decision exactly, as in "+2 science for 1 food and
1 happiness".

**Lesson (turn 46, live):** a free diplomatic action has no treasury movement to confirm it, which is
why war and alliances were withheld at first. The relationship itself is the signal: `isAtWarWith` and
`hasAllied` on the seat's own Diplomacy component, read for met players only, in a second vetted block
that the policy test pins the same way as the first. Ending an alliance has no project row at all: the
shipped panel sends `CANCEL_ALLIANCE` carrying the **alliance** action type, which is the one place an
operation and its action type disagree.

**Lesson (turn 49, live):** attacking is two operations, and the payload must not choose between them
by inspecting the unit's strengths. `Game.Combat.testAttackInto(unitId, {X, Y})` is a synchronous
classifier that returns `COMBAT_RANGED` or not, and the shipped dispatcher branches on exactly that:
a ranged strike is its own operation with a plain `{X, Y}` and no modifiers at all, while a melee
strike is an ordinary move carrying `ATTACK + MOVE_IGNORE_UNEXPLORED_DESTINATION`. The combat preview
(`simulateAttackAsync`) is asynchronous and answers on an engine event, so it is unusable from a
one-shot payload; the offer reports both sides' health and strength instead and leaves the arithmetic
to the seat. The confirmation is the attacker's own `attacksRemaining` falling: a strike spends it
whatever the outcome, and nothing else does. Naming a target needs a third vetted block, which may
read only the defender's unit type and damage, and only on a plot the engine says this unit may
attack right now.

**Lesson (turn 50, live):** the moment seats could propose treaties, the first proposal paused play on
the receiving seat as an unsupported decision. The engine's blocker is spelled `DIPLOMATIC_RESPOSE_REQUIRED`
(sic) and is matched as the engine spells it. The pending proposals are the seat's own diplomatic events
where it is the target, and the answer is `RESPOND_DIPLOMATIC_ACTION` with the event id and an accept or
reject response type. The engine's check for an answer keeps succeeding after one is given (live: the first accept read
as unknown for exactly that reason), so it is no signal; each event carries its own `responseType`,
`INVALID_RESPONSE` until answered and then the answer given, which is both the offer gate and the proof.

**Lesson (turn 56, live):** an action can hang the game's script thread without the engine itself
hanging. Founding at one plot never returned, three times running and once with a 40-second deadline,
while the engine answered other probes in a tenth of a second and nothing was founded. Each retry cost
a human reconciliation. The registry now keeps a per-match quarantine: an exact action (kind and
arguments) that has come back unknown twice is still listed but marked not startable with the reason,
and a human lifts it deliberately with `lift_quarantine`.

**Lesson (turn 56, live):** a trade route is two actions, not one. `projectPossibleTradeRoutes()` marks a
route `SUCCESS` when it is legal in principle, but `canStart(MAKE_TRADE_ROUTE, {X, Y})` is true only once
the merchant stands in range of the target city. For seven ages of play the offer demanded range first
and so was never made, while four legal routes sat marked `SUCCESS`. The shipped chooser enables its
button on `SUCCESS` alone and, when the check fails, sends the merchant walking to the nearest plot of
the city with an ordinary move allowed to end in unexplored ground; the player confirms on arrival.
Aiming at a city means seeing it, so a third vetted block may read, for each city the engine itself
names as a route target, only its name, location and plots.

**Note (A02, offline):** peace is the one family here with no live evidence at all. No seat has been at
war in this game, so `canMakePeaceWith` has been false for every pair and the deal interfaces have
never been driven. The proposal follows the shipped screen line for line; the answer to an incoming
deal assumes its id is the outgoing form mirrored, which the shipped code implies but does not show.
Both stay `offline_verified` in the ledger until a real war offers them.

**Lesson (turn 60, live):** deactivating a tradition and unassigning a resource are refused by the
engine outside the windows in which activating and assigning are allowed: every argument shape,
`$hash` or `$index`, refused on a seat with no policy or resource decision pending, and so did
activating a card already active. Both offers therefore appear only in those windows, alongside their
opposites, which is the shipped behaviour. Neither the pillage nor the religious operations have a
live case yet: no seat is at war and no seat has trained a missionary.

**Lesson (turn 61, live):** a town-project choice sent on its own is dropped. The shipped chooser sends
`CONSIDER_TOWN_PROJECT` the moment the focus panel opens, before any choice; three choices sent
without it went unknown on one town while the engine's check kept saying yes, and the first sent
after it landed in a third of a second. The payload now sends the consider step first, and
`keep_town_focus` offers the consider step alone, which clears the "town focus available" blocker
without changing anything, as opening and closing the panel does.

**Lesson (turn 63, live):** a wake applied after the payload's own read-back window closed, and the
host had no signal for the `awake` or `spent` expectations, so an order that had landed stopped the
seat on an unknown outcome. `unitAwake` (ready to move, the same reading the offer takes as its
precondition) and `unitMoves` now confirm wake, cancel and plunder from the host side.

**Legacy rewards moved to the finish.** Picking a card used to apply its rewards at once; putting a
card back would then have refunded points for a reward already taken. Rewards are now applied when
the deck is finished, once per effect, exactly as the shipped confirm does, so a pick is reversible
until then. Placement effects are never applied as rewards: they are placed, or fall back to a
settler when the deck is marked complete.

**What the shipped UI does not have (Priority 4 research).** `UNITOPERATION_BUILD_ROUTE` is commented out
of the data; roads are the `connect_with_road` command. `EMBARK`/`DISEMBARK` are invisible and automatic.
Rail is passive infrastructure (`ROUTE_RAILROAD` once a rail station stands) plus the explicit
`move_by_rail`. There is no cargo or delivery operation: a treasure fleet is unloaded with the disband
command (`getDisbandBaseAmount` is the payout), so `disband_unit` doubles as delivery and its guidance
stays. Commander promotions are the ordinary `promote_unit` with commander disciplines, paid from
commendations. Only five `UnitAbilities` rows name a command or operation (`RESETTLE`, `EMBED_LOOKOUT`,
`SEARCH` twice, `RANGE_ATTACK` for the sepoy); every other ability is matched natively by name.


**Lesson (turn 66, live):** a settler offered a one-turn path went one plot and kept the move for the
next turn, so arrival never read true and the seat stopped on an unknown outcome. A move whose unit
has left its plot is confirmed as accepted (`unitMoved`, `arrived: false`); arrival stays the
positive signal when it comes.

The same settler then failed to step at all (one move left for a plot costing two, though the engine's
path had said one turn): the queued operation it did not have when offered (`unitPendingOps`) is the
proof the order was accepted, reported as `queued: true`.

A unit already carrying a queued operation is not offered fresh moves at all (its cancel stays):
a third order on the same settler left no signal to confirm by. *Narrowed on turn 99 (below): only a
unit whose current activity is the move itself is withheld; a unit under a standing order is not.*


**Priority 5 and 6 research, what the shipped UI does not have.** There is no display/claim artifact
operation: an artifact is placed with `move_great_work` like any work. Wonders and victory projects
are plain `BUILD` items (`produce_constructible`, `produce_project`). `AIR_BOMB` is one of the focused
attacks; there is no intercept, patrol or naval bombardment action, and no contamination cleanup (fallout
decays). There is no city or district attack apart from ranged and melee into the plot. Espionage is not
a unit: the four espionage projects are diplomatic actions the engine lists like any other, so
`start_diplomatic_action` already offers them (`group: ESPIONAGE`, confirmed by influence spent). A far
`MOVE_TO` is the engine's own multi-turn move. Automation is cancelled with `cancel_order`.

**Lesson (turn 67, live):** six towns had a focus decision pending at once, each with its own blocking
notification naming the town in `Target`. Keeping one town's focus cleared that town's notification
while the others stayed, so a read-back that asked "does any town-focus notification still block?"
reported an unknown for a consider that had worked. `keep_town_focus` is now offered only for the towns
a blocking notification names, and proves itself by that town's own notification going
(`townFocusPending`).

**Lesson (turn 74, live):** a relic sent from the archive to a temple's empty slot with the building's
instance id was accepted by `canStart` (which checks nothing for this operation: a bogus work or
building also reads true) and silently dropped by the engine. The shipped screen sends the building's
constructible type; the offer now binds that, and the perform matches it against the settlement's
buildings with an empty slot.

**Lesson (turn 82, live):** the engine still counted one resource to assign while every unplaced
resource had no legal settlement; the seat shuffled an ivory that was already placed between two
towns for a whole turn, each move confirmed, because the confirm was withheld while any assignment
was possible. Only an unplaced resource with a legal settlement counts now; moving a placed one is
offered as a `reassignment`, which never answers the blocker.

**Lesson (turn 99, live):** a settler under a nightly alert order was offered no move for twelve turns
and was disbanded as "boxed in". A standing order (sleep, fortify, alert) also reads as a pending
operation, so the turn-66 guard withheld its moves. The guard now applies only to a unit whose current
activity is the move itself (`UnitActivityTypes.OPERATION`).

**Lesson (turn 109, live, revision 21fbacb+):** six units already under sentry or hold orders were
re-ordered three times in one turn while the two units the turn was actually waiting on sat past the
option cap, and the seat gave up. The engine accepts a standing order for a unit that already has one,
so `unit_order` is now offered only to units that are ready to move; a unit under an order is changed
through `wake_unit` or `cancel_order` first.

**Purchase proofs (work package B3).** A lighter treasury says something was bought; it does not say
what. `purchase_constructible` now also requires the building to stand in the settlement's own
constructible list (`cityConstructibles`), and `purchase_unit` one more unit of the bought type
(`unitTypeCounts`), with the receipt naming which identity confirmed it. When the engine offers no
constructible list the treasury stands alone and the receipt says `treasuryOnly`.

**Bounded tools continue (work package C).** `get_unit_options`, `get_city_options` and
`list_actions(kind=...)` page over the catalog captured on the first call (40 per page, every option
once); a `cursor` is bound to seat, match, turn, age, attachment generation, entity and kind filter and
returns `REFRESH_REQUIRED` when any of them changed. Counts describe the captured catalog, which is what
the game's own legality check offered the seat; nothing is claimed about native completeness beyond it.

**Lesson (review of 2026-09-17, offline):** a receipt proves the implementation that produced it, not the
one reading it. Fingerprints over the lines that *name* a kind missed every guard and read-back body
change; baselining an unstamped pass at build time made a changed implementation look verified. The
digest now covers the whole offer block, dispatch branch, bind and confirm blocks and the read-back
signals they consult (`src/civ7_observer/contract.py`); the host stamps each journal row with it at
execution (`contract`), and a pass is judged by the stamp the receipt carries: current passes,
superseded asks for a retest, none is historical. Payload-established confirmations carry the same
typed `effect` the poll would record, so a receipt reads the same whichever path confirmed it.
