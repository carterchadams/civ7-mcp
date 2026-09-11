// Offline tests for the map section of payloads/observe.js (Change 5), including anti-leak fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "observe.js"), "utf8");
const render = (id, mode) => raw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode)).replaceAll("GUARDS_ONLY", "false");
function run(globals, boundId = 1, mode = "singleplayer") {
  return JSON.parse(vm.runInContext(render(boundId, mode), vm.createContext({ ...globals }), { timeout: 5000 }));
}
const table = (rows) => ({ length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null });
const SP = { isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false };
const ENUM = { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 };

// 6x4 map. Visibility for player 1: a 3x2 block at x 1-3, y 1-2 is VISIBLE, x 4 column REVEALED, rest HIDDEN.
// Player 0 (hidden opponent) sees everything. A hidden enemy unit sits at (5,3); a resource sits at (2,1).
function world({ log = [], enumValue = ENUM, noEnum = false, revealedFn, detailThrows = false } = {}) {
  const W = 6, H = 4;
  const vis1 = (x, y) => (x >= 1 && x <= 3 && y >= 1 && y <= 2 ? 2 : x === 4 ? 1 : 0);
  const getRevealedState = revealedFn ?? ((pid, x, y) => { log.push(`vis(${pid},${x},${y})`); if (pid !== 1) return 2; return vis1(x, y); });
  const detail = (name, val) => (x, y) => { log.push(`${name}(${x},${y})`); if (detailThrows) throw new Error("detail read exploded"); return typeof val === "function" ? val(x, y) : val; };
  const mapImpl = {
    getGridWidth: () => W, getGridHeight: () => H, getPlotCount: () => W * H,
    getRevealedState,
    getTerrainType: detail("terrain", (x, y) => (x === 2 ? 5 : 1)),
    getBiomeType: detail("biome", 0),
    getFeatureType: detail("feature", (x, y) => (x === 3 && y === 1 ? 7 : -1)),
    getElevation: detail("elevation", (x, y) => 100 + x),
    isRiver: detail("isRiver", (x, y) => x === 1 && y === 2),
    getRiverType: detail("riverType", (x, y) => (x === 1 && y === 2 ? 3 : -1)),
    getIndexFromXY: (x, y) => y * W + x,
    getResourceType: detail("RESOURCE", 9),
    getYields: detail("YIELDS", [1, 2]),
    getRevealedStates: (pid) => { log.push(`getRevealedStates(${pid})`); return []; },
  };
  const GameplayMap = new Proxy(mapImpl, { get(t, k) { if (typeof t[k] === "undefined") log.push(`map.unknown.${String(k)}`); return t[k]; } });
  const me = {
    id: 1, isTurnActive: true, isValid: true, Cities: { getCities: () => [] }, Units: { getUnits: () => [] },
    Techs: { getTreeType: () => 500, getResearching: () => ({ type: -1 }), getResearched: () => [], getTargetNode: () => -1, getTurnsLeft: () => -1, getNodeCost: () => 0 },
    Culture: { getActiveTree: () => 600, getAvailableTrees: () => [600], getResearching: () => ({ type: -1 }), getResearched: () => [], getTargetNode: () => -1, getTurnsLeft: () => -1, getNodeCost: () => 0 },
  };
  const enemy = new Proxy({ Units: { getUnits: () => [{ id: { owner: 0, id: 1, type: 1 }, location: { x: 5, y: 3 } }] } }, { get(t, k) { log.push(`ENEMY.${String(k)}`); return t[k]; } });
  const g = {
    UI: { isInGame: () => true, isMultiplayer: () => false },
    Game: { turn: 16, age: 4242, ProgressionTrees: { getNode: () => null } },
    GameContext: { localPlayerID: 1, localObserverID: 1 },
    Players: { get: (id) => { log.push(`Players.get(${id})`); return id === 1 ? me : enemy; }, getAlive: () => { log.push("Players.getAlive"); return []; } },
    Configuration: { getGame: () => SP },
    GameplayMap,
    MapUnits: new Proxy({}, { get(_, k) { log.push(`MapUnits.${String(k)}`); return () => []; } }),
    MapCities: new Proxy({}, { get(_, k) { log.push(`MapCities.${String(k)}`); return () => []; } }),
    GameInfo: { Units: table([]), Constructibles: table([]), Projects: table([]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]), ProgressionTrees: table([{ $hash: 500, ProgressionTreeType: "T" }, { $hash: 600, ProgressionTreeType: "C" }]), ProgressionTreeNodes: table([]),
      Terrains: table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }, { $hash: 5, TerrainType: "TERRAIN_HILL" }]), Biomes: table([{ $hash: 0, BiomeType: "BIOME_PLAINS" }]), Features: table([{ $hash: 7, FeatureType: "FEATURE_FOREST" }]) },
    ProgressionTreeNodeState: { NODE_STATE_INVALID: 0, NODE_STATE_CLOSED: 1, NODE_STATE_OPEN: 2, NODE_STATE_IN_PROGRESS: 3, NODE_STATE_UNLOCKED: 4, NODE_STATE_FULLY_UNLOCKED: 5 },
    Locale: { compose: (k) => k },
  };
  if (!noEnum) g.RevealedStates = enumValue;
  return g;
}

