// Offline tests for payloads/offers.js (read-only enumeration) and payloads/perform.js (the mutation payload).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const offersRaw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "offers.js"), "utf8");
const performRaw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "perform.js"), "utf8");
const table = (rows) => ({ length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null });
const SP = { isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false, campaignSetupGUID: "ABCDEF0123456789", gameGUIDHexString: "" };
const STATE = { NODE_STATE_INVALID: 0, NODE_STATE_CLOSED: 1, NODE_STATE_OPEN: 2, NODE_STATE_IN_PROGRESS: 3, NODE_STATE_UNLOCKED: 4, NODE_STATE_FULLY_UNLOCKED: 5 };

function world({ log = [], local = 1, turnActive = true, curtain = false, blocking = false, sentComplete = false, canStartFail = false, researchAfter = 701 } = {}) {
  const me = {
    id: local, isTurnActive: turnActive, isValid: true,
    Techs: { getAllAvailableNodeTypes: () => [701, 702], getResearching: () => ({ type: researchAfter }), getNodeCost: (t) => (t === 701 ? 60 : 100), getTurnsForNode: (t) => (t === 701 ? 4 : 7), getTreeType: () => 500 },
    Culture: { getAllAvailableNodeTypes: () => [801], getResearching: () => ({ type: -1 }), getNodeCost: () => 125, getTurnsForNode: () => 6, getActiveTree: () => 600 },
  };
  const other = new Proxy({}, { get(_, k) { log.push(`other.${String(k)}`); return undefined; } });
  const ops = {
    canStart: (pid, op, args, show) => { log.push(`canStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: !canStartFail }; },
    sendRequest: (pid, op, args) => { log.push(`sendRequest(${pid},${op},${JSON.stringify(args)})`); },
  };
  return {
    UI: { isInGame: () => true },
    Game: { turn: 10, age: 4242, PlayerOperations: ops, Notifications: { getEndTurnBlockingType: (pid) => { log.push(`blocking(${pid})`); return blocking ? 23669119 : 0; }, getTypeName: () => undefined }, ProgressionTrees: { getNodeState: () => 2 } },
    EndTurnBlockingTypes: { NONE: 0, UNITS: 23669119, RESEARCH: -286188551 },
    GameContext: { localPlayerID: local, localObserverID: local, _sent: sentComplete, hasSentTurnComplete() { log.push("hasSentTurnComplete"); return this._sent; }, sendTurnComplete() { log.push("sendTurnComplete"); this._sent = true; } },
    Players: { get: (id) => { log.push(`Players.get(${id})`); return id === local ? me : other; } },
    Configuration: { getGame: () => SP },
    PlayerOperationTypes: { SET_TECH_TREE_NODE: 9001, SET_CULTURE_TREE_NODE: 9002, GRANT_TREE_NODE: 9999 },
    ProgressionTreeNodeState: STATE,
    GameInfo: { Units: table([{ $hash: 99, UnitType: "UNIT_SCOUT" }]), ProgressionTreeNodes: table([{ $hash: 701, ProgressionTreeNodeType: "NODE_TECH_AQ_POTTERY", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_P" }, { $hash: 702, ProgressionTreeNodeType: "NODE_TECH_AQ_WRITING", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_W" }, { $hash: 801, ProgressionTreeNodeType: "NODE_CIVIC_AQ_MAIN_MYSTICISM", ProgressionTree: "TREE_CIVICS_AQ_MAIN", Name: "LOC_M" }]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]) },
    Locale: { compose: (k) => ({ LOC_P: "Pottery", LOC_W: "Writing", LOC_M: "Mysticism", LOC_C: "Cordoba" })[k] ?? k },
    document: { getElementById: (id) => (id === "hotseat-screen-curtain" && curtain ? {} : null) },
  };
}
const renderOffers = (id, mode) => offersRaw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode));
const PRE_DEFAULT = { SET_TECH_TREE_NODE: 701, SET_CULTURE_TREE_NODE: -1, END_TURN: 0, SKIP_UNIT: 2, MOVE_UNIT: 1010, PRODUCE_UNIT: 0, PRODUCE_CONSTRUCTIBLE: 0 };
const renderPerform = (id, mode, kind, arg, turn, age, arg2 = 0, arg3 = 0, pre = PRE_DEFAULT[kind] ?? 0, match = "ABCDEF0123456789") => performRaw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode)).replaceAll("OP_KIND", JSON.stringify(kind)).replaceAll("OP_ARG2", String(arg2)).replaceAll("OP_ARG3", String(arg3)).replaceAll("OP_ARG", String(arg)).replaceAll("EXPECTED_TURN", String(turn)).replaceAll("EXPECTED_AGE", String(age)).replaceAll("EXPECTED_GUID", JSON.stringify(match)).replaceAll("OP_PRE", String(pre));
const runPerformArgs = (g, kind, arg, arg2, arg3, { id = 1, mode = "singleplayer", turn = 10, age = 4242, pre, match } = {}) => JSON.parse(vm.runInContext(renderPerform(id, mode, kind, arg, turn, age, arg2, arg3, pre, match), vm.createContext({ ...g }), { timeout: 2000 }));
const runOffers = (g, id = 1, mode = "singleplayer") => JSON.parse(vm.runInContext(renderOffers(id, mode), vm.createContext({ ...g }), { timeout: 2000 }));
const runPerform = (g, kind, arg, { id = 1, mode = "singleplayer", turn = 10, age = 4242, pre, match } = {}) => JSON.parse(vm.runInContext(renderPerform(id, mode, kind, arg, turn, age, 0, 0, pre, match), vm.createContext({ ...g }), { timeout: 2000 }));

// ---- offers.js

test("offers enumerate research/civic choices with native canStart and an end-turn offer with native blocker state", () => {
  const log = [];
  const r = runOffers(world({ log }));
  assert.equal(r.refused, null);
  assert.deepEqual(r.context, { turn: 10, age: 4242, ageType: "AGE_ANTIQUITY", playerId: 1, localPlayerId: 1, localObserverId: 1, mode: "singleplayer", isTurnActive: true, curtainDisplayed: false, gameGuid: "ABCDEF0123456789" });
  assert.ok(r.offers.every((o) => typeof o.pre === "number"));
  const research = r.offers.filter((o) => o.kind === "SET_TECH_TREE_NODE");
  assert.deepEqual(research.map((o) => [o.arg, o.typeKey, o.displayName, o.tree, o.cost, o.turns, o.canStart]), [[701, "NODE_TECH_AQ_POTTERY", "Pottery", "TREE_TECHS_AQ", 60, 4, true], [702, "NODE_TECH_AQ_WRITING", "Writing", "TREE_TECHS_AQ", 100, 7, true]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "SET_CULTURE_TREE_NODE").map((o) => o.typeKey), ["NODE_CIVIC_AQ_MAIN_MYSTICISM"]);
  const end = r.offers.find((o) => o.kind === "END_TURN");
  assert.deepEqual(end, { kind: "END_TURN", arg: 0, pre: 0, canStart: true, blockingType: null, alreadySent: false });
  assert.ok(log.filter((e) => e.startsWith("canStart(")).every((e) => e.startsWith("canStart(1,") && e.endsWith(",false)")));
  assert.ok(!log.some((e) => e.startsWith("sendRequest") || e === "sendTurnComplete"), "offers must never mutate");
  assert.ok(!log.some((e) => e.startsWith("other.")));
});

test("offers report blocked end turn and unavailable research honestly", () => {
  const r = runOffers(world({ blocking: true, canStartFail: true, sentComplete: true }));
  const end = r.offers.find((o) => o.kind === "END_TURN");
  assert.deepEqual([end.canStart, end.blockingType, end.alreadySent], [false, "UNITS", true]);
  assert.ok(r.offers.filter((o) => o.kind !== "END_TURN").every((o) => o.canStart === false));
});

test("offers apply the same guards as observe and report the curtain", () => {
  assert.equal(runOffers(world(), 0).refused.code, "WRONG_PLAYER");
  assert.equal(runOffers(world({ turnActive: false })).refused.code, "TURN_NOT_READY");
  assert.equal(runOffers(world({ curtain: true })).context.curtainDisplayed, true);
});

// ---- perform.js

test("perform refuses when the match id or the precondition differ from the offer", () => {
  assert.equal(runPerform(world({}), "SET_TECH_TREE_NODE", 701, { match: "OTHER" }).refused.code, "ACTION_EXPIRED");
  assert.equal(runPerform(world({}), "SET_TECH_TREE_NODE", 701, { pre: 702 }).refused.code, "ACTION_EXPIRED");
  const g = withUnits(world({ log: [] }), [unit(5)]); g._log = [];
  assert.equal(runPerformArgs(g, "SKIP_UNIT", 5, 0, 0, { pre: 1 }).refused.code, "ACTION_EXPIRED");
});

test("perform re-checks guards and canStart immediately before sendRequest, then reports the read-back", () => {
  const log = [];
  const r = runPerform(world({ log, researchAfter: 701 }), "SET_TECH_TREE_NODE", 701);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "SET_TECH_TREE_NODE", arg: 701, observedType: 701, matches: true });
  const i = log.indexOf('canStart(1,9001,{"ProgressionTreeNodeType":701},false)');
  const j = log.indexOf('sendRequest(1,9001,{"ProgressionTreeNodeType":701})');
  assert.ok(i !== -1 && j !== -1 && i < j, `canStart must precede sendRequest: ${log}`);
  assert.equal(log.filter((e) => e.startsWith("sendRequest")).length, 1);
});

test("perform refuses without sending when canStart fails, context differs, seat differs, or kind is unknown", () => {
  for (const [label, g, kind, arg, opts] of [
    ["canStart false", world({ canStartFail: true }), "SET_TECH_TREE_NODE", 701, {}],
    ["turn changed", world(), "SET_TECH_TREE_NODE", 701, { turn: 11 }],
    ["age changed", world(), "SET_TECH_TREE_NODE", 701, { age: 1 }],
    ["wrong seat", world(), "SET_TECH_TREE_NODE", 701, { id: 0 }],
    ["unknown kind", world(), "GRANT_TREE_NODE", 701, {}],
    ["inactive turn", world({ turnActive: false }), "SET_TECH_TREE_NODE", 701, {}],
  ]) {
    const log = [];
    g.Game.PlayerOperations.sendRequest = (...a) => { log.push("SENT"); };
    g.GameContext.sendTurnComplete = () => { log.push("SENT"); };
    const r = runPerform(g, kind, arg, opts);
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.includes("SENT"), `${label}: must not mutate`);
  }
});

test("perform end turn checks native blockers and hasSentTurnComplete first", () => {
  const log = [];
  const ok = runPerform(world({ log }), "END_TURN", 0);
  assert.equal(ok.outcome, "sent");
  assert.ok(log.indexOf("blocking(1)") < log.indexOf("sendTurnComplete"));
  assert.equal(ok.readback.sentComplete, true);
  const blocked = runPerform(world({ blocking: true }), "END_TURN", 0);
  assert.equal(blocked.refused.code, "ACTION_BLOCKED");
  assert.equal(blocked.refused.blockingType, "UNITS");
  const dup = runPerform(world({ sentComplete: true }), "END_TURN", 0);
  assert.equal(dup.refused.code, "ACTION_BLOCKED");
});

test("perform reports a mismatched read-back as unknown, not success", () => {
  const r = runPerform(world({ researchAfter: 702 }), "SET_TECH_TREE_NODE", 701, { pre: 702 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.readback.matches, false);
});

// ---- unit skip
function withUnits(g, units, { skipOk = true } = {}) {
  const me = g.Players.get(1);
  me.Units = { getUnits: () => units };
  g.UnitOperationTypes = { SKIP_TURN: 745019656, SLEEP: -41338758 };
  g.UnitActivityTypes = { NONE: -1, AWAKE: 1797587246, OPERATION: 1225574625 };
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { g._log.push(`ucanStart(${JSON.stringify(uid)},${op},${JSON.stringify(args)},${show})`); return { Success: skipOk && uid.owner === 1 }; },
    sendRequest: (uid, op, args) => { g._log.push(`usendRequest(${JSON.stringify(uid)},${op},${JSON.stringify(args)})`); const u = units.find((x) => x.id.id === uid.id); if (u) { u.isReadyToMove = false; u.activityType = 1225574625; } },
  };
  return g;
}
const unit = (id, extra) => ({ id: { owner: 1, id, type: 26 }, type: 99, isOnMap: true, isReadyToMove: true, isReadyToSelect: true, activityType: 1797587246, Movement: { movementMovesRemaining: 2, maxMoves: 2 }, ...extra });

test("offers include one skip offer per owned unit with canStart from the native query", () => {
  const log = [];
  const g = withUnits(world({ log }), [unit(5), unit(6, { isReadyToMove: false, Movement: { movementMovesRemaining: 0, maxMoves: 2 } })]);
  g._log = log;
  const r = runOffers(g);
  const skips = r.offers.filter((o) => o.kind === "SKIP_UNIT");
  assert.deepEqual(skips.map((o) => [o.arg, o.unitTypeKey, o.movesRemaining, o.canStart]), [[5, "UNIT_SCOUT", 2, true], [6, "UNIT_SCOUT", 0, true]]);
  assert.ok(log.filter((e) => e.startsWith("ucanStart(")).every((e) => e.includes('"owner":1') && e.includes("745019656") && e.endsWith(",{},false)")));
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

test("perform SKIP_UNIT resolves the unit from the bound roster, checks canStart, sends, and reads back", () => {
  const log = [];
  const units = [unit(5), unit(6)];
  const g = withUnits(world({ log }), units); g._log = log;
  const r = runPerform(g, "SKIP_UNIT", 5);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "SKIP_UNIT", arg: 5, isReadyToMove: false, matches: true });
  const i = log.findIndex((e) => e.startsWith("ucanStart(") && e.includes('"id":5'));
  const j = log.findIndex((e) => e.startsWith("usendRequest(") && e.includes('"id":5'));
  assert.ok(i !== -1 && j !== -1 && i < j);
  assert.ok(!log.some((e) => e.startsWith("usendRequest(") && e.includes('"id":6')));
});

test("perform SKIP_UNIT refuses an id that is not in the bound roster and never touches Units.get", () => {
  const log = [];
  const g = withUnits(world({ log }), [unit(5)]); g._log = log;
  g.Units = new Proxy({}, { get(_, k) { log.push(`Units.${String(k)}`); return () => ({}); } });
  const r = runPerform(g, "SKIP_UNIT", 99);
  assert.equal(r.refused.code, "UNKNOWN_ACTION");
  assert.ok(!log.some((e) => e.startsWith("Units.")));
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

// ---- unit move (adjacent, known plots only, never an attack)
function withMap(g, { hiddenAt = [], moveOk = true, unreachable = [] } = {}) {
  g.Units = { getPathTo: (uid, loc) => { g._log.push(`path(${uid.id},${loc.x},${loc.y})`); return unreachable.some(([ux, uy]) => ux === loc.x && uy === loc.y) ? { plots: [], turns: [], obstacles: [] } : { plots: [1, 2], turns: [1, 1], obstacles: [] }; } };
  g.UnitOperationTypes = { ...(g.UnitOperationTypes || {}), SKIP_TURN: 745019656, MOVE_TO: 1477390184 };
  g.UnitOperationMoveModifiers = { NONE: 0, ATTACK: 16, MOVE_IGNORE_UNEXPLORED_DESTINATION: 16384 };
  g.RevealedStates = { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 };
  g.DirectionTypes = { NO_DIRECTION: -1, DIRECTION_NORTHEAST: 0, DIRECTION_EAST: 1, DIRECTION_SOUTHEAST: 2, DIRECTION_SOUTHWEST: 3, DIRECTION_WEST: 4, DIRECTION_NORTHWEST: 5, NUM_DIRECTION_TYPES: 6 };
  const neighbours = (loc, d) => [{ x: loc.x, y: loc.y + 1 }, { x: loc.x + 1, y: loc.y }, { x: loc.x, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y }, { x: loc.x - 1, y: loc.y + 1 }][d];
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getAdjacentPlotLocation: (loc, d) => { g._log.push(`adj(${loc.x},${loc.y},${d})`); return neighbours(loc, d); }, getRevealedState: (pid, x, y) => { g._log.push(`vis(${pid},${x},${y})`); return hiddenAt.some(([hx, hy]) => hx === x && hy === y) ? 0 : 2; }, getTerrainType: () => 1 };
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  const prev = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { g._log.push(`ucanStart(${JSON.stringify(uid)},${op},${JSON.stringify(args)},${show})`); if (op === 1477390184) return { Success: moveOk && uid.owner === 1 }; return prev ? prev.canStart(uid, op, args, show) : { Success: true }; },
    sendRequest: (uid, op, args) => { g._log.push(`usendRequest(${JSON.stringify(uid)},${op},${JSON.stringify(args)})`); if (op === 1477390184) { const u = g.Players.get(1).Units.getUnits().find((x) => x.id.id === uid.id); if (u) u.location = { x: args.X, y: args.Y }; } else if (prev) prev.sendRequest(uid, op, args); },
  };
  return g;
}

test("move offers cover adjacent known reachable plots only, with canStart(MOVE_TO) and Modifiers NONE", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })]), { hiddenAt: [[11, 10]], unreachable: [[10, 11]] }); g._log = log;
  const r = runOffers(g);
  const moves = r.offers.filter((o) => o.kind === "MOVE_UNIT");
  assert.equal(moves.length, 4, "six neighbours minus one hidden minus one with no path");
  assert.ok(!moves.some((o) => o.x === 10 && o.y === 11), "plot with an empty native path must not be offered");
  assert.ok(moves.every((o) => o.pathTurns === 1));
  assert.ok(moves.every((o) => o.arg === 5 && o.canStart === true && typeof o.x === "number" && typeof o.y === "number" && o.direction >= 0 && o.terrainKey === "TERRAIN_FLAT"));
  assert.ok(!moves.some((o) => o.x === 11 && o.y === 10), "hidden plot must not be offered");
  const moveChecks = log.filter((e) => e.startsWith("ucanStart(") && e.includes("1477390184"));
  assert.equal(moveChecks.length, 4);
  assert.ok(moveChecks.every((e) => e.includes('"Modifiers":0')));
  // visibility is read before canStart for each plot
  for (const o of moves) {
    const vi = log.indexOf(`vis(1,${o.x},${o.y})`);
    const ci = log.findIndex((e) => e.startsWith("ucanStart(") && e.includes(`"X":${o.x},"Y":${o.y}`));
    assert.ok(vi !== -1 && ci > vi);
  }
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

test("perform MOVE_UNIT sends only for an adjacent known plot after canStart, and reads back the location", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "MOVE_UNIT", 5, 11, 10);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "MOVE_UNIT", arg: 5, target: { x: 11, y: 10 }, location: { x: 11, y: 10 }, matches: true });
  const send = log.find((e) => e.startsWith("usendRequest(") && e.includes("1477390184"));
  assert.ok(send && send.includes('"X":11,"Y":10,"Modifiers":0'));
});

test("perform MOVE_UNIT refuses non-adjacent, hidden, unknown-unit and canStart-false targets without sending", () => {
  for (const [label, mk, uid, x, y] of [
    ["non-adjacent", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 5, 13, 13],
    ["hidden", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { hiddenAt: [[11, 10]] }), 5, 11, 10],
    ["unknown unit", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 9, 11, 10],
    ["canStart false", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { moveOk: false }), 5, 11, 10],
    ["no native path", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { unreachable: [[11, 10]] }), 5, 11, 10],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "MOVE_UNIT", uid, x, y);
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("usendRequest")), `${label}: must not send`);
  }
});

// ---- produce unit (city production, units only; constructibles need placement and are deferred)
function withCity(g, { buildable = [99, 100], sentTo = null } = {}) {
  const city = { id: { owner: 1, id: 65536, type: 1 }, owner: 1, name: "LOC_C", location: { x: 3, y: 4 }, isTown: false, BuildQueue: { currentProductionTypeHash: -1, isEmpty: true, _q: [], getQueue() { return this._q.slice(); } } };
  g.Players.get(1).Cities = { getCities: () => [city] };
  g.GameInfo.Units = table([{ $hash: 99, UnitType: "UNIT_SCOUT", Name: "LOC_SCOUT", CoreClass: "CORE_CLASS_RECON" }, { $hash: 100, UnitType: "UNIT_WARRIOR", Name: "LOC_WARRIOR", CoreClass: "CORE_CLASS_MILITARY" }, { $hash: 101, UnitType: "UNIT_GALLEY", Name: "LOC_GALLEY", CoreClass: "CORE_CLASS_MILITARY" }]);
  g.GameInfo.Units[Symbol.iterator] = function* () { yield* [{ $hash: 99, UnitType: "UNIT_SCOUT", Name: "LOC_SCOUT" }, { $hash: 100, UnitType: "UNIT_WARRIOR", Name: "LOC_WARRIOR" }, { $hash: 101, UnitType: "UNIT_GALLEY", Name: "LOC_GALLEY" }]; };
  g.CityOperationTypes = { BUILD: 5551, CONSIDER_TOWN_PROJECT: 5552 };
  g.Game.CityOperations = {
    canStart: (cid, op, args, show) => { g._log.push(`ccanStart(${JSON.stringify(cid)},${op},${JSON.stringify(args)},${show})`); return { Success: cid.owner === 1 && buildable.includes(args.UnitType), Requirements: {}, FailureReasons: buildable.includes(args.UnitType) ? undefined : ["LOC_NO"] }; },
    sendRequest: (cid, op, args) => { g._log.push(`csendRequest(${JSON.stringify(cid)},${op},${JSON.stringify(args)})`); city.BuildQueue._q.push({ type: sentTo ?? args.UnitType, kind: 1 }); city.BuildQueue.currentProductionTypeHash = city.BuildQueue._q[0].type; city.BuildQueue.isEmpty = false; },
  };
  g.Game.CityCommands = { canStart: () => { g._log.push("PURCHASE"); return { Success: true }; }, sendRequest: () => { g._log.push("PURCHASE"); } };
  return g;
}

test("produce offers list units the native BUILD canStart accepts, per owned city, never purchases", () => {
  const log = [];
  const g = withCity(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  const prod = r.offers.filter((o) => o.kind === "PRODUCE_UNIT");
  assert.deepEqual(prod.map((o) => [o.arg, o.arg2, o.unitTypeKey, o.canStart]), [[65536, 99, "UNIT_SCOUT", true], [65536, 100, "UNIT_WARRIOR", true]]);
  assert.ok(prod.every((o) => o.cityName === "Cordoba" && o.cityId === 65536), "city names must be localized, not raw keys");
  assert.ok(log.filter((e) => e.startsWith("ccanStart(")).every((e) => e.includes('"owner":1') && e.includes(",5551,") && e.endsWith(",false)")));
  assert.ok(!log.includes("PURCHASE") && !log.some((e) => e.startsWith("csendRequest")));
});

test("perform PRODUCE_UNIT resolves the city from the bound roster, checks canStart, sends BUILD and reads back", () => {
  const log = [];
  const g = withCity(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "PRODUCE_UNIT", 65536, 100, 0);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "PRODUCE_UNIT", arg: 65536, unitType: 100, queuedAt: 0, queueLength: 1, matches: true });
  const i = log.findIndex((e) => e.startsWith("ccanStart(") && e.includes('"UnitType":100'));
  const j = log.findIndex((e) => e.startsWith("csendRequest(") && e.includes('"UnitType":100'));
  assert.ok(i !== -1 && j !== -1 && i < j);
  assert.ok(!log.includes("PURCHASE"));
});

test("perform PRODUCE_UNIT refuses unknown city, unbuildable unit, and never uses Cities.get", () => {
  for (const [label, cid, ut] of [["unknown city", 7, 100], ["unbuildable", 65536, 101]]) {
    const log = [];
    const g = withCity(withUnits(world({ log }), [])); g._log = log;
    g.Cities = new Proxy({}, { get(_, k) { log.push(`Cities.${String(k)}`); return () => ({}); } });
    const r = runPerformArgs(g, "PRODUCE_UNIT", cid, ut, 0);
    assert.ok(r.refused, label);
    assert.ok(!log.some((e) => e.startsWith("csendRequest") || e.startsWith("Cities.")), label);
  }
});


test("perform MOVE_UNIT requires the destination to be exactly VISIBLE at execution, before any path lookup or send", () => {
  for (const [label, mutate] of [
    ["fogged since the offer", (g) => { const inner = g.GameplayMap.getRevealedState; g.GameplayMap.getRevealedState = (pid, x, y) => (x === 11 && y === 10 ? 1 : inner(pid, x, y)); }],
    ["enum without integer VISIBLE", (g) => { g.RevealedStates = { HIDDEN: 0, REVEALED: 1 }; }],
    ["non-integer visibility result", (g) => { g.GameplayMap.getRevealedState = () => "2"; }],
  ]) {
    const log = [];
    const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
    mutate(g);
    const r = runPerformArgs(g, "MOVE_UNIT", 5, 11, 10);
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("path(") || e.startsWith("usendRequest")), `${label}: no path lookup or send after refusal: ${log}`);
  }
});

// ---- found city (where the unit stands; the shipped panel sends no target plot)
function withFounder(g, units, { foundOk = true, cityAfter = true } = {}) {
  withUnits(g, units);
  const cities = [];
  g.Players.get(1).Cities = { getCities: () => cities };
  g.UnitOperationTypes.FOUND_CITY = 1463004268;
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getTerrainType: () => 1 };
  const inner = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => op === 1463004268 ? (g._log.push(`ucanStart(${JSON.stringify(uid)},${op},${JSON.stringify(args)},${show})`), { Success: foundOk && uid.owner === 1 && units.some((u) => u.id.id === uid.id && u.type === 7) }) : inner.canStart(uid, op, args, show),
    sendRequest: (uid, op, args) => { if (op !== 1463004268) return inner.sendRequest(uid, op, args); g._log.push(`usendRequest(${JSON.stringify(uid)},${op},${JSON.stringify(args)})`); const u = units.find((x) => x.id.id === uid.id); if (u && cityAfter) cities.push({ id: { owner: 1, id: 65536, type: 1 }, location: { x: u.location.x, y: u.location.y } }); },
  };
  return g;
}
const founder = (id, extra) => unit(id, { type: 7, location: { x: 15, y: 27 }, Movement: { movementMovesRemaining: 3, maxMoves: 3 }, ...extra });

test("found offers exist only for units the native FOUND_CITY canStart accepts, bound to the unit's plot", () => {
  const log = [];
  const g = withFounder(world({ log }), [founder(5), unit(6, { location: { x: 1, y: 1 } })]); g._log = log;
  g.GameInfo.Units = table([{ $hash: 99, UnitType: "UNIT_SCOUT" }, { $hash: 7, UnitType: "UNIT_FOUNDER" }]);
  const r = runOffers(g);
  const found = r.offers.filter((o) => o.kind === "FOUND_CITY");
  assert.deepEqual(found.map((o) => [o.arg, o.x, o.y, o.pre, o.unitId, o.unitTypeKey, o.terrainKey, o.movesRemaining, o.canStart]), [[5, 15, 27, 2715, 5, "UNIT_FOUNDER", "TERRAIN_FLAT", 3, true]]);
  assert.deepEqual(found[0].from, { x: 15, y: 27 });
  const checks = log.filter((e) => e.startsWith("ucanStart(") && e.includes("1463004268"));
  assert.equal(checks.length, 3, "an existence check per owned unit, then a legality check for the settler only");
  assert.ok(checks.every((e) => e.includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1')));
  assert.deepEqual(checks.map((e) => e.endsWith(",true)")), [true, false, true]);
  assert.equal(found[0].reason, null);
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

test("a settler that cannot found where it stands is still offered, canStart false with a reason, so the seat moves it", () => {
  const log = [];
  const g = withFounder(world({ log }), [founder(5)], { foundOk: false }); g._log = log;
  g.Game.UnitOperations.canStart = ((inner) => (uid, op, args, show) => op === 1463004268 && show === true ? { Success: uid.id === 5 } : inner(uid, op, args, show))(g.Game.UnitOperations.canStart);
  const r = runOffers(g);
  const found = r.offers.filter((o) => o.kind === "FOUND_CITY");
  assert.equal(found.length, 1);
  assert.equal(found[0].canStart, false);
  assert.match(found[0].reason, /refuses founding/);
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

// ---- expand city (new population placement onto a claimable plot)
function withExpand(g, { plots = [[16, 28], [16, 27]], types = [4, 5], claimOk = true, removeAfter = true } = {}) {
  const city = { id: { owner: 1, id: 65536, type: 1 }, owner: 1, name: "LOC_C", location: { x: 15, y: 27 }, isTown: false, Growth: { isReadyToPlacePopulation: true }, BuildQueue: { currentProductionTypeHash: -1, isEmpty: true } };
  g.Players.get(1).Cities = { getCities: () => [city] };
  let offered = plots.map(([x, y]) => y * 100 + x);
  g.CityCommandTypes = { EXPAND: 7771, PURCHASE: 7772 };
  g.GameInfo.Constructibles = table([{ $hash: 4, ConstructibleType: "IMPROVEMENT_FARM" }, { $hash: 5, ConstructibleType: "IMPROVEMENT_MINE" }]);
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  g.GameInfo.Features = table([]);
  g.GameInfo.Yields = [{ $hash: 619730924, YieldType: "YIELD_FOOD" }, { $hash: -1155936758, YieldType: "YIELD_PRODUCTION" }];
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }), getTerrainType: () => 1, getFeatureType: () => -1, isRiver: (x) => x === 16, getYield: (x, y, h) => (h === 619730924 ? 2 : 1) };
  g.Game.CityCommands = {
    canStart: (cid, op, args, show) => { g._log.push(`kcanStart(${JSON.stringify(cid)},${op},${JSON.stringify(args)},${show})`); if (op !== 7771 || cid.owner !== 1) return { Success: false }; if (args.X === undefined) return { Success: true, Plots: offered.slice(), ConstructibleTypes: offered.map((pi) => types[plots.findIndex(([x, y]) => y * 100 + x === pi)] ?? 4) }; return { Success: claimOk && offered.includes(args.Y * 100 + args.X) }; },
    sendRequest: (cid, op, args) => { g._log.push(`ksendRequest(${JSON.stringify(cid)},${op},${JSON.stringify(args)})`); if (removeAfter) offered = offered.filter((pi) => pi !== args.Y * 100 + args.X); },
  };
  return g;
}

test("expand offers list every claimable plot the native EXPAND query returns, with improvement, terrain and yields", () => {
  const log = [];
  const g = withExpand(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  const ex = r.offers.filter((o) => o.kind === "EXPAND_CITY");
  assert.deepEqual(ex.map((o) => [o.arg, o.x, o.y, o.pre, o.cityId, o.cityName, o.improvementKey, o.terrainKey, o.river, o.growthReady, o.canStart]),
    [[65536, 16, 28, 2816, 65536, "Cordoba", "IMPROVEMENT_FARM", "TERRAIN_FLAT", true, true, true], [65536, 16, 27, 2716, 65536, "Cordoba", "IMPROVEMENT_MINE", "TERRAIN_FLAT", true, true, true]]);
  assert.deepEqual(ex[0].yields, { food: 2, production: 1 });
  assert.ok(log.filter((e) => e.startsWith("kcanStart(")).every((e) => e.includes('"owner":1') && e.includes(",7771,") && e.endsWith(",false)")));
  assert.ok(!log.some((e) => e.startsWith("ksendRequest")));
});

test("perform EXPAND_CITY re-checks the plot is still offered and canStart, sends EXPAND {X, Y}, and reads back its disappearance", () => {
  const log = [];
  const g = withExpand(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "EXPAND_CITY", 65536, 16, 28, { pre: 2816 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "EXPAND_CITY", arg: 65536, plot: { x: 16, y: 28, index: 2816 }, stillOffered: false, matches: true });
  const i = log.findIndex((e) => e.startsWith("kcanStart(") && e.includes('"X":16,"Y":28'));
  const j = log.findIndex((e) => e.startsWith("ksendRequest(") && e.includes('"X":16,"Y":28'));
  assert.ok(i !== -1 && j !== -1 && i < j);
});

test("perform EXPAND_CITY refuses an unknown city, a plot no longer offered, a stale plot index and a canStart refusal without sending", () => {
  for (const [label, mk, cid, x, y, pre] of [
    ["unknown city", () => withExpand(withUnits(world({ log: [] }), [])), 7, 16, 28, 2816],
    ["plot not offered", () => withExpand(withUnits(world({ log: [] }), [])), 65536, 17, 28, 2817],
    ["stale index", () => withExpand(withUnits(world({ log: [] }), [])), 65536, 16, 28, 1],
    ["canStart false", () => withExpand(withUnits(world({ log: [] }), []), { claimOk: false }), 65536, 16, 28, 2816],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "EXPAND_CITY", cid, x, y, { pre });
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("ksendRequest")), `${label}: must not send`);
  }
  const log = [];
  const g = withExpand(withUnits(world({ log }), []), { removeAfter: false }); g._log = log;
  const r = runPerformArgs(g, "EXPAND_CITY", 65536, 16, 28, { pre: 2816 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.readback.matches, false);
});

test("perform FOUND_CITY re-checks the unit's plot and canStart, sends with no target plot, and reads back the new settlement", () => {
  const log = [];
  const g = withFounder(world({ log }), [founder(5)]); g._log = log;
  const r = runPerformArgs(g, "FOUND_CITY", 5, 15, 27, { pre: 2715 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "FOUND_CITY", arg: 5, at: { x: 15, y: 27 }, matches: true });
  const i = log.findIndex((e) => e.startsWith("ucanStart(") && e.includes("1463004268"));
  const j = log.findIndex((e) => e.startsWith("usendRequest(") && e.includes("1463004268"));
  assert.ok(i !== -1 && j !== -1 && i < j);
  assert.ok(log[j].includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1'));
});

test("perform FOUND_CITY refuses a moved unit, a stale plot, an unknown unit and a canStart refusal without sending; a missing settlement reads back as no match", () => {
  for (const [label, mk, uid, x, y, pre] of [
    ["unit moved since the offer", () => withFounder(world({ log: [] }), [founder(5, { location: { x: 16, y: 27 } })]), 5, 15, 27, 2715],
    ["stale plot index", () => withFounder(world({ log: [] }), [founder(5)]), 5, 15, 27, 1],
    ["unknown unit", () => withFounder(world({ log: [] }), [founder(5)]), 9, 15, 27, 2715],
    ["canStart false", () => withFounder(world({ log: [] }), [founder(5)], { foundOk: false }), 5, 15, 27, 2715],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "FOUND_CITY", uid, x, y, { pre });
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("usendRequest")), `${label}: must not send`);
  }
  const log = [];
  const g = withFounder(world({ log }), [founder(5)], { cityAfter: false }); g._log = log;
  const r = runPerformArgs(g, "FOUND_CITY", 5, 15, 27, { pre: 2715 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.readback.matches, false);
});

// ---- produce constructible (buildings need a placement plot; the plot index rides as arg3)
function withBuildings(g, { urban = [[3, 4]], expand = [[4, 4], [4, 5]], sentTo = null } = {}) {
  withCity(g, { sentTo });
  const rows = [{ $hash: 501, ConstructibleType: "BUILDING_GRANARY", ConstructibleClass: "BUILDING", Name: "LOC_GRANARY" }, { $hash: 502, ConstructibleType: "BUILDING_ALTAR", ConstructibleClass: "BUILDING", Name: "LOC_ALTAR" }];
  g.GameInfo.Constructibles = table(rows); g.GameInfo.Constructibles[Symbol.iterator] = function* () { yield* rows; };
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]); g.GameInfo.Features = table([]);
  g.GameInfo.Yields = [{ $hash: 619730924, YieldType: "YIELD_FOOD" }];
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }), getTerrainType: () => 1, getFeatureType: () => -1, isRiver: () => false, getYield: () => 3 };
  const idx = ([x, y]) => y * 100 + x;
  const city = g.Players.get(1).Cities.getCities()[0];
  const inner = g.Game.CityOperations;
  g.Game.CityOperations = {
    canStart: (cid, op, args, show) => {
      if (args.ConstructibleType === undefined) return inner.canStart(cid, op, args, show);
      g._log.push(`bcanStart(${JSON.stringify(cid)},${op},${JSON.stringify(args)},${show})`);
      if (cid.owner !== 1 || args.ConstructibleType !== 501) return { Success: false };
      if (args.X === undefined) return { Success: true, Plots: urban.map(idx), ExpandUrbanPlots: expand.map(idx) };
      return { Success: [...urban, ...expand].some(([x, y]) => x === args.X && y === args.Y) };
    },
    sendRequest: (cid, op, args) => { if (args.ConstructibleType === undefined) return inner.sendRequest(cid, op, args); g._log.push(`bsendRequest(${JSON.stringify(cid)},${op},${JSON.stringify(args)})`); city.BuildQueue._q.push({ type: sentTo ?? args.ConstructibleType, kind: 2 }); city.BuildQueue.currentProductionTypeHash = city.BuildQueue._q[0].type; },
  };
  city.Production = { getUnitProductionCost: (h) => (h === 99 ? 30 : 40), getConstructibleProductionCost: () => 36 };
  city.BuildQueue.getTurnsLeft = (h) => (h === 501 ? 8 : 5);
  return g;
}

test("production offers carry cost and turns for units, and one placement offer per (building, plot) with urban/newUrban labels", () => {
  const log = [];
  const g = withBuildings(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  const units = r.offers.filter((o) => o.kind === "PRODUCE_UNIT");
  assert.deepEqual(units.map((o) => [o.unitTypeKey, o.cost, o.turns, o.pre, o.queueLength, o.queue]), [["UNIT_SCOUT", 30, 5, 0, 0, []], ["UNIT_WARRIOR", 40, 5, 0, 0, []]]);
  const builds = r.offers.filter((o) => o.kind === "PRODUCE_CONSTRUCTIBLE");
  assert.deepEqual(builds.map((o) => [o.arg, o.arg2, o.arg3, o.x, o.y, o.placement, o.constructibleKey, o.displayName, o.cost, o.turns, o.canStart]),
    [[65536, 501, 403, 3, 4, "urban", "BUILDING_GRANARY", "LOC_GRANARY", 36, 8, true], [65536, 501, 404, 4, 4, "newUrban", "BUILDING_GRANARY", "LOC_GRANARY", 36, 8, true], [65536, 501, 504, 4, 5, "newUrban", "BUILDING_GRANARY", "LOC_GRANARY", 36, 8, true]]);
  assert.deepEqual(builds[0].yields, { food: 3 });
  assert.ok(!builds.some((o) => o.arg2 === 502), "a building the native query refuses is not offered");
  assert.ok(!log.some((e) => e.startsWith("bsendRequest") || e.startsWith("csendRequest")));
});

test("perform PRODUCE_CONSTRUCTIBLE derives the plot from its index, checks canStart with X/Y, sends BUILD with placement and reads back", () => {
  const log = [];
  const g = withBuildings(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "PRODUCE_CONSTRUCTIBLE", 65536, 501, 404, { pre: 0 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "PRODUCE_CONSTRUCTIBLE", arg: 65536, constructibleType: 501, plot: { x: 4, y: 4, index: 404 }, queuedAt: 0, queueLength: 1, matches: true });
  const i = log.findIndex((e) => e.startsWith("bcanStart(") && e.includes('"X":4,"Y":4'));
  const j = log.findIndex((e) => e.startsWith("bsendRequest(") && e.includes('"ConstructibleType":501,"X":4,"Y":4'));
  assert.ok(i !== -1 && j !== -1 && i < j);
});

test("perform PRODUCE_CONSTRUCTIBLE refuses unknown city, non-constructible type, changed production, invalid plot and a refused placement without sending", () => {
  for (const [label, mk, cid, ct, pi, pre] of [
    ["unknown city", () => withBuildings(withUnits(world({ log: [] }), [])), 7, 501, 404, 0],
    ["not a constructible", () => withBuildings(withUnits(world({ log: [] }), [])), 65536, 99, 404, 0],
    ["queue changed", () => withBuildings(withUnits(world({ log: [] }), [])), 65536, 501, 404, 77],
    ["invalid plot", () => withBuildings(withUnits(world({ log: [] }), [])), 65536, 501, -5, 0],
    ["placement refused", () => withBuildings(withUnits(world({ log: [] }), [])), 65536, 501, 909, 0],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "PRODUCE_CONSTRUCTIBLE", cid, ct, pi, { pre });
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("bsendRequest")), `${label}: must not send`);
  }
});

// ---- traditions (policy cards): activate into a free slot, then confirm to clear the blocker
function withTraditions(g, { unlocked = [9001, 9002], active = [], slots = 1, activateOk = true, blockerAfter = 0 } = {}) {
  const cu = g.Players.get(1).Culture;
  let actives = active.slice();
  g.CultureSlotTypes = { NO_CULTURE_SLOT: 0, TRADITION_CULTURE_SLOT: 1, POLICY_CULTURE_SLOT: 2, CRISIS_CULTURE_SLOT: 3 };
  g.PlayerOperationParameters = { Activate: -1326475004, Deactivate: 1318334332 };
  g.PlayerOperationTypes.CHANGE_TRADITION = -403962502; g.PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS = 965202866;
  g.EndTurnBlockingTypes.TRADITIONS = 555;
  const rows = [{ $hash: 9001, $index: 11, TraditionType: "TRADITION_A", CultureSlotType: "TRADITION_CULTURE_SLOT", Name: "LOC_TA", Description: "LOC_TA_D" }, { $hash: 9002, $index: 12, TraditionType: "TRADITION_B", CultureSlotType: "TRADITION_CULTURE_SLOT", Name: "LOC_TB", Description: "LOC_TB_D" }];
  g.GameInfo.Traditions = table(rows);
  cu.getNumCultureSlots = (st) => (st === 1 ? slots : 0);
  cu.getActiveTraditions = (st) => (st === 1 ? actives.slice() : []);
  cu.getUnlockedTraditions = (st) => (st === 1 ? unlocked.slice() : []);
  cu.isTraditionActive = (h) => actives.includes(h);
  let blocker = 555;
  g.Game.Notifications.getEndTurnBlockingType = () => blocker;
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== -403962502 && op !== 965202866) return inner.canStart(pid, op, args, show); g._log.push(`tcanStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: op === 965202866 ? true : activateOk && actives.length < slots }; },
    sendRequest: (pid, op, args) => { if (op !== -403962502 && op !== 965202866) return inner.sendRequest(pid, op, args); g._log.push(`tsendRequest(${pid},${op},${JSON.stringify(args)})`); if (op === -403962502) { const row = rows.find((r) => r.$index === args.TraditionType); if (row && activateOk) actives.push(row.$hash); } else { blocker = blockerAfter; } },
  };
  return g;
}

