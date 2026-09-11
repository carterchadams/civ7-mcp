// Runs payloads/observe.js against a named fixture and prints the raw JSON result.
// Used by tests/test_payload_roundtrip.py so Python's schema sees real JS output.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "..", "src", "civ7_observer", "payloads", "observe.js"), "utf8");
const [, , fixtureName, boundId = "1", mode = "singleplayer"] = process.argv;

const table = (rows) => ({ length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null });
const base = () => {
  const cities = [{ id: { owner: 1, id: 65536, type: 1 }, owner: 1, name: "LOC_MADRID", location: { x: 63, y: 15 }, isTown: true, isCapital: true, population: 6, ruralPopulation: 4, urbanPopulation: 2, BuildQueue: { currentProductionTypeHash: -1, isEmpty: true } }];
  const units = [{ id: { owner: 1, id: 131072, type: 26 }, owner: 1, type: 99, name: "Scout", location: { x: 59, y: 35 }, isOnMap: true, isEmbarked: true, isDead: false, isValid: true, isCommanderUnit: true, armyId: { owner: 1, id: 5, type: 3 }, Movement: { movementMovesRemaining: 0, maxMoves: 2 }, Health: { damage: 32, maxDamage: 100 } }];
  const me = { id: 1, isTurnActive: true, isValid: true, Cities: { getCities: () => cities }, Units: { getUnits: () => units },
    Techs: { getTreeType: () => 500, getResearching: () => ({ type: -1, state: 0, progress: 0, depth: 0, maxDepth: 0 }), getResearched: () => [{ type: 700, state: 5, progress: 0, depth: 1, maxDepth: 1 }], getTargetNode: () => -1, getTurnsLeft: () => -1, getNodeCost: () => 0 },
    Culture: { getActiveTree: () => 600, getAvailableTrees: () => [600], getResearching: () => ({ type: 800, state: 0, progress: 10, depth: 0, maxDepth: 1 }), getResearched: () => [{ type: 800, state: 3, progress: 10, depth: 0, maxDepth: 1 }], getTargetNode: () => -1, getTurnsLeft: () => 6, getNodeCost: () => 60 } };
  return {
    UI: { isInGame: () => true, isMultiplayer: () => false },
    Game: { turn: 12, age: 4242, ProgressionTrees: { getNode: (pid, t) => ({ 700: { nodeType: 700, state: 5, progress: 0, depthUnlocked: 1, maxDepth: 1, repeatedDepth: 0 }, 800: { nodeType: 800, state: 3, progress: 10, depthUnlocked: 0, maxDepth: 1, repeatedDepth: 0 } })[t] ?? null } },
    ProgressionTreeNodeState: { NODE_STATE_INVALID: 0, NODE_STATE_CLOSED: 1, NODE_STATE_OPEN: 2, NODE_STATE_IN_PROGRESS: 3, NODE_STATE_UNLOCKED: 4, NODE_STATE_FULLY_UNLOCKED: 5 },
    GameContext: { localPlayerID: 1, localObserverID: 1 },
    Players: { get: (id) => (id === 1 ? me : undefined) },
    Configuration: { getGame: () => ({ isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false }) },
    GameInfo: { Units: table([{ $hash: 99, UnitType: "UNIT_SCOUT" }]), Constructibles: table([]), Projects: table([]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]),
      Terrains: table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]), Biomes: table([{ $hash: 0, BiomeType: "BIOME_PLAINS" }]), Features: table([]),
      ProgressionTrees: table([{ $hash: 500, ProgressionTreeType: "TREE_TECHS_AQ" }, { $hash: 600, ProgressionTreeType: "TREE_CIVICS_AQ_MAIN" }]),
      ProgressionTreeNodes: table([{ $hash: 700, ProgressionTreeNodeType: "NODE_TECH_AQ_AGRICULTURE", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_A" }, { $hash: 800, ProgressionTreeNodeType: "NODE_CIVIC_AQ_MAIN_CHIEFDOM", ProgressionTree: "TREE_CIVICS_AQ_MAIN", Name: "LOC_C" }]) },
    GameplayMap: { getGridWidth: () => 2, getGridHeight: () => 2, getRevealedState: (pid, x, y) => (x === 0 && y === 0 ? 2 : 0), getTerrainType: () => 1, getBiomeType: () => 0, getFeatureType: () => -1, getElevation: () => 50, isRiver: () => false, getRiverType: () => -1, getIndexFromXY: (x, y) => y * 2 + x },
    RevealedStates: { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 },
    Locale: { compose: (k) => (k === "LOC_MADRID" ? "Madrid" : k) },
    _me: me,
  };
};

const fixtures = {
  good: () => base(),
  coerced_booleans: () => { const g = base(); const c = g._me.Cities.getCities()[0]; delete c.isTown; delete c.isCapital; const u = g._me.Units.getUnits()[0]; delete u.isEmbarked; delete u.isCommanderUnit; return g; },
  string_movement: () => { const g = base(); g._me.Units.getUnits()[0].Movement.movementMovesRemaining = "2"; return g; },
  not_in_game: () => { const g = base(); g.UI.isInGame = () => false; return g; },
};
const g = fixtures[fixtureName]();
delete g._me;
const out = vm.runInContext(raw.replaceAll("BOUND_PLAYER_ID", boundId).replaceAll("ALLOWED_MODE", JSON.stringify(mode)).replaceAll("GUARDS_ONLY", "false"), vm.createContext(g), { timeout: 2000 });
process.stdout.write(out);
