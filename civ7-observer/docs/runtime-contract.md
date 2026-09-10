# Runtime contract (Milestone B)

Local-build-specific evidence for every field the observation needs. "Source" cites the
shipped UI script that reads the same API (under
`Base/modules/`, native Linux build, Steam buildid 24661151). "Live" is what the API
returned through `probe` / developer probes on 2026-09-10. Enum names come from the live
globals and match the shipped scripts' usage.

Legend: **P** property, **M** method. Hash = engine integer id (may be negative); resolve
through `GameInfo.<Table>.lookup(hash).<TypeKey>`.

| item | value |
|---|---|
| Cohtml / V8 | 2.2.3.0 (CDP 1.3) / 9.4.146.24 |
| Debugger | `0.0.0.0:9444`; one target, id `"0"`, ws `ws://127.0.0.1:9444/json/devtools/page/0`; url `fs://game/root-game.html` in game, `fs://game/core/ui/shell/root-shell.html` at the menu |
| Config file | `~/snap/steam/common/My Games/Sid Meier's Civilization VII/AppOptions.txt` (debugger was on with `;UIDebugger 1` commented) |
| UI script tree | `base-standard/ui` 601 js + 603 maps, `core/ui` 373 js, `ui-next` present under both; no `.ts` shipped; source maps carry no enum declarations |

## Enums (live globals, confirmed against shipped usage)

| enum | values | shipped usage |
|---|---|---|
| `ProgressionTreeNodeState` | `NODE_STATE_INVALID 0, NODE_STATE_CLOSED 1, NODE_STATE_OPEN 2, NODE_STATE_IN_PROGRESS 3, NODE_STATE_UNLOCKED 4, NODE_STATE_FULLY_UNLOCKED 5` | `base-standard/ui/tree-grid/tree-grid.js:226-341,734-764` |
| `RevealedStates` | `HIDDEN 0, REVEALED 1, VISIBLE 2` | 49 call sites, e.g. `base-standard/ui/world-input/world-input.js` |
| `DirectionTypes` | `NO_DIRECTION -1, NE 0, E 1, SE 2, SW 3, W 4, NW 5, NUM 6` | used with `getAdjacentPlotLocation` |
| `PlayerIds` | `NO_PLAYER -1, WORLD_PLAYER 63, OBSERVER_ID 1000` | 63 appears in `aiPlayerIDs`; never export it as a rival |

## Context

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| in game | `UI.isInGame()` | M | boolean | everywhere | true in game, false at menu |
| multiplayer | `UI.isMultiplayer()` | M | boolean; **true in local hotseat** | | false SP, true hotseat |
| turn | `Game.turn` | P | int ≥ 1 | `panel-sub-system-dock.js` | 1, 2 |
| age | `Game.age` | P | hash → `GameInfo.Ages.lookup(h).AgeType` | | `AGE_ANTIQUITY` |
| local player | `GameContext.localPlayerID` | P | int; **follows the hotseat seat** | 10+ call sites | 0 → 1 on seat swap |
| local observer | `GameContext.localObserverID` | P | int; equals localPlayerID in game; **-1 at menu** | | 0 → 1 on seat swap |
| `Players`, `GameplayMap`, `Game` | globals | | undefined at the main menu, `GameContext` still defined | | confirmed |

## Game mode: `Configuration.getGame()` (object of P)

| flag | SP | hotseat | note |
|---|---|---|---|
| `isHotseat` | false | true | primary hotseat signal |
| `isLocalMultiplayer` | false | true | |
| `isAnyMultiplayer` | false | true | |
| `isNetworkMultiplayer`, `isInternetMultiplayer`, `isLANMultiplayer`, `isPlayByCloud`, `isMatchMaking` | false | false | all must be false for an allowed session |
| `isGameStarted` / `isGameReady` | true / false | true / false | `isGameReady` is false mid-game; do not gate on it |
| `getGameModeString()` | `"BAD_MODE"` | `"BAD_MODE"` | unusable |