test("tradition offers list unlocked, inactive cards per slot type with slot counts, and the confirm only under the TRADITIONS blocker", () => {
  const log = [];
  const g = withTraditions(world({ log, blocking: true }), { active: [9002] }); g._log = log;
  const r = runOffers(g);
  const trads = r.offers.filter((o) => o.kind === "CHANGE_TRADITION");
  assert.deepEqual(trads.map((o) => [o.arg, o.arg2, o.pre, o.slot, o.slotsTotal, o.slotsFree, o.typeKey, o.canStart]), [[11, 9001, 1, "TRADITION_CULTURE_SLOT", 1, 0, "TRADITION_A", false]]);
  assert.equal(r.offers.filter((o) => o.kind === "CONSIDER_ASSIGN_TRADITIONS").length, 1);
  assert.ok(log.filter((e) => e.startsWith("tcanStart(")).every((e) => e.startsWith("tcanStart(1,") && e.endsWith(",false)")));
  const g2 = withTraditions(world({ log: [] })); g2._log = []; g2.Game.Notifications.getEndTurnBlockingType = () => 0;
  const r2 = runOffers(g2);
  assert.equal(r2.offers.filter((o) => o.kind === "CONSIDER_ASSIGN_TRADITIONS").length, 0, "confirm is offered only while TRADITIONS blocks the turn");
  assert.ok(r2.offers.filter((o) => o.kind === "CHANGE_TRADITION").every((o) => o.canStart === true && o.slotsFree === 1));
});

