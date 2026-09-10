# Runtime contract (live evidence)

Recorded from the installed native Linux build on 2026-09-10 via `Runtime.evaluate`
against the single Cohtml target. Developer-only, read-only probes; no operations were
sent. Values are what this build returned on turn 2 of a fresh single-player game.

| item | value |
|---|---|
| Steam buildid | 24661151 |
| Cohtml | 2.2.3.0, CDP protocol 1.3 (`/json/version`) |
| V8 | 9.4.146.24 |
| Debugger listen address | `0.0.0.0:9444` (all interfaces, not loopback only) |
| Targets | exactly one: id `"0"`, ws `ws://127.0.0.1:9444/json/devtools/page/0`; url is `fs://game/root-game.html` in a loaded game and `fs://game/core/ui/shell/root-shell.html` at the main menu |
| `AppOptions.txt` | `~/snap/steam/common/My Games/Sid Meier's Civilization VII/AppOptions.txt`; the `UIDebugger` line was still commented (`;UIDebugger 1`) yet the debugger was listening |

## Context

| read | live shape |
|---|---|
| `UI.isInGame()` | boolean `true` in a loaded game |
| `UI.isMultiplayer()` | boolean `false` |
| `UI.isHotseat` | **undefined** (does not exist) |
| `Game.turn` | number `2` |
| `Game.age` | number hash `2077444219`; resolve with `GameInfo.Ages.lookup(hash).AgeType` |
| `GameContext.localPlayerID` / `localObserverID` | numbers, both `0` in a loaded single-player game; at the main menu `GameContext` still exists with `localPlayerID 0` and `localObserverID -1` while `Game`, `Players`, `GameplayMap` are undefined |

## Game mode: `Configuration.getGame()`

Object with boolean flags `isHotseat`, `isLocalMultiplayer`, `isNetworkMultiplayer`,
`isInternetMultiplayer`, `isLANMultiplayer`, `isAnyMultiplayer`, `isPlayByCloud`,
`isMatchMaking`, `isPrivateGame`, `isSavedGame`, `isGameStarted`, `isGameReady`,
`isPaused`; all multiplayer flags were `false` in single-player.

Live two-human hotseat game (turn 1, seat 1): `isHotseat true`, `isLocalMultiplayer true`,
`isAnyMultiplayer true`, `UI.isMultiplayer() true`, `isNetworkMultiplayer false`,
`isInternetMultiplayer false`, `isLANMultiplayer false`, `isPlayByCloud false`,
`isGameStarted true`, `isGameReady false` (even mid-game), `humanPlayerIDs [0, 1]`,
`humanPlayerCount 2`, `aiPlayerIDs` 2-29 plus 63 (63 is likely the independent-powers
slot), `observerIDs []`. `getGameModeString()` returned `"BAD_MODE"`, so do not use it
for the mode guard; use the boolean flags. The local-hotseat guard for Change 3 is
therefore: `isHotseat && isLocalMultiplayer && !isNetworkMultiplayer && !isInternetMultiplayer && !isLANMultiplayer && !isPlayByCloud`,
and single-player is `!isAnyMultiplayer`. Also exposes
`humanPlayerIDs`, `aiPlayerIDs`, `participatingPlayerIDs`, `observerIDs`, `gameSeed`
(do **not** export), `gameMode` (number hash; `getGameModeString()` exists).

## Player: `Players.get(id)`

Properties: `id`, `isTurnActive`, `isAlive`, `isHuman`, `isAI`, `isMajor`, `isMinor`,
`isBarbarian`, `isIndependent`, `civilizationType` (hash), `leaderType` (hash),
`civilizationName`, `leaderName`, `team`. Components include `Cities`, `Units`, `Techs`,
`Culture`, `Visibility`, `Diplomacy`, `Treasury`, `Resources`.

## Settlements: `player.Cities`

`getCities()` returns an array (1 on turn 2). `getCapital()`, `getCityIds()`, `numCities`
also exist. City record: `id` is a **ComponentID object** `{owner, id, type}` (e.g.
`{"owner":0,"id":65536,"type":1}`), `localId`, `owner`, `name` (localization key; use
`Locale.compose`), `location` `{x, y}`, `isTown` (boolean), `isCapital`,
`isOriginalCapital`, `population`, `ruralPopulation`, `urbanPopulation`,
`pendingPopulation`, `isBeingRazed`, `isDistantLands`, plus components `Production`,
`Growth`, `Yields`, `BuildQueue`, `Districts`, `Constructibles`.

