// Offline tests for the technology/civics sections of payloads/observe.js (Change 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "observe.js"), "utf8");
const render = (id, mode) => raw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode));
function run(globals, boundId = 1, mode = "singleplayer") {
  const out = vm.runInContext(render(boundId, mode), vm.createContext({ ...globals }), { timeout: 2000 });
  return JSON.parse(out);
}
const table = (rows) => ({ length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null });
const STATE = { NODE_STATE_INVALID: 0, NODE_STATE_CLOSED: 1, NODE_STATE_OPEN: 2, NODE_STATE_IN_PROGRESS: 3, NODE_STATE_UNLOCKED: 4, NODE_STATE_FULLY_UNLOCKED: 5 };
const SP = { isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false };

// hashes: techs tree 500, civics main 600, greece 601; nodes 700 agriculture(done), 701 pottery(current), 702 writing(open, depth2), 703 sailing(unlocked 1/2)
// civic nodes 800 chiefdom(done), 801 discipline(current), 802 ekklesia(open, greece)
const NODES = { 700: { state: 5, depthUnlocked: 1, maxDepth: 1 }, 701: { state: 3, depthUnlocked: 0, maxDepth: 1, progress: 45 }, 702: { state: 2, depthUnlocked: 0, maxDepth: 2 }, 703: { state: 4, depthUnlocked: 1, maxDepth: 2 }, 800: { state: 5, depthUnlocked: 1, maxDepth: 1 }, 801: { state: 3, depthUnlocked: 0, maxDepth: 2, progress: 72 }, 802: { state: 2, depthUnlocked: 0, maxDepth: 1 } };

