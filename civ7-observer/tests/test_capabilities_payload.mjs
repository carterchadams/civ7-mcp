// Offline tests for payloads/capabilities.js with mocked game globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "capabilities.js"), "utf8");

function render(boundId) {
  assert.ok(raw.includes("BOUND_PLAYER_ID"), "payload must reference BOUND_PLAYER_ID");
  return raw.replaceAll("BOUND_PLAYER_ID", String(boundId));
}

function run(globals, boundId = 1) {
  const ctx = vm.createContext({ ...globals });
  const out = vm.runInContext(render(boundId), ctx, { timeout: 2000 });
  assert.equal(typeof out, "string");
  return JSON.parse(out);
}

const NODE_STATE = { NODE_STATE_INVALID: 0, NODE_STATE_CLOSED: 1, NODE_STATE_OPEN: 2, NODE_STATE_IN_PROGRESS: 3, NODE_STATE_UNLOCKED: 4, NODE_STATE_FULLY_UNLOCKED: 5 };

function table(rows, key) {
  return { length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null, [Symbol.iterator]: () => rows[Symbol.iterator]() };
}

function fullGame({ accessLog } = {}) {
  const log = accessLog ?? [];
  const player1 = {
    id: 1, isTurnActive: true, isAlive: true, isHuman: true, isAI: false, civilizationType: 11, leaderType: 22,
    Cities: { getCities: () => [{ id: { owner: 1, id: 65536, type: 1 }, localId: 65536, owner: 1, name: "LOC_CITY", location: { x: 3, y: 4 }, isTown: false, isCapital: true, population: 2, ruralPopulation: 1, urbanPopulation: 1, BuildQueue: { currentProductionTypeHash: -1, isEmpty: true, getTurnsLeft: () => -1 } }] },
    Units: { getUnits: () => [{ id: { owner: 1, id: 131072, type: 26 }, localId: 131072, owner: 1, type: 99, name: "Scout", location: { x: 3, y: 5 }, isOnMap: true, isDead: false, isCommanderUnit: false, armyId: { owner: -1, id: -1, type: 0 }, Movement: { movementMovesRemaining: 2, maxMoves: 2 }, Health: { damage: 0, maxDamage: 100 } }] },
    Techs: { getTreeType: () => 500, getResearching: () => ({ type: -1, state: 0, progress: 0, depth: 0, maxDepth: 0 }), getResearched: () => [{ type: 700, state: 5, progress: 0, depth: 1, maxDepth: 1 }], getTargetNode: () => -1, getTurnsLeft: () => -1, getNumTechsUnlocked: () => 1 },
    Culture: { getActiveTree: () => 600, getAvailableTrees: () => [600], getResearching: () => ({ type: 800, state: 0, progress: 10, depth: 0, maxDepth: 1 }), getResearched: () => [{ type: 800, state: 3, progress: 10, depth: 0, maxDepth: 1 }], getTargetNode: () => -1, getTurnsLeft: () => 6, getNumCivicsUnlocked: () => 0 },
  };
  const hidden = new Proxy({}, { get(_, k) { log.push(`Players.get(other).${String(k)}`); return undefined; } });
  return {
    UI: { isInGame: () => true, isMultiplayer: () => false },
    Game: { turn: 2, age: 4242, ProgressionTrees: { getNode: (pid, t) => { log.push(`getNode(${pid})`); return { nodeType: t, state: 5, progress: 0, depthUnlocked: 1, maxDepth: 1, repeatedDepth: 0, unlockIndices: [1] }; }, getNodeState: (pid, t) => 5 } },
    GameContext: { localPlayerID: 1, localObserverID: 1 },
    Players: { get: (id) => { log.push(`Players.get(${id})`); return id === 1 ? player1 : hidden; } },
    Configuration: { getGame: () => new Proxy({ isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isGameStarted: true, isGameReady: false, isPaused: false, humanPlayerIDs: [0, 1], gameSeed: 12345 }, { get(t, k) { log.push(`Configuration.${String(k)}`); return t[k]; } }) },
    GameplayMap: new Proxy({ getGridWidth: () => 10, getGridHeight: () => 8, getPlotCount: () => 80, getRevealedState: (pid, x, y) => { log.push(`getRevealedState(${pid})`); return 2; }, getTerrainType: () => 1, getBiomeType: () => 0, getFeatureType: () => -1, getElevation: () => 100, isRiver: () => false, getRiverType: () => -1, getIndexFromXY: (x, y) => y * 10 + x, getLocationFromIndex: (i) => ({ x: i % 10, y: Math.floor(i / 10) }), getAdjacentPlotLocation: (loc, d) => ({ x: loc.x + 1, y: loc.y }), getResourceType: () => { log.push("getResourceType"); return 7; } }, { get(t, k) { if (k === "getResourceType") log.push("touched getResourceType"); return t[k]; } }),
    GameInfo: { Units: table([{ $hash: 99, UnitType: "UNIT_SCOUT" }]), ProgressionTreeNodes: table([{ $hash: 700, ProgressionTreeNodeType: "NODE_TECH_A" }, { $hash: 800, ProgressionTreeNodeType: "NODE_CIVIC_B" }]), ProgressionTrees: table([{ $hash: 500, ProgressionTreeType: "TREE_TECHS_AQ" }, { $hash: 600, ProgressionTreeType: "TREE_CIVICS_AQ_MAIN" }]), Terrains: table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]), Biomes: table([{ $hash: 0, BiomeType: "BIOME_PLAINS" }]), Features: table([]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]), Civilizations: table([{ $hash: 11, CivilizationType: "CIVILIZATION_GREECE" }]), Leaders: table([{ $hash: 22, LeaderType: "LEADER_ALEXANDER" }]), Yields: table([]) },
    ProgressionTreeNodeState: NODE_STATE,
    RevealedStates: { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 },
    DirectionTypes: { NO_DIRECTION: -1, DIRECTION_NORTHEAST: 0, DIRECTION_EAST: 1, DIRECTION_SOUTHEAST: 2, DIRECTION_SOUTHWEST: 3, DIRECTION_WEST: 4, DIRECTION_NORTHWEST: 5, NUM_DIRECTION_TYPES: 6 },
    PlayerIds: { NO_PLAYER: -1, WORLD_PLAYER: 63, OBSERVER_ID: 1000 },
    Locale: { compose: (k) => (k === "LOC_CITY" ? "Athênai" : k) },
  };
}