## Units: `player.Units`

`getUnits()` returns an array (1 on turn 2). Unit record: `id` ComponentID
`{"owner":0,"id":131072,"type":26}`, `localId`, `owner`, `type` (hash; resolve with
`GameInfo.Units.lookup(hash).UnitType`), `typeName`, `typeHash`, `name`, `location`
`{x, y}`, `isOnMap`, `isDead`, `isValid`, `isEmbarked`, `isFortified`, `hasMoved`,
`canMove`, `isCommanderUnit`, `armyId`, `formationID`, `sightRange`. `Movement`
component: `movementMovesRemaining` and `maxMoves` (both `2` for the starting unit).
`Health` and `Combat` components exist (shapes not yet probed).

## Technology: `player.Techs`

Methods: `getTreeType`, `getResearching`, `getResearched`, `getTargetNode`,
`getTurnsLeft`, `getNodeCost`, `getTurnsForNode`, `getLastCompletedNodeType`,
`isNodeUnlocked`, `getNodeUnlockDepthsRemaining`, `getNumTechsUnlocked`,
`getAllAvailableNodeTypes`.

- `getResearching()` returns an **object** `{type, state, progress, depth, maxDepth}`,
  not a number. With no research chosen it was `{"type":-1,"state":0,"progress":0,"depth":0,"maxDepth":0}`
  (`type: -1` is the "none" sentinel).
- `getResearched()` returns an **array of the same record shape**; on turn 2 it already
  listed nodes such as `{"type":510800721,"state":5,"progress":0,"depth":1,"maxDepth":1}`.
  The `state` enum meaning (0, 3, 5 observed) must be mapped before export.
- `getTargetNode()` returned number `-1` (no queued target).

## Civics: `player.Culture`

Methods include `getActiveTree`, `getAvailableTrees`, `getResearching`, `getResearched`,
`getTargetNode`, `getTurnsLeft`, `getNodeCost`, `getLastCompletedNodeType`,
`getLastCompletedNodeTreeType`, `isNodeUnlocked`, `getNumCivicsUnlocked`,
`getAllAvailableNodeTypes`, tradition/government/ideology readers, and **`unlockTradition`
(a mutator; never call)**.

- `getResearching()` object: `{"type":-420583012,"state":0,"progress":10,"depth":0,"maxDepth":1}`.
- `getResearched()` array of the same shape.
- `getActiveTree()` returns a number hash (`-667771572`); resolve with
  `GameInfo.ProgressionTrees.lookup(hash).ProgressionTreeType`.

## Map: `GameplayMap`

- Grid `74 x 46` in this save (`getGridWidth()`, `getGridHeight()`, `getPlotCount()`).
- `RevealedStates` is `{"HIDDEN":0,"REVEALED":1,"VISIBLE":2}`.
- `getRevealedState(playerId, x, y)` is **player-first** (see live-test-results for the
  swapped-order check). Tile readers: `getTerrainType`, `getBiomeType`,
  `getFeatureType`, `getFeatureClassType`, `getElevation`, `getRiverType`, `isRiver`,
  `isNavigableRiver`, `getResourceType` (do not export in v0.1), `getYield(s)`,
  `getPlotIndicesInRadius`, `getAdjacentPlotLocation`, `getDirectionToPlot`,
  `getIndexFromXY`, `getLocationFromIndex`.
- Static tables: `GameInfo.Terrains` (6), `Biomes` (6), `Features` (40), `Units` (89),
  `ProgressionTreeNodes` (186); each has `.lookup(hash)` and `.length`.

## Progression trees: `Game.ProgressionTrees`

`getTree`, `getNode`, `getTreeStructure`, `getNodeState`, `getNodeProgress`,
`getNodeCurrentUnlockDepth`, `getNodeMaxUnlockDepth`, `getNodeUnlockIndicesAtDepth`,
`getAllTreeRevealData`, and **`revealTree` (a mutator; never call)**.

## Live checks of the adapter's error mapping (same session)

| expression | adapter result |
|---|---|
| reference to an undefined global | `CDP_EVALUATE_EXCEPTION`, description `ReferenceError: ... is not defined` |
| `undefined` | `CDP_MISSING_VALUE` (remote type `undefined`) |
| `1+1` / `({a:1})` | values `2` / `{"a": 1}` returned by value |
| syntax error | `CDP_EVALUATE_EXCEPTION`, `SyntaxError: Unexpected end of input` |