test("exports only currently visible tiles with confirmed keys and explicit coverage", () => {
  const r = run(world());
  assert.equal(r.refused, null);
  const m = r.map;
  assert.equal(m.status, "supported");
  assert.equal(m.width, 6); assert.equal(m.height, 4);
  assert.equal(m.coverage, "currently-visible-only");
  assert.deepEqual(m.counts, { visible: 6, revealed: 4, hidden: 14 });
  assert.equal(m.tiles.length, 6);
  const coords = m.tiles.map((t) => `${t.x},${t.y}`).sort();
  assert.deepEqual(coords, ["1,1", "1,2", "2,1", "2,2", "3,1", "3,2"]);
  const t21 = m.tiles.find((t) => t.x === 2 && t.y === 1);
  assert.deepEqual(t21, { x: 2, y: 1, index: 8, terrain: 5, terrainKey: "TERRAIN_HILL", biome: 0, biomeKey: "BIOME_PLAINS", feature: null, featureKey: null, elevation: 102, isRiver: false, riverType: null });
  const t31 = m.tiles.find((t) => t.x === 3 && t.y === 1);
  assert.equal(t31.featureKey, "FEATURE_FOREST"); assert.equal(t31.feature, 7);
  const t12 = m.tiles.find((t) => t.x === 1 && t.y === 2);
  assert.equal(t12.isRiver, true); assert.equal(t12.riverType, 3);
  assert.ok(!("resource" in t21) && !("yields" in t21));
});

test("ANTI-LEAK: visibility is queried first with the bound id and detail is never read for non-visible tiles", () => {
  const log = [];
  run(world({ log }));
  const visCalls = log.filter((e) => e.startsWith("vis("));
  assert.equal(visCalls.length, 24, "every plot must be visibility-checked exactly once");
  assert.ok(visCalls.every((e) => e.startsWith("vis(1,")), "visibility must be keyed by the bound player only");
  const detail = log.filter((e) => /^(terrain|biome|feature|elevation|isRiver|riverType)\(/.test(e));
  const visibleSet = new Set(["1,1", "1,2", "2,1", "2,2", "3,1", "3,2"]);
  for (const d of detail) {
    const [, x, y] = d.match(/\((\d+),(\d+)\)/);
    assert.ok(visibleSet.has(`${x},${y}`), `detail read on non-visible tile: ${d}`);
  }
  // ordering: for each visible tile, its visibility read precedes any of its detail reads
  for (const key of visibleSet) {
    const [x, y] = key.split(",");
    const vi = log.indexOf(`vis(1,${x},${y})`);
    const di = log.findIndex((e) => e.startsWith("terrain(") && e.endsWith(`(${x},${y})`));
    assert.ok(vi !== -1 && di > vi, `visibility must precede detail for ${key}`);
  }
});

test("ANTI-LEAK: hidden opponent objects, global unit/city maps, resources, yields and bulk visibility are never touched", () => {
  const log = [];
  run(world({ log }));
  const forbidden = log.filter((e) => e.startsWith("ENEMY.") || e.startsWith("MapUnits.") || e.startsWith("MapCities.") || e.startsWith("RESOURCE(") || e.startsWith("YIELDS(") || e.startsWith("getRevealedStates(") || e === "Players.getAlive" || e === "Players.get(0)");
  assert.deepEqual(forbidden, []);
  assert.deepEqual(log.filter((e) => e.startsWith("map.unknown.")), [], "payload must not probe undocumented GameplayMap members");
});

test("broken visibility contract refuses the capture; nothing hidden is read", () => {
  for (const [label, opts] of [
    ["absent enum", { noEnum: true }],
    ["enum without integer VISIBLE", { enumValue: { HIDDEN: 0 } }],
    ["non-integer visibility result", { revealedFn: () => "2" }],
    ["undefined visibility result", { revealedFn: () => undefined }],
  ]) {
    const log = [];
    const r = run(world({ log, ...opts }));
    assert.equal(r.refused?.code, "API_CONTRACT_MISMATCH", label);
    assert.deepEqual(log.filter((e) => /^(terrain|biome|feature|elevation|isRiver|riverType)\(/.test(e)), [], `${label}: detail reads happened`);
  }
});

test("a throwing tile detail read fails the capture instead of dropping tiles", () => {
  assert.equal(run(world({ detailThrows: true })).refused?.code, "API_CONTRACT_MISMATCH");
});

test("map warnings: unknown terrain key keeps the hash", () => {
  const g = world();
  g.GameInfo.Terrains = table([]);
  const r = run(g);
  assert.equal(r.refused, null);
  assert.equal(r.map.tiles[0].terrainKey, null);
  assert.ok(r.warnings.some((w) => w.code === "TILE_DEFINITION_MISSING"));
});

test("oversized map dimensions are refused before any plot is scanned", () => {
  const log = [];
  const g = world({ log });
  g.GameplayMap.getGridWidth = () => 513;
  const r = run(g);
  assert.equal(r.refused?.code, "PAYLOAD_TOO_LARGE");
  assert.deepEqual(log.filter((e) => e.startsWith("vis(")), []);
});