test("perform CHANGE_TRADITION re-checks identity, slot occupancy and canStart, sends Activate, and reads back; CONSIDER clears the blocker", () => {
  const log = [];
  const g = withTraditions(world({ log, blocking: true })); g._log = log;
  const r = runPerformArgs(g, "CHANGE_TRADITION", 11, 9001, 0, { pre: 0 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "CHANGE_TRADITION", arg: 11, tradition: 9001, active: true, matches: true });
  const send = log.find((e) => e.startsWith("tsendRequest(1,-403962502"));
  assert.ok(send && send.includes('"TraditionType":11,"Action":-1326475004'));
  const c = runPerform(g, "CONSIDER_ASSIGN_TRADITIONS", 0, { pre: 0 });
  assert.equal(c.outcome, "sent");
  assert.deepEqual(c.readback, { kind: "CONSIDER_ASSIGN_TRADITIONS", arg: 0, blocking: "NONE", matches: true });
});

test("perform CHANGE_TRADITION refuses a mismatched identity, a changed slot count, an already active card and a canStart refusal without sending", () => {
  for (const [label, mk, idx, hash, pre] of [
    ["identity mismatch", () => withTraditions(world({ log: [] })), 12, 9001, 0],
    ["slot count changed", () => withTraditions(world({ log: [] })), 11, 9001, 1],
    ["already active", () => withTraditions(world({ log: [] }), { active: [9001] }), 11, 9001, 1],
    ["canStart false", () => withTraditions(world({ log: [] }), { activateOk: false }), 11, 9001, 0],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "CHANGE_TRADITION", idx, hash, 0, { pre });
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("tsendRequest")), `${label}: must not send`);
  }
});