function game({ log = [], techs, culture, nodes = NODES, noEnum = false } = {}) {
  const me = {
    id: 1, isTurnActive: true, isValid: true,
    Cities: { getCities: () => [] },
    Units: { getUnits: () => [] },
    Techs: techs === null ? undefined : (techs ?? {
      getTreeType: () => 500,
      getResearching: () => ({ type: 701, state: 0, progress: 45, depth: 0, maxDepth: 1 }),
      getResearched: () => [700, 701, 702, 703].map((t) => ({ type: t, state: nodes[t].state, progress: nodes[t].progress ?? 0, depth: nodes[t].depthUnlocked, maxDepth: nodes[t].maxDepth })),
      getTargetNode: () => 702,
      getTurnsLeft: () => 1,
      getNodeCost: (t) => (t === 701 ? 60 : 100),
    }),
    Culture: culture === null ? undefined : (culture ?? {
      getActiveTree: () => 600,
      getAvailableTrees: () => [600, 601],
      getResearching: () => ({ type: 801, state: 0, progress: 72, depth: 0, maxDepth: 2 }),
      getResearched: () => [800, 801, 802].map((t) => ({ type: t, state: nodes[t].state, progress: nodes[t].progress ?? 0, depth: nodes[t].depthUnlocked, maxDepth: nodes[t].maxDepth })),
      getTargetNode: () => -1,
      getTurnsLeft: () => 1,
      getNodeCost: (t) => 125,
    }),
  };
  const g = {
    UI: { isInGame: () => true, isMultiplayer: () => false },
    Game: { turn: 16, age: 4242, ProgressionTrees: { getNode: (pid, t) => { log.push(`getNode(${pid},${t})`); const n = nodes[t]; return n ? { nodeType: t, state: n.state, progress: n.progress ?? 0, depthUnlocked: n.depthUnlocked, maxDepth: n.maxDepth, repeatedDepth: 0, unlockIndices: [] } : null; } } },
    GameContext: { localPlayerID: 1, localObserverID: 1 },
    Players: { get: (id) => { log.push(`Players.get(${id})`); return id === 1 ? me : undefined; } },
    Configuration: { getGame: () => SP },
    GameInfo: {
      Units: table([]), Constructibles: table([]), Projects: table([]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]),
      ProgressionTrees: table([{ $hash: 500, ProgressionTreeType: "TREE_TECHS_AQ" }, { $hash: 600, ProgressionTreeType: "TREE_CIVICS_AQ_MAIN" }, { $hash: 601, ProgressionTreeType: "TREE_CIVICS_AQ_GREECE" }]),
      ProgressionTreeNodes: table([
        { $hash: 700, ProgressionTreeNodeType: "NODE_TECH_AQ_AGRICULTURE", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_AGRI" },
        { $hash: 701, ProgressionTreeNodeType: "NODE_TECH_AQ_POTTERY", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_POTTERY" },
        { $hash: 702, ProgressionTreeNodeType: "NODE_TECH_AQ_WRITING", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_WRITING" },
        { $hash: 703, ProgressionTreeNodeType: "NODE_TECH_AQ_SAILING", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_SAILING" },
        { $hash: 800, ProgressionTreeNodeType: "NODE_CIVIC_AQ_MAIN_CHIEFDOM", ProgressionTree: "TREE_CIVICS_AQ_MAIN", Name: "LOC_CHIEF" },
        { $hash: 801, ProgressionTreeNodeType: "NODE_CIVIC_AQ_MAIN_DISCIPLINE", ProgressionTree: "TREE_CIVICS_AQ_MAIN", Name: "LOC_DISC" },
        { $hash: 802, ProgressionTreeNodeType: "NODE_CIVIC_AQ_GREECE_EKKLESIA", ProgressionTree: "TREE_CIVICS_AQ_GREECE", Name: "LOC_EKK" },
      ]),
    },
    Locale: { compose: (k) => ({ LOC_POTTERY: "Pottery", LOC_DISC: "Discipline", LOC_AGRI: "Agriculture", LOC_SAILING: "Sailing", LOC_CHIEF: "Chiefdom", LOC_WRITING: "Writing", LOC_EKK: "Ekklesia" })[k] ?? k },
  };
  if (!noEnum) g.ProgressionTreeNodeState = STATE;
  return g;
}

test("technology: current, completed with depth, queued target, tree", () => {
  const r = run(game());
  assert.equal(r.refused, null);
  const t = r.technology;
  assert.equal(t.status, "supported");
  assert.deepEqual(t.tree, { type: 500, typeKey: "TREE_TECHS_AQ" });
  assert.deepEqual(t.current, { type: 701, typeKey: "NODE_TECH_AQ_POTTERY", displayName: "Pottery", tree: "TREE_TECHS_AQ", state: 3, stateName: "NODE_STATE_IN_PROGRESS", progress: 45, cost: 60, turnsLeft: 1, depthUnlocked: 0, maxDepth: 1 });
  assert.deepEqual(t.queuedTarget, { type: 702, typeKey: "NODE_TECH_AQ_WRITING" });
  assert.deepEqual(t.completed.map((n) => [n.typeKey, n.stateName, n.depthUnlocked, n.maxDepth]), [
    ["NODE_TECH_AQ_AGRICULTURE", "NODE_STATE_FULLY_UNLOCKED", 1, 1],
    ["NODE_TECH_AQ_SAILING", "NODE_STATE_UNLOCKED", 1, 2],
  ]);
  assert.equal(t.completed[0].tree, "TREE_TECHS_AQ");
  assert.equal(t.completed[0].displayName, "Agriculture");
});

test("technology state comes from getNode, not from the getResearching record", () => {
  const r = run(game());
  assert.equal(r.technology.current.state, 3);  // the record said 0
});

test("civics: current, completed, active and available trees, civ-specific tree membership", () => {
  const r = run(game());
  const c = r.civics;
  assert.equal(c.status, "supported");
  assert.deepEqual(c.trees, { active: { type: 600, typeKey: "TREE_CIVICS_AQ_MAIN" }, available: [{ type: 600, typeKey: "TREE_CIVICS_AQ_MAIN" }, { type: 601, typeKey: "TREE_CIVICS_AQ_GREECE" }] });
  assert.equal(c.current.typeKey, "NODE_CIVIC_AQ_MAIN_DISCIPLINE");
  assert.equal(c.current.progress, 72);
  assert.equal(c.current.cost, 125);
  assert.equal(c.current.maxDepth, 2);
  assert.equal(c.queuedTarget, null);
  assert.deepEqual(c.completed.map((n) => [n.typeKey, n.tree]), [["NODE_CIVIC_AQ_MAIN_CHIEFDOM", "TREE_CIVICS_AQ_MAIN"]]);
  assert.deepEqual(r.warnings, []);
});

test("no current research is null, not an empty-looking record", () => {
  const g = game();
  g.Players.get(1).Techs.getResearching = () => ({ type: -1, state: 0, progress: 0, depth: 0, maxDepth: 0 });
  g.Players.get(1).Techs.getTurnsLeft = () => -1;
  const r = run(g);
  assert.equal(r.technology.current, null);
});

test("missing Culture component fails the capture instead of reporting no civics", () => {
  assert.equal(run(game({ culture: null })).refused.code, "API_CONTRACT_MISMATCH");
  assert.equal(run(game({ techs: null })).refused.code, "API_CONTRACT_MISMATCH");
});

test("missing state enum or malformed records fail the capture", () => {
  assert.equal(run(game({ noEnum: true })).refused.code, "API_CONTRACT_MISMATCH");
  const g = game();
  g.Players.get(1).Techs.getResearched = () => 5;
  assert.equal(run(g).refused.code, "API_CONTRACT_MISMATCH");
  const g2 = game();
  g2.Players.get(1).Culture.getResearching = () => ({ type: "801" });
  assert.equal(run(g2).refused.code, "API_CONTRACT_MISMATCH");
  const g3 = game();
  g3.Game.ProgressionTrees.getNode = () => null;   // current node must resolve
  assert.equal(run(g3).refused.code, "API_CONTRACT_MISMATCH");
});

test("unknown node definition keeps the hash and null keys rather than dropping the node", () => {
  const g = game();
  g.Players.get(1).Techs.getResearched = () => [{ type: 999, state: 5, progress: 0, depth: 1, maxDepth: 1 }];
  g.Game.ProgressionTrees.getNode = (pid, t) => (t === 999 ? { nodeType: 999, state: 5, progress: 0, depthUnlocked: 1, maxDepth: 1 } : { nodeType: t, state: 3, progress: 45, depthUnlocked: 0, maxDepth: 1 });
  const r = run(g);
  assert.equal(r.technology.completed[0].type, 999);
  assert.equal(r.technology.completed[0].typeKey, null);
  assert.ok(r.warnings.some((w) => w.code === "NODE_DEFINITION_MISSING"));
});

test("progression reads use only the bound player id", () => {
  const log = [];
  run(game({ log }));
  assert.ok(log.filter((e) => e.startsWith("getNode(")).every((e) => e.startsWith("getNode(1,")));
  assert.ok(log.filter((e) => e.startsWith("Players.get(")).every((e) => e === "Players.get(1)"));
});