The object also exposes `humanPlayerIDs`, `aiPlayerIDs`, `participatingPlayerIDs`,
`observerIDs`, `gameSeed`. **Never read them in a payload** (policy test).

Guard: single-player = `!isAnyMultiplayer`; local hotseat = `isHotseat && isLocalMultiplayer && !isNetworkMultiplayer && !isInternetMultiplayer && !isLANMultiplayer && !isPlayByCloud`.

## Player: `Players.get(BOUND_PLAYER_ID)`

| field | kind | shape | live |
|---|---|---|---|
| `id` | P | int | 0 / 1 |
| `isTurnActive` | P | boolean; the other hotseat human reads false | true for the seat |
| `isAlive`, `isHuman`, `isAI`, `isMajor`, `isMinor`, `isBarbarian`, `isIndependent` | P | boolean | |
| `civilizationType` | P | hash → `GameInfo.Civilizations.lookup(h).CivilizationType` | `CIVILIZATION_SPAIN` |
| `leaderType` | P | hash → `GameInfo.Leaders.lookup(h).LeaderType` | `LEADER_ISABELLA` |
| components | P | `Cities`, `Units`, `Techs`, `Culture`, `Visibility`, `Diplomacy`, `Treasury`, `Resources`, `Armies`, … | |

**Omniscience:** `Players.get(otherId)` and `GameplayMap.getRevealedState(otherId, …)` answer
fully from any seat (seat 2 read seat 1's 19 visible tiles). Seat binding is enforced only
by our payload and `tests/test_payload_policy.py`.

## Settlements: `player.Cities`

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| roster | `Cities.getCities()` | M | array incl. towns (`isTown` true) | `city-banners.js` | 1 city |
| id | `city.id` | P | ComponentID `{owner, id, type}`; keep whole object | | `{owner:0,id:65536,type:1}` |
| `localId`, `owner` | P | int | | |
| name | `city.name` → `Locale.compose(name)` | P → M | localization key → display string | 15 sites `Locale.compose(city.name)` | `LOC_CITY_NAME_GREECE1` → `Athênai`; `Madrid` |
| location | `city.location` | P | `{x, y}` | 46 sites | `{63,7}` |
| `isTown`, `isCapital`, `isOriginalCapital`, `isBeingRazed`, `isDistantLands` | P | boolean | 31 / 22 / 16 sites | |
| population | `population`, `ruralPopulation`, `urbanPopulation`, `pendingPopulation` | P | int | 12 sites | 1 |
| production (optional) | `BuildQueue.currentProductionTypeHash` (-1 = none), `BuildQueue.isEmpty`, `BuildQueue.getTurnsLeft()` (-1 = none), `getQueue()` | P/M | | `city.BuildQueue.getTurnsLeft` 3 sites | scout hash while building a scout; -1 / true / -1 when idle |
| yields (optional) | `Yields.getNetYield`, `getYields`, `getNetYields` | M | not yet shaped | | deferred |

Not yet observed: a town (`isTown` true), razing, conquest. **Needs game progress.**

## Units: `player.Units`

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| roster | `Units.getUnits()` | M | array | | 1 unit |
| id | `unit.id` | P | ComponentID `{owner, id, type}` | | `{owner:0,id:131072,type:26}` |
| type | `unit.type` → `GameInfo.Units.lookup(h).UnitType`; also `unit.typeName`, `typeHash` | P | hash | | `UNIT_SCOUT` |
| name | `unit.name` (`Locale.compose` in 5 sites) | P | string | | `Scout` |
| location | `unit.location` | P | `{x, y}`; **invalid = `x == -1 \|\| y == -1`** | `world-input.js:378` | `{63,15}` |
| on map | `unit.isOnMap` | P | boolean; false for packed/off-map units | 5 sites | true |
| `isDead`, `isValid`, `isEmbarked`, `isFortified`, `hasMoved`, `canMove` | P | boolean | | |
| movement | `Movement.movementMovesRemaining`, `Movement.maxMoves` | P | int; UI reads `Movement?.` (component may be absent) | 7 / 3 sites | 2 / 2, 0 / 2 after moving |
| health | `Health.damage`, `Health.maxDamage` | P | int; health = maxDamage − damage | 14 / 11 sites | 0 / 100 |
| commander | `unit.isCommanderUnit`, `unit.armyId` | P | boolean; ComponentID with `owner -1, id -1` = no army | 13 / 14 sites | false, none |
| combat (optional) | `Combat.getMeleeStrength()` | M | | | deferred |

Not yet observed: off-map/packed unit, damaged unit, commander with army. **Needs game progress.**

## Technology: `player.Techs`

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| tree | `Techs.getTreeType()` → `GameInfo.ProgressionTrees.lookup(h).ProgressionTreeType` | M | hash | | `TREE_TECHS_AQ` |
| current | `Techs.getResearching()` | M | object `{type, state, progress, depth, maxDepth}`; **`type -1` = none; its `state` field is unreliable (0 = INVALID even while in progress)** | `panel-sub-system-dock.js:517` (uses `.type` only) | `{type:-1,…}` then Pottery |
| current node data | `Game.ProgressionTrees.getNode(BOUND, type)` | M | `{nodeType, state, progress, depthUnlocked, maxDepth, repeatedDepth, unlockIndices[]}`; null for -1 | `panel-sub-system-dock.js:372-398`, `tree-grid.js:221` | Pottery state 3 |
| node state | `Game.ProgressionTrees.getNodeState(BOUND, type)` | M | `ProgressionTreeNodeState` | `tree-grid.js:217` | |
| cost / progress | `Techs.getNodeCost(type)` (int, 0 possible), `getNode().progress` | M/P | dock: ratio = `1 − progress/cost` (0 cost ⇒ 1) | `panel-sub-system-dock.js:525-529` | |
| turns left | `Techs.getTurnsLeft()` | M | int; **-1 = nothing selected** | `panel-sub-system-dock.js:519` | 7 / -1 |
| completed | `Techs.getResearched()` | M | array of the same record shape, **includes OPEN (2) and IN_PROGRESS (3) nodes**; completed = `state === NODE_STATE_FULLY_UNLOCKED (5)`; partial mastery = `NODE_STATE_UNLOCKED (4)` with `getNode().depthUnlocked < maxDepth` | `tree-grid.js:294,341` (`isCompleted`), `tree-grid.js:891` | Agriculture 5/depth 1; Pottery, Animal Husbandry, Sailing 2 |
| queued target | `Techs.getTargetNode()` | M | hash; -1 = none | | -1 |
| available (optional) | `Techs.getAllAvailableNodeTypes()` | M | not yet probed | | |
| node names | `GameInfo.ProgressionTreeNodes.lookup(h).ProgressionTreeNodeType`, `.Name` | | | dock | `NODE_TECH_AQ_AGRICULTURE` |

## Civics: `player.Culture`

Same record shapes and state semantics as Techs, plus:

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| active tree | `Culture.getActiveTree()` | M | hash; null/0 possible before any choice | `model-culture-tree.js:82`, `culture-chooser.js:78,128` | `TREE_CIVICS_AQ_MAIN` |
| available trees | `Culture.getAvailableTrees()` | M | array of hashes; civ-specific trees appear here | `culture-chooser.js:120` | `[TREE_CIVICS_AQ_MAIN]` only so far |
| current | `Culture.getResearching()` | M | as Techs; `progress` live 10 with cost 60 | `panel-sub-system-dock.js:399` | Chiefdom |
| current node (dock path) | `Game.ProgressionTrees.getTree(BOUND, activeTree).nodes[activeNodeIndex]` then `getNode` | M | `activeNodeIndex -1` = none | `panel-sub-system-dock.js:376-384` | |
| depth label | `getNode().depthUnlocked ≥ 1` ⇒ roman numeral `depthUnlocked + 1` | | | `panel-sub-system-dock.js:391-396` | |
| turns left | `Culture.getTurnsLeft()`, `getTurnsForNode(type)` | M | int | `model-culture-tree.js:94` | 6, 8 |
| completed | `Culture.getResearched()` | M | as Techs | | Chiefdom state 3 (in progress) |
| mutators present on the same object | `unlockTradition` | M | **never call** | | |

Not yet observed: a completed civic (state 5), a civilization-specific tree in
`getAvailableTrees()`, mastery depth > 1. **Needs game progress.**

## Map: `GameplayMap`

| field | receiver | kind | shape / sentinel | source | live |
|---|---|---|---|---|---|
| size | `getGridWidth()`, `getGridHeight()`, `getPlotCount()` | M | int | | 74 × 46 |
| visibility | `getRevealedState(playerId, x, y)` | M | **player-first**; `RevealedStates`; out-of-range → 0; swapped args silently → 0 | 20 shipped sites all pass `GameContext.localPlayerID` first | city tile 2, far 0 |
| terrain / biome / feature | `getTerrainType`, `getBiomeType`, `getFeatureType` `(x, y)` | M | hash; feature -1 = none; lookup `Terrains.TerrainType`, `Biomes.BiomeType`, `Features.FeatureType` | | `TERRAIN_FLAT`, `BIOME_PLAINS`, -1 |
| elevation / river | `getElevation(x,y)` int; `isRiver(x,y)` bool; `getRiverType(x,y)` (-1 none); `isNavigableRiver(x,y)` | M | | | 554, false, -1 |
| index | `getIndexFromXY(x,y)`, `getLocationFromIndex(i)` | M | round-trips | | 1173 ↔ {63,15} |
| adjacency | `getAdjacentPlotLocation({x,y}, DirectionTypes)` | M | `{x, y}`; **the `(x, y, dir)` form returns undefined** | | 6 neighbours of {63,15}: {64,16},{64,15},{64,14},{63,14},{62,15},{63,16} |
| yields (optional) | `getYields(x, y, playerId)` | M | returned `[]`; signature unconfirmed | | deferred |
| resources | `getResourceType` | M | **excluded in v0.1** (policy) | | |
| full-grid scan | visibility-first loop over 3404 plots | | ~10 ms in-game; 19-33 visible tiles ≈ 0.7 KB | | no chunking needed |

## Static tables (`GameInfo.*`, each has `.length`, `.lookup(hash)`, rows carry `$hash`)

`Units 89`, `ProgressionTreeNodes 186`, `ProgressionTrees 23`, `Terrains 6`, `Biomes 6`,
`Features 40`, `Ages 3`, `Civilizations 33`, `Leaders 24`, `Yields 7`.

## Progression state matrix (observed)

| where | record `state` | `getNode().state` | meaning |
|---|---|---|---|
| `getResearching()` for a just-chosen or in-progress node | 0 | 3 | **use `getNode`**, not the record |
| `getResearched()` entry, completed all depths | 5 | 5 | completed |
| `getResearched()` entry, open | 2 | 2 | available |
| `getResearched()` entry, in progress | 3 | 3 | current |
| not observed yet | 4 | 4 | unlocked with mastery remaining |

## Acceptance status

| core field | status |
|---|---|
| context, mode, seat identity | verified (SP + both hotseat seats) |
| settlement id/name/location/isTown/isCapital/population | verified; town value only seen false |
| unit id/type/name/location/isOnMap/movement/health | verified; off-map only seen true |
| tech current/completed/target/turns | verified incl. sentinel and state decoding |
| civic current/completed/tree/turns | verified; completed and civ-specific tree **not yet observed** |
| visibility + tile keys + adjacency | verified |

`probe --out runs/capabilities.json` reproduces every live row above with 0 payload errors.