// ---- narrative choices (the first pending story; links or a single CLOSE)
function withStory(g, { links = ["DISCOVERY_X_A", "DISCOVERY_X_B"], variable = false, afterChoice = "resolved", canOk = true, blockerNotif = true } = {}) {
  const me = g.Players.get(1);
  let pending = { owner: 1, id: 28, type: 35 };
  const rows = [
    { $hash: -1089908522, $index: 1, NarrativeStoryType: "DISCOVERY_X", Activation: "AUTO", StoryTitle: "LOC_X_TITLE", Completion: "LOC_X_BODY", Name: "LOC_X_NAME", VariableLinks: variable, Cost: 0 },
    { $hash: 7001, $index: 2, NarrativeStoryType: "DISCOVERY_X_A", Activation: "LINKED", Cost: 0 },
    { $hash: 7002, $index: 3, NarrativeStoryType: "DISCOVERY_X_B", Activation: "LINKED_REQUISITE", Cost: 50, CostYield: "YIELD_GOLD" },
    { $hash: 7003, $index: 4, NarrativeStoryType: "DISCOVERY_X_C", Activation: "LINKED", Cost: 0 },
  ];
  g.GameInfo.NarrativeStories = { lookup: (k) => rows.find((r) => r.$hash === k || r.NarrativeStoryType === k) ?? null };
  g.GameInfo.NarrativeStory_Links = links.map((to) => ({ FromNarrativeStoryType: "DISCOVERY_X", ToNarrativeStoryType: to }));
  g.StoryTextTypes = { INVALID: 0, BODY: 1, OPTION: 2, REWARD: 3, IMPERATIVE: 4, TITLE: 5 };
  g.PlayerOperationParameters = { Activate: -1326475004, Deactivate: 1318334332 };
  g.PlayerOperationTypes.CHOOSE_NARRATIVE_STORY_DIRECTION = 1916708168;
  me.Stories = {
    getFirstPendingDiscoveryLastMetID: () => pending, getPendingMetIds: () => null,
    find: (id) => (pending && id.id === pending.id ? { id, type: -1089908522, state: 4 } : null),
    getOrderedLinks: () => (variable ? links.slice() : []),
    determineNarrativeInjection: (sid, hash, tt) => `${hash}:${tt}`,
    determineNarrativeInjectionComponentId: () => "LOC_END_REWARD",
    determineRequisiteLink: (key) => key === "DISCOVERY_X_B",
    canAfford: (key) => key !== "DISCOVERY_X_B",
  };
  if (blockerNotif) {
    g.Game.Notifications.getEndTurnBlockingType = () => -2084516792;
    g.Game.Notifications.getIdsForPlayer = (pid) => { g._log.push(`notifIds(${pid})`); return [{ owner: 1, id: 11, type: 20 }]; };
    g.Game.Notifications.find = () => ({ Type: 1287223640, BlocksTurnAdvancement: true });
    g.Game.Notifications.getTypeName = (t) => (t === 1287223640 ? "NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION" : undefined);
  }
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 1916708168) return inner.canStart(pid, op, args, show); g._log.push(`ncanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: canOk }; },
    sendRequest: (pid, op, args) => { if (op !== 1916708168) return inner.sendRequest(pid, op, args); g._log.push(`nsendRequest(${pid},${JSON.stringify(args)})`); if (afterChoice === "resolved") pending = null; },
  };
  return g;
}

test("an unnamed end-turn blocker is named after the blocking notification's type, and narrative offers list eligible, affordable links", () => {
  const log = [];
  const g = withStory(world({ log })); g._log = log;
  const r = runOffers(g);
  const end = r.offers.find((o) => o.kind === "END_TURN");
  assert.equal(end.blockingType, "NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION");
  assert.ok(log.every((e) => !e.startsWith("notifIds(") || e === "notifIds(1)"), "only the bound player's notifications are read");
  const n = r.offers.filter((o) => o.kind === "CHOOSE_NARRATIVE_STORY_DIRECTION");
  assert.deepEqual(n.map((o) => [o.arg, o.arg2, o.pre, o.storyId, o.storyKey, o.answerKey, o.option, o.reward, o.action, o.cost, o.costYield, o.affordable, o.canStart]),
    [[28, 7001, -1089908522, 28, "DISCOVERY_X", "DISCOVERY_X_A", "7001:2", "7001:3", "7001:4", 0, null, true, true],
     [28, 7002, -1089908522, 28, "DISCOVERY_X", "DISCOVERY_X_B", "7002:2", "7002:3", "7002:4", 50, "YIELD_GOLD", false, false]]);
  assert.equal(n[0].title, "LOC_X_TITLE"); assert.equal(n[0].body, "LOC_X_BODY");
  assert.ok(!log.some((e) => e.startsWith("nsendRequest")));
});

test("a story with no eligible links offers the single CLOSE answer", () => {
  const g = withStory(world({ log: [] }), { links: [] }); g._log = [];
  const n = runOffers(g).offers.filter((o) => o.kind === "CHOOSE_NARRATIVE_STORY_DIRECTION");
  assert.deepEqual(n.map((o) => [o.arg2, o.answerKey, o.option, o.reward, o.canStart]), [[-1, "CLOSE", "LOC_NARRATIVE_STORY_END_STORY_NAME", "LOC_END_REWARD", true]]);
});

test("perform CHOOSE_NARRATIVE_STORY_DIRECTION re-finds the pending story, sends the string key with the story id, and reads back", () => {
  const log = [];
  const g = withStory(world({ log })); g._log = log;
  const r = runPerformArgs(g, "CHOOSE_NARRATIVE_STORY_DIRECTION", 28, 7001, 0, { pre: -1089908522 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "CHOOSE_NARRATIVE_STORY_DIRECTION", arg: 28, answerKey: "DISCOVERY_X_A", stillPending: false, matches: true });
  const send = log.find((e) => e.startsWith("nsendRequest(1,"));
  assert.ok(send && send.includes('"TargetType":"DISCOVERY_X_A","Target":{"owner":1,"id":28,"type":35},"Action":-1326475004'));
  const c = withStory(world({ log: [] }), { links: [] }); c._log = [];
  const rc = runPerformArgs(c, "CHOOSE_NARRATIVE_STORY_DIRECTION", 28, -1, 0, { pre: -1089908522 });
  assert.equal(rc.outcome, "sent"); assert.equal(rc.readback.answerKey, "CLOSE");
});

test("perform CHOOSE_NARRATIVE_STORY_DIRECTION refuses a story that is not pending, a changed story type, an unknown answer and a canStart refusal without sending", () => {
  for (const [label, mk, sid, hash, pre] of [
    ["not pending", () => withStory(world({ log: [] })), 99, 7001, -1089908522],
    ["story type changed", () => withStory(world({ log: [] })), 28, 7001, 5],
    ["unknown answer", () => withStory(world({ log: [] })), 28, 4242, -1089908522],
    ["canStart false", () => withStory(world({ log: [] }), { canOk: false }), 28, 7001, -1089908522],
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "CHOOSE_NARRATIVE_STORY_DIRECTION", sid, hash, 0, { pre });
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("nsendRequest")), `${label}: must not send`);
  }
});


test("a city with a queue offers production as an append: precondition is the queue length and the queue is listed", () => {
  const log = [];
  const g = withBuildings(withUnits(world({ log }), [])); g._log = log;
  const city = g.Players.get(1).Cities.getCities()[0];
  city.BuildQueue._q.push({ type: 100, kind: 1 }); city.BuildQueue.currentProductionTypeHash = 100;
  const r = runOffers(g);
  const units = r.offers.filter((o) => o.kind === "PRODUCE_UNIT");
  assert.ok(units.every((o) => o.pre === 1 && o.queueLength === 1 && o.queue.length === 1 && o.queue[0] === "UNIT_WARRIOR"));
  const p = runPerformArgs(g, "PRODUCE_UNIT", 65536, 99, 0, { pre: 1 });
  assert.equal(p.outcome, "sent");
  assert.deepEqual(p.readback, { kind: "PRODUCE_UNIT", arg: 65536, unitType: 99, queuedAt: 1, queueLength: 2, matches: true });
  const stale = runPerformArgs(g, "PRODUCE_UNIT", 65536, 99, 0, { pre: 1 });
  assert.equal(stale.refused.code, "ACTION_EXPIRED", "a second append with the old queue length must be refused");
});