No CDP events arrived unsolicited during any call (`events_ignored == 0`).

## Visibility signature check

With the capital at (63, 7): `getRevealedState(pid, 63, 7)` = `2` (VISIBLE),
`getRevealedState(pid, 64, 7)` = `2`, a far tile = `0`, out-of-range coordinates = `0`.
**Swapped order** `getRevealedState(63, 7, pid)` returned `0`, a plausible-looking HIDDEN,
so the wrong argument order fails silently. Player-first is confirmed.

A full-grid scan of 74 x 46 tiles (visibility first, then terrain/biome/feature for
VISIBLE tiles only) took about 10 ms inside the game and produced 19 visible tiles
(10 revealed-but-fogged, 3375 hidden), 644 bytes of tile JSON. Chunking is unnecessary
at this map size.

## Hash and name resolution (confirmed)

`GameInfo.Ages.lookup(Game.age).AgeType` = `AGE_ANTIQUITY`;
`GameInfo.Civilizations.lookup(player.civilizationType).CivilizationType` = `CIVILIZATION_GREECE`;
`GameInfo.Units.lookup(unit.type).UnitType` = `UNIT_SCOUT`; `unit.name` = `Scout`;
`GameInfo.Terrains.lookup(...)` = `TERRAIN_FLAT`; `city.name` = `LOC_CITY_NAME_GREECE1`
and `Locale.compose(city.name)` = `Athênai`;
`GameInfo.ProgressionTreeNodes.lookup(...)` = `NODE_CIVIC_AQ_MAIN_CHIEFDOM`,
`NODE_TECH_AQ_AGRICULTURE`; `GameInfo.ProgressionTrees.lookup(...)` = `TREE_CIVICS_AQ_MAIN`,
`TREE_TECHS_AQ`.

**Caveat for Change 4:** `Techs.getResearched()` returned 4 records on turn 2 with
`state` values `[5, 2, 2, 2]`. Only one node can plausibly be complete that early, so
`getResearched()` is not "completed nodes"; it appears to include available/in-progress
nodes and the `state` field must be decoded before anything is reported as completed.

## Progression `state` codes observed so far

| state | observed on | meaning inferred |
|---|---|---|
| 0 | `getResearching()` records for a just-chosen tech and the in-progress civic | current selection (progress carried separately) |
| 2 | `getResearched()` entries for Pottery, Animal Husbandry, Sailing before/while chosen | available, not started or not completed |
| 3 | `getResearched()` entry for the civic currently in progress (progress 10) | in progress |
| 5 | `getResearched()` entry for Agriculture (depth 1 of 1) | completed |

`getResearching()` and the matching `getResearched()` entry can disagree on `state`
(civic Chiefdom: 0 vs 3). Treat `getResearching().type` as "current" and decode
`getResearched()` states explicitly; do not count anything below 5 as completed until
the enum is confirmed in the game's UI scripts. `Techs.getTurnsLeft()` and
`Culture.getTurnsLeft()` return numbers (7 and 8 here).

`city.BuildQueue.currentProductionTypeHash` returned the `UNIT_SCOUT` hash while the
capital was building a scout.

## Hotseat seat transition (turn 1, seat 1 ended turn, curtain dismissed on seat 2)

`GameContext.localPlayerID` went 0 -> 1 and `GameContext.localObserverID` went 0 -> 1,
so both follow the active seat. `Players.get(0).isTurnActive` became false while
`Players.get(1).isTurnActive` is true. The target id, URL, and WebSocket URL did not
change across the seat swap.

**Omniscience warning:** from seat 2's realm, `GameplayMap.getRevealedState(0, x, y)`
still returned player 0's real visibility (19 visible tiles vs 7 for player 1). Every
player-scoped read in `observe.js` must be keyed by the bound player id **and** the
bound id must equal `localPlayerID`/`localObserverID` at capture time; the game does not
restrict the debug API to the current seat.

## Open items for Change 2

- Map the `state` enum used by `getResearching`/`getResearched` records.
- Confirm `Health`/`Combat` unit component fields and the off-map (`isOnMap === false`) representation.
- Confirm `Locale.compose` for display names and `civilizationFullName`.
- Confirm the hotseat values of `localPlayerID` / `localObserverID` on each seat.