test("reports the bound player's identity, roster, progression and map shapes", () => {
  const r = run(fullGame(), 1);
  assert.equal(r.probeVersion, 1);
  assert.equal(r.boundPlayerId, 1);
  assert.equal(r.context.turn, 2);
  assert.equal(r.context.ageType, "AGE_ANTIQUITY");
  assert.equal(r.mode.isHotseat, false);
  assert.equal(r.enums.ProgressionTreeNodeState.NODE_STATE_FULLY_UNLOCKED, 5);
  assert.equal(r.player.civilizationTypeName, "CIVILIZATION_GREECE");
  assert.equal(r.settlements.count, 1);
  assert.equal(r.settlements.sample.displayName, "Athênai");
  assert.deepEqual(r.settlements.sample.id, { owner: 1, id: 65536, type: 1 });
  assert.equal(r.units.sample.typeName, "UNIT_SCOUT");
  assert.deepEqual(r.units.sample.movement, { remaining: 2, max: 2 });
  assert.deepEqual(r.units.sample.health, { damage: 0, maxDamage: 100 });
  assert.equal(r.techs.treeTypeName, "TREE_TECHS_AQ");
  assert.equal(r.techs.researching.type, -1);
  assert.equal(r.techs.researched[0].name, "NODE_TECH_A");
  assert.equal(r.techs.researched[0].stateName, "NODE_STATE_FULLY_UNLOCKED");
  assert.equal(r.techs.researched[0].node.depthUnlocked, 1);
  assert.equal(r.civics.activeTreeName, "TREE_CIVICS_AQ_MAIN");
  assert.deepEqual(r.civics.availableTreeNames, ["TREE_CIVICS_AQ_MAIN"]);
  assert.equal(r.civics.researching.name, "NODE_CIVIC_B");
  assert.equal(r.map.width, 10);
  assert.equal(r.map.sampleTile.terrainName, "TERRAIN_FLAT");
  assert.equal(r.map.sampleTile.revealedState, 2);
  assert.equal(r.staticTables.Units, 1);
  assert.deepEqual(r.errors, []);
});

test("only ever reads the bound player, never the roster, seed, or resources", () => {
  const log = [];
  run(fullGame({ accessLog: log }), 1);
  const playerGets = log.filter((e) => e.startsWith("Players.get("));
  assert.ok(playerGets.length > 0);
  assert.ok(playerGets.every((e) => e === "Players.get(1)"), `unexpected player reads: ${playerGets}`);
  assert.ok(log.filter((e) => e.startsWith("Players.get(other)")).length === 0);
  assert.ok(log.filter((e) => e.startsWith("getRevealedState(")).every((e) => e === "getRevealedState(1)"));
  assert.ok(log.filter((e) => e.startsWith("getNode(")).every((e) => e === "getNode(1)"));
  assert.ok(!log.includes("Configuration.humanPlayerIDs"));
  assert.ok(!log.includes("Configuration.gameSeed"));
  assert.ok(!log.some((e) => e.includes("getResourceType")));
});

test("bound player different from the local player is reported, and nothing else is read", () => {
  const log = [];
  const r = run(fullGame({ accessLog: log }), 0);
  assert.equal(r.boundPlayerId, 0);
  assert.equal(r.seatMismatch, true);
  assert.equal(r.player, null);
  assert.ok(!log.some((e) => e.startsWith("Players.get(")), `must not read any player on mismatch: ${log}`);
});

test("missing APIs are recorded as errors instead of throwing", () => {
  const g = fullGame();
  delete g.Players.get(1).Culture;
  g.GameplayMap = { getGridWidth: () => { throw new Error("nope"); } };
  const r = run(g, 1);
  assert.ok(r.errors.some((e) => e.path.startsWith("civics")));
  assert.ok(r.errors.some((e) => e.path.startsWith("map")));
  assert.equal(r.civics.researching, null);
});

test("payload source contains no forbidden operations", () => {
  for (const bad of ["sendRequest", "PlayerOperations", "revealTree", "unlockTradition", "localStorage", "setTimeout", "import ", "humanPlayerIDs", "gameSeed", "getResourceType", "Players.get(GameContext"]) {
    assert.ok(!raw.includes(bad), `forbidden token in payload: ${bad}`);
  }
});
