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
  assert.deepEqual(r.context, { turn: 10, age: 4242, ageType: "AGE_ANTIQUITY", playerId: 1, localPlayerId: 1, localObserverId: 1, mode: "singleplayer", isTurnActive: true, curtainDisplayed: false, gameGuid: "ABCDEF0123456789", blockingNotifications: [], unitIds: null });
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

// ---- unit move (anywhere the native path reaches this turn, visible plots only, never an attack)
function withMap(g, { hiddenAt = [], moveOk = true, unreachable = [], nextTurn = [] } = {}) {
  g.GameInfo.Features = table([{ $hash: 55, FeatureType: "FEATURE_FOREST" }]);
  g.GameInfo.Yields = [{ $hash: 619730924, YieldType: "YIELD_FOOD" }, { $hash: -1155936758, YieldType: "YIELD_PRODUCTION" }];
  g.Units = { getPathTo: (uid, loc) => { g._log.push(`path(${uid.id},${loc.x},${loc.y})`); if (unreachable.some(([ux, uy]) => ux === loc.x && uy === loc.y)) return { plots: [], turns: [], obstacles: [] }; if (nextTurn.some(([ux, uy]) => ux === loc.x && uy === loc.y)) return { plots: [1, 2, 3], turns: [1, 1, 2], obstacles: [] }; return { plots: [1, 2], turns: [1, 1], obstacles: [] }; } };
  g.UnitOperationTypes = { ...(g.UnitOperationTypes || {}), SKIP_TURN: 745019656, MOVE_TO: 1477390184 };
  g.UnitOperationMoveModifiers = { NONE: 0, ATTACK: 16, MOVE_IGNORE_UNEXPLORED_DESTINATION: 16384 };
  g.RevealedStates = { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 };
  g.DirectionTypes = { NO_DIRECTION: -1, DIRECTION_NORTHEAST: 0, DIRECTION_EAST: 1, DIRECTION_SOUTHEAST: 2, DIRECTION_SOUTHWEST: 3, DIRECTION_WEST: 4, DIRECTION_NORTHWEST: 5, NUM_DIRECTION_TYPES: 6 };
  const neighbours = (loc, d) => [{ x: loc.x, y: loc.y + 1 }, { x: loc.x + 1, y: loc.y }, { x: loc.x, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y }, { x: loc.x - 1, y: loc.y + 1 }][d];
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getAdjacentPlotLocation: (loc, d) => { g._log.push(`adj(${loc.x},${loc.y},${d})`); return neighbours(loc, d); }, getRevealedState: (pid, x, y) => { g._log.push(`vis(${pid},${x},${y})`); return hiddenAt.some(([hx, hy]) => hx === x && hy === y) ? 0 : 2; }, getTerrainType: () => 1, getFeatureType: (x, y) => (x === 11 && y === 11 ? 55 : -1), isRiver: (x, y) => x === 11 && y === 10, getYield: (x, y, h) => (h === 619730924 ? 2 : 0) };
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  const prev = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { g._log.push(`ucanStart(${JSON.stringify(uid)},${op},${JSON.stringify(args)},${show})`); if (op === 1477390184) return { Success: moveOk && uid.owner === 1 }; return prev ? prev.canStart(uid, op, args, show) : { Success: true }; },
    sendRequest: (uid, op, args) => { g._log.push(`usendRequest(${JSON.stringify(uid)},${op},${JSON.stringify(args)})`); if (op === 1477390184) { const u = g.Players.get(1).Units.getUnits().find((x) => x.id.id === uid.id); if (u) u.location = { x: args.X, y: args.Y }; } else if (prev) prev.sendRequest(uid, op, args); },
  };
  return g;
}

test("move offers cover everywhere reachable this turn, visible and with a native one-turn path, Modifiers NONE", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })]), { hiddenAt: [[11, 10]], unreachable: [[10, 11]] }); g._log = log;
  const r = runOffers(g);
  const moves = r.offers.filter((o) => o.kind === "MOVE_UNIT");
  // the unit has two movement, so the search reaches two rings: 18 plots less the hidden one and the one with no path
  assert.equal(moves.length, 16);
  assert.ok(moves.every((o) => o.steps >= 1 && o.steps <= 2), "nothing beyond the unit's movement is offered");
  assert.ok(moves.some((o) => o.steps === 2), "a two-tile destination is reachable in one action");
  assert.ok(!moves.some((o) => o.x === 10 && o.y === 11), "plot with an empty native path must not be offered");
  assert.ok(moves.every((o) => o.pathTurns === 1));
  assert.ok(moves.every((o) => o.arg === 5 && o.canStart === true && typeof o.x === "number" && typeof o.y === "number" && o.terrainKey === "TERRAIN_FLAT"));
  // the plot detail a settling decision needs travels with the move (live friction, turn 34)
  assert.ok(moves.every((o) => o.yields && o.yields.food === 2 && o.yields.production === undefined), "zero yields are dropped to keep the listing small");
  const riverMove = moves.find((o) => o.x === 11 && o.y === 10);
  assert.ok(!riverMove || riverMove.river === true);
  const forestMove = moves.find((o) => o.x === 11 && o.y === 11);
  assert.ok(!forestMove || forestMove.featureKey === "FEATURE_FOREST");
  assert.ok(!moves.some((o) => o.x === 11 && o.y === 10), "hidden plot must not be offered");
  const moveChecks = log.filter((e) => e.startsWith("ucanStart(") && e.includes("1477390184"));
  assert.equal(moveChecks.length, 16);
  assert.ok(moveChecks.every((e) => e.includes('"Modifiers":0')));
  // visibility is read before canStart for each plot
  for (const o of moves) {
    const vi = log.indexOf(`vis(1,${o.x},${o.y})`);
    const ci = log.findIndex((e) => e.startsWith("ucanStart(") && e.includes(`"X":${o.x},"Y":${o.y}`));
    assert.ok(vi !== -1 && ci > vi);
  }
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

test("perform MOVE_UNIT sends for any visible plot the native path reaches this turn, and reads back the location", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "MOVE_UNIT", 5, 11, 10);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "MOVE_UNIT", arg: 5, target: { x: 11, y: 10 }, location: { x: 11, y: 10 }, matches: true });
  const send = log.find((e) => e.startsWith("usendRequest(") && e.includes("1477390184"));
  assert.ok(send && send.includes('"X":11,"Y":10,"Modifiers":0'));
});

test("perform MOVE_UNIT accepts a destination several tiles away when the path reaches it this turn", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "MOVE_UNIT", 5, 13, 13);
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.ok(log.find((e) => e.startsWith("usendRequest(") && e.includes('"X":13,"Y":13')));
});

test("perform MOVE_UNIT refuses a plot the path reaches only next turn, and hidden, unknown-unit and canStart-false targets without sending", () => {
  for (const [label, mk, uid, x, y] of [
    ["arrives next turn", () => withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { nextTurn: [[13, 13]] }), 5, 13, 13],
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
  g.GameplayMap = { getIndexFromXY: (x, y) => y * 100 + x, getTerrainType: () => 1, getFeatureType: () => -1, isRiver: () => true, getYield: (x, y, h) => (h === 619730924 ? 3 : 0) };
  g.GameInfo.Yields = [{ $hash: 619730924, YieldType: "YIELD_FOOD" }];
  g.GameInfo.Features = table([]);
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
  assert.deepEqual([found[0].yields, found[0].river, found[0].featureKey], [{ food: 3 }, true, null]);
  const checks = log.filter((e) => e.startsWith("ucanStart(") && e.includes("1463004268"));
  assert.equal(checks.length, 3, "an existence check per owned unit, then a legality check for the settler only");
  assert.ok(checks.every((e) => e.includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1')));
  // the existence checks are made once for every owned unit, then legality for the settler alone
  assert.deepEqual(checks.map((e) => e.endsWith(",true)")), [true, true, false]);
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
  cu.getNumAllCultureSlots = () => slots;
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
  assert.deepEqual(trads.map((o) => [o.arg, o.arg2, o.pre, o.slot, o.slotsTotal, o.slotsFree, o.slotsFreeAny, o.typeKey, o.canStart]), [[11, 9001, 1, "TRADITION_CULTURE_SLOT", 1, 0, 0, "TRADITION_A", false]]);
  const confirm = r.offers.filter((o) => o.kind === "CONSIDER_ASSIGN_TRADITIONS");
  assert.equal(confirm.length, 1);
  assert.deepEqual([confirm[0].canStart, confirm[0].slotsFreeAny, confirm[0].activatable], [true, 0, 0], "slot full: confirming is the right move");
  assert.ok(log.filter((e) => e.startsWith("tcanStart(")).every((e) => e.startsWith("tcanStart(1,") && e.endsWith(",false)")));
  const free = withTraditions(world({ log: [], blocking: true })); free._log = [];
  const fc = runOffers(free).offers.find((o) => o.kind === "CONSIDER_ASSIGN_TRADITIONS");
  assert.deepEqual([fc.canStart, fc.slotsFreeAny, fc.activatable], [false, 1, 2], "a free slot with an activatable card: confirm is not startable yet");
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

// ---- pantheon
function withPantheon(g, { allowed = [3001], have = [] } = {}) {
  const me = g.Players.get(1);
  let pantheons = have.slice();
  const rows = [{ $hash: 3001, BeliefType: "PANTHEON_BONUS_1", BeliefClassType: "BELIEF_CLASS_PANTHEON", Name: "LOC_P1", Description: "LOC_P1_D" }, { $hash: 3002, BeliefType: "PANTHEON_BONUS_2", BeliefClassType: "BELIEF_CLASS_PANTHEON", Name: "LOC_P2", Description: "LOC_P2_D" }, { $hash: 3100, BeliefType: "BELIEF_FOUNDER_X", BeliefClassType: "BELIEF_CLASS_FOUNDER", Name: "LOC_F", Description: "LOC_F_D" }];
  g.GameInfo.Beliefs = table(rows); g.GameInfo.Beliefs[Symbol.iterator] = function* () { yield* rows; };
  g.PlayerOperationTypes.FOUND_PANTHEON = -1770928175;
  me.Religion = { getNumPantheons: () => pantheons.length, getPantheons: () => pantheons.slice() };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== -1770928175) return inner.canStart(pid, op, args, show); g._log.push(`pcanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: allowed.includes(args.BeliefType) && !pantheons.includes(args.BeliefType) }; },
    sendRequest: (pid, op, args) => { if (op !== -1770928175) return inner.sendRequest(pid, op, args); g._log.push(`psendRequest(${pid},${JSON.stringify(args)})`); pantheons.push(args.BeliefType); },
  };
  return g;
}

test("pantheon offers list only the pantheon beliefs the native FOUND_PANTHEON canStart accepts, with text", () => {
  const log = [];
  const g = withPantheon(world({ log })); g._log = log;
  const r = runOffers(g);
  const p = r.offers.filter((o) => o.kind === "FOUND_PANTHEON");
  assert.deepEqual(p.map((o) => [o.arg, o.pre, o.typeKey, o.displayName, o.description, o.canStart]), [[3001, 0, "PANTHEON_BONUS_1", "LOC_P1", "LOC_P1_D", true]]);
  assert.equal(log.filter((e) => e.startsWith("pcanStart(")).length, 2, "founder beliefs are never queried");
  assert.ok(!log.some((e) => e.startsWith("psendRequest")));
});

test("perform FOUND_PANTHEON checks the belief class, the pantheon count and canStart, sends, and reads back", () => {
  const log = [];
  const g = withPantheon(world({ log })); g._log = log;
  const r = runPerform(g, "FOUND_PANTHEON", 3001, { pre: 0 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "FOUND_PANTHEON", arg: 3001, founded: true, matches: true });
  assert.ok(log.find((e) => e.startsWith("psendRequest(1,") && e.includes('"BeliefType":3001')));
  for (const [label, mk, hash, pre] of [
    ["not a pantheon belief", () => withPantheon(world({ log: [] })), 3100, 0],
    ["count changed", () => withPantheon(world({ log: [] })), 3001, 1],
    ["canStart false", () => withPantheon(world({ log: [] }), { allowed: [] }), 3001, 0],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerform(h, "FOUND_PANTHEON", hash, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("psendRequest")), `${label}: must not send`);
  }
});

// ---- government
function withGovernment(g, { current = -1, starting = ["GOVERNMENT_DESPOTISM", "GOVERNMENT_OLIGARCHY"], allowed = null, applied = "hash" } = {}) {
  const cu = g.Players.get(1).Culture;
  let gov = current;
  const rows = [{ $index: 0, $hash: 809918684, GovernmentType: "GOVERNMENT_CLASSICAL_REPUBLIC", Name: "LOC_G0", Description: "LOC_G0_D", CelebrationName: "LOC_G0_C" }, { $index: 1, $hash: -87192893, GovernmentType: "GOVERNMENT_DESPOTISM", Name: "LOC_G1", Description: "LOC_G1_D", CelebrationName: "LOC_G1_C" }, { $index: 2, $hash: -1635089126, GovernmentType: "GOVERNMENT_OLIGARCHY", Name: "LOC_G2", Description: "LOC_G2_D", CelebrationName: "LOC_G2_C" }];
  g.GameInfo.Governments = table(rows); g.GameInfo.Governments[Symbol.iterator] = function* () { yield* rows; };
  g.GameInfo.StartingGovernments = starting.map((t) => ({ GovernmentType: t }));
  g.GameInfo.GovernmentModifiers = [{ GovernmentType: "GOVERNMENT_DESPOTISM", ModifierId: "MOD_DESP" }];
  g.GameInfo.ModifierStrings = [{ ModifierId: "MOD_DESP", Context: "Description", Text: "LOC_DESP_FX" }, { ModifierId: "MOD_OTHER", Context: "Description", Text: "LOC_X" }];
  g.GameInfo.ProgressionTreeNodeUnlocks = [{ RequiredGovernmentType: "GOVERNMENT_DESPOTISM", TargetType: 9001 }];
  g.GameInfo.Traditions = g.GameInfo.Traditions || table([{ $hash: 9001, $index: 11, TraditionType: "TRADITION_A", Name: "LOC_TA" }]);
  g.PlayerOperationParameters = g.PlayerOperationParameters || { Activate: -1326475004, Deactivate: 1318334332 };
  g.PlayerOperationTypes.CHANGE_GOVERNMENT = 1553605243;
  cu.getGovernmentType = () => gov;
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 1553605243) return inner.canStart(pid, op, args, show); g._log.push(`gcanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: allowed === null || allowed.includes(args.GovernmentType) }; },
    sendRequest: (pid, op, args) => { if (op !== 1553605243) return inner.sendRequest(pid, op, args); g._log.push(`gsendRequest(${pid},${JSON.stringify(args)})`); const row = rows.find((r) => r.$index === args.GovernmentType); gov = applied === "hash" ? row.$hash : row.$index; },
  };
  return g;
}

test("government offers list the starting governments while none is held, with text and the celebration name", () => {
  const log = [];
  const g = withGovernment(world({ log })); g._log = log;
  const govs = runOffers(g).offers.filter((o) => o.kind === "CHANGE_GOVERNMENT");
  assert.deepEqual(govs.map((o) => [o.arg, o.arg2, o.pre, o.typeKey, o.displayName, o.celebration, o.canStart]), [[1, -87192893, -1, "GOVERNMENT_DESPOTISM", "LOC_G1", "LOC_G1_C", true], [2, -1635089126, -1, "GOVERNMENT_OLIGARCHY", "LOC_G2", "LOC_G2_C", true]]);
  assert.deepEqual([govs[0].effects, govs[0].unlocksTraditions, govs[1].effects, govs[1].unlocksTraditions], [["LOC_DESP_FX"], ["LOC_TA"], [], []]);
  assert.ok(log.filter((e) => e.startsWith("gcanStart(")).every((e) => e.includes('"Action":-1326475004') && e.endsWith(",false)")));
  assert.ok(!log.some((e) => e.startsWith("gsendRequest")));
});

test("blocking notifications are reported in the offers context", () => {
  const g = withStory(world({ log: [] })); g._log = [];
  const r = runOffers(g);
  assert.deepEqual(r.context.blockingNotifications, ["NOTIFICATION_CHOOSE_DISCOVERY_STORY_DIRECTION"]);
  const h = world({ log: [] });
  assert.deepEqual(runOffers(h).context.blockingNotifications, []);
});

test("perform CHANGE_GOVERNMENT checks identity, the current government and canStart, sends Activate by index, and reads back hash or index", () => {
  for (const applied of ["hash", "index"]) {
    const log = [];
    const g = withGovernment(world({ log }), { applied }); g._log = log;
    const r = runPerformArgs(g, "CHANGE_GOVERNMENT", 1, -87192893, 0, { pre: -1 });
    assert.equal(r.refused, null, applied);
    assert.equal(r.readback.matches, true, applied);
    assert.ok(log.find((e) => e.startsWith("gsendRequest(1,") && e.includes('"GovernmentType":1,"Action":-1326475004')));
  }
  for (const [label, mk, idx, hash, pre] of [
    ["identity mismatch", () => withGovernment(world({ log: [] })), 2, -87192893, -1],
    ["government changed", () => withGovernment(world({ log: [] }), { current: 809918684 }), 1, -87192893, -1],
    ["canStart false", () => withGovernment(world({ log: [] }), { allowed: [] }), 1, -87192893, -1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "CHANGE_GOVERNMENT", idx, hash, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("gsendRequest")), `${label}: must not send`);
  }
});

// ---- attribute points
function withAttributes(g, { points = { ATTRIBUTE_CULTURAL: 1 }, wildcard = 2, canNodes = [4001], blocked = true } = {}) {
  const me = g.Players.get(1);
  const states = { 4001: 2, 4002: 1 };
  g.GameInfo.Attributes = [{ AttributeType: "ATTRIBUTE_CULTURAL", Name: "LOC_ATTR_C", ProgressionTreeType: "TREE_ATTRIBUTE_CULTURAL" }];
  const nodes = [{ $hash: 4001, ProgressionTreeNodeType: "NODE_ATTRIBUTE_CULTURAL_01", ProgressionTree: "TREE_ATTRIBUTE_CULTURAL", Name: null, Description: "LOC_N1_D", Cost: 1 }, { $hash: 4002, ProgressionTreeNodeType: "NODE_ATTRIBUTE_CULTURAL_02", ProgressionTree: "TREE_ATTRIBUTE_CULTURAL", Name: null, Description: "LOC_N2_D", Cost: 1 }, ...[701, 702, 801].map((h) => g.GameInfo.ProgressionTreeNodes.lookup(h))];
  g.GameInfo.ProgressionTreeNodes = table(nodes); g.GameInfo.ProgressionTreeNodes[Symbol.iterator] = function* () { yield* nodes; };
  g.Game.ProgressionTrees = { getNode: (pid, h) => (states[h] !== undefined ? { state: states[h] } : null) };
  g.PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE = 323351948; g.PlayerOperationTypes.CONSIDER_ASSIGN_ATTRIBUTE = 446393507;
  me.Identity = { getAvailableAttributePoints: (a) => points[a] ?? 0, getWildcardPoints: () => wildcard };
  if (blocked) {
    g.Game.Notifications.getEndTurnBlockingType = () => 777;
    g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 5, type: 20 }];
    g.Game.Notifications.find = () => ({ Type: 1, BlocksTurnAdvancement: true });
    g.Game.Notifications.getTypeName = () => "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL";
  }
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 323351948 && op !== 446393507) return inner.canStart(pid, op, args, show); g._log.push(`acanStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: op === 446393507 ? true : canNodes.includes(args.ProgressionTreeNodeType) }; },
    sendRequest: (pid, op, args) => { if (op !== 323351948 && op !== 446393507) return inner.sendRequest(pid, op, args); g._log.push(`asendRequest(${pid},${op},${JSON.stringify(args)})`); if (op === 323351948) states[args.ProgressionTreeNodeType] = 5; },
  };
  return g;
}

test("attribute offers list purchasable nodes with attribute, points and description, and the consider only under the notification", () => {
  const log = [];
  const g = withAttributes(world({ log })); g._log = log;
  const r = runOffers(g);
  const buys = r.offers.filter((o) => o.kind === "BUY_ATTRIBUTE_TREE_NODE");
  assert.deepEqual(buys.map((o) => [o.arg, o.pre, o.typeKey, o.attribute, o.attributeName, o.description, o.cost, o.availablePoints, o.wildcardPoints, o.canStart]), [[4001, 2, "NODE_ATTRIBUTE_CULTURAL_01", "ATTRIBUTE_CULTURAL", "LOC_ATTR_C", "LOC_N1_D", 1, 1, 2, true]]);
  assert.equal(r.offers.filter((o) => o.kind === "CONSIDER_ASSIGN_ATTRIBUTE").length, 1);
  assert.equal(r.offers.find((o) => o.kind === "END_TURN").blockingType, "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL");
  const h = withAttributes(world({ log: [] }), { blocked: false }); h._log = [];
  assert.equal(runOffers(h).offers.filter((o) => o.kind === "CONSIDER_ASSIGN_ATTRIBUTE").length, 0);
});

test("perform BUY_ATTRIBUTE_TREE_NODE checks the tree, the node state and canStart, sends, and reads back the unlocked state", () => {
  const log = [];
  const g = withAttributes(world({ log })); g._log = log;
  const r = runPerform(g, "BUY_ATTRIBUTE_TREE_NODE", 4001, { pre: 2 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "BUY_ATTRIBUTE_TREE_NODE", arg: 4001, stateBefore: 2, state: 5, matches: true });
  for (const [label, mk, hash, pre] of [
    ["not an attribute node", () => withAttributes(world({ log: [] })), 701, 2],
    ["state changed", () => withAttributes(world({ log: [] })), 4001, 5],
    ["canStart false", () => withAttributes(world({ log: [] }), { canNodes: [] }), 4001, 2],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerform(h, "BUY_ATTRIBUTE_TREE_NODE", hash, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("asendRequest")), `${label}: must not send`);
  }
  const c = runPerform(g, "CONSIDER_ASSIGN_ATTRIBUTE", 0, { pre: 0 });
  assert.equal(c.outcome, "sent");
});

// ---- celebration (golden age) choice
function withCelebration(g, { choices = ["GOLDEN_AGE_CR_1", "GOLDEN_AGE_CR_2"], allowed = [5001, 5002] } = {}) {
  const cu = g.Players.get(1).Culture;
  let left = choices.slice();
  const rows = [{ $hash: 5001, GoldenAgeType: "GOLDEN_AGE_CR_1", Name: "LOC_CR", Description: "LOC_CR1_D" }, { $hash: 5002, GoldenAgeType: "GOLDEN_AGE_CR_2", Name: "LOC_CR", Description: "LOC_CR2_D" }];
  g.GameInfo.GoldenAges = { lookup: (k) => rows.find((r) => r.$hash === k || r.GoldenAgeType === k) ?? null };
  g.PlayerOperationTypes.CHOOSE_GOLDEN_AGE = 1273802547;
  cu.getGoldenAgeChoices = () => left.slice();
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 1273802547) return inner.canStart(pid, op, args, show); g._log.push(`ccanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: allowed.includes(args.GoldenAgeType) }; },
    sendRequest: (pid, op, args) => { if (op !== 1273802547) return inner.sendRequest(pid, op, args); g._log.push(`csendRequest(${pid},${JSON.stringify(args)})`); left = []; },
  };
  return g;
}

test("celebration offers hash the type strings the culture component lists, with description and native legality", () => {
  const log = [];
  const g = withCelebration(world({ log }), { allowed: [5001] }); g._log = log;
  const c = runOffers(g).offers.filter((o) => o.kind === "CHOOSE_GOLDEN_AGE");
  assert.deepEqual(c.map((o) => [o.arg, o.pre, o.typeKey, o.displayName, o.description, o.canStart]), [[5001, 2, "GOLDEN_AGE_CR_1", "LOC_CR", "LOC_CR1_D", true], [5002, 2, "GOLDEN_AGE_CR_2", "LOC_CR", "LOC_CR2_D", false]]);
  assert.ok(log.filter((e) => e.startsWith("ccanStart(")).every((e) => /"GoldenAgeType":500[12]/.test(e)), "the hash, never the string, is sent");
});

test("perform CHOOSE_GOLDEN_AGE re-checks the choice list and canStart, sends the hash, and reads back the emptied list", () => {
  const log = [];
  const g = withCelebration(world({ log })); g._log = log;
  const r = runPerform(g, "CHOOSE_GOLDEN_AGE", 5001, { pre: 2 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CHOOSE_GOLDEN_AGE", arg: 5001, choicesLeft: 0, matches: true });
  assert.ok(log.find((e) => e.startsWith("csendRequest(1,") && e.includes('"GoldenAgeType":5001')));
  for (const [label, mk, hash, pre] of [
    ["not offered", () => withCelebration(world({ log: [] }), { choices: ["GOLDEN_AGE_CR_2"] }), 5001, 1],
    ["list changed", () => withCelebration(world({ log: [] })), 5001, 1],
    ["canStart false", () => withCelebration(world({ log: [] }), { allowed: [] }), 5001, 2],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerform(h, "CHOOSE_GOLDEN_AGE", hash, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("csendRequest")), `${label}: must not send`);
  }
});

// ---- resource assignment
function withResources(g, { toAssign = 1, legal = { "1637:131073": true, "1752:65536": true }, blocked = true } = {}) {
  const me = g.Players.get(1);
  const assigned = { 1698: 65536 };
  const listFor = (cid) => Object.entries(assigned).filter(([, c]) => c === cid).map(([v]) => ({ uniqueResource: { resource: 0 }, value: Number(v) }));
  const cities = [{ id: { owner: 1, id: 65536, type: 1 }, name: "LOC_C", isTown: false, Resources: { getAssignedResourcesCap: () => 4, getTotalCountAssignedResources: () => 1, getAssignedResources: () => listFor(65536) } }, { id: { owner: 1, id: 131073, type: 1 }, name: "LOC_B", isTown: true, Resources: { getAssignedResourcesCap: () => 1, getTotalCountAssignedResources: () => 0, getAssignedResources: () => listFor(131073) } }];
  me.Cities = { getCities: () => cities };
  me.Resources = { getResources: () => [{ uniqueResource: { resource: 601 }, value: 1637 }, { uniqueResource: { resource: 602 }, value: 1698 }, { uniqueResource: { resource: 603 }, value: 1752 }], getCountResourcesToAssign: () => toAssign, getCityIDAssigned: () => undefined };
  g.Game.Resources = { getOriginCity: () => ({ owner: 1, id: 65536, type: 1 }) };
  g.GameInfo.Resources = table([{ $hash: 601, ResourceType: "RESOURCE_RUBIES", Name: "LOC_RUBIES", ResourceClassType: "RESOURCECLASS_BONUS", Tooltip: "LOC_RUBIES_T" }, { $hash: 602, ResourceType: "RESOURCE_IVORY", Name: "LOC_IVORY", ResourceClassType: "RESOURCECLASS_EMPIRE", Tooltip: "LOC_IVORY_T" }, { $hash: 603, ResourceType: "RESOURCE_PEARLS", Name: "LOC_PEARLS", ResourceClassType: "RESOURCECLASS_CITY", Tooltip: "LOC_PEARLS_T" }]);
  g.GameplayMap = { getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }), getIndexFromXY: (x, y) => y * 100 + x };
  g.PlayerOperationTypes.ASSIGN_RESOURCE = -727226626; g.PlayerOperationTypes.CONSIDER_ASSIGN_RESOURCE = -2020490726;
  if (blocked) { g.Game.Notifications.getEndTurnBlockingType = () => 778; g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 6, type: 20 }]; g.Game.Notifications.find = () => ({ Type: 2, BlocksTurnAdvancement: true }); g.Game.Notifications.getTypeName = () => "NOTIFICATION_ASSIGN_NEW_RESOURCES"; }
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== -727226626 && op !== -2020490726) return inner.canStart(pid, op, args, show); g._log.push(`rcanStart(${pid},${op},${JSON.stringify(args)},${show})`); if (op === -2020490726) return { Success: true }; const key = `${args.Location.y * 100 + args.Location.x}:${args.City}`; return { Success: !!legal[key] }; },
    sendRequest: (pid, op, args) => { if (op !== -727226626 && op !== -2020490726) return inner.sendRequest(pid, op, args); g._log.push(`rsendRequest(${pid},${op},${JSON.stringify(args)})`); if (op === -727226626) assigned[args.Location.y * 100 + args.Location.x] = args.City; },
  };
  return g;
}

test("resource offers pair each resource with every city the native check accepts, skipping its current city, with effect text and capacity", () => {
  const log = [];
  const g = withResources(world({ log })); g._log = log;
  const r = runOffers(g);
  const res = r.offers.filter((o) => o.kind === "ASSIGN_RESOURCE");
  assert.deepEqual(res.map((o) => [o.arg, o.arg2, o.pre, o.resourceKey, o.description, o.resourceClass, o.cityName, o.cityIsTown, o.cityCap, o.cityAssigned, o.assignedCityId, o.canStart]),
    [[1637, 131073, 1, "RESOURCE_RUBIES", "LOC_RUBIES_T", "RESOURCECLASS_BONUS", "LOC_B", true, 1, 0, null, true], [1752, 65536, 1, "RESOURCE_PEARLS", "LOC_PEARLS_T", "RESOURCECLASS_CITY", "Cordoba", false, 4, 1, null, true]]);
  assert.ok(!log.some((e) => e.startsWith("rcanStart(") && e.includes('"City":65536') && e.includes('"x":98,"y":16')), "an assigned resource is not offered to the city it is already in");
  const consider = r.offers.find((o) => o.kind === "CONSIDER_ASSIGN_RESOURCE");
  assert.deepEqual([consider.canStart, consider.toAssign, consider.assignable], [false, 1, 2]);
  const done = withResources(world({ log: [] }), { toAssign: 0 }); done._log = [];
  assert.equal(runOffers(done).offers.find((o) => o.kind === "CONSIDER_ASSIGN_RESOURCE").canStart, true);
});

test("perform ASSIGN_RESOURCE checks ownership, the pending count and canStart, sends Location and City, and reads back the assignment", () => {
  const log = [];
  const g = withResources(world({ log })); g._log = log;
  const r = runPerformArgs(g, "ASSIGN_RESOURCE", 1637, 131073, 0, { pre: 1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "ASSIGN_RESOURCE", arg: 1637, city: 131073, assignedTo: 131073, matches: true });
  assert.ok(log.find((e) => e.startsWith("rsendRequest(1,") && e.includes('"Location":{"x":37,"y":16},"City":131073')));
  for (const [label, mk, v, cid, pre] of [
    ["not ours", () => withResources(world({ log: [] })), 9999, 131073, 1],
    ["unknown city", () => withResources(world({ log: [] })), 1637, 7, 1],
    ["pending count changed", () => withResources(world({ log: [] })), 1637, 131073, 0],
    ["canStart false", () => withResources(world({ log: [] }), { legal: {} }), 1637, 131073, 1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "ASSIGN_RESOURCE", v, cid, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("rsendRequest")), `${label}: must not send`);
  }
  const c = runPerform(g, "CONSIDER_ASSIGN_RESOURCE", 0, { pre: 0 });
  assert.equal(c.outcome, "sent");
});

// ---- unit promotion (discipline + promotion pair, hashes only)
function withPromotions(g, { canPromote = true, earnable = ["PROMOTION_A"], held = 0, allow = true, applies = true } = {}) {
  const units = [unit(5, { type: 7 })];
  withUnits(g, units);
  const promos = [{ $hash: 7101, UnitPromotionType: "PROMOTION_A", Name: "LOC_PA", Description: "LOC_PA_D", Commendation: false }, { $hash: 7102, UnitPromotionType: "PROMOTION_B", Name: "LOC_PB", Description: "LOC_PB_D", Commendation: true }];
  const discs = [{ $hash: 8101, UnitPromotionDisciplineType: "DISCIPLINE_X", Name: "LOC_DX" }];
  const byHashOrType = (rows, field) => ({ length: rows.length, lookup: (k) => rows.find((r) => r.$hash === k || r[field] === k) ?? null });
  g.GameInfo.UnitPromotions = byHashOrType(promos, "UnitPromotionType");
  g.GameInfo.UnitPromotionDisciplines = byHashOrType(discs, "UnitPromotionDisciplineType");
  g.GameInfo.UnitPromotionDisciplineDetails = promos.map((p) => ({ UnitPromotionDisciplineType: "DISCIPLINE_X", UnitPromotionType: p.UnitPromotionType }));
  g.UnitCommandTypes = { PROMOTE: -1259482049, DELETE: 1 };
  const state = { held, has: {} };
  units[0].Experience = {
    canPromote, getNumPromotions: 10, getTotalPromotionsEarned: state.held, getStoredPromotionPoints: 1, getStoredCommendations: 0, getLevel: 2,
    canEarnPromotion: (d, p) => d === "DISCIPLINE_X" && earnable.includes(p),
    hasPromotion: (d, p) => !!state.has[p],
  };
  g.Game.UnitCommands = {
    canStart: (uid, cmd, args, show) => { g._log.push(`pcanStart(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)},${show})`); return { Success: allow && cmd === -1259482049 && uid.owner === 1 }; },
    sendRequest: (uid, cmd, args) => { g._log.push(`psendRequest(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)})`); if (applies) { const row = promos.find((p) => p.$hash === args.PromotionType); state.has[row.UnitPromotionType] = true; units[0].Experience.getTotalPromotionsEarned = state.held + 1; units[0].Experience.hasPromotion = (d, p) => !!state.has[p]; } },
  };
  return g;
}

test("promotion offers pair each earnable promotion with its discipline, carrying points, level and text", () => {
  const log = [];
  const g = withPromotions(world({ log })); g._log = log;
  const r = runOffers(g);
  const pr = r.offers.filter((o) => o.kind === "PROMOTE_UNIT");
  assert.deepEqual(pr.map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.unitId, o.discipline, o.disciplineName, o.typeKey, o.displayName, o.description, o.commendation, o.promotionsEarned, o.promotionPoints, o.unitLevel, o.canStart]),
    [[5, 7101, 8101, 0, 5, "DISCIPLINE_X", "LOC_DX", "PROMOTION_A", "LOC_PA", "LOC_PA_D", false, 0, 1, 2, true]]);
  const promoChecks = log.filter((e) => e.startsWith("pcanStart(") && e.includes("PromotionType"));
  assert.ok(promoChecks.length > 0 && promoChecks.every((e) => e.includes('"PromotionType":7101,"PromotionDisciplineType":8101')), "hashes only, never type strings");
  assert.ok(!log.some((e) => e.startsWith("pcanStart(") && /"PROMOTION_|"DISCIPLINE_/.test(e)), "a type string must never reach the native check");
  assert.ok(!log.some((e) => e.startsWith("psendRequest")));
  const none = withPromotions(world({ log: [] }), { canPromote: false }); none._log = [];
  assert.equal(runOffers(none).offers.filter((o) => o.kind === "PROMOTE_UNIT").length, 0, "a unit that cannot promote is never queried");
});

test("perform PROMOTE_UNIT re-checks the pair, the promotion count and canStart, sends hashes, and reads back", () => {
  const log = [];
  const g = withPromotions(world({ log })); g._log = log;
  const r = runPerformArgs(g, "PROMOTE_UNIT", 5, 7101, 8101, { pre: 0 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "PROMOTE_UNIT", arg: 5, promotion: 7101, discipline: 8101, earned: 1, hasPromotion: true, matches: true });
  const i = log.findIndex((e) => e.startsWith("pcanStart("));
  const j = log.findIndex((e) => e.startsWith("psendRequest("));
  assert.ok(i !== -1 && j !== -1 && i < j);
});

test("perform PROMOTE_UNIT refuses an unknown unit, a changed promotion count, a mismatched pair, an unearnable promotion and a canStart refusal without sending", () => {
  for (const [label, mk, uid, ph, dh, pre] of [
    ["unknown unit", () => withPromotions(world({ log: [] })), 9, 7101, 8101, 0],
    ["count changed", () => withPromotions(world({ log: [] })), 5, 7101, 8101, 3],
    ["not a definition", () => withPromotions(world({ log: [] })), 5, 4242, 8101, 0],
    ["not earnable", () => withPromotions(world({ log: [] }), { earnable: [] }), 5, 7101, 8101, 0],
    ["canStart false", () => withPromotions(world({ log: [] }), { allow: false }), 5, 7101, 8101, 0],
    ["cannot promote", () => withPromotions(world({ log: [] }), { canPromote: false }), 5, 7101, 8101, 0],
  ]) {
    const g = mk(); const l = []; g._log = l;
    const rr = runPerformArgs(g, "PROMOTE_UNIT", uid, ph, dh, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("psendRequest")), `${label}: must not send`);
  }
  const g = withPromotions(world({ log: [] }), { applies: false }); g._log = [];
  const r = runPerformArgs(g, "PROMOTE_UNIT", 5, 7101, 8101, { pre: 0 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.readback.matches, false);
});

test("a plot another player occupies is never offered as a move, and nothing about the occupant is exposed", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  // live (turn 34): a Modifiers:NONE move into an independent's tile was accepted and silently dropped
  g.Game.Combat = { getBestDefender: (loc, uid) => { g._log.push(`defender(${loc.x},${loc.y})`); return (loc.x === 11 && loc.y === 10) ? { owner: 13, id: 393221, type: 1 } : { owner: -1, id: -1, type: 0 }; } };
  const r = runOffers(g);
  const moves = r.offers.filter((o) => o.kind === "MOVE_UNIT");
  assert.ok(!moves.some((o) => o.x === 11 && o.y === 10), "the occupied plot must not be offered");
  assert.ok(moves.length > 0, "the other neighbours are still offered");
  const dump = JSON.stringify(r.offers);
  assert.ok(!dump.includes("393221") && !dump.includes('"owner"'), "no occupant identity may reach the client");
  assert.ok(log.some((e) => e.startsWith("defender(")), "the engine's own defender query is what decides");
});

test("a plot the bound player's own unit stands on is still offered", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  g.Game.Combat = { getBestDefender: () => ({ owner: 1, id: 77, type: 1 }) };
  assert.ok(runOffers(g).offers.filter((o) => o.kind === "MOVE_UNIT").length > 0);
});

// ---- town projects (a town specialises through the growth mode, not the build queue)
function withTown(g, { isTown = true, current = -1, allowed = [9301], mode = "PROJECT" } = {}) {
  const town = { id: { owner: 1, id: 131073, type: 1 }, owner: 1, name: "LOC_T", isTown, location: { x: 5, y: 5 },
    Growth: { projectType: current, growthType: -1126871330, isReadyToPlacePopulation: true },
    BuildQueue: { currentProductionTypeHash: -1, isEmpty: true, _q: [], getQueue() { return this._q.slice(); } },
    Resources: { getAssignedResourcesCap: () => 1, getTotalCountAssignedResources: () => 0, getAssignedResources: () => [] } };
  g.Players.get(1).Cities = { getCities: () => [town] };
  const rows = [{ $hash: 9301, ProjectType: "PROJECT_TOWN_FORT", Name: "LOC_FORT", Description: "LOC_FORT_D", Cost: 120, TownDefault: false, UpgradeToCity: false },
                { $hash: 9302, ProjectType: "PROJECT_TOWN_MINING", Name: "LOC_MINE", Description: "LOC_MINE_D", Cost: 120, TownDefault: true, UpgradeToCity: false }];
  g.GameInfo.Projects = table(rows); g.GameInfo.Projects[Symbol.iterator] = function* () { yield* rows; };
  g.GrowthTypes = { INVALID: 0, EXPAND: -1126871330, MIGRATE: 1308026452, PROJECT: -284569333 };
  g.CityCommandTypes = { EXPAND: 7771, CHANGE_GROWTH_MODE: -580125556 };
  g.Game.CityCommands = {
    canStart: (cid, cmd, args, show) => { g._log.push(`tcanStart(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)},${show})`); if (cmd !== -580125556) return { Success: false }; return { Success: allowed.includes(args.ProjectType) && args.Type === g.GrowthTypes[mode] }; },
    sendRequest: (cid, cmd, args) => { g._log.push(`tsendRequest(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)})`); town.Growth.projectType = args.ProjectType; },
  };
  return g;
}

test("town project offers list the projects the growth-mode command accepts, with cost and description", () => {
  const log = [];
  const g = withTown(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  const tp = r.offers.filter((o) => o.kind === "CHOOSE_TOWN_PROJECT");
  assert.deepEqual(tp.map((o) => [o.arg, o.arg2, o.pre, o.cityName, o.typeKey, o.displayName, o.description, o.cost, o.townDefault, o.canStart]),
    [[131073, 9301, -1, "LOC_T", "PROJECT_TOWN_FORT", "LOC_FORT", "LOC_FORT_D", 120, false, true]]);
  const growthChecks = log.filter((e) => e.startsWith("tcanStart(") && e.includes(",-580125556,"));
  assert.ok(growthChecks.length > 0 && growthChecks.every((e) => e.includes('"Type":-284569333') && e.includes('"City":131073') && e.endsWith(",false)")));
  assert.ok(!log.some((e) => e.startsWith("tsendRequest")));
  const city = withTown(withUnits(world({ log: [] }), []), { isTown: false }); city._log = [];
  assert.equal(runOffers(city).offers.filter((o) => o.kind === "CHOOSE_TOWN_PROJECT").length, 0, "a city is not a town");
});

test("perform CHOOSE_TOWN_PROJECT re-checks the town, its current project and canStart, then reads back", () => {
  const log = [];
  const g = withTown(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "CHOOSE_TOWN_PROJECT", 131073, 9301, 0, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CHOOSE_TOWN_PROJECT", arg: 131073, project: 9301, observed: 9301, matches: true });
  for (const [label, mk, cid, ph, pre] of [
    ["unknown settlement", () => withTown(withUnits(world({ log: [] }), [])), 7, 9301, -1],
    ["not a town", () => withTown(withUnits(world({ log: [] }), []), { isTown: false }), 131073, 9301, -1],
    ["project changed", () => withTown(withUnits(world({ log: [] }), [])), 131073, 9301, 42],
    ["not a project", () => withTown(withUnits(world({ log: [] }), [])), 131073, 4242, -1],
    ["canStart false", () => withTown(withUnits(world({ log: [] }), []), { allowed: [] }), 131073, 9301, -1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "CHOOSE_TOWN_PROJECT", cid, ph, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("tsendRequest")), `${label}: must not send`);
  }
});

test("move and found offers carry the game's own minimum-settlement-distance rule, with no identity attached", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  g.GameplayMap.isCityWithinMinimumDistance = (x, y) => x <= 11;
  const moves = runOffers(g).offers.filter((o) => o.kind === "MOVE_UNIT");
  assert.ok(moves.length > 0);
  assert.ok(moves.every((o) => o.tooCloseToSettle === undefined), "a unit that cannot found gets no settling hint");
  assert.ok(moves.length > 6, "the search reaches past the immediate neighbours");
  const settler = withMap(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])); settler._log = [];
  settler.GameplayMap.isCityWithinMinimumDistance = (x) => x <= 11;
  settler.UnitOperationTypes.FOUND_CITY = 1463004268;
  const innerCan = settler.Game.UnitOperations.canStart;
  settler.Game.UnitOperations.canStart = (uid, op, args, show) => (op === 1463004268 ? { Success: true } : innerCan(uid, op, args, show));
  const smoves = runOffers(settler).offers.filter((o) => o.kind === "MOVE_UNIT");
  assert.ok(smoves.every((o) => o.tooCloseToSettle === (o.x <= 11)), "a settler's destinations report the rule");
  // a destination beyond the rule reports false for the settler, and nothing at all for the other unit
  const far = smoves.find((o) => o.x > 11);
  assert.ok(far && far.tooCloseToSettle === false, "the wider reach now includes plots outside the minimum distance");
  assert.equal(moves.find((o) => o.x > 11).tooCloseToSettle, undefined);
  assert.ok(!JSON.stringify(moves).includes('"owner"'));
});

test("a settler blocked by the minimum distance is told so, and one blocked for another reason is not", () => {
  const log = [];
  const g = withFounder(world({ log }), [founder(5)], { foundOk: false }); g._log = log;
  g.Game.UnitOperations.canStart = ((inner) => (uid, op, args, show) => op === 1463004268 && show === true ? { Success: uid.id === 5 } : inner(uid, op, args, show))(g.Game.UnitOperations.canStart);
  g.GameplayMap.isCityWithinMinimumDistance = () => true;
  const close = runOffers(g).offers.find((o) => o.kind === "FOUND_CITY");
  assert.equal(close.tooCloseToSettle, true);
  assert.match(close.reason, /minimum distance/);
  const h = withFounder(world({ log: [] }), [founder(5)], { foundOk: false }); h._log = [];
  h.Game.UnitOperations.canStart = ((inner) => (uid, op, args, show) => op === 1463004268 && show === true ? { Success: uid.id === 5 } : inner(uid, op, args, show))(h.Game.UnitOperations.canStart);
  h.GameplayMap.isCityWithinMinimumDistance = () => false;
  const other = runOffers(h).offers.find((o) => o.kind === "FOUND_CITY");
  assert.equal(other.tooCloseToSettle, false);
  assert.match(other.reason, /not the minimum-settlement-distance rule/);
});

test("a town already running a project is not offered another (the engine accepts and then drops it)", () => {
  const log = [];
  const g = withCity(withUnits(world({ log }), [])); g._log = log;
  const city = g.Players.get(1).Cities.getCities()[0];
  city.isTown = true; city.Growth = { projectType: 4242, isReadyToPlacePopulation: false };
  g.CityCommandTypes = { ...(g.CityCommandTypes || {}), CHANGE_GROWTH_MODE: 7772 };
  g.GrowthTypes = { EXPAND: 0, PROJECT: 1 };
  const rows = [{ $hash: 4242, ProjectType: "PROJECT_TOWN_A", Name: "LOC_A" }, { $hash: 4243, ProjectType: "PROJECT_TOWN_B", Name: "LOC_B" }];
  g.GameInfo.Projects = table(rows); g.GameInfo.Projects[Symbol.iterator] = function* () { yield* rows; };
  g.Game.CityCommands = { canStart: () => ({ Success: true }), sendRequest: () => { g._log.push("gsend"); } };
  assert.deepEqual(runOffers(g).offers.filter((o) => o.kind === "CHOOSE_TOWN_PROJECT"), []);
  city.Growth = { projectType: -1, isReadyToPlacePopulation: false };
  assert.ok(runOffers(g).offers.filter((o) => o.kind === "CHOOSE_TOWN_PROJECT").length >= 1, "a town with no project is offered one");
});

test("a town-project choice is preceded by the consider step the shipped chooser sends on opening, and keeping the focus is offered while the blocker stands", () => {
  const log = [];
  const g = withCity(withUnits(world({ log }), [])); g._log = log;
  const city = g.Players.get(1).Cities.getCities()[0];
  city.isTown = true; city.Growth = { projectType: -1, isReadyToPlacePopulation: false };
  g.CityCommandTypes = { ...(g.CityCommandTypes || {}), CHANGE_GROWTH_MODE: 7772 };
  g.CityOperationTypes = { ...(g.CityOperationTypes || {}), CONSIDER_TOWN_PROJECT: 5552 };
  g.GrowthTypes = { EXPAND: 0, PROJECT: 1 };
  const rows = [{ $hash: 4242, ProjectType: "PROJECT_TOWN_FISHING", Name: "LOC_F" }];
  g.GameInfo.Projects = table(rows); g.GameInfo.Projects[Symbol.iterator] = function* () { yield* rows; };
  let blocking = true;
  g.Game.Notifications = { ...g.Game.Notifications, getIdsForPlayer: () => (blocking ? [{ owner: 1, id: 1, type: 9 }] : []), find: () => ({ Type: 9 }), getTypeName: () => "NOTIFICATION_CHOOSE_TOWN_PROJECT", getBlocksTurnAdvancement: () => true, getEndTurnBlockingType: () => 0 };
  g.Game.CityCommands = { canStart: () => ({ Success: true }), sendRequest: (cid, cmd, args) => { log.push(`growth(${JSON.stringify(args)})`); city.Growth = { projectType: args.ProjectType }; } };
  const inner = g.Game.CityOperations;
  g.Game.CityOperations = { canStart: inner.canStart, sendRequest: (cid, op, args) => { if (op === 5552) { log.push("consider"); blocking = false; return; } return inner.sendRequest(cid, op, args); } };
  const offers = runOffers(g).offers;
  assert.deepEqual(offers.filter((o) => o.kind === "CONSIDER_TOWN_PROJECT").map((o) => [o.arg, o.cityName]), [[65536, "Cordoba"]]);
  const r = runPerformArgs(g, "CHOOSE_TOWN_PROJECT", 65536, 4242, 0, { pre: -1 });
  assert.equal(r.refused, null);
  const i = log.indexOf("consider"), j = log.findIndex((e) => e.startsWith("growth("));
  assert.ok(i !== -1 && j !== -1 && i < j, "consider goes out before the choice");
  blocking = true;
  const k = runPerformArgs(g, "CONSIDER_TOWN_PROJECT", 65536, 0, 0, { pre: 0 });
  assert.deepEqual(k.readback, { kind: "CONSIDER_TOWN_PROJECT", arg: 65536, stillBlocking: false, matches: true });
});

// ---- purchasing a unit with the treasury
function withPurchase(g, { affordable = [99], gold = 800, unitsAfter = 1 } = {}) {
  withCity(g, {});
  const me = g.Players.get(1);
  let units = [];
  me.Units = { getUnits: () => units };
  me.Treasury = { goldBalance: gold };
  g.CityCommandTypes = { EXPAND: 7771, PURCHASE: 1490793096 };
  const city = me.Cities.getCities()[0];
  g.Game.CityCommands = {
    canStart: (cid, cmd, args, show) => { g._log.push(`qcanStart(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)},${show})`); if (cmd !== 1490793096) return { Success: false }; return { Success: cid.owner === 1 && affordable.includes(args.UnitType), Cost: 240, Requirements: {} }; },
    sendRequest: (cid, cmd, args) => { g._log.push(`qsendRequest(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)})`); for (let i = 0; i < unitsAfter; i++) units = units.concat([unit(900 + i)]); me.Units = { getUnits: () => units }; },
  };
  return g;
}

test("purchase offers carry the native cost and the seat's gold, and never touch the build queue", () => {
  const log = [];
  const g = withPurchase(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  const buys = r.offers.filter((o) => o.kind === "PURCHASE_UNIT");
  assert.deepEqual(buys.map((o) => [o.arg, o.arg2, o.pre, o.cityName, o.unitTypeKey, o.cost, o.goldBalance, o.canStart]),
    [[65536, 99, 0, "Cordoba", "UNIT_SCOUT", 240, 800, true]]);
  assert.ok(!log.some((e) => e.startsWith("qsendRequest")));
});

test("perform PURCHASE_UNIT re-checks the roster size and canStart, sends PURCHASE, and reads back a new unit", () => {
  const log = [];
  const g = withPurchase(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "PURCHASE_UNIT", 65536, 99, 0, { pre: 0 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "PURCHASE_UNIT", arg: 65536, unitType: 99, unitsBefore: 0, units: 1, matches: true });
  assert.ok(log.find((e) => e.startsWith("qsendRequest(") && e.includes('"UnitType":99')));
  for (const [label, mk, cid, ut, pre] of [
    ["unknown city", () => withPurchase(withUnits(world({ log: [] }), [])), 7, 99, 0],
    ["not a unit", () => withPurchase(withUnits(world({ log: [] }), [])), 65536, 4242, 0],
    ["roster changed", () => withPurchase(withUnits(world({ log: [] }), [])), 65536, 99, 3],
    ["canStart false", () => withPurchase(withUnits(world({ log: [] }), []), { affordable: [] }), 65536, 99, 0],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "PURCHASE_UNIT", cid, ut, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("qsendRequest")), `${label}: must not send`);
  }
  const none = withPurchase(withUnits(world({ log: [] }), []), { unitsAfter: 0 }); none._log = [];
  const rr = runPerformArgs(none, "PURCHASE_UNIT", 65536, 99, 0, { pre: 0 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

test("perform of a war declaration reads the relationship back, since the treasury never moves for it", () => {
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), []), { spend: 0, warAfter: [0] }); g._log = log;
  const r = runPerformArgs(g, "START_DIPLOMATIC_ACTION", 0, 9003, 0, { pre: 500 });
  assert.equal(r.refused, null);
  assert.equal(r.readback.wasAtWar, false);
  assert.equal(r.readback.atWar, true);
  assert.equal(r.readback.matches, true, "a war costs no influence; the relationship is the whole signal");
  assert.ok(log.find((e) => e.startsWith("dsendRequest(") && e.includes(",557,")), "the listing's own operation for that project");
});

test("an alliance that is never formed leaves the action unmatched even though the call went through", () => {
  const g = withDiplomacy(withUnits(world({ log: [] }), []), { spend: 0 }); g._log = [];
  const r = runPerformArgs(g, "START_DIPLOMATIC_ACTION", 0, 9003, 0, { pre: 500 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.readback.matches, false);
});

test("ending an alliance is offered only while one exists, and confirms on the alliance being gone", () => {
  const log = [];
  const none = withDiplomacy(withUnits(world({ log }), [])); none._log = log;
  assert.deepEqual(runOffers(none).offers.filter((o) => o.kind === "CANCEL_ALLIANCE"), [],
    "nothing to end when the seat is allied with no one");
  const g = withDiplomacy(withUnits(world({ log: [] }), []), { allied: [0], alliedAfter: [] }); g._log = [];
  const offers = runOffers(g).offers.filter((o) => o.kind === "CANCEL_ALLIANCE");
  assert.deepEqual(offers.map((o) => [o.arg, o.targetName, o.targetIsMajor]), [[0, "LOC_ABBASID", true]]);
  const h = withDiplomacy(withUnits(world({ log: [] }), []), { allied: [0], alliedAfter: [] }); h._log = [];
  const r = runPerformArgs(h, "CANCEL_ALLIANCE", 0, 0, 0, { pre: 1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CANCEL_ALLIANCE", arg: 0, wasAllied: true, allied: false, matches: true });
  assert.ok(h._log.find((e) => e.startsWith("csendRequest(") && e.includes('"Type":769311562')), "the cancel carries the alliance action type");
});

test("perform CANCEL_ALLIANCE refuses an unmet target, itself, a seat with no alliance and a refused check", () => {
  for (const [label, mk, target] of [
    ["unmet", () => withDiplomacy(withUnits(world({ log: [] }), []), { met: [], allied: [0] }), 0],
    ["itself", () => withDiplomacy(withUnits(world({ log: [] }), []), { allied: [1] }), 1],
    ["not allied", () => withDiplomacy(withUnits(world({ log: [] }), [])), 0],
    ["canStart false", () => withDiplomacy(withUnits(world({ log: [] }), []), { allied: [0], cancelOk: false }), 0],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "CANCEL_ALLIANCE", target, 0, 0, { pre: 1 });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("csendRequest")), `${label}: must not send`);
  }
});

test("a project with secondary targets is offered once per target the engine accepts, carrying the parameter the engine names", () => {
  const rows = [{ actionType: 9010, actionTypeName: "DIPLOMACY_ACTION_ESPIONAGE_STEAL_TECH", actionDisplayName: "LOC_STEAL", operationType: 560, actionGroup: 5, projectStatus: 1,
                  targetList1: [{ targetID: 0, costYieldD: 107 }],
                  targetList2: [{ parameterName: "City", targetID: 65536, targetName: "LOC_CAPITAL", targetPlot: 1234, costYieldD: 107 }, { parameterName: "City", targetID: 65537, targetName: "LOC_TOWN", targetPlot: 1235, costYieldD: 90 }] }];
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), []), { projects: rows }); g._log = log;
  g.GameplayMap = { ...(g.GameplayMap || {}), getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  const dips = runOffers(g).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION");
  assert.deepEqual(dips.map((o) => [o.arg, o.arg2, o.arg3, o.cost, o.secondary]), [
    [0, 9010, 65536, 107, { parameter: "City", id: 65536, name: "LOC_CAPITAL", at: { x: 34, y: 12 } }],
    [0, 9010, 65537, 90, { parameter: "City", id: 65537, name: "LOC_TOWN", at: { x: 35, y: 12 } }]]);
  assert.ok(log.some((e) => e.startsWith("dcanStart(") && e.includes('"City":65536')), "the secondary rides the argument the engine named");
  const r = runPerformArgs(g, "START_DIPLOMATIC_ACTION", 0, 9010, 65537, { pre: 500 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback.secondary, { parameter: "City", id: 65537 });
  assert.ok(log.find((e) => e.startsWith("dsendRequest(") && e.includes('"City":65537')));
  const gone = withDiplomacy(withUnits(world({ log: [] }), []), { projects: rows }); gone._log = [];
  gone.GameplayMap = g.GameplayMap;
  assert.ok(runPerformArgs(gone, "START_DIPLOMATIC_ACTION", 0, 9010, 99999, { pre: 500 }).refused, "a secondary the engine no longer lists is refused");
});

// ---- a call to arms from an ally
function withCallToArms(g, { call = 21, initial = 0, target = 7, allied = [0], warOk = true, warAfter = true } = {}) {
  g._log = g._log || [];
  withDiplomacy(g, { allied, met: [{ id: 0, major: true, name: "LOC_ABBASID" }, { id: 7, major: true, name: "LOC_MEIJI" }] });
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, DECLARE_WAR: 9901 };
  g.DiplomacyActionTypes = { ...(g.DiplomacyActionTypes || {}), DIPLOMACY_ACTION_DECLARE_WAR: -434781988, DIPLOMACY_ACTION_FORM_ALLIANCE: 769311562 };
  let pending = call;
  g.Game.Diplomacy = { ...g.Game.Diplomacy, getNextCallToArms: () => pending, getDiplomaticEventData: (id) => (id === call ? { uniqueID: call, initialPlayer: initial, targetPlayer: target } : null) };
  const me = g.Players.get(1);
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 9901) return inner.canStart(pid, op, args, show); g._log.push(`wcanStart(${JSON.stringify(args)})`); return { Success: warOk && pid === 1 }; },
    sendRequest: (pid, op, args) => { if (op !== 9901) return inner.sendRequest(pid, op, args); g._log.push(`wsendRequest(${JSON.stringify(args)})`); if (warAfter) { me.Diplomacy.isAtWarWith = (id) => id === args.Player2; pending = -1; } },
  };
  return g;
}

test("a call to arms offers war on the ally's enemy, needing confirmation, and only while the ally is really an ally", () => {
  const g = withCallToArms(withUnits(world({ log: [] }), [])); g._log = [];
  const calls = runOffers(g).offers.filter((o) => o.kind === "DECLARE_WAR");
  assert.deepEqual(calls.map((o) => [o.arg, o.arg2, o.pre, o.allyPlayerId, o.allyName, o.targetPlayerId, o.targetName, o.requiresConfirmation]), [[7, 21, 21, 0, "LOC_ABBASID", 7, "LOC_MEIJI", true]]);
  const none = withCallToArms(withUnits(world({ log: [] }), []), { allied: [] }); none._log = [];
  assert.deepEqual(runOffers(none).offers.filter((o) => o.kind === "DECLARE_WAR"), []);
  const quiet = withCallToArms(withUnits(world({ log: [] }), []), { call: -1 }); quiet._log = [];
  assert.deepEqual(runOffers(quiet).offers.filter((o) => o.kind === "DECLARE_WAR"), []);
});

test("perform DECLARE_WAR for a call to arms declares on the enemy and confirms on being at war", () => {
  const g = withCallToArms(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runPerformArgs(g, "DECLARE_WAR", 7, 21, 0, { pre: 21 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "DECLARE_WAR", arg: 7, callToArms: 21, wasAtWar: false, atWar: true, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("wsendRequest(") && e.includes('"Player2":7') && e.includes('"Type":-434781988')));
  for (const [label, mk, enemy, call] of [["call gone", () => withCallToArms(withUnits(world({ log: [] }), []), { call: -1 }), 7, 21], ["other call", () => withCallToArms(withUnits(world({ log: [] }), [])), 7, 22], ["itself", () => withCallToArms(withUnits(world({ log: [] }), [])), 1, 21], ["engine refuses", () => withCallToArms(withUnits(world({ log: [] }), []), { warOk: false }), 7, 21]]) {
    const h = mk(); h._log = [];
    assert.ok(runPerformArgs(h, "DECLARE_WAR", enemy, call, 0, { pre: call }).refused, label);
    assert.ok(!h._log.some((e) => e.startsWith("wsendRequest")), label);
  }
});

// ---- peace: a plain proposal, and answering an incoming one
function withPeace(g, { atWar = [0], canPeace = [0], pending = [], incomingItems = 1, drafted = 1, proposeApplies = true, answerApplies = true } = {}) {
  g._log = g._log || [];
  withDiplomacy(g, { atWar, met: [{ id: 0, major: true, name: "LOC_ABBASID" }, { id: 7, major: true, name: "LOC_MEIJI" }] });
  const me = g.Players.get(1);
  let pendingNow = new Set(pending);
  me.Diplomacy.canMakePeaceWith = (id) => ({ Success: canPeace.includes(id) });
  g.DiplomacyDealDirection = { OUTGOING: 0, INCOMING: 1 };
  g.DiplomacyDealProposalActions = { PROPOSED: 1, ADJUSTED: 2, INSPECT: 3, ACCEPTED: 4, REJECTED: 5 };
  g.DiplomacyDealItemTypes = { AGREEMENTS: 9 };
  g.DiplomacyDealItemAgreementTypes = { MAKE_PEACE: 3 };
  const drafts = {};
  g.Game.DiplomacyDeals = {
    hasPendingDeal: (a, b) => pendingNow.has(b),
    getWorkingDeal: (id) => id.direction === 1 ? { itemIds: Array.from({ length: incomingItems }, (_, i) => i) } : { itemIds: drafts[id.player2] || [] },
    clearWorkingDeal: (id) => { g._log.push(`clear(${JSON.stringify(id)})`); drafts[id.player2] = []; },
    addItemToWorkingDeal: (id, item) => { g._log.push(`add(${JSON.stringify(item)})`); drafts[id.player2] = Array.from({ length: drafted }, (_, i) => i); return 1; },
    sendWorkingDeal: (id, action) => { g._log.push(`send(${JSON.stringify(id)},${action})`); if (action === 1 && proposeApplies) pendingNow.add(id.player2); if ((action === 4 || action === 5) && answerApplies) { pendingNow.delete(id.player1); if (action === 4) me.Diplomacy.isAtWarWith = () => false; } },
  };
  return g;
}

test("peace is offered as a plain proposal while at war, and as accept or reject once a deal is on the table", () => {
  const g = withPeace(withUnits(world({ log: [] }), [])); g._log = [];
  const offers = runOffers(g).offers;
  assert.deepEqual(offers.filter((o) => o.kind === "PROPOSE_PEACE").map((o) => [o.arg, o.targetName]), [[0, "LOC_ABBASID"]]);
  assert.deepEqual(offers.filter((o) => ["ACCEPT_PEACE", "REJECT_PEACE"].includes(o.kind)), []);
  const table = withPeace(withUnits(world({ log: [] }), []), { pending: [0] }); table._log = [];
  const to = runOffers(table).offers;
  assert.deepEqual(to.filter((o) => ["PROPOSE_PEACE", "ACCEPT_PEACE", "REJECT_PEACE"].includes(o.kind)).map((o) => [o.kind, o.arg, o.dealItems]), [["ACCEPT_PEACE", 0, 1], ["REJECT_PEACE", 0, 1]]);
  const notyet = withPeace(withUnits(world({ log: [] }), []), { canPeace: [] }); notyet._log = [];
  assert.deepEqual(runOffers(notyet).offers.filter((o) => o.kind === "PROPOSE_PEACE"), [], "the game decides when peace may be offered");
  const peace = withPeace(withUnits(world({ log: [] }), []), { atWar: [] }); peace._log = [];
  assert.deepEqual(runOffers(peace).offers.filter((o) => ["PROPOSE_PEACE", "ACCEPT_PEACE", "REJECT_PEACE"].includes(o.kind)), []);
});

test("perform PROPOSE_PEACE runs the shipped workflow step by step and confirms on a deal being on the table", () => {
  const g = withPeace(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runPerformArgs(g, "PROPOSE_PEACE", 0, 0, 0, { pre: 0 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "PROPOSE_PEACE", arg: 0, proposed: true, pending: true, matches: true });
  const seq = g._log.filter((e) => /^(clear|add|send)\(/.test(e));
  assert.deepEqual(seq, ['clear({"direction":0,"player1":1,"player2":0})', 'add({"type":9,"agreementType":3})', 'send({"direction":0,"player1":1,"player2":0},1)']);
  for (const [label, mk, other] of [["not at war", () => withPeace(withUnits(world({ log: [] }), []), { atWar: [] }), 0], ["already on the table", () => withPeace(withUnits(world({ log: [] }), []), { pending: [0] }), 0], ["peace not allowed yet", () => withPeace(withUnits(world({ log: [] }), []), { canPeace: [] }), 0], ["unmet", () => withPeace(withUnits(world({ log: [] }), [])), 9]]) {
    const h = mk(); h._log = [];
    assert.ok(runPerformArgs(h, "PROPOSE_PEACE", other, 0, 0, { pre: 0 }).refused, label);
    assert.ok(!h._log.some((e) => e.startsWith("send(")), label);
  }
  const bad = withPeace(withUnits(world({ log: [] }), []), { drafted: 0 }); bad._log = [];
  assert.ok(runPerformArgs(bad, "PROPOSE_PEACE", 0, 0, 0, { pre: 0 }).refused, "a draft without the agreement is never sent");
  assert.ok(!bad._log.some((e) => e.startsWith("send(")));
});

test("perform ACCEPT_PEACE confirms on the war ending and REJECT_PEACE on the table clearing with the war still on", () => {
  const a = withPeace(withUnits(world({ log: [] }), []), { pending: [0] }); a._log = [];
  const ra = runPerformArgs(a, "ACCEPT_PEACE", 0, 0, 0, { pre: 1 });
  assert.deepEqual(ra.readback, { kind: "ACCEPT_PEACE", arg: 0, pending: false, atWar: false, matches: true });
  assert.ok(a._log.find((e) => e === 'send({"direction":1,"player1":0,"player2":1},4)'));
  const rj = withPeace(withUnits(world({ log: [] }), []), { pending: [0] }); rj._log = [];
  const rr = runPerformArgs(rj, "REJECT_PEACE", 0, 0, 0, { pre: 1 });
  assert.deepEqual(rr.readback, { kind: "REJECT_PEACE", arg: 0, pending: false, atWar: true, matches: true });
  const none = withPeace(withUnits(world({ log: [] }), [])); none._log = [];
  assert.ok(runPerformArgs(none, "ACCEPT_PEACE", 0, 0, 0, { pre: 1 }).refused, "nothing on the table");
  const empty = withPeace(withUnits(world({ log: [] }), []), { pending: [0], incomingItems: 0 }); empty._log = [];
  assert.ok(runPerformArgs(empty, "ACCEPT_PEACE", 0, 0, 0, { pre: 1 }).refused, "an incoming deal with no terms is not answered");
});

// ---- specialists (a PLAYER operation taking a plot INDEX, not a city one taking x/y)
function withSpecialists(g, { slots = null, assignable = [489], applied = true, ready = true } = {}) {
  withCity(g, {});
  g.Players.get(1).Cities.getCities()[0].Growth = { isReadyToPlacePopulation: ready };
  g.GameInfo.Yields = [{ $hash: 1, YieldType: "YIELD_FOOD" }, { $hash: 2, YieldType: "YIELD_SCIENCE" }];
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_HILL" }]);
  g.GameplayMap = { ...(g.GameplayMap || {}), getIndexFromXY: (x, y) => y * 100 + x, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }), getTerrainType: () => 1, getFeatureType: () => -1, isRiver: () => false, getYield: () => 0 };
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, ASSIGN_WORKER: 9201 };
  const rows = slots ?? [
    { PlotIndex: 489, CityID: 65536, NumWorkers: 0, MaxWorkers: 1, IsBlocked: false, CurrentYields: [0, 0], NextYields: [0, 2], CurrentMaintenance: [0, 0], NextMaintenance: [1, 0] },
    { PlotIndex: 490, CityID: 65536, NumWorkers: 0, MaxWorkers: 1, IsBlocked: true, CurrentYields: [0, 0], NextYields: [0, 3], CurrentMaintenance: [0, 0], NextMaintenance: [1, 0] },
  ];
  const city = g.Players.get(1).Cities.getCities()[0];
  city.Workers = { GetAllPlacementInfo: () => rows, getCityWorkerCap: () => 2, getNumWorkers: () => 0 };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op !== 9201) return inner.canStart(pid, op, args, show);
      g._log.push(`wcanStart(${pid},${op},${JSON.stringify(args)},${show})`);
      return { Success: pid === 1 && assignable.includes(args.Location) };
    },
    sendRequest: (pid, op, args) => {
      if (op !== 9201) return inner.sendRequest(pid, op, args);
      g._log.push(`wsendRequest(${pid},${op},${JSON.stringify(args)})`);
      if (applied) { const r = rows.find((q) => q.PlotIndex === args.Location); if (r) r.NumWorkers += 1; }
    },
  };
  return g;
}

test("specialist offers name the plot index, the yields it would add and the upkeep it would cost", () => {
  const log = [];
  const g = withSpecialists(withUnits(world({ log }), [])); g._log = log;
  const sp = runOffers(g).offers.filter((o) => o.kind === "ASSIGN_WORKER");
  assert.deepEqual(sp.map((o) => [o.arg, o.arg2, o.pre, o.plotIndex, o.x, o.y, o.maxWorkers, o.cityWorkerCap, o.terrainKey]),
    [[65536, 489, 0, 489, 89, 4, 1, 2, "TERRAIN_HILL"]]);
  assert.deepEqual(sp[0].yields, {});
  assert.deepEqual(sp[0].yieldsNext, { science: 2 });
  assert.deepEqual(sp[0].upkeepNext, { food: 1 });
  assert.ok(!log.some((e) => e.startsWith("wsendRequest")));
});

test("specialists are offered only while the settlement has a population point to place", () => {
  const g = withSpecialists(withUnits(world({ log: [] }), []), { ready: false }); g._log = [];
  assert.deepEqual(runOffers(g).offers.filter((o) => o.kind === "ASSIGN_WORKER"), [], "the engine accepts and then drops the request without one");
  const rr = runPerformArgs(g, "ASSIGN_WORKER", 65536, 489, 0, { pre: 0 });
  assert.ok(rr.refused && !g._log.some((e) => e.startsWith("wsendRequest")));
});

test("a blocked plot and a plot the engine refuses are both withheld", () => {
  const log = [];
  const g = withSpecialists(withUnits(world({ log }), [])); g._log = log;
  assert.ok(!runOffers(g).offers.some((o) => o.kind === "ASSIGN_WORKER" && o.arg2 === 490), "blocked plot offered");
  const none = withSpecialists(withUnits(world({ log: [] }), []), { assignable: [] }); none._log = [];
  assert.deepEqual(runOffers(none).offers.filter((o) => o.kind === "ASSIGN_WORKER"), []);
});

test("perform ASSIGN_WORKER sends the plot index as a player operation and reads the plot's workers back", () => {
  const log = [];
  const g = withSpecialists(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "ASSIGN_WORKER", 65536, 489, 0, { pre: 0 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "ASSIGN_WORKER", arg: 65536, plotIndex: 489, workersBefore: 0, workers: 1, matches: true });
  assert.ok(log.find((e) => e.startsWith("wsendRequest(") && e.includes('"Location":489,"Amount":1')));
});

test("perform ASSIGN_WORKER refuses an unknown settlement, a foreign plot, a blocked plot, a changed count and a refused check", () => {
  for (const [label, mk, cid, plot, pre] of [
    ["unknown settlement", () => withSpecialists(withUnits(world({ log: [] }), [])), 7, 489, 0],
    ["plot this city cannot work", () => withSpecialists(withUnits(world({ log: [] }), [])), 65536, 4242, 0],
    ["blocked plot", () => withSpecialists(withUnits(world({ log: [] }), []), { assignable: [489, 490] }), 65536, 490, 0],
    ["count changed", () => withSpecialists(withUnits(world({ log: [] }), [])), 65536, 489, 3],
    ["canStart false", () => withSpecialists(withUnits(world({ log: [] }), []), { assignable: [] }), 65536, 489, 0],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "ASSIGN_WORKER", cid, plot, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("wsendRequest")), `${label}: must not send`);
  }
  const none = withSpecialists(withUnits(world({ log: [] }), []), { applied: false }); none._log = [];
  const rr = runPerformArgs(none, "ASSIGN_WORKER", 65536, 489, 0, { pre: 0 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- disbanding a unit (destructive; the engine raises its own confirmation flag)
function withDisband(g, { deletable = [5], gone = true } = {}) {
  g.UnitCommandTypes = { ...(g.UnitCommandTypes || {}), DELETE: 6660 };
  const me = g.Players.get(1);
  const inner = g.Game.UnitCommands;
  g.Game.UnitCommands = {
    canStart: (uid, cmd, args, show) => {
      if (cmd !== 6660) return inner ? inner.canStart(uid, cmd, args, show) : { Success: false };
      g._log.push(`delcanStart(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)},${show})`);
      return deletable.includes(uid.id)
        ? { Success: true, RequiresConfirmation: true, ConfirmDialogBody: ["Are you sure you want to delete Scout?"] }
        : { Success: false };
    },
    sendRequest: (uid, cmd, args) => {
      if (cmd !== 6660) return inner ? inner.sendRequest(uid, cmd, args) : undefined;
      g._log.push(`delsendRequest(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)})`);
      if (gone) { const kept = me.Units.getUnits().filter((u) => u.id.id !== uid.id); me.Units = { getUnits: () => kept }; }
    },
  };
  return g;
}

test("a disband offer carries the engine's own confirmation flag and warning text", () => {
  const log = [];
  const g = withDisband(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const dis = runOffers(g).offers.filter((o) => o.kind === "DISBAND_UNIT");
  assert.deepEqual(dis.map((o) => [o.arg, o.unitId, o.destructive, o.requiresConfirmation, o.warning, o.pre]),
    [[5, 5, true, true, ["Are you sure you want to delete Scout?"], 1]]);
  assert.ok(!log.some((e) => e.startsWith("delsendRequest")), "enumeration must never disband anything");
});

test("perform DISBAND_UNIT removes the unit and reads back that it is gone", () => {
  const log = [];
  const g = withDisband(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "DISBAND_UNIT", 5, 0, 0, { pre: 1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "DISBAND_UNIT", arg: 5, unitsBefore: 1, gone: true, matches: true });
  assert.ok(log.find((e) => e.startsWith("delsendRequest(") && e.includes("6660")));
  assert.ok(log.find((e) => e.startsWith("delsendRequest(") && e.includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1')), "the shipped no-target argument shape");
});

test("perform DISBAND_UNIT refuses an unknown unit, a changed roster and a refused check without sending", () => {
  for (const [label, mk, uid, pre] of [
    ["unknown unit", () => withDisband(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 9, 1],
    ["roster changed", () => withDisband(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 5, 4],
    ["canStart false", () => withDisband(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { deletable: [] }), 5, 1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "DISBAND_UNIT", uid, 0, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("delsendRequest")), `${label}: must not send`);
  }
  const stays = withDisband(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { gone: false }); stays._log = [];
  const rr = runPerformArgs(stays, "DISBAND_UNIT", 5, 0, 0, { pre: 1 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- city projects (a third thing the build queue can hold; no plot, no gold)
function withProjects(g, { startable = [301] } = {}) {
  withBuildings(g, {});
  const rows = [{ $hash: 301, ProjectType: "PROJECT_CITY_SCIENCE_PROJECT", Name: "LOC_SCIENCE_PROJECT", Description: "LOC_SCIENCE_DESC" },
                { $hash: 302, ProjectType: "PROJECT_CITY_CULTURE_PROJECT", Name: "LOC_CULTURE_PROJECT", Description: "LOC_CULTURE_DESC" }];
  g.GameInfo.Projects = table(rows); g.GameInfo.Projects[Symbol.iterator] = function* () { yield* rows; };
  const city = g.Players.get(1).Cities.getCities()[0];
  const inner = g.Game.CityOperations;
  g.Game.CityOperations = {
    canStart: (cid, op, args, show) => {
      if (args.ProjectType === undefined) return inner.canStart(cid, op, args, show);
      g._log.push(`prcanStart(${JSON.stringify(cid)},${op},${JSON.stringify(args)},${show})`);
      return { Success: cid.owner === 1 && startable.includes(args.ProjectType) };
    },
    sendRequest: (cid, op, args) => {
      if (args.ProjectType === undefined) return inner.sendRequest(cid, op, args);
      g._log.push(`prsendRequest(${JSON.stringify(cid)},${op},${JSON.stringify(args)})`);
      city.BuildQueue._q.push({ type: args.ProjectType, kind: 3 });
    },
  };
  return g;
}

test("project offers list only the projects the native BUILD check accepts, with the queue they would join", () => {
  const log = [];
  const g = withProjects(withUnits(world({ log }), [])); g._log = log;
  const projects = runOffers(g).offers.filter((o) => o.kind === "PRODUCE_PROJECT");
  assert.deepEqual(projects.map((o) => [o.arg, o.arg2, o.typeKey, o.displayName, o.description, o.pre, o.queueLength]),
    [[65536, 301, "PROJECT_CITY_SCIENCE_PROJECT", "LOC_SCIENCE_PROJECT", "LOC_SCIENCE_DESC", 0, 0]]);
  assert.ok(!log.some((e) => e.startsWith("prsendRequest")));
});

test("perform PRODUCE_PROJECT enqueues the project and reads it back at the offered position", () => {
  const log = [];
  const g = withProjects(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "PRODUCE_PROJECT", 65536, 301, 0, { pre: 0 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "PRODUCE_PROJECT", arg: 65536, projectType: 301, queuedAt: 0, queueLength: 1, matches: true });
  assert.ok(log.find((e) => e.startsWith("prsendRequest(") && e.includes('"ProjectType":301')));
});

test("perform PRODUCE_PROJECT refuses an unknown city, a non-project, a changed queue and a refused check", () => {
  for (const [label, mk, cid, pt, pre] of [
    ["unknown city", () => withProjects(withUnits(world({ log: [] }), [])), 7, 301, 0],
    ["not a project", () => withProjects(withUnits(world({ log: [] }), [])), 65536, 4242, 0],
    ["queue changed", () => withProjects(withUnits(world({ log: [] }), [])), 65536, 301, 2],
    ["canStart false", () => withProjects(withUnits(world({ log: [] }), []), { startable: [] }), 65536, 301, 0],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "PRODUCE_PROJECT", cid, pt, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("prsendRequest")), `${label}: must not send`);
  }
});

// ---- standing research and civic goals
function withTreeGoals(g, { techTarget = -1, civicTarget = -1, acceptable = [701, 702, 801], applied = true } = {}) {
  const me = g.Players.get(1);
  me.Techs.getTargetNode = () => techTarget;
  me.Culture.getTargetNode = () => civicTarget;
  me.Techs.getTreeType = () => 500;
  me.Culture.getActiveTree = () => 600;
  g.GameInfo.ProgressionTrees = table([{ $hash: 500, ProgressionTreeType: "TREE_TECHS_AQ" }, { $hash: 600, ProgressionTreeType: "TREE_CIVICS_AQ_MAIN" }]);
  const nodeRows = [{ $hash: 701, ProgressionTreeNodeType: "NODE_TECH_AQ_POTTERY", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_P" },
                    { $hash: 702, ProgressionTreeNodeType: "NODE_TECH_AQ_WRITING", ProgressionTree: "TREE_TECHS_AQ", Name: "LOC_W" },
                    { $hash: 801, ProgressionTreeNodeType: "NODE_CIVIC_AQ_MAIN_MYSTICISM", ProgressionTree: "TREE_CIVICS_AQ_MAIN", Name: "LOC_M" }];
  g.GameInfo.ProgressionTreeNodes = table(nodeRows);
  g.GameInfo.ProgressionTreeNodes[Symbol.iterator] = function* () { yield* nodeRows; };
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, SET_TECH_TREE_TARGET_NODE: 9101, SET_CULTURE_TREE_TARGET_NODE: 9102 };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op === 9101 || op === 9102) { g._log.push(`tcanStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: pid === 1 && acceptable.includes(args.ProgressionTreeNodeType) }; }
      return inner.canStart(pid, op, args, show);
    },
    sendRequest: (pid, op, args) => {
      if (op === 9101 || op === 9102) { g._log.push(`tsendRequest(${pid},${op},${JSON.stringify(args)})`); if (applied) { if (op === 9101) me.Techs.getTargetNode = () => args.ProgressionTreeNodeType; else me.Culture.getTargetNode = () => args.ProgressionTreeNodeType; } return; }
      return inner.sendRequest(pid, op, args);
    },
  };
  return g;
}

test("goal offers list every node in the seat's own tree the engine accepts as a target, with its cost", () => {
  const log = [];
  const g = withTreeGoals(withUnits(world({ log }), [])); g._log = log;
  const r = runOffers(g);
  assert.deepEqual(r.offers.filter((o) => o.kind === "SET_TECH_TREE_TARGET_NODE").map((o) => [o.arg, o.typeKey, o.tree, o.cost, o.turns, o.pre]),
    [[701, "NODE_TECH_AQ_POTTERY", "TREE_TECHS_AQ", 60, 4, -1], [702, "NODE_TECH_AQ_WRITING", "TREE_TECHS_AQ", 100, 7, -1]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "SET_CULTURE_TREE_TARGET_NODE").map((o) => [o.arg, o.typeKey, o.tree]),
    [[801, "NODE_CIVIC_AQ_MAIN_MYSTICISM", "TREE_CIVICS_AQ_MAIN"]]);
  assert.ok(!log.some((e) => e.startsWith("tsendRequest")));
});

test("the node that is already the standing goal is not offered again", () => {
  const log = [];
  const g = withTreeGoals(withUnits(world({ log }), []), { techTarget: 701 }); g._log = log;
  const goals = runOffers(g).offers.filter((o) => o.kind === "SET_TECH_TREE_TARGET_NODE");
  assert.deepEqual(goals.map((o) => [o.arg, o.pre, o.currentTarget]), [[702, 701, 701]]);
});

test("perform SET_TECH_TREE_TARGET_NODE sends the goal and reads back the node the engine now holds", () => {
  const log = [];
  const g = withTreeGoals(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "SET_TECH_TREE_TARGET_NODE", 702, 0, 0, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "SET_TECH_TREE_TARGET_NODE", arg: 702, targetNode: 702, matches: true });
  assert.ok(log.find((e) => e.startsWith("tsendRequest(") && e.includes("9101") && e.includes('"ProgressionTreeNodeType":702')));
  const civ = withTreeGoals(withUnits(world({ log: [] }), [])); civ._log = [];
  const rc = runPerformArgs(civ, "SET_CULTURE_TREE_TARGET_NODE", 801, 0, 0, { pre: -1 });
  assert.deepEqual(rc.readback, { kind: "SET_CULTURE_TREE_TARGET_NODE", arg: 801, targetNode: 801, matches: true });
});

test("perform of a goal refuses a node the engine will not target and a goal that changed since the offer", () => {
  for (const [label, mk, node, pre] of [
    ["not targetable", () => withTreeGoals(withUnits(world({ log: [] }), []), { acceptable: [] }), 702, -1],
    ["goal changed", () => withTreeGoals(withUnits(world({ log: [] }), []), { techTarget: 701 }), 702, -1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "SET_TECH_TREE_TARGET_NODE", node, 0, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("tsendRequest")), `${label}: must not send`);
  }
  const none = withTreeGoals(withUnits(world({ log: [] }), []), { applied: false }); none._log = [];
  const rr = runPerformArgs(none, "SET_TECH_TREE_TARGET_NODE", 702, 0, 0, { pre: -1 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- founding a religion and adding beliefs
function withReligion(g, { held = -1, beliefs = [], open = [35560851], beliefsOk = [777], applied = true } = {}) {
  const me = g.Players.get(1);
  let heldBeliefs = beliefs.slice();
  me.Religion = { getReligionType: () => held, getBeliefs: () => heldBeliefs };
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, FOUND_RELIGION: 9501, ADD_BELIEF: 9502 };
  const religions = [{ $hash: 35560851, ReligionType: "RELIGION_BUDDHISM", Name: "LOC_BUD" }, { $hash: 1816441899, ReligionType: "RELIGION_CATHOLICISM", Name: "LOC_CATH" }, { $hash: -547366190, ReligionType: "RELIGION_CUSTOM_1", Name: "LOC_CUSTOM", RequiresCustomName: true }];
  g.GameInfo.Religions = table(religions); g.GameInfo.Religions[Symbol.iterator] = function* () { yield* religions; };
  const beliefRows = [{ $hash: 777, BeliefType: "BELIEF_BONUS_1", BeliefClassType: "BELIEF_CLASS_ENHANCER", Name: "LOC_B1", Description: "LOC_B1_D" }, { $hash: 778, BeliefType: "BELIEF_BONUS_2", BeliefClassType: "BELIEF_CLASS_FOUNDER", Name: "LOC_B2", Description: "LOC_B2_D" }];
  g.GameInfo.Beliefs = table(beliefRows); g.GameInfo.Beliefs[Symbol.iterator] = function* () { yield* beliefRows; };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op === 9501) { g._log.push(`relcanStart(${JSON.stringify(args)})`); return { Success: pid === 1 && open.includes(args.ReligionType) }; }
      if (op === 9502) { g._log.push(`belcanStart(${JSON.stringify(args)})`); return { Success: pid === 1 && beliefsOk.includes(args.BeliefType) }; }
      return inner.canStart(pid, op, args, show);
    },
    sendRequest: (pid, op, args) => {
      if (op === 9501) { g._log.push(`relsendRequest(${JSON.stringify(args)})`); if (applied) me.Religion.getReligionType = () => args.ReligionType; return; }
      if (op === 9502) { g._log.push(`belsendRequest(${JSON.stringify(args)})`); if (applied) heldBeliefs = heldBeliefs.concat([args.BeliefType]); return; }
      return inner.sendRequest(pid, op, args);
    },
  };
  return g;
}

test("religion offers list the named religions the engine still allows and never the custom ones; beliefs only once a religion is held", () => {
  const g = withReligion(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runOffers(g);
  assert.deepEqual(r.offers.filter((o) => o.kind === "FOUND_RELIGION").map((o) => [o.arg, o.typeKey, o.pre]), [[35560851, "RELIGION_BUDDHISM", -1]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "ADD_BELIEF"), [], "no beliefs before a religion exists");
  const h = withReligion(withUnits(world({ log: [] }), []), { held: 35560851 }); h._log = [];
  const rh = runOffers(h);
  assert.deepEqual(rh.offers.filter((o) => o.kind === "FOUND_RELIGION"), [], "a seat with a religion is not offered another");
  assert.deepEqual(rh.offers.filter((o) => o.kind === "ADD_BELIEF").map((o) => [o.arg, o.beliefClass, o.pre]), [[777, "ENHANCER", 0]]);
});

test("perform FOUND_RELIGION and ADD_BELIEF confirm on the religion held and the belief count rising", () => {
  const g = withReligion(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runPerformArgs(g, "FOUND_RELIGION", 35560851, 0, 0, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "FOUND_RELIGION", arg: 35560851, religion: 35560851, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("relsendRequest(") && e.includes('"ReligionType":35560851')));
  const h = withReligion(withUnits(world({ log: [] }), []), { held: 35560851 }); h._log = [];
  const rb = runPerformArgs(h, "ADD_BELIEF", 777, 0, 0, { pre: 0 });
  assert.deepEqual(rb.readback, { kind: "ADD_BELIEF", arg: 777, beliefsBefore: 0, held: [777], matches: true });
  for (const [label, mk, kind, arg, pre] of [
    ["not a religion", () => withReligion(withUnits(world({ log: [] }), [])), "FOUND_RELIGION", 4242, -1],
    ["religion changed", () => withReligion(withUnits(world({ log: [] }), []), { held: 35560851 }), "FOUND_RELIGION", 1816441899, -1],
    ["engine refuses religion", () => withReligion(withUnits(world({ log: [] }), []), { open: [] }), "FOUND_RELIGION", 35560851, -1],
    ["beliefs changed", () => withReligion(withUnits(world({ log: [] }), []), { held: 35560851, beliefs: [778, 779] }), "ADD_BELIEF", 777, 0],
    ["engine refuses belief", () => withReligion(withUnits(world({ log: [] }), []), { held: 35560851, beliefsOk: [] }), "ADD_BELIEF", 777, 0],
  ]) {
    const x = mk(); x._log = [];
    assert.ok(runPerformArgs(x, kind, arg, 0, 0, { pre }).refused, `${label}: expected refusal`);
    assert.ok(!x._log.some((e) => e.includes("sendRequest")), `${label}: must not send`);
  }
});

// ---- answering another civilization's proposal
function withProposal(g, { events = null, answerable = [16], closesAfter = true } = {}) {
  withDiplomacy(g, {});
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, RESPOND_DIPLOMATIC_ACTION: 9401 };
  g.DiplomaticResponseTypes = { INVALID_RESPONSE: -1, DIPLOMACY_RESPONSE_ACCEPT: 926305338, DIPLOMACY_RESPONSE_REJECT: 567527351 };
  const rows = events ?? [
    { uniqueID: 16, actionType: 9001, actionTypeName: "DIPLOMACY_ACTION_OPEN_BORDERS", name: "LOC_OPEN_BORDERS", description: "LOC_OB_DESC", initialPlayer: 0, targetPlayer: 1, responseType: -1 },
    { uniqueID: 17, actionType: 9002, actionTypeName: "DIPLOMACY_ACTION_DENOUNCE", name: "LOC_DENOUNCE", description: "LOC_D_DESC", initialPlayer: 1, targetPlayer: 0, responseType: -1 },
    { uniqueID: 18, actionType: 9001, actionTypeName: "DIPLOMACY_ACTION_OPEN_BORDERS", name: "LOC_OPEN_BORDERS", description: "LOC_OB_DESC", initialPlayer: 0, targetPlayer: 1, responseType: 926305338 },
  ];
  let open = new Set(answerable);
  g.Game.Diplomacy.getPlayerEvents = (pid) => { g._log.push(`events(${pid})`); return rows; };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op !== 9401) return inner.canStart(pid, op, args, show);
      g._log.push(`rcanStart(${pid},${JSON.stringify(args)},${show})`);
      return { Success: pid === 1 && open.has(args.ID) };
    },
    sendRequest: (pid, op, args) => {
      if (op !== 9401) return inner.sendRequest(pid, op, args);
      g._log.push(`rsendRequest(${pid},${JSON.stringify(args)})`);
      if (closesAfter) { const ev = rows.find((r) => r.uniqueID === args.ID); if (ev) ev.responseType = args.Type; }
    },
  };
  return g;
}

test("each pending proposal aimed at this seat is offered twice, to accept and to reject, naming the proposer; the seat's own proposals are not", () => {
  const log = [];
  const g = withProposal(withUnits(world({ log }), [])); g._log = log;
  const rs = runOffers(g).offers.filter((o) => o.kind === "RESPOND_DIPLOMATIC_ACTION");
  assert.deepEqual(rs.map((o) => [o.arg, o.arg2, o.answer, o.typeKey, o.proposerPlayerId, o.proposerName, o.pre]),
    [[16, 926305338, "accept", "DIPLOMACY_ACTION_OPEN_BORDERS", 0, "LOC_ABBASID", 1],
     [16, 567527351, "reject", "DIPLOMACY_ACTION_OPEN_BORDERS", 0, "LOC_ABBASID", 1]]);
  assert.ok(!rs.some((o) => o.arg === 17), "an event this seat started is not something it answers");
  assert.ok(!rs.some((o) => o.arg === 18), "an event already answered is not offered again, even though the engine's check still accepts one");
  assert.ok(!log.some((e) => e.startsWith("rsendRequest")));
});

test("perform RESPOND_DIPLOMATIC_ACTION sends the event id and response type, and confirms once the engine will no longer take an answer", () => {
  const log = [];
  const g = withProposal(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "RESPOND_DIPLOMATIC_ACTION", 16, 926305338, 0, { pre: 1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "RESPOND_DIPLOMATIC_ACTION", arg: 16, response: 926305338, recordedResponse: 926305338, matches: true });
  assert.ok(log.find((e) => e.startsWith("rsendRequest(") && e.includes('"ID":16,"Type":926305338')));
  for (const [label, mk, id, type] of [
    ["not pending", () => withProposal(withUnits(world({ log: [] }), [])), 99, 926305338],
    ["seat's own event", () => withProposal(withUnits(world({ log: [] }), [])), 17, 926305338],
    ["already answered", () => withProposal(withUnits(world({ log: [] }), []), { answerable: [16, 18] }), 18, 926305338],
    ["not accept or reject", () => withProposal(withUnits(world({ log: [] }), [])), 16, 4242],
    ["engine refuses", () => withProposal(withUnits(world({ log: [] }), []), { answerable: [] }), 16, 926305338],
  ]) {
    const h = mk(); const l = []; h._log = l;
    assert.ok(runPerformArgs(h, "RESPOND_DIPLOMATIC_ACTION", id, type, 0, { pre: 1 }).refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("rsendRequest")), `${label}: must not send`);
  }
  const stays = withProposal(withUnits(world({ log: [] }), []), { closesAfter: false }); stays._log = [];
  const rr = runPerformArgs(stays, "RESPOND_DIPLOMATIC_ACTION", 16, 567527351, 0, { pre: 1 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- a just-captured settlement: keep, raze or liberate
function withCapture(g, { pending = true, allowed = [0, 2, 3], after = "keep" } = {}) {
  withCity(g, {});
  const city = g.Players.get(1).Cities.getCities()[0];
  city.isJustConqueredFrom = pending; city.isBeingRazed = false; city.population = 7;
  city.Constructibles = { getNumWonders: () => 1 };
  g.CityCommandTypes = { ...(g.CityCommandTypes || {}), DESTROY: 7770 };
  const me = g.Players.get(1);
  g.Game.CityCommands = {
    canStart: (cid, cmd, args, show) => { g._log.push(`dcanStart(${cmd},${JSON.stringify(args)})`); return { Success: cmd === 7770 && cid.owner === 1 && allowed.includes(args.Directive) }; },
    sendRequest: (cid, cmd, args) => {
      g._log.push(`dsendRequest(${cmd},${JSON.stringify(args)})`);
      if (after === "keep") { city.isJustConqueredFrom = false; }
      if (after === "raze") { city.isJustConqueredFrom = false; city.isBeingRazed = true; }
      if (after === "liberate") { me.Cities = { getCities: () => [] }; }
    },
  };
  return g;
}

test("a just-captured settlement is offered keep, raze and liberate, the last two needing confirmation", () => {
  const g = withCapture(withUnits(world({ log: [] }), [])); g._log = [];
  const caps = runOffers(g).offers.filter((o) => ["KEEP_CITY", "RAZE_CITY", "LIBERATE_CITY"].includes(o.kind));
  assert.deepEqual(caps.map((o) => [o.kind, o.arg, o.population, o.wonders, o.requiresConfirmation]), [["KEEP_CITY", 65536, 7, 1, undefined], ["RAZE_CITY", 65536, 7, 1, true], ["LIBERATE_CITY", 65536, 7, 1, true]]);
  const settled = withCapture(withUnits(world({ log: [] }), []), { pending: false }); settled._log = [];
  assert.deepEqual(runOffers(settled).offers.filter((o) => ["KEEP_CITY", "RAZE_CITY", "LIBERATE_CITY"].includes(o.kind)), []);
  const noRaze = withCapture(withUnits(world({ log: [] }), []), { allowed: [0, 2] }); noRaze._log = [];
  assert.ok(!runOffers(noRaze).offers.some((o) => o.kind === "RAZE_CITY"), "a directive the engine refuses is not offered");
});

test("perform of each disposition sends DESTROY with its directive and reads back the city's fate", () => {
  for (const [kind, directive, after, expect] of [["KEEP_CITY", 2, "keep", { stillPending: false, razing: false, stillOwned: true }], ["RAZE_CITY", 3, "raze", { stillPending: false, razing: true, stillOwned: true }], ["LIBERATE_CITY", 0, "liberate", { stillPending: null, razing: null, stillOwned: false }]]) {
    const g = withCapture(withUnits(world({ log: [] }), []), { after }); g._log = [];
    const r = runPerformArgs(g, kind, 65536, 0, 0, { pre: 1 });
    assert.equal(r.refused, null, kind);
    assert.deepEqual(r.readback, { kind, arg: 65536, directive, ...expect, matches: true }, kind);
    assert.ok(g._log.find((e) => e.startsWith("dsendRequest(") && e.includes(`"Directive":${directive}`)));
  }
  for (const [label, mk, cid] of [["unknown city", () => withCapture(withUnits(world({ log: [] }), [])), 7], ["already decided", () => withCapture(withUnits(world({ log: [] }), []), { pending: false }), 65536], ["engine refuses", () => withCapture(withUnits(world({ log: [] }), []), { allowed: [] }), 65536]]) {
    const h = mk(); h._log = [];
    assert.ok(runPerformArgs(h, "RAZE_CITY", cid, 0, 0, { pre: 1 }).refused, label);
    assert.ok(!h._log.some((e) => e.startsWith("dsendRequest")), label);
  }
});

// ---- a city-state bonus
function withCityStateBonus(g, { pending = 12, bonuses = ["CITY_STATE_BONUS_A", "CITY_STATE_BONUS_B"], canHave = ["CITY_STATE_BONUS_A"], applied = true } = {}) {
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, CHOOSE_CITY_STATE_BONUS: 9601 };
  const rows = bonuses.map((b, i) => ({ $hash: 5000 + i, CityStateBonusType: b, Name: "LOC_" + b, Description: "LOC_" + b + "_D" }));
  g.GameInfo.CityStateBonuses = table(rows); g.GameInfo.CityStateBonuses[Symbol.iterator] = function* () { yield* rows; };
  let pend = pending;
  g.Game.CityStates = { getCityStateBonusToSelect: (pid) => pend, canHaveBonus: (pid, cs, type) => canHave.includes(type) };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 9601) return inner.canStart(pid, op, args, show); g._log.push(`bcanStart(${JSON.stringify(args)})`); return { Success: pid === 1 && args.OtherPlayer === pend }; },
    sendRequest: (pid, op, args) => { if (op !== 9601) return inner.sendRequest(pid, op, args); g._log.push(`bsendRequest(${JSON.stringify(args)})`); if (applied) pend = -1; },
  };
  return g;
}

test("a pending city-state bonus offers only the bonuses the engine says this seat can have", () => {
  const g = withCityStateBonus(withUnits(world({ log: [] }), [])); g._log = [];
  const bs = runOffers(g).offers.filter((o) => o.kind === "CHOOSE_CITY_STATE_BONUS");
  assert.deepEqual(bs.map((o) => [o.arg, o.arg2, o.pre, o.typeKey, o.cityStatePlayerId]), [[5000, 12, 12, "CITY_STATE_BONUS_A", 12]]);
  const none = withCityStateBonus(withUnits(world({ log: [] }), []), { pending: -1 }); none._log = [];
  assert.deepEqual(runOffers(none).offers.filter((o) => o.kind === "CHOOSE_CITY_STATE_BONUS"), []);
});

test("perform CHOOSE_CITY_STATE_BONUS sends the city-state and the bonus hash and confirms when nothing is pending for it", () => {
  const g = withCityStateBonus(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runPerformArgs(g, "CHOOSE_CITY_STATE_BONUS", 5000, 12, 0, { pre: 12 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CHOOSE_CITY_STATE_BONUS", arg: 5000, cityState: 12, pendingAfter: -1, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("bsendRequest(") && e.includes('"OtherPlayer":12,"CityStateBonusType":5000')));
  const stale = withCityStateBonus(withUnits(world({ log: [] }), []), { pending: 13 }); stale._log = [];
  assert.ok(runPerformArgs(stale, "CHOOSE_CITY_STATE_BONUS", 5000, 12, 0, { pre: 12 }).refused);
  const bogus = withCityStateBonus(withUnits(world({ log: [] }), [])); bogus._log = [];
  assert.ok(runPerformArgs(bogus, "CHOOSE_CITY_STATE_BONUS", 4242, 12, 0, { pre: 12 }).refused);
});

// ---- supporting a side of an ongoing diplomatic action
function withSupport(g, { events = [{ uniqueID: 16, actionTypeName: "DIPLOMACY_ACTION_GIVE_INFLUENCE_TOKEN", name: "LOC_BEFRIEND", initialPlayer: 1, targetPlayer: 40, support: 1 }], sides = [true], influence = 300, spend = 60 } = {}) {
  const me = g.Players.get(1);
  me.DiplomacyTreasury = { diplomacyBalance: influence };
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, SUPPORT_DIPLOMATIC_ACTION: 9701 };
  g.DiplomacyTokenTypes = { DIPLOMACY_TOKEN_GLOBAL: 77 };
  g.Game.Diplomacy = { ...(g.Game.Diplomacy || {}), getPlayerEvents: (pid) => events, getInfluenceForNextSupport: (id, pid, side) => 60 };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 9701) return inner.canStart(pid, op, args, show); g._log.push(`scanStart(${JSON.stringify(args)})`); return { Success: pid === 1 && sides.includes(args.SubType) }; },
    sendRequest: (pid, op, args) => { if (op !== 9701) return inner.sendRequest(pid, op, args); g._log.push(`ssendRequest(${JSON.stringify(args)})`); me.DiplomacyTreasury = { diplomacyBalance: influence - spend }; },
  };
  return g;
}

test("support offers list each side the engine allows for the seat's own events, with the token's influence cost", () => {
  const g = withSupport(withUnits(world({ log: [] }), [])); g._log = [];
  const sp = runOffers(g).offers.filter((o) => o.kind === "SUPPORT_DIPLOMATIC_ACTION");
  assert.deepEqual(sp.map((o) => [o.arg, o.arg2, o.side, o.cost, o.pre, o.affordable, o.initiatorPlayerId, o.targetPlayerId]), [[16, 1, "initiator", 60, 300, true, 1, 40]]);
  const both = withSupport(withUnits(world({ log: [] }), []), { sides: [true, false] }); both._log = [];
  assert.deepEqual(runOffers(both).offers.filter((o) => o.kind === "SUPPORT_DIPLOMATIC_ACTION").map((o) => o.side), ["initiator", "target"]);
});

test("perform SUPPORT_DIPLOMATIC_ACTION sends one global token for the chosen side and confirms on influence spent", () => {
  const g = withSupport(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runPerformArgs(g, "SUPPORT_DIPLOMATIC_ACTION", 16, 1, 0, { pre: 300 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "SUPPORT_DIPLOMATIC_ACTION", arg: 16, side: "initiator", influenceBefore: 300, influence: 240, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("ssendRequest(") && e.includes('"ID":16,"Type":77,"Amount":1,"SubType":true')));
  for (const [label, mk, id, side, pre] of [["event gone", () => withSupport(withUnits(world({ log: [] }), []), { events: [] }), 16, 1, 300], ["influence moved", () => withSupport(withUnits(world({ log: [] }), [])), 16, 1, 200], ["side refused", () => withSupport(withUnits(world({ log: [] }), [])), 16, 0, 300]]) {
    const h = mk(); h._log = [];
    assert.ok(runPerformArgs(h, "SUPPORT_DIPLOMATIC_ACTION", id, side, 0, { pre }).refused, label);
    assert.ok(!h._log.some((e) => e.startsWith("ssendRequest")), label);
  }
});

// ---- acknowledging an advisor warning
function withAdvisorWarning(g, { ids = [[900, 3]], ok = true, clears = true } = {}) {
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, VIEWED_ADVISOR_WARNING: 9801 };
  let live = ids.map(([id, type]) => ({ owner: 1, id, type }));
  g.Game.Notifications = { ...g.Game.Notifications, getIdsForPlayer: () => live, find: (nid) => ({ Type: nid.type }), getTypeName: (t) => (t === 3 ? "NOTIFICATION_ADVISOR_WARNING_MILITARY" : "NOTIFICATION_OTHER"), getEndTurnBlockingType: () => 0 };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 9801) return inner.canStart(pid, op, args, show); g._log.push(`acanStart(${JSON.stringify(args)})`); return { Success: ok && pid === 1 }; },
    sendRequest: (pid, op, args) => { if (op !== 9801) return inner.sendRequest(pid, op, args); g._log.push(`asendRequest(${JSON.stringify(args)})`); if (clears) live = live.filter((n) => n.id !== args.Target.id); },
  };
  return g;
}

test("an advisor warning is offered for acknowledgement and confirmed by its notification leaving", () => {
  const g = withAdvisorWarning(withUnits(world({ log: [] }), [])); g._log = [];
  const w = runOffers(g).offers.filter((o) => o.kind === "VIEWED_ADVISOR_WARNING");
  assert.deepEqual(w.map((o) => [o.arg, o.arg2, o.typeKey]), [[900, 3, "NOTIFICATION_ADVISOR_WARNING_MILITARY"]]);
  const r = runPerformArgs(g, "VIEWED_ADVISOR_WARNING", 900, 3, 0, { pre: 1 });
  assert.deepEqual(r.readback, { kind: "VIEWED_ADVISOR_WARNING", arg: 900, gone: true, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("asendRequest(") && e.includes('"Target":{"owner":1,"id":900,"type":3}')));
  const other = withAdvisorWarning(withUnits(world({ log: [] }), []), { ids: [[901, 4]] }); other._log = [];
  assert.deepEqual(runOffers(other).offers.filter((o) => o.kind === "VIEWED_ADVISOR_WARNING"), [], "only advisor warnings");
  const gone = withAdvisorWarning(withUnits(world({ log: [] }), [])); gone._log = [];
  assert.ok(runPerformArgs(gone, "VIEWED_ADVISOR_WARNING", 999, 3, 0, { pre: 1 }).refused);
});

// ---- the six generic unit commands (upgrade, army packing, great person)
function withUnitCommands(g, { ok = ["UPGRADE"], plots = [1011], typeAfter = 100, armyAfter = null, gone = false } = {}) {
  withMap(g, {});
  g.UnitCommandTypes = { ...(g.UnitCommandTypes || {}), UPGRADE: 7001, PACK_ARMY: 7002, ADD_TO_ARMY: 7003, REMOVE_FROM_ARMY: 7004, UNPACK_ARMY: 7005, ACTIVATE_GREAT_PERSON: 7006 };
  const names = { 7001: "UPGRADE", 7002: "PACK_ARMY", 7003: "ADD_TO_ARMY", 7004: "REMOVE_FROM_ARMY", 7005: "UNPACK_ARMY", 7006: "ACTIVATE_GREAT_PERSON" };
  g.GameplayMap = { ...g.GameplayMap, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  g.Armies = { get: (aid) => ({ unitCount: 3 }) };
  const me = g.Players.get(1);
  const u = me.Units.getUnits()[0];
  u.type = 99; u.armyId = { id: -1 };
  const prev = g.Game.UnitCommands;
  g.Game.UnitCommands = {
    canStart: (uid, cmd, args, show) => {
      const name = names[cmd];
      if (!name) return prev ? prev.canStart(uid, cmd, args, show) : { Success: false };
      g._log.push(`ucanStart(${uid.id},${name},${JSON.stringify(args)},${show})`);
      if (!ok.includes(name)) return { Success: false };
      return { Success: true, Plots: plots, AdditionalDescription: name === "UPGRADE" ? "LOC_UPGRADE_INFO" : undefined };
    },
    sendRequest: (uid, cmd, args) => {
      const name = names[cmd];
      if (!name) return prev ? prev.sendRequest(uid, cmd, args) : undefined;
      g._log.push(`usendRequest(${uid.id},${name},${JSON.stringify(args)})`);
      if (name === "UPGRADE") u.type = typeAfter;
      if (name === "ADD_TO_ARMY" && armyAfter !== null) u.armyId = { id: armyAfter };
      if (gone) me.Units = { getUnits: () => [] };
    },
  };
  return g;
}

test("no-target commands are offered once per unit, plot commands once per engine-listed plot, each saying what proves it", () => {
  const log = [];
  const g = withUnitCommands(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: ["UPGRADE", "ADD_TO_ARMY"], plots: [1011, 1012] }); g._log = log;
  const r = runOffers(g);
  assert.deepEqual(r.offers.filter((o) => o.kind === "UPGRADE").map((o) => [o.arg, o.pre, o.expect, o.description, o.arg2]), [[5, 99, "type", "LOC_UPGRADE_INFO", undefined]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "ADD_TO_ARMY").map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.expect]), [[5, 11, 10, -1, "army"], [5, 12, 10, -1, "army"]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "PACK_ARMY"), [], "a command the engine refuses is not offered");
  assert.ok(log.filter((e) => e.startsWith("ucanStart(") && e.includes('"X":-9999')).length >= 1, "the shipped no-target probe shape");
  assert.ok(!log.some((e) => e.startsWith("usendRequest")));
});

test("perform UPGRADE sends the no-target shape and confirms on the unit's type changing", () => {
  const log = [];
  const g = withUnitCommands(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "UPGRADE", 5, 0, 0, { pre: 99 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "UPGRADE", arg: 5, expect: "type", before: 99, after: 100, present: true, matches: true });
  assert.ok(log.find((e) => e.startsWith("usendRequest(") && e.includes("UPGRADE") && e.includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1')));
});

test("perform ADD_TO_ARMY needs a plot and confirms on the unit's army changing; ACTIVATE_GREAT_PERSON confirms on the unit being spent", () => {
  const g = withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: ["ADD_TO_ARMY"], armyAfter: 42 }); g._log = [];
  const r = runPerformArgs(g, "ADD_TO_ARMY", 5, 11, 10, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual([r.readback.before, r.readback.after, r.readback.matches], [-1, 42, true]);
  assert.ok(g._log.find((e) => e.startsWith("usendRequest(") && e.includes('"X":11,"Y":10')));
  const noPlot = withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: ["ADD_TO_ARMY"] }); noPlot._log = [];
  assert.ok(runPerformArgs(noPlot, "ADD_TO_ARMY", 5, -1, -1, { pre: -1 }).refused, "a plot command without a plot is refused");
  const gp = withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: ["ACTIVATE_GREAT_PERSON"], gone: true }); gp._log = [];
  const rg = runPerformArgs(gp, "ACTIVATE_GREAT_PERSON", 5, 11, 10, { pre: 1 });
  assert.deepEqual([rg.readback.present, rg.readback.matches], [false, true]);
});

test("perform of a unit command refuses an unknown unit, a changed state and a refused check without sending", () => {
  for (const [label, mk, kind, uid, pre] of [
    ["unknown unit", () => withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), "UPGRADE", 9, 99],
    ["state changed", () => withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), "UPGRADE", 5, 12],
    ["engine refuses", () => withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: [] }), "UPGRADE", 5, 99],
  ]) {
    const h = mk(); const l = []; h._log = l;
    assert.ok(runPerformArgs(h, kind, uid, 0, 0, { pre }).refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("usendRequest")), `${label}: must not send`);
  }
  const same = withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { typeAfter: 99 }); same._log = [];
  const rr = runPerformArgs(same, "UPGRADE", 5, 0, 0, { pre: 99 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- pillage and spread religion (plot-target operations), a town back to growth, queue edits,
// a tradition out of its slot, resources out or swapped, and wake/cancel (Priority 2)
function withPillage(g, { plots = [1011, 1012], moves = 2, spend = true, spread = false, charges = 3 } = {}) {
  withMap(g, {});
  g.UnitOperationTypes = { ...g.UnitOperationTypes, PILLAGE: 3001, COASTAL_RAID: 3002, PILLAGE_ROUTE: 3003, SPREAD_RELIGION: 3004 };
  g.GameplayMap = { ...g.GameplayMap, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  const u = g.Players.get(1).Units.getUnits()[0];
  u.Movement = { movementMovesRemaining: moves };
  let left = charges;
  u.getActivationOperationPlots = (type, excl) => (type === "UNITOPERATION_SPREAD_RELIGION" ? plots : []);
  const prev = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => {
      if (op === 3001 || op === 3002 || op === 3003) { g._log.push(`pcanStart(${op},${JSON.stringify(args)})`); if (args.X === undefined) return { Success: true, Plots: plots }; return { Success: plots.includes(args.Y * 100 + args.X) }; }
      if (op === 3004) { g._log.push(`rcanStart(${JSON.stringify(args)})`); if (!spread) return { Success: false }; return { Success: args.X === -9999 || plots.includes(args.Y * 100 + args.X), ChargesRemaining: left }; }
      return prev.canStart(uid, op, args, show);
    },
    sendRequest: (uid, op, args) => {
      if (op === 3004) { g._log.push(`rsendRequest(${JSON.stringify(args)})`); if (spend) left -= 1; return; }
      if (op === 3001 || op === 3002 || op === 3003) { g._log.push(`psendRequest(${op},${JSON.stringify(args)})`); if (spend) u.Movement = { movementMovesRemaining: moves - 1 }; return; }
      return prev.sendRequest(uid, op, args);
    },
  };
  return g;
}

test("pillage offers list the plots the engine names and confirm on the unit's moves being spent", () => {
  const g = withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = [];
  const r = runOffers(g);
  assert.deepEqual(r.offers.filter((o) => o.kind === "PILLAGE").map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.movesLeft]), [[5, 11, 10, 2, 2], [5, 12, 10, 2, 2]]);
  assert.equal(r.offers.filter((o) => o.kind === "COASTAL_RAID").length, 2);
  const pr = runPerformArgs(g, "PILLAGE", 5, 11, 10, { pre: 2 });
  assert.deepEqual(pr.readback, { kind: "PILLAGE", arg: 5, target: { x: 11, y: 10 }, before: 2, after: 1, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("psendRequest(3001,") && e.includes('"X":11,"Y":10')));
  for (const [label, mk, x, y, pre] of [["moves changed", () => withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 11, 10, 1], ["plot not listed", () => withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 50, 50, 2]]) {
    const h = mk(); h._log = [];
    assert.ok(runPerformArgs(h, "PILLAGE", 5, x, y, { pre }).refused, label);
    assert.ok(!h._log.some((e) => e.startsWith("psendRequest")), label);
  }
  const stays = withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { spend: false }); stays._log = [];
  assert.equal(runPerformArgs(stays, "PILLAGE", 5, 11, 10, { pre: 2 }).readback.matches, false);
});

test("spreading religion is offered on the unit's activation plots and confirms on a charge being spent", () => {
  const g = withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { spread: true }); g._log = [];
  const sp = runOffers(g).offers.filter((o) => o.kind === "SPREAD_RELIGION");
  assert.deepEqual(sp.map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.charges]), [[5, 11, 10, 3, 3], [5, 12, 10, 3, 3]]);
  const r = runPerformArgs(g, "SPREAD_RELIGION", 5, 11, 10, { pre: 3 });
  assert.deepEqual(r.readback, { kind: "SPREAD_RELIGION", arg: 5, target: { x: 11, y: 10 }, before: 3, after: 2, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("rsendRequest(") && e.includes('"X":11,"Y":10,"UnitAbilityType":-1')));
  const none = withPillage(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])); none._log = [];
  assert.deepEqual(runOffers(none).offers.filter((o) => o.kind === "SPREAD_RELIGION"), [], "a unit without the operation is never offered it");
});

function withTownAndQueue(g, { project = 4242, queue = [301, 302, 303], removeOk = true, swapOk = true, growthOk = true } = {}) {
  withCity(g, {});
  const city = g.Players.get(1).Cities.getCities()[0];
  city.isTown = true; city.Growth = { projectType: project, isReadyToPlacePopulation: false };
  city.BuildQueue._q = queue.map((t) => ({ type: t }));
  g.CityCommandTypes = { ...(g.CityCommandTypes || {}), CHANGE_GROWTH_MODE: 7772 };
  g.GrowthTypes = { EXPAND: 0, PROJECT: 1 }; g.ProjectTypes = { NO_PROJECT: -1 };
  g.CityOperationsParametersValues = { RemoveAt: 1, Swap: 2, MoveTo: 3, Exclusive: 4 };
  const rows = [{ $hash: 4242, ProjectType: "PROJECT_TOWN_A", Name: "LOC_A" }];
  g.GameInfo.Projects = table(rows); g.GameInfo.Projects[Symbol.iterator] = function* () { yield* rows; };
  g.Game.CityCommands = { canStart: (cid, cmd, args) => { g._log.push(`gcanStart(${cmd},${JSON.stringify(args)})`); return { Success: cmd === 7772 && args.Type === 0 && growthOk }; }, sendRequest: (cid, cmd, args) => { g._log.push(`gsend(${JSON.stringify(args)})`); city.Growth = { projectType: -1 }; } };
  const inner = g.Game.CityOperations;
  g.Game.CityOperations = {
    canStart: (cid, op, args, show) => { if (args.InsertMode === undefined) return inner.canStart(cid, op, args, show); g._log.push(`qcanStart(${JSON.stringify(args)})`); return { Success: args.InsertMode === 1 ? removeOk : swapOk }; },
    sendRequest: (cid, op, args) => { if (args.InsertMode === undefined) return inner.sendRequest(cid, op, args); g._log.push(`qsend(${JSON.stringify(args)})`); const q = city.BuildQueue._q; if (args.InsertMode === 1) q.splice(args.QueueLocation, 1); else { const a = args.QueueSourceLocation, b = args.QueueDestinationLocation; [q[a], q[b]] = [q[b], q[a]]; } },
  };
  return g;
}

test("a town running a project is offered a return to growth, proved by the project clearing", () => {
  const g = withTownAndQueue(withUnits(world({ log: [] }), [])); g._log = [];
  const t = runOffers(g).offers.filter((o) => o.kind === "TOWN_GROWTH_MODE");
  assert.deepEqual(t.map((o) => [o.arg, o.pre, o.currentProjectKey]), [[65536, 4242, "PROJECT_TOWN_A"]]);
  const r = runPerformArgs(g, "TOWN_GROWTH_MODE", 65536, 0, 0, { pre: 4242 });
  assert.deepEqual(r.readback, { kind: "TOWN_GROWTH_MODE", arg: 65536, projectBefore: 4242, projectAfter: -1, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("gsend(") && e.includes('"Type":0,"ProjectType":-1,"City":65536')));
  const growing = withTownAndQueue(withUnits(world({ log: [] }), []), { project: -1 }); growing._log = [];
  assert.deepEqual(runOffers(growing).offers.filter((o) => o.kind === "TOWN_GROWTH_MODE"), []);
});

test("queue edits are offered per item and proved by the queue itself", () => {
  const g = withTownAndQueue(withUnits(world({ log: [] }), [])); g._log = [];
  const offers = runOffers(g).offers;
  assert.deepEqual(offers.filter((o) => o.kind === "QUEUE_REMOVE").map((o) => [o.arg2, o.arg3, o.pre]), [[0, 301, 3], [1, 302, 3], [2, 303, 3]]);
  assert.deepEqual(offers.filter((o) => o.kind === "QUEUE_MOVE_UP").map((o) => [o.arg2, o.toPosition]), [[1, 0], [2, 1]]);
  assert.deepEqual(offers.filter((o) => o.kind === "QUEUE_MOVE_DOWN").map((o) => [o.arg2, o.toPosition]), [[0, 1], [1, 2]]);
  const up = runPerformArgs(g, "QUEUE_MOVE_UP", 65536, 1, 302, { pre: 3 });
  assert.deepEqual(up.readback, { kind: "QUEUE_MOVE_UP", arg: 65536, position: 1, item: 302, queueAfter: [302, 301, 303], matches: true });
  assert.ok(g._log.find((e) => e.startsWith("qsend(") && e.includes('"InsertMode":2,"QueueSourceLocation":1,"QueueDestinationLocation":0')));
  const rm = withTownAndQueue(withUnits(world({ log: [] }), [])); rm._log = [];
  const rr = runPerformArgs(rm, "QUEUE_REMOVE", 65536, 2, 303, { pre: 3 });
  assert.deepEqual(rr.readback.queueAfter, [301, 302]); assert.equal(rr.readback.matches, true);
  const stale = withTownAndQueue(withUnits(world({ log: [] }), [])); stale._log = [];
  assert.ok(runPerformArgs(stale, "QUEUE_REMOVE", 65536, 1, 303, { pre: 3 }).refused, "the item is no longer at that position");
  assert.ok(runPerformArgs(stale, "QUEUE_REMOVE", 65536, 1, 302, { pre: 2 }).refused, "the queue length changed");
});

function withPolicyAndResources(g, { active = [-305844099], deactOk = true, assigned = [[1630, 65536], [1640, 131073]], unassignOk = true, swapOk = true } = {}) {
  withCity(g, {});
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, CHANGE_TRADITION: 8801, ASSIGN_RESOURCE: 8802, SWAP_RESOURCES: 8803 };
  g.PlayerOperationParameters = { Activate: -1326475004, Deactivate: 1318334332, Clear: -611376643 };
  g.CultureSlotTypes = { TRADITION_CULTURE_SLOT: 0, POLICY_CULTURE_SLOT: 1, CRISIS_CULTURE_SLOT: 2 };
  g.GameInfo.Traditions = table([{ $hash: -305844099, $index: 69, TraditionType: "TRADITION_ANGARIUM", Name: "LOC_ANG", Description: "LOC_ANG_D" }]);
  g.GameInfo.Resources = table([{ $hash: 501, ResourceType: "RESOURCE_JADE" }, { $hash: 502, ResourceType: "RESOURCE_IVORY" }]);
  g.GameplayMap = { ...(g.GameplayMap || {}), getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  const me = g.Players.get(1);
  let act = active.slice();
  me.Culture = { ...me.Culture, getActiveTraditions: (slot) => (slot === 0 ? act : []), isTraditionActive: (h) => act.includes(h),
                 getNumCultureSlots: () => 0, getUnlockedTraditions: () => [], getGoldenAgeChoices: () => [], getGovernmentType: () => -1 };
  const cities = { 65536: me.Cities.getCities()[0], 131073: { id: { owner: 1, id: 131073, type: 1 }, name: "LOC_D", location: { x: 5, y: 5 }, isTown: false, BuildQueue: { getQueue: () => [], currentProductionTypeHash: -1 } } };
  let homes = Object.fromEntries(assigned);
  for (const c of Object.values(cities)) c.Resources = { getAssignedResources: () => Object.entries(homes).filter(([v, cid]) => cid === c.id.id).map(([v]) => ({ value: Number(v) })) };
  me.Cities = { getCities: () => Object.values(cities) };
  me.Resources = { getResources: () => [{ value: 1630, uniqueResource: { resource: 501 } }, { value: 1640, uniqueResource: { resource: 502 } }] };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op === 8801) { g._log.push(`tcanStart(${JSON.stringify(args)})`); return { Success: deactOk && args.Action === 1318334332 }; }
      if (op === 8802) { g._log.push(`acanStart(${JSON.stringify(args)})`); return { Success: unassignOk && args.Action === 1318334332 }; }
      if (op === 8803) { g._log.push(`scanStart(${JSON.stringify(args)})`); return { Success: swapOk }; }
      return inner.canStart(pid, op, args, show);
    },
    sendRequest: (pid, op, args) => {
      if (op === 8801) { g._log.push(`tsend(${JSON.stringify(args)})`); act = act.filter((h) => h !== args.TraditionType); return; }
      if (op === 8802) { g._log.push(`asend(${JSON.stringify(args)})`); delete homes[args.Location.y * 100 + args.Location.x]; return; }
      if (op === 8803) { g._log.push(`ssend(${JSON.stringify(args)})`); const a = args.Location.y * 100 + args.Location.x, b = args.Location2.y * 100 + args.Location2.x; [homes[a], homes[b]] = [homes[b], homes[a]]; return; }
      return inner.sendRequest(pid, op, args);
    },
  };
  return g;
}

test("an active tradition is offered for deactivation and proved by leaving the active list", () => {
  const g = withPolicyAndResources(withUnits(world({ log: [] }), [])); g._log = [];
  const raw = runOffers(g); assert.equal(raw.refused, null, JSON.stringify(raw.refused));
  const d = raw.offers.filter((o) => o.kind === "DEACTIVATE_TRADITION");
  assert.deepEqual(d.map((o) => [o.arg, o.slot, o.typeKey]), [[-305844099, "TRADITION_CULTURE_SLOT", "TRADITION_ANGARIUM"]]);
  const r = runPerformArgs(g, "DEACTIVATE_TRADITION", -305844099, 0, 0, { pre: 1 });
  assert.deepEqual(r.readback, { kind: "DEACTIVATE_TRADITION", arg: -305844099, active: false, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("tsend(") && e.includes('"Action":1318334332')));
  const closed = withPolicyAndResources(withUnits(world({ log: [] }), []), { deactOk: false }); closed._log = [];
  assert.deepEqual(runOffers(closed).offers.filter((o) => o.kind === "DEACTIVATE_TRADITION"), [], "outside a policy window the engine refuses, and nothing is offered");
});

test("resources are offered out of a settlement and swapped between two, proved by where they end up", () => {
  const g = withPolicyAndResources(withUnits(world({ log: [] }), [])); g._log = [];
  const offers = runOffers(g).offers;
  assert.deepEqual(offers.filter((o) => o.kind === "UNASSIGN_RESOURCE").map((o) => [o.arg, o.arg2, o.pre, o.resourceKey]), [[1630, 65536, 65536, "RESOURCE_JADE"], [1640, 131073, 131073, "RESOURCE_IVORY"]]);
  assert.deepEqual(offers.filter((o) => o.kind === "SWAP_RESOURCES").map((o) => [o.arg, o.arg2, o.pre, o.otherCityId]), [[1630, 1640, 65536, 131073]]);
  const un = runPerformArgs(g, "UNASSIGN_RESOURCE", 1630, 65536, 0, { pre: 65536 });
  assert.deepEqual(un.readback, { kind: "UNASSIGN_RESOURCE", arg: 1630, homeBefore: 65536, homeAfter: null, matches: true });
  assert.ok(g._log.find((e) => e.startsWith("asend(") && e.includes('"City":65536,"Action":1318334332')));
  const sw = withPolicyAndResources(withUnits(world({ log: [] }), [])); sw._log = [];
  const rs = runPerformArgs(sw, "SWAP_RESOURCES", 1630, 1640, 0, { pre: 65536 });
  assert.deepEqual(rs.readback, { kind: "SWAP_RESOURCES", arg: 1630, homeBefore: 65536, homeAfter: 131073, matches: true });
  assert.ok(sw._log.find((e) => e.startsWith("ssend(") && e.includes('"Location2"')));
  const moved = withPolicyAndResources(withUnits(world({ log: [] }), [])); moved._log = [];
  assert.ok(runPerformArgs(moved, "UNASSIGN_RESOURCE", 1630, 65536, 0, { pre: 131073 }).refused, "the resource is not where the offer said");
});

// ---- attacking
function withAttack(g, { defenders = { "1010": { id: 77, owner: 4 } }, ranged = false, canAttack = true, attacksRemaining = 1,
                         startsWar = false, spend = true, reach = null, opOk = true } = {}) {
  withMap(g, {});
  g.CombatTypes = { NO_COMBAT: 0, COMBAT_MELEE: 1, COMBAT_RANGED: 2 };
  g.GameplayMap = { ...g.GameplayMap, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  g.UnitOperationTypes = { ...g.UnitOperationTypes, RANGE_ATTACK: 1900 };
  g.UnitOperationMoveModifiers = { NONE: 0, ATTACK: 16, MOVE_IGNORE_UNEXPLORED_DESTINATION: 16384 };
  const me = g.Players.get(1);
  const attacker = me.Units.getUnits()[0];
  attacker.Combat = { isCombat: true, canAttack: canAttack, attacksRemaining: attacksRemaining, rangedStrength: ranged ? 20 : 0, getMeleeStrength: () => 15 };
  attacker.Health = { damage: 10, maxDamage: 100 };
  me.Diplomacy = { willMoveStartWar: () => ({ Success: startsWar }) };
  g.Units = { ...(g.Units || {}), get: (cid) => (cid && cid.id === 77 ? { id: cid, type: 42, Health: { damage: 30, maxDamage: 100 } } : null),
              getPathTo: g.Units.getPathTo, getReachableTargets: () => (reach === null ? [1010] : reach) };
  g.GameInfo.Units = table([{ $hash: 42, UnitType: "UNIT_ENEMY_WARRIOR" }, { $hash: 99, UnitType: "UNIT_SCOUT" }]);
  g.Game.Combat = {
    getBestDefender: (loc, uid) => { g._log.push(`defender(${loc.x},${loc.y})`); return defenders[String(loc.y * 100 + loc.x)] ?? null; },
    testAttackInto: (uid, args) => { g._log.push(`testAttackInto(${args.X},${args.Y})`); return ranged ? 2 : 1; },
  };
  const prevOps = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => {
      if (op === 1900 || (args && args.Modifiers === 16400)) { g._log.push(`acanStart(${uid.id},${op},${JSON.stringify(args)},${show})`); return { Success: opOk }; }
      return prevOps.canStart(uid, op, args, show);
    },
    sendRequest: (uid, op, args) => {
      if (op === 1900 || (args && args.Modifiers === 16400)) {
        g._log.push(`asendRequest(${uid.id},${op},${JSON.stringify(args)})`);
        if (spend) attacker.Combat = { ...attacker.Combat, attacksRemaining: attacksRemaining - 1 };
        return;
      }
      return prevOps.sendRequest(uid, op, args);
    },
  };
  return g;
}

test("attack offers name the target plot and what stands on it, and nothing else about it", () => {
  const log = [];
  const g = withAttack(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const raw = runOffers(g);
  assert.equal(raw.refused, null, JSON.stringify(raw.refused));
  const at = raw.offers.filter((o) => o.kind === "ATTACK");
  assert.deepEqual(at.map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.ranged, o.startsWar]), [[5, 10, 10, 1, false, false]]);
  assert.deepEqual(at[0].defender, { typeKey: "UNIT_ENEMY_WARRIOR", damage: 30, maxDamage: 100 });
  assert.deepEqual(at[0].to, { x: 10, y: 10 });
  // the defender's owner is never exposed, only what a human sees in the combat preview
  assert.ok(!JSON.stringify(at[0]).includes('"owner"'));
  assert.ok(!log.some((e) => e.startsWith("asendRequest")), "enumeration must never attack");
});

test("an attack that would start a war is marked destructive; one against a civilization already at war is not", () => {
  const g = withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { startsWar: true }); g._log = [];
  const at = runOffers(g).offers.filter((o) => o.kind === "ATTACK");
  assert.deepEqual(at.map((o) => [o.startsWar, o.destructive, o.requiresConfirmation]), [[true, true, true]]);
  const h = withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])); h._log = [];
  assert.ok(runOffers(h).offers.filter((o) => o.kind === "ATTACK").every((o) => o.destructive === undefined));
});

test("a unit with no attack left, one that cannot attack, and an empty plot are all withheld", () => {
  for (const [label, opts] of [["spent", { attacksRemaining: 0 }], ["cannot attack", { canAttack: false }], ["nobody there", { defenders: {} }], ["engine refuses", { opOk: false }]]) {
    const g = withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), opts); g._log = [];
    assert.deepEqual(runOffers(g).offers.filter((o) => o.kind === "ATTACK"), [], label);
  }
});

test("perform ATTACK sends a melee strike as a move carrying the attack modifiers, and confirms on the attack being spent", () => {
  const log = [];
  const g = withAttack(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })])); g._log = log;
  const r = runPerformArgs(g, "ATTACK", 5, 10, 10, { pre: 1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "ATTACK", arg: 5, target: { x: 10, y: 10 }, ranged: false, attacksBefore: 1, attacksRemaining: 0, matches: true });
  const send = log.find((e) => e.startsWith("asendRequest("));
  assert.ok(send.includes('"Modifiers":16400'), "attack plus ignore-unexplored, as the shipped dispatcher sends");
});

test("perform ATTACK sends a ranged strike as its own operation with no move modifiers at all", () => {
  const log = [];
  const g = withAttack(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })]), { ranged: true }); g._log = log;
  const r = runPerformArgs(g, "ATTACK", 5, 10, 10, { pre: 1 });
  assert.equal(r.refused, null);
  assert.equal(r.readback.ranged, true);
  const send = log.find((e) => e.startsWith("asendRequest("));
  assert.ok(send.includes(",1900,") && !send.includes("Modifiers"));
});

test("perform ATTACK refuses an unknown unit, a spent attack, a changed count and a hidden plot without sending", () => {
  for (const [label, mk, uid, x, y, pre] of [
    ["unknown unit", () => withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 9, 10, 10, 1],
    ["no attack left", () => withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { attacksRemaining: 0 }), 5, 10, 10, 0],
    ["count changed", () => withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })])), 5, 10, 10, 3],
    ["hidden plot", () => withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { }), 5, 99, 99, 1],
    ["engine refuses", () => withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { opOk: false }), 5, 10, 10, 1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    if (label === "hidden plot") h.GameplayMap.getRevealedState = () => 0;
    const rr = runPerformArgs(h, "ATTACK", uid, x, y, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("asendRequest")), `${label}: must not send`);
  }
  const none = withAttack(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { spend: false }); none._log = [];
  const rr = runPerformArgs(none, "ATTACK", 5, 10, 10, { pre: 1 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- diplomacy (the only place the payload looks past the bound seat, and only at met players)
function withDiplomacy(g, { influence = 500, met = [{ id: 0, major: true, name: "LOC_ABBASID" }, { id: 7, major: false, name: "LOC_INDEP" }], projects = null, spend = 33, acceptShape = "Player2", atWar = [], allied = [], warAfter = [], cancelOk = true, alliedAfter = null } = {}) {
  const me = g.Players.get(1);
  me.DiplomacyTreasury = { diplomacyBalance: influence };
  me.Diplomacy = { hasMet: (id) => met.some((m) => m.id === id), isAtWarWith: (id) => atWar.includes(id), hasAllied: (id) => allied.includes(id) };
  me.Units = me.Units || { getUnits: () => [] };
  g.DiplomacyProjectStatus = { PROJECT_AVAILABLE: 1, PROJECT_BLOCKED: 2, PROJECT_NO_VIABLE_TARGETS: 3, PROJECT_NOT_UNLOCKED: 4, PROJECT_ACTIVE: 5 };
  g.DiplomacyActionTargetTypes = { NO_DIPLOMACY_TARGET: -1 };
  g.DiplomacyActionTypes = { DIPLOMACY_ACTION_FORM_ALLIANCE: 769311562, DIPLOMACY_ACTION_DECLARE_WAR: -434781988 };
  g.PlayerOperationTypes = { ...g.PlayerOperationTypes, CANCEL_ALLIANCE: 9301 };
  g.DiplomacyActionGroups = { NO_DIPLOMACY_ACTION_GROUP: -1, DIPLOMACY_ACTION_GROUP_TREATY: 4, DIPLOMACY_ACTION_GROUP_SANCTION: 5 };
  const rows = projects ?? [
    { actionType: 9001, actionTypeName: "DIPLOMACY_ACTION_OPEN_BORDERS", actionDisplayName: "LOC_OPEN_BORDERS", operationType: 555, actionGroup: 4, projectStatus: 1, targetList1: [{ targetID: 0, costYieldD: 33 }] },
    { actionType: 9002, actionTypeName: "DIPLOMACY_ACTION_DENOUNCE", actionDisplayName: "LOC_DENOUNCE", operationType: 556, actionGroup: 5, projectStatus: 1, targetList1: [{ targetID: 0, costYieldD: 80 }] },
    { actionType: 9003, actionTypeName: "DIPLOMACY_ACTION_DECLARE_WAR", actionDisplayName: "LOC_WAR", operationType: 557, actionGroup: 5, projectStatus: 1, targetList1: [{ targetID: 0, costYieldD: 0 }] },
    { actionType: 9004, actionTypeName: "DIPLOMACY_ACTION_BLOCKED", actionDisplayName: "LOC_BLOCKED", operationType: 558, actionGroup: 5, projectStatus: 2, targetList1: [{ targetID: 0, costYieldD: 40 }] },
  ];
  g.Game.Diplomacy = {
    getProjectDataForUI: (pid, target) => { g._log.push(`projects(${pid},${target})`); return rows.map((r) => ({ ...r, targetList1: r.targetList1.map((t) => ({ ...t, targetID: target })) })); },
  };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op === 9301) { g._log.push(`ccanStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: cancelOk && pid === 1 }; }
      if (args && args.Type !== undefined && args.Amount === 1) {
        g._log.push(`dcanStart(${pid},${op},${JSON.stringify(args)},${show})`);
        return { Success: pid === 1 && args[acceptShape] !== undefined };
      }
      return inner.canStart(pid, op, args, show);
    },
    sendRequest: (pid, op, args) => {
      if (op === 9301) { g._log.push(`csendRequest(${pid},${op},${JSON.stringify(args)})`); if (alliedAfter !== null) { me.Diplomacy.hasAllied = (id) => alliedAfter.includes(id); } return; }
      if (args && args.Type !== undefined && args.Amount === 1) {
        g._log.push(`dsendRequest(${pid},${op},${JSON.stringify(args)})`);
        me.DiplomacyTreasury = { diplomacyBalance: influence - spend };
        if (warAfter.length) me.Diplomacy.isAtWarWith = (id) => warAfter.includes(id);
        return;
      }
      return inner.sendRequest(pid, op, args);
    },
  };
  g.Players = { get: (id) => { g._log.push(`Players.get(${id})`); if (id === 1) return me; const m = met.find((x) => x.id === id); return m ? { id: m.id, isMajor: m.major, civilizationName: m.name } : undefined; } };
  g.Players.getEverAlive = () => [me, ...met.map((m) => ({ id: m.id, isMajor: m.major, civilizationName: m.name }))];
  return g;
}

test("diplomacy offers name each met civilization and the influence each available action costs", () => {
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), [])); g._log = log;
  const dips = runOffers(g).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION");
  assert.deepEqual(dips.map((o) => [o.arg, o.arg2, o.typeKey, o.targetName, o.cost, o.expect]),
    [[0, 9001, "DIPLOMACY_ACTION_OPEN_BORDERS", "LOC_ABBASID", 33, "influence"],
     [0, 9002, "DIPLOMACY_ACTION_DENOUNCE", "LOC_ABBASID", 80, "influence"],
     [0, 9003, "DIPLOMACY_ACTION_DECLARE_WAR", "LOC_ABBASID", 0, "war"]]);
  assert.deepEqual(dips.filter((o) => o.expect === "war").map((o) => [o.destructive, o.requiresConfirmation]), [[true, true]]);
  assert.ok(dips.filter((o) => o.expect === "influence").every((o) => o.destructive === undefined));
  assert.ok(dips.every((o) => o.costYield === "influence" && o.influenceBalance === 500));
  assert.ok(!log.some((e) => e.startsWith("dsendRequest")), "enumeration must never start an action");
});

test("a free action with no relationship to change, a blocked one and an unmet civilization are all withheld", () => {
  const log = [];
  const free = [{ actionType: 9005, actionTypeName: "DIPLOMACY_ACTION_SOMETHING_FREE", actionDisplayName: "LOC_FREE", operationType: 559, actionGroup: 5, projectStatus: 1, targetList1: [{ targetID: 0, costYieldD: 0 }] }];
  const g = withDiplomacy(withUnits(world({ log }), []), { projects: free }); g._log = log;
  assert.deepEqual(runOffers(g).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION"), [],
    "a free action that changes no relationship leaves no signal and is not offered");
  const h = withDiplomacy(withUnits(world({ log: [] }), [])); h._log = [];
  const dips = runOffers(h).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION");
  assert.ok(!dips.some((o) => o.arg2 === 9004), "a blocked project is not offered");
  const unmet = withDiplomacy(withUnits(world({ log: [] }), []), { met: [] }); unmet._log = [];
  assert.deepEqual(runOffers(unmet).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION"), []);
});

test("diplomacy offers never carry anything about a met civilization beyond its id, name and major flag", () => {
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), [])); g._log = log;
  const dips = runOffers(g).offers.filter((o) => o.kind === "START_DIPLOMATIC_ACTION");
  for (const o of dips) {
    for (const k of Object.keys(o)) {
      assert.ok(!["units", "cities", "location", "yields", "gold", "techs", "visibility"].includes(k), `leaked field ${k}`);
    }
  }
});

test("perform START_DIPLOMATIC_ACTION takes the operation from the engine's own listing and confirms on influence spent", () => {
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "START_DIPLOMATIC_ACTION", 0, 9001, 0, { pre: 500 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "START_DIPLOMATIC_ACTION", arg: 0, actionType: 9001, secondary: null, influenceBefore: 500, influence: 467,
    wasAtWar: false, atWar: false, wasAllied: false, allied: false, matches: true });
  const send = log.find((e) => e.startsWith("dsendRequest("));
  assert.ok(send.includes(",555,"), "the operation must be the one the listing gave for that project");
  assert.ok(send.includes('"Type":9001') && send.includes('"Player2":0'));
});

test("perform START_DIPLOMATIC_ACTION addresses an independent power by ID when Player2 is refused", () => {
  const log = [];
  const g = withDiplomacy(withUnits(world({ log }), []), { acceptShape: "ID" }); g._log = log;
  const r = runPerformArgs(g, "START_DIPLOMATIC_ACTION", 7, 9001, 0, { pre: 500 });
  assert.equal(r.refused, null);
  assert.ok(log.find((e) => e.startsWith("dsendRequest(") && e.includes('"ID":7')));
});

test("perform START_DIPLOMATIC_ACTION refuses an unmet target, itself, a stale influence balance, a withdrawn project and a refused check", () => {
  for (const [label, mk, target, at, pre] of [
    ["unmet civilization", () => withDiplomacy(withUnits(world({ log: [] }), []), { met: [] }), 0, 9001, 500],
    ["the seat itself", () => withDiplomacy(withUnits(world({ log: [] }), [])), 1, 9001, 500],
    ["influence moved", () => withDiplomacy(withUnits(world({ log: [] }), [])), 0, 9001, 400],
    ["project withdrawn", () => withDiplomacy(withUnits(world({ log: [] }), [])), 0, 9004, 500],
    ["unknown action type", () => withDiplomacy(withUnits(world({ log: [] }), [])), 0, 4242, 500],
    ["canStart false", () => withDiplomacy(withUnits(world({ log: [] }), []), { acceptShape: "nothing" }), 0, 9001, 500],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "START_DIPLOMATIC_ACTION", target, at, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("dsendRequest")), `${label}: must not send`);
  }
  const none = withDiplomacy(withUnits(world({ log: [] }), []), { spend: 0 }); none._log = [];
  const rr = runPerformArgs(none, "START_DIPLOMATIC_ACTION", 0, 9001, 0, { pre: 500 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- buying a building with gold, and promoting a town into a city
// Both ride CityCommandTypes.PURCHASE: one carries a constructible and its plot, the other the
// ORDER_TOWN_UPGRADE directive. Gold is the precondition for both, since the treasury only moves on a
// mutation and so a lighter balance is a positive, specific effect.
function withGoldPurchases(g, { gold = 900, upgradeOk = true, isTown = true, upgradeCost = 320, spend = 144, buyable = [501] } = {}) {
  withBuildings(g, {});
  const me = g.Players.get(1);
  me.Treasury = { goldBalance: gold };
  me.Units = { getUnits: () => [] };
  g.CityCommandTypes = { EXPAND: 7771, PURCHASE: 1490793096 };
  g.OrderTypes = { ORDER_TOWN_UPGRADE: 8 };
  const city = me.Cities.getCities()[0];
  city.isTown = isTown;
  city.Gold = { getTownUpgradeCost: () => upgradeCost };
  g.Game.CityCommands = {
    canStart: (cid, cmd, args, show) => {
      g._log.push(`pcanStart(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)},${show})`);
      if (cmd !== 1490793096 || cid.owner !== 1) return { Success: false };
      if (args.Directive !== undefined) return { Success: upgradeOk && city.isTown === true };
      if (args.UnitType !== undefined) return { Success: false };
      return { Success: buyable.includes(args.ConstructibleType), Cost: 144 };
    },
    sendRequest: (cid, cmd, args) => {
      g._log.push(`psendRequest(${JSON.stringify(cid)},${cmd},${JSON.stringify(args)})`);
      if (args.Directive !== undefined) { city.isTown = false; me.Treasury = { goldBalance: gold - upgradeCost }; return; }
      me.Treasury = { goldBalance: gold - spend };
    },
  };
  return g;
}

test("building-purchase offers carry the native cost, the seat's gold and the same plot as the build offer", () => {
  const log = [];
  const g = withGoldPurchases(withUnits(world({ log }), [])); g._log = log;
  const buys = runOffers(g).offers.filter((o) => o.kind === "PURCHASE_CONSTRUCTIBLE");
  assert.deepEqual(buys.map((o) => [o.arg, o.arg2, o.arg3, o.x, o.y, o.placement, o.constructibleKey, o.cost, o.pre, o.goldBalance, o.affordable]),
    [[65536, 501, 403, 3, 4, "urban", "BUILDING_GRANARY", 144, 900, 900, true],
     [65536, 501, 404, 4, 4, "newUrban", "BUILDING_GRANARY", 144, 900, 900, true],
     [65536, 501, 504, 4, 5, "newUrban", "BUILDING_GRANARY", 144, 900, 900, true]]);
  assert.ok(!log.some((e) => e.startsWith("psendRequest")), "enumeration must never buy anything");
});

test("a building the seat cannot afford is still offered, marked unaffordable rather than hidden", () => {
  const log = [];
  const g = withGoldPurchases(withUnits(world({ log }), []), { gold: 12 }); g._log = log;
  const buys = runOffers(g).offers.filter((o) => o.kind === "PURCHASE_CONSTRUCTIBLE");
  assert.ok(buys.length > 0);
  assert.ok(buys.every((o) => o.affordable === false && o.goldBalance === 12));
});

test("perform PURCHASE_CONSTRUCTIBLE re-checks gold and canStart with the plot, sends PURCHASE and reads back a lighter treasury", () => {
  const log = [];
  const g = withGoldPurchases(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "PURCHASE_CONSTRUCTIBLE", 65536, 501, 403, { pre: 900 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(r.readback, { kind: "PURCHASE_CONSTRUCTIBLE", arg: 65536, constructibleType: 501, plotIndex: 403, goldBefore: 900, gold: 756, matches: true });
  assert.ok(log.find((e) => e.startsWith("psendRequest(") && e.includes('"ConstructibleType":501') && e.includes('"X":3') && e.includes('"Y":4')));
  assert.ok(!log.some((e) => e.startsWith("bsendRequest")), "buying must never touch the build queue");
});

test("perform PURCHASE_CONSTRUCTIBLE refuses an unknown city, a non-constructible, a changed treasury and a refused purchase without sending", () => {
  for (const [label, mk, cid, ct, pi, pre] of [
    ["unknown city", () => withGoldPurchases(withUnits(world({ log: [] }), [])), 7, 501, 403, 900],
    ["not a constructible", () => withGoldPurchases(withUnits(world({ log: [] }), [])), 65536, 4242, 403, 900],
    ["treasury moved", () => withGoldPurchases(withUnits(world({ log: [] }), [])), 65536, 501, 403, 800],
    ["canStart false", () => withGoldPurchases(withUnits(world({ log: [] }), []), { buyable: [] }), 65536, 501, 403, 900],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "PURCHASE_CONSTRUCTIBLE", cid, ct, pi, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("psendRequest")), `${label}: must not send`);
  }
  const none = withGoldPurchases(withUnits(world({ log: [] }), []), { spend: 0 }); none._log = [];
  const rr = runPerformArgs(none, "PURCHASE_CONSTRUCTIBLE", 65536, 501, 403, { pre: 900 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

test("a town is offered the upgrade to a city with its own gold price; a city is not offered it at all", () => {
  const log = [];
  const g = withGoldPurchases(withUnits(world({ log }), [])); g._log = log;
  const ups = runOffers(g).offers.filter((o) => o.kind === "UPGRADE_TOWN");
  assert.deepEqual(ups.map((o) => [o.arg, o.cityName, o.cost, o.pre, o.goldBalance, o.affordable, o.canStart]), [[65536, "Cordoba", 320, 900, 900, true, true]]);
  const asCity = withGoldPurchases(withUnits(world({ log: [] }), []), { isTown: false }); asCity._log = [];
  assert.deepEqual(runOffers(asCity).offers.filter((o) => o.kind === "UPGRADE_TOWN"), []);
  const refused = withGoldPurchases(withUnits(world({ log: [] }), []), { upgradeOk: false }); refused._log = [];
  assert.deepEqual(runOffers(refused).offers.filter((o) => o.kind === "UPGRADE_TOWN"), []);
});

test("perform UPGRADE_TOWN sends the upgrade directive and reads back a settlement that is no longer a town", () => {
  const log = [];
  const g = withGoldPurchases(withUnits(world({ log }), [])); g._log = log;
  const r = runPerformArgs(g, "UPGRADE_TOWN", 65536, 0, 0, { pre: 900 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "UPGRADE_TOWN", arg: 65536, wasTown: true, isTown: false, matches: true });
  assert.ok(log.find((e) => e.startsWith("psendRequest(") && e.includes('"Directive":8')));
  for (const [label, mk, cid, pre] of [
    ["unknown settlement", () => withGoldPurchases(withUnits(world({ log: [] }), [])), 7, 900],
    ["already a city", () => withGoldPurchases(withUnits(world({ log: [] }), []), { isTown: false }), 65536, 900],
    ["treasury moved", () => withGoldPurchases(withUnits(world({ log: [] }), [])), 65536, 100],
    ["canStart false", () => withGoldPurchases(withUnits(world({ log: [] }), []), { upgradeOk: false }), 65536, 900],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "UPGRADE_TOWN", cid, 0, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("psendRequest")), `${label}: must not send`);
  }
});

test("the traditions confirm is gated per slot type, so a free slot elsewhere does not hold it back", () => {
  const log = [];
  // two crisis slots free with crisis cards pending, and plenty of free ordinary slots with none
  const g = withTraditions(world({ log, blocking: true })); g._log = log;
  const cu = g.Players.get(1).Culture;
  const rows = [{ $hash: 9001, $index: 11, TraditionType: "TRADITION_CRISIS_A", CultureSlotType: "CRISIS_CULTURE_SLOT", Name: "LOC_CA", Description: "LOC_CA_D", IsCrisis: true }];
  g.GameInfo.Traditions = table(rows);
  cu.getNumCultureSlots = (st) => (st === 3 ? 2 : st === 2 ? 17 : 0);
  cu.getNumAllCultureSlots = () => 19;
  cu.getUnlockedTraditions = (st) => (st === 3 ? [9001] : []);
  cu.getActiveTraditions = () => [];
  cu.isTraditionActive = () => false;
  g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 4, type: 20 }];
  g.Game.Notifications.find = () => ({ Type: 9, BlocksTurnAdvancement: true });
  g.Game.Notifications.getTypeName = () => "NOTIFICATION_CRISIS";
  const r = runOffers(g);
  const card = r.offers.find((o) => o.kind === "CHANGE_TRADITION");
  assert.equal(card.isCrisis, true);
  const confirm = r.offers.find((o) => o.kind === "CONSIDER_ASSIGN_TRADITIONS");
  assert.ok(confirm, "the crisis notification offers the confirm too");
  assert.equal(confirm.canStart, false, "a free crisis slot with a pending crisis card holds the confirm back");
  assert.deepEqual(confirm.pendingBySlot, { CRISIS_CULTURE_SLOT: 1 });
});

test("the offers context lists the seat's own unit ids", () => {
  const g = withUnits(world({ log: [] }), [unit(5), unit(6)]); g._log = [];
  assert.deepEqual(runOffers(g).context.unitIds, [5, 6]);
});

// ---- age transition: civilization choice (a setup parameter) and the one-way finish
function withAgeTransition(g, { current = "RANDOM", valid = ["CIVILIZATION_ABBASID", "CIVILIZATION_CHOLA"], blocking = true, finishOk = true } = {}) {
  let value = current;
  const rows = [{ $hash: 125352635, CivilizationType: "CIVILIZATION_ABBASID", Name: "LOC_AB", FullName: "LOC_AB_F", Description: "LOC_AB_D" }, { $hash: -12769722, CivilizationType: "CIVILIZATION_CHOLA", Name: "LOC_CH", FullName: "LOC_CH_F", Description: "LOC_CH_D" }, { $hash: 2053970112, CivilizationType: "CIVILIZATION_GREECE", Name: "LOC_GR", FullName: "LOC_GR_F", Description: "LOC_GR_D" }, { $hash: -1634075386, CivilizationType: "CIVILIZATION_PERSIA", Name: "LOC_PE", FullName: "LOC_PE_F", Description: "LOC_PE_D" }];
  g.GameInfo.Civilizations = { lookup: (k) => rows.find((r) => r.$hash === k || r.CivilizationType === k) ?? null };
  const domain = [{ value: "RANDOM", invalidReason: 0 }, ...rows.map((r) => ({ value: r.CivilizationType, invalidReason: valid.includes(r.CivilizationType) ? 0 : 4 }))];
  g.GameSetup = {
    findPlayerParameter: (pid, id) => { g._log.push(`findParam(${pid},${id})`); if (id === "AgeTransitionPlayerCivilization") return { value: { value }, domain: { possibleValues: domain } }; if (id === "PlayerCivilization") return { value: { value: "CIVILIZATION_PERSIA" } }; return null; },
    setPlayerParameterValue: (pid, id, v) => { g._log.push(`setParam(${pid},${id},${v})`); if (id === "AgeTransitionPlayerCivilization") value = v; },
  };
  g.Database = { query: (db, sql) => [{ CivilizationType: "CIVILIZATION_PERSIA", Type: "CIVILIZATION_ABBASID", Name: "LOC_AB", Description: "LOC_AB_D" }] };
  g.PlayerOperationTypes.SET_AGE_TRANSITION_DATA = 850178580;
  if (blocking) { g.Game.Notifications.getEndTurnBlockingType = () => 779; g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 8, type: 20 }]; g.Game.Notifications.find = () => ({ Type: 3, BlocksTurnAdvancement: true }); g.Game.Notifications.getTypeName = () => "NOTIFICATION_CHOOSE_CIVILIZATION"; }
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== 850178580) return inner.canStart(pid, op, args, show); g._log.push(`fcanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: finishOk }; },
    sendRequest: (pid, op, args) => { if (op !== 850178580) return inner.sendRequest(pid, op, args); g._log.push(`fsendRequest(${pid},${JSON.stringify(args)})`); },
  };
  return g;
}

test("age transition offers list the seat's valid next-age civilizations with text and the historical flag, and gate the finish on a choice", () => {
  const log = [];
  const g = withAgeTransition(world({ log })); g._log = log;
  const r = runOffers(g);
  const civs = r.offers.filter((o) => o.kind === "CHOOSE_AGE_CIVILIZATION");
  assert.deepEqual(civs.map((o) => [o.arg, o.pre, o.typeKey, o.displayName, o.description, o.historical, o.selected, o.invalidReason, o.canStart]),
    [[125352635, -1, "CIVILIZATION_ABBASID", "LOC_AB", "LOC_AB_D", true, false, 0, true], [-12769722, -1, "CIVILIZATION_CHOLA", "LOC_CH", "LOC_CH_D", false, false, 0, true],
     [2053970112, -1, "CIVILIZATION_GREECE", "LOC_GR", "LOC_GR_D", false, false, 4, false], [-1634075386, -1, "CIVILIZATION_PERSIA", "LOC_PE", "LOC_PE_D", false, false, 4, false]]);
  assert.ok(!civs.some((o) => o.typeKey === "RANDOM"), "RANDOM is never offered: the seat must choose");
  const fin = r.offers.find((o) => o.kind === "SET_AGE_TRANSITION_DATA");
  assert.deepEqual([fin.canStart, fin.selectedCivilization, fin.pre], [false, "RANDOM", -1], "nothing chosen yet: the finish is withheld");
  assert.ok(!log.some((e) => e.startsWith("setParam") || e.startsWith("fsendRequest")));
  const h = withAgeTransition(world({ log: [] }), { blocking: false }); h._log = [];
  assert.equal(runOffers(h).offers.filter((o) => o.kind === "CHOOSE_AGE_CIVILIZATION" || o.kind === "SET_AGE_TRANSITION_DATA").length, 0, "only while the game asks");
  const k = withAgeTransition(world({ log: [] }), { current: "CIVILIZATION_CHOLA" }); k._log = [];
  const kr = runOffers(k);
  assert.equal(kr.offers.find((o) => o.kind === "SET_AGE_TRANSITION_DATA").canStart, true);
  assert.equal(kr.offers.find((o) => o.typeKey === "CIVILIZATION_CHOLA").selected, true);
  assert.equal(kr.offers.find((o) => o.typeKey === "CIVILIZATION_CHOLA").canStart, false, "the selected civilization is not re-offered");
});

test("perform CHOOSE_AGE_CIVILIZATION writes only the bound seat's age-transition parameter after re-validating, and reads it back", () => {
  const log = [];
  const g = withAgeTransition(world({ log })); g._log = log;
  const r = runPerform(g, "CHOOSE_AGE_CIVILIZATION", 125352635, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CHOOSE_AGE_CIVILIZATION", arg: 125352635, civilization: "CIVILIZATION_ABBASID", selected: "CIVILIZATION_ABBASID", matches: true });
  assert.deepEqual(log.filter((e) => e.startsWith("setParam")), ["setParam(1,AgeTransitionPlayerCivilization,CIVILIZATION_ABBASID)"]);
  for (const [label, mk, hash, pre] of [
    ["not a civilization", () => withAgeTransition(world({ log: [] })), 4242, -1],
    ["selection changed", () => withAgeTransition(world({ log: [] })), 125352635, 99],
    ["unavailable for this seat", () => withAgeTransition(world({ log: [] })), 2053970112, -1],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerform(h, "CHOOSE_AGE_CIVILIZATION", hash, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("setParam")), `${label}: must not write`);
  }
});

test("perform SET_AGE_TRANSITION_DATA refuses until a civilization is chosen, then sends Finished after canStart", () => {
  const g = withAgeTransition(world({ log: [] })); g._log = [];
  const none = runPerform(g, "SET_AGE_TRANSITION_DATA", 0, { pre: -1 });
  assert.equal(none.refused.code, "ACTION_NOT_STARTABLE");
  assert.ok(!g._log.some((e) => e.startsWith("fsendRequest")));
  const h = withAgeTransition(world({ log: [] }), { current: "CIVILIZATION_ABBASID" }); h._log = [];
  const ok = runPerform(h, "SET_AGE_TRANSITION_DATA", 0, { pre: 125352635 });
  assert.equal(ok.outcome, "sent");
  assert.ok(h._log.find((e) => e === 'fsendRequest(1,{"Finished":true})'));
  const stale = withAgeTransition(world({ log: [] }), { current: "CIVILIZATION_ABBASID" }); stale._log = [];
  assert.equal(runPerform(stale, "SET_AGE_TRANSITION_DATA", 0, { pre: -1 }).refused.code, "ACTION_EXPIRED");
});

test("a notification whose own blocking field went stale is not counted once the engine says it no longer blocks", () => {
  // live (turn 93): CHOOSE_CIVILIZATION kept BlocksTurnAdvancement true after the finish; the per-id query said false
  const g = withAgeTransition(world({ log: [] }), { current: "CIVILIZATION_ABBASID" }); g._log = [];
  g.Game.Notifications.getEndTurnBlockingType = () => 23669119;   // UNITS still blocks
  g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 786, type: 20 }, { owner: 1, id: 790, type: 20 }];
  g.Game.Notifications.find = (id) => ({ Type: id.id, BlocksTurnAdvancement: true });
  g.Game.Notifications.getTypeName = (t) => (t === 786 ? "NOTIFICATION_CHOOSE_CIVILIZATION" : "NOTIFICATION_COMMAND_UNITS");
  g.Game.Notifications.getBlocksTurnAdvancement = (id) => id.id === 790;
  const r = runOffers(g);
  assert.deepEqual(r.context.blockingNotifications, ["NOTIFICATION_COMMAND_UNITS"]);
  assert.equal(r.offers.filter((o) => o.kind === "CHOOSE_AGE_CIVILIZATION" || o.kind === "SET_AGE_TRANSITION_DATA").length, 0, "the transition is not offered again once satisfied");
});

// ---- new-age legacy cards
function withLegacies(g, { deck = [], points = 3, usable = true, placement = false, plotsListed = null, placeOk = [[5, 5], [6, 5]], potentialCapitals = [], civChanged = false } = {}) {
  const me = g.Players.get(1);
  const cards = [
    { id: "CARD_A", name: "LOC_CA", description: "LOC_CA_D", cost: [{ category: 1, value: 1 }], effects: [{ id: "EFF_A", amount: 1, isPlacementEffect: false }] },
    { id: "CARD_B", name: "LOC_CB", description: "LOC_CB_D", cost: [{ category: 1, value: 2 }], effects: [{ id: "EFF_B", amount: 1, isPlacementEffect: placement }] },
  ];
  let inDeck = deck.slice(); const applied = {};
  // the engine wraps a deck entry: {id: <instance>, info: {<the card>}}
  let instance = 0;
  me.AdvancedStart = { getAvailableCards: () => cards, getCards: () => cards.filter((c) => inDeck.includes(c.id)).map((c) => ({ id: ++instance, info: c })), getLegacyPoints: () => [{ category: 1, value: points }] };
  g.Database = { makeHash: (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; } };
  g.PlayerOperationTypes.ADVANCED_START_MODIFY_DECK = 214839009; g.PlayerOperationTypes.ADVANCED_START_USE_EFFECT = 1398940173; g.PlayerOperationTypes.ADVANCED_START_MARK_COMPLETED = 867990583;
  g.Game.Notifications.getEndTurnBlockingType = () => 780; g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: 9, type: 20 }]; g.Game.Notifications.find = () => ({ Type: 4, BlocksTurnAdvancement: true }); g.Game.Notifications.getTypeName = () => "NOTIFICATION_AGE_TRANSITION";
  const inner = g.Game.PlayerOperations;
  const ops = new Set([214839009, 1398940173, 867990583]);
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (!ops.has(op)) return inner.canStart(pid, op, args, show); g._log.push(`lcanStart(${pid},${op},${JSON.stringify(args)},${show})`);
      if (op === 214839009) return { Success: args.Type === "ADD" ? !inDeck.includes(args.ID) : inDeck.includes(args.ID) };
      if (op === 1398940173) { const owner = cards.find((c) => c.effects.some((e) => e.id === args.ID)); return { Success: usable && !!owner && inDeck.includes(owner.id) && !applied[args.ID] }; }
      return { Success: true }; },
    sendRequest: (pid, op, args) => { g._log.push(`lsendRequest(${pid},${op},${JSON.stringify(args)})`); if (op === 214839009 && args.Type === "ADD") inDeck.push(args.ID); if (op === 214839009 && args.Type === "REMOVE") inDeck = inDeck.filter((x) => x !== args.ID); if (op === 1398940173) applied[args.ID] = true; },
  };
  // placement (555001) and the capital (555002) sit beside the deck operations
  g.PlayerOperationTypes.ADVANCED_START_PLACE_SETTLEMENT = 555001; g.PlayerOperationTypes.SELECT_CAPITAL = 555002;
  const cities = [{ id: { owner: 1, id: 65536, type: 1 }, name: "LOC_C", location: { x: 3, y: 4 }, population: 5, isTown: false },
                  { id: { owner: 1, id: 131072, type: 1 }, name: "LOC_T", location: { x: 12, y: 4 }, population: 3, isTown: true }];
  let capital = cities[0];
  me.Cities = { getCities: () => cities, getCapital: () => capital, getPotentialSwitchCapitalCityIds: () => potentialCapitals.map((id) => ({ owner: 1, id, type: 1 })) };
  me.civilizationType = 7; me.previousAgeCivilizationType = civChanged ? 6 : 7;
  g.GameplayMap = { getGridWidth: () => 20, getGridHeight: () => 20, getIndexFromXY: (x, y) => y * 100 + x, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }), getTerrainType: () => 1 };
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  const deckOps = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => {
      if (op === 555001) { g._log.push(`pcanStart(${JSON.stringify(args)})`); const eff = cards[1].effects[0]; if (args.X === undefined) return { Success: true, Plots: plotsListed }; return { Success: inDeck.includes("CARD_B") && eff.isPlacementEffect && eff.amount > 0 && placeOk.some(([x, y]) => x === args.X && y === args.Y) }; }
      if (op === 555002) { g._log.push(`kcanStart(${JSON.stringify(args)})`); return { Success: potentialCapitals.includes(args.City) }; }
      return deckOps.canStart(pid, op, args, show); },
    sendRequest: (pid, op, args) => {
      if (op === 555001) { g._log.push(`psendRequest(${JSON.stringify(args)})`); cards[1].effects[0].amount -= 1; return; }
      if (op === 555002) { g._log.push(`ksendRequest(${JSON.stringify(args)})`); capital = cities.find((c) => c.id.id === args.City); return; }
      return deckOps.sendRequest(pid, op, args); },
  };
  return { g, hash: g.Database.makeHash };
}

test("legacy offers list unpicked cards with cost and points, and the finish", () => {
  const log = [];
  const { g, hash } = withLegacies(world({ log })); g._log = log;
  const r = runOffers(g);
  const picks = r.offers.filter((o) => o.kind === "ADVANCED_START_MODIFY_DECK");
  assert.deepEqual(picks.map((o) => [o.arg, o.pre, o.cardId, o.displayName, o.cost, o.pointsAvailable, o.effectCount, o.needsPlacement, o.canStart]),
    [[hash("CARD_A"), 0, "CARD_A", "LOC_CA", 1, 3, 1, false, true], [hash("CARD_B"), 0, "CARD_B", "LOC_CB", 2, 3, 1, false, true]]);
  assert.equal(r.offers.filter((o) => o.kind === "ADVANCED_START_USE_EFFECT").length, 0, "effects are never offered on their own");
  const fin = r.offers.find((o) => o.kind === "ADVANCED_START_MARK_COMPLETED");
  assert.deepEqual([fin.canStart, fin.deck, fin.pointsAvailable], [true, [], 3]);
  const { g: h } = withLegacies(world({ log: [] }), { deck: ["CARD_A"] }); h._log = [];
  const hr = runOffers(h);
  assert.ok(!hr.offers.some((o) => o.kind === "ADVANCED_START_MODIFY_DECK" && o.cardId === "CARD_A"), "a picked card is not offered again");
  assert.deepEqual(hr.offers.find((o) => o.kind === "ADVANCED_START_MARK_COMPLETED").deck, ["CARD_A"]);
  const { g: pl } = withLegacies(world({ log: [] }), { placement: true }); pl._log = [];
  const plo = runOffers(pl).offers;
  assert.deepEqual([plo.find((o) => o.cardId === "CARD_B" && o.kind === "ADVANCED_START_MODIFY_DECK").canStart, plo.find((o) => o.cardId === "CARD_B").needsPlacement], [true, true], "a placement card is pickable and says so");
  assert.equal(plo.find((o) => o.kind === "ADVANCED_START_MARK_COMPLETED").pendingPlacements, 0, "nothing to place until the card is picked");
  assert.equal(plo.filter((o) => o.kind === "ADVANCED_START_REMOVE_CARD").length, 0, "nothing to put back while the deck is empty");
  assert.equal(plo.filter((o) => o.kind === "SELECT_CAPITAL").length, 0, "no other settlement may be the capital here");
});

test("picked cards are offered back; a picked placement card offers its settlement on each plot the engine accepts, from its Plots list or a probe around the seat's settlements, and the finish counts what is unplaced", () => {
  const { g, hash } = withLegacies(world({ log: [] }), { deck: ["CARD_A", "CARD_B"], placement: true, potentialCapitals: [131072] }); g._log = [];
  const r = runOffers(g).offers;
  assert.deepEqual(r.filter((o) => o.kind === "ADVANCED_START_REMOVE_CARD").map((o) => [o.arg, o.pre, o.cardId, o.cost, o.deck, o.canStart]),
    [[hash("CARD_A"), 2, "CARD_A", 1, ["CARD_A", "CARD_B"], true], [hash("CARD_B"), 2, "CARD_B", 2, ["CARD_A", "CARD_B"], true]]);
  const places = r.filter((o) => o.kind === "ADVANCED_START_PLACE_SETTLEMENT");
  assert.deepEqual(places.map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.effectId, o.cardId, o.remaining, o.terrainKey, o.canStart]),
    [[hash("EFF_B"), 5, 5, 1, "EFF_B", "CARD_B", 1, "TERRAIN_FLAT", true], [hash("EFF_B"), 6, 5, 1, "EFF_B", "CARD_B", 1, "TERRAIN_FLAT", true]]);
  assert.ok(g._log.filter((e) => e.startsWith("pcanStart(") && e.includes('"X"')).length > 100, "with no Plots list the plots around both settlements are probed");
  assert.equal(r.find((o) => o.kind === "ADVANCED_START_MARK_COMPLETED").pendingPlacements, 1);
  assert.deepEqual(r.filter((o) => o.kind === "SELECT_CAPITAL").map((o) => [o.arg, o.arg2, o.pre, o.cityName, o.population, o.isTown, o.currentCapitalName, o.swap, o.canStart]),
    [[131072, 0, 65536, "LOC_T", 3, true, "Cordoba", false, true]]);
  const { g: listed } = withLegacies(world({ log: [] }), { deck: ["CARD_B"], placement: true, plotsListed: [505, 606], civChanged: true, potentialCapitals: [131072] }); listed._log = [];
  const lr = runOffers(listed).offers;
  assert.deepEqual(lr.filter((o) => o.kind === "ADVANCED_START_PLACE_SETTLEMENT").map((o) => [o.arg2, o.arg3]), [[5, 5]], "an engine Plots list is used as given, each plot still checked");
  assert.equal(lr.find((o) => o.kind === "SELECT_CAPITAL").arg2, 1, "a changed civilization renames the new capital, as the shipped confirm sends it");
  assert.ok(!listed._log.some((e) => e.startsWith("psendRequest") || e.startsWith("ksendRequest")));
});

test("putting a card back, placing a settlement and moving the capital each re-check and read back their own effect", () => {
  const { g, hash } = withLegacies(world({ log: [] }), { deck: ["CARD_A", "CARD_B"], placement: true, potentialCapitals: [131072] }); g._log = [];
  const rm = runPerform(g, "ADVANCED_START_REMOVE_CARD", hash("CARD_A"), { pre: 2 });
  assert.equal(rm.refused, null);
  assert.deepEqual(rm.readback, { kind: "ADVANCED_START_REMOVE_CARD", arg: hash("CARD_A"), card: "CARD_A", deck: ["CARD_B"], matches: true });
  assert.ok(g._log.find((l) => l === 'lsendRequest(1,214839009,{"Type":"REMOVE","ID":"CARD_A"})'));
  assert.ok(!g._log.some((l) => l.includes("1398940173")), "no reward is touched by putting a card back");
  assert.equal(runPerform(g, "ADVANCED_START_REMOVE_CARD", hash("CARD_A"), { pre: 1 }).refused.code, "UNKNOWN_ACTION", "a card not in the deck cannot be put back");
  const pl = runPerformArgs(g, "ADVANCED_START_PLACE_SETTLEMENT", hash("EFF_B"), 6, 5, { pre: 1 });
  assert.equal(pl.refused, null);
  assert.deepEqual(pl.readback, { kind: "ADVANCED_START_PLACE_SETTLEMENT", arg: hash("EFF_B"), effect: "EFF_B", at: { x: 6, y: 5 }, remaining: 0, matches: true });
  assert.ok(g._log.find((l) => l === 'psendRequest({"ID":"EFF_B","X":6,"Y":5})'));
  assert.equal(runPerformArgs(g, "ADVANCED_START_PLACE_SETTLEMENT", hash("EFF_B"), 5, 5, { pre: 1 }).refused.code, "ACTION_EXPIRED", "spent placements are not re-placed");
  assert.equal(runPerformArgs(g, "ADVANCED_START_PLACE_SETTLEMENT", hash("EFF_A"), 5, 5, { pre: 1 }).refused.code, "UNKNOWN_ACTION", "an instant effect is not a placement");
  const cap = runPerformArgs(g, "SELECT_CAPITAL", 131072, 0, 0, { pre: 65536 });
  assert.equal(cap.refused, null);
  assert.deepEqual(cap.readback, { kind: "SELECT_CAPITAL", arg: 131072, capitalCityId: 131072, matches: true });
  assert.ok(g._log.find((l) => l === 'ksendRequest({"Player1":1,"City":131072,"Swap":false})'));
  assert.equal(runPerformArgs(g, "SELECT_CAPITAL", 65536, 0, 0, { pre: 131072 }).refused.code, "ACTION_NOT_STARTABLE", "only the engine's legal set");
  assert.equal(runPerformArgs(g, "SELECT_CAPITAL", 131072, 0, 0, { pre: 65536 }).refused.code, "ACTION_EXPIRED", "a moved capital expires the offer");
  assert.equal(runPerformArgs(g, "SELECT_CAPITAL", 131072, 1, 0, { pre: 131072 }).refused.code, "ACTION_EXPIRED", "the naming flag is bound");
});

test("picking a legacy card adds it without its reward; the finish applies every picked card's reward once each and then marks the deck", () => {
  const log = [];
  const { g, hash } = withLegacies(world({ log }), { placement: true }); g._log = log;
  const a = runPerform(g, "ADVANCED_START_MODIFY_DECK", hash("CARD_A"), { pre: 0 });
  assert.equal(a.refused, null);
  assert.deepEqual(a.readback, { kind: "ADVANCED_START_MODIFY_DECK", arg: hash("CARD_A"), card: "CARD_A", deck: ["CARD_A"], matches: true });
  assert.ok(log.find((l) => l === 'lsendRequest(1,214839009,{"Type":"ADD","ID":"CARD_A"})'));
  assert.ok(!log.some((l) => l.includes("1398940173")), "no reward is applied by a pick");
  assert.equal(runPerform(g, "ADVANCED_START_MODIFY_DECK", hash("CARD_B"), { pre: 1 }).refused, null, "a placement card is picked like any other");
  const m = runPerform(g, "ADVANCED_START_MARK_COMPLETED", 0, { pre: 2 });
  assert.equal(m.outcome, "sent");
  assert.deepEqual(m.readback, { kind: "ADVANCED_START_MARK_COMPLETED", arg: 0, effectsApplied: 1, matches: false });
  assert.equal(log.filter((l) => l === 'lsendRequest(1,1398940173,{"ID":"EFF_A"})').length, 1, "the instant effect is applied exactly once");
  assert.ok(!log.some((l) => l.includes('{"ID":"EFF_B"}')), "a placement effect is never applied as a reward");
  assert.ok(log.indexOf('lsendRequest(1,1398940173,{"ID":"EFF_A"})') < log.indexOf("lsendRequest(1,867990583,{})"), "rewards land before the mark");
  assert.ok(log.find((l) => l === "lsendRequest(1,867990583,{})"));
  assert.equal(runPerform(g, "ADVANCED_START_MODIFY_DECK", hash("CARD_A"), { pre: 0 }).refused.code, "ACTION_EXPIRED", "stale deck size");
  assert.equal(runPerform(g, "ADVANCED_START_MODIFY_DECK", 4242, { pre: 2 }).refused.code, "UNKNOWN_ACTION");
});

// ---- syncretism: three operations over the same civilization list, made once
function withSyncretism(g, { civs = { UNITS: [7001], INFRASTRUCTURE: [7001, 7002], SELF: [] }, chosen = -1, ok = true } = {}) {
  const me = g.Players.get(1);
  me.Identity = { getSyncreticCivType: () => chosen, getSyncreticChoiceType: () => (chosen === -1 ? -1 : 2) };
  g.SyncreticChoiceTypes = { SYNCRETIC_CHOICE_UNITS: 1, SYNCRETIC_CHOICE_INFRASTRUCTURE: 2, SYNCRETIC_CHOICE_SELF: 3 };
  g.PlayerOperationTypes.CHOOSE_SYNCRETISM_UNITS = 6101; g.PlayerOperationTypes.CHOOSE_SYNCRETISM_INFRASTRUCTURE = 6102; g.PlayerOperationTypes.CHOOSE_SYNCRETISM_SELF = 6103;
  g.GameInfo.LegacyCivilizationTraits = table([{ $hash: 7001, CivilizationType: "CIVILIZATION_ABBASID" }, { $hash: 7002, CivilizationType: "CIVILIZATION_MING" }]);
  g.GameInfo.Civilizations = { lookup: (k) => ({ CIVILIZATION_ABBASID: { $hash: 7001, CivilizationType: "CIVILIZATION_ABBASID", Name: "LOC_ABB" }, CIVILIZATION_MING: { $hash: 7002, CivilizationType: "CIVILIZATION_MING", Name: "LOC_MING" }, 7001: { $hash: 7001, CivilizationType: "CIVILIZATION_ABBASID", Name: "LOC_ABB" }, 7002: { $hash: 7002, CivilizationType: "CIVILIZATION_MING", Name: "LOC_MING" } })[k] ?? null };
  g.GameInfo.Constructibles = table([{ $hash: 8801, ConstructibleType: "BUILDING_MADRASA" }]);
  g.GameInfo.Traditions = table([{ $hash: 8901, TraditionType: "TRADITION_ABBASID_SYNCRETISM" }]);
  g.Game.Unlocks = {
    getSyncreticCivUnlocksForChoice: (pid, flag) => { g._log.push(`syncList(${pid},${flag})`); return civs[{ 1: "UNITS", 2: "INFRASTRUCTURE", 3: "SELF" }[flag]]; },
    getUnitChoiceSyncreticUnlocks: () => [{ kind: "KIND_UNIT", typeHash: 99 }],
    getInfrastructureChoiceSyncreticUnlocks: () => [{ kind: "KIND_CONSTRUCTIBLE", typeHash: 8801 }, { kind: "KIND_QUARTER", typeHash: 4444 }],
    getSelfChoiceSyncreticUnlocks: () => [{ kind: "KIND_TRADITION", typeHash: 8901 }],
  };
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op < 6101 || op > 6103) return inner.canStart(pid, op, args, show); g._log.push(`scanStart(${pid},${op},${JSON.stringify(args)},${show})`); return { Success: ok, Units: [99], AdditionalDescription: ["LOC_UNIT_NOTE"] }; },
    sendRequest: (pid, op, args) => { if (op < 6101 || op > 6103) return inner.sendRequest(pid, op, args); g._log.push(`ssendRequest(${pid},${op},${JSON.stringify(args)})`); chosen = args.CivilizationType; },
  };
  return g;
}

test("syncretism offers one option per civilization per choice kind, naming what each gives, only until a choice is made", () => {
  const g = withSyncretism(withUnits(world({ log: [] }), [])); g._log = [];
  const r = runOffers(g).offers.filter((o) => o.kind.startsWith("CHOOSE_SYNCRETISM"));
  assert.deepEqual(r.map((o) => [o.kind, o.arg, o.pre, o.civKey, o.displayName, o.choice, o.unlocks, o.description, o.canStart]), [
    ["CHOOSE_SYNCRETISM_UNITS", 7001, -1, "CIVILIZATION_ABBASID", "LOC_ABB", "SYNCRETIC_CHOICE_UNITS", [{ kind: "KIND_UNIT", key: "UNIT_SCOUT" }], "LOC_UNIT_NOTE", true],
    ["CHOOSE_SYNCRETISM_INFRASTRUCTURE", 7001, -1, "CIVILIZATION_ABBASID", "LOC_ABB", "SYNCRETIC_CHOICE_INFRASTRUCTURE", [{ kind: "KIND_CONSTRUCTIBLE", key: "BUILDING_MADRASA" }, { kind: "KIND_QUARTER", key: "4444" }], "LOC_UNIT_NOTE", true],
    ["CHOOSE_SYNCRETISM_INFRASTRUCTURE", 7002, -1, "CIVILIZATION_MING", "LOC_MING", "SYNCRETIC_CHOICE_INFRASTRUCTURE", [{ kind: "KIND_CONSTRUCTIBLE", key: "BUILDING_MADRASA" }, { kind: "KIND_QUARTER", key: "4444" }], "LOC_UNIT_NOTE", true],
  ]);
  assert.ok(g._log.filter((e) => e.startsWith("scanStart(")).every((e) => e.includes('"CivilizationType":')));
  const done = withSyncretism(withUnits(world({ log: [] }), []), { chosen: 7001 }); done._log = [];
  assert.equal(runOffers(done).offers.filter((o) => o.kind.startsWith("CHOOSE_SYNCRETISM")).length, 0, "a made choice is not offered again");
});

test("perform a syncretism choice re-checks the civilization is in that kind's list and reads back the identity", () => {
  const g = withSyncretism(withUnits(world({ log: [] }), [])); g._log = [];
  assert.equal(runPerform(g, "CHOOSE_SYNCRETISM_UNITS", 7002, { pre: -1 }).refused.code, "ACTION_NOT_STARTABLE", "Ming is only an infrastructure choice here");
  const r = runPerform(g, "CHOOSE_SYNCRETISM_INFRASTRUCTURE", 7002, { pre: -1 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "CHOOSE_SYNCRETISM_INFRASTRUCTURE", arg: 7002, syncreticCiv: 7002, matches: true });
  assert.ok(g._log.find((e) => e === 'ssendRequest(1,6102,{"CivilizationType":7002})'));
  assert.equal(runPerform(g, "CHOOSE_SYNCRETISM_UNITS", 7001, { pre: -1 }).refused.code, "ACTION_EXPIRED", "made once");
});

test("a migrant's resettle lists the engine's plots with what each would build and sends the plot alone; the unit being spent is the proof", () => {
  const g = withUnitCommands(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ok: ["RESETTLE"], plots: [1011, 1012], gone: true }); g._log = [];
  g.UnitCommandTypes.RESETTLE = 7007;
  g.GameInfo.Constructibles = table([{ $hash: 31, ConstructibleType: "IMPROVEMENT_FARM" }, { $hash: 32, ConstructibleType: "IMPROVEMENT_MINE" }]);
  const prev = g.Game.UnitCommands;
  g.Game.UnitCommands = { canStart: (uid, cmd, args, show) => { if (cmd !== 7007) return prev.canStart(uid, cmd, args, show); g._log.push(`rcanStart(${JSON.stringify(args)})`); return { Success: true, Plots: [1011, 1012], ConstructibleTypes: [31, 32] }; },
                          sendRequest: (uid, cmd, args) => { if (cmd !== 7007) return prev.sendRequest(uid, cmd, args); g._log.push(`rsendRequest(${JSON.stringify(args)})`); g.Players.get(1).Units = { getUnits: () => [] }; } };
  const r = runOffers(g).offers.filter((o) => o.kind === "RESETTLE");
  assert.deepEqual(r.map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.expect, o.constructibleKey, o.canStart]), [[5, 11, 10, 1, "gone", "IMPROVEMENT_FARM", true], [5, 12, 10, 1, "gone", "IMPROVEMENT_MINE", true]]);
  assert.ok(g._log.includes("rcanStart({})"), "listed with the empty argument the shipped mode uses");
  const p = runPerformArgs(g, "RESETTLE", 5, 12, 10, { pre: 1 });
  assert.equal(p.refused, null);
  assert.deepEqual([p.readback.present, p.readback.matches], [false, true]);
  assert.ok(g._log.includes('rsendRequest({"X":12,"Y":10})'), "the plot alone, no ability field");
});

// ---- logistics, commanders, unique abilities and tile work (A19-A22): table-driven, shape read off the engine
function withTableActions(g, { ops = {}, cmds = {}, gold = 500 } = {}) {
  // ops/cmds: name -> { plots: [...] | null, ok: true } ; a plot list makes it a plot action
  withMap(g, {});
  g.GameplayMap = { ...g.GameplayMap, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }) };
  const me = g.Players.get(1);
  me.Treasury = { goldBalance: gold };
  let nextType = 8000;
  const opTypes = {}, cmdTypes = {}, byType = {};
  for (const n of Object.keys(ops)) { opTypes[n] = ++nextType; byType[nextType] = ["op", n]; }
  for (const n of Object.keys(cmds)) { cmdTypes[n] = ++nextType; byType[nextType] = ["cmd", n]; }
  g.UnitOperationTypes = { ...(g.UnitOperationTypes || {}), ...opTypes };
  g.UnitCommandTypes = { ...(g.UnitCommandTypes || {}), ...cmdTypes };
  const make = (prevApi, tableOf) => ({
    canStart: (uid, t, args, show) => { const hit = byType[t]; if (!hit) return prevApi ? prevApi.canStart(uid, t, args, show) : { Success: false };
      const row = tableOf(hit[1]); g._log.push(`tcanStart(${hit[1]},${JSON.stringify(args)})`);
      if (row.ok === false) return { Success: false };
      if (args.X === undefined) return { Success: true, Plots: row.plots || [] };
      if (args.X === -9999) return { Success: true, AdditionalDescription: row.detail };
      return { Success: (row.plots || []).includes(args.Y * 100 + args.X) }; },
    sendRequest: (uid, t, args) => { const hit = byType[t]; if (!hit) return prevApi ? prevApi.sendRequest(uid, t, args) : undefined;
      const row = tableOf(hit[1]); g._log.push(`tsendRequest(${hit[1]},${JSON.stringify(args)})`);
      const u = me.Units.getUnits().find((x) => x.id.id === uid.id);
      if (row.after === "gone") me.Units = { getUnits: () => me.Units.getUnits().filter((x) => x.id.id !== uid.id) };
      else if (row.after === "offmap") { u.isOnMap = false; u.location = { x: -9999, y: -9999 }; }
      else if (row.after === "moved") u.location = { x: args.X, y: args.Y };
      else if (row.after === "gold") me.Treasury.goldBalance -= 120;
      else if (row.after !== "nothing") u.Movement.movementMovesRemaining = 0; },
  });
  g.Game.UnitOperations = make(g.Game.UnitOperations, (n) => ops[n]);
  g.Game.UnitCommands = make(g.Game.UnitCommands, (n) => cmds[n]);
  return g;
}

test("table-driven operations and commands are plot actions when the engine lists plots and no-target actions when it merely allows them, each saying what proves it; destructive ones need a confirmation", () => {
  const g = withTableActions(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]),
    { ops: { REPAIR: { plots: null, detail: "LOC_REPAIR" }, REBASE: { plots: [1011, 1012] }, DISPERSE_INDEPENDENT: { plots: [1013] }, REINFORCE_ARMY: { ok: false } },
      cmds: { UPGRADE_ARMY: { plots: null, detail: "LOC_UPGRADE_ALL" }, MOVE_BY_RAIL: { plots: [1211] }, SCORCHED_EARTH: { plots: null } } }); g._log = [];
  const r = runOffers(g).offers;
  const row = (k) => r.filter((o) => o.kind === k).map((o) => [o.arg, o.arg2, o.arg3, o.pre, o.expect, o.description ?? null, o.requiresConfirmation ?? null, o.to ?? null]);
  assert.deepEqual(row("REPAIR"), [[5, -1, -1, 2, "used", "LOC_REPAIR", null, null]], "no plots: a no-target action, its moves the precondition");
  assert.deepEqual(row("REBASE"), [[5, 11, 10, 1010, "moved", null, null, { x: 11, y: 10 }], [5, 12, 10, 1010, "moved", null, null, { x: 12, y: 10 }]], "plots: one offer per engine plot, the unit's plot the precondition");
  assert.deepEqual(row("DISPERSE_INDEPENDENT"), [[5, 13, 10, 2, "used", null, true, { x: 13, y: 10 }]]);
  assert.deepEqual(row("REINFORCE_ARMY"), [], "refused by the engine: not offered");
  assert.deepEqual(row("UPGRADE_ARMY"), [[5, -1, -1, 500, "gold", "LOC_UPGRADE_ALL", null, null]], "the treasury is the precondition of a paid upgrade");
  assert.deepEqual(row("MOVE_BY_RAIL"), [[5, 11, 12, 1010, "moved", null, null, { x: 11, y: 12 }]]);
  assert.deepEqual(row("SCORCHED_EARTH"), [[5, -1, -1, 2, "used", null, true, null]]);
  assert.ok(g._log.includes('tcanStart(REPAIR,{"X":-9999,"Y":-9999,"UnitAbilityType":-1})') && g._log.includes("tcanStart(REPAIR,{})"), "probed with the sentinel, then listed with the empty argument");
  assert.ok(!g._log.some((e) => e.startsWith("tsendRequest")));
});

test("perform of a table-driven action sends the bound plot or the sentinel and reads back its own proof: moves used, unit consumed, moved, off the map, or gold paid", () => {
  const mk = (ops, cmds) => { const g = withTableActions(withUnits(world({ log: [] }), [unit(5, { location: { x: 10, y: 10 } })]), { ops, cmds }); g._log = []; return g; };
  let g = mk({ REPAIR: { plots: null } }, {});
  let r = runPerformArgs(g, "REPAIR", 5, -1, -1, { pre: 2 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "REPAIR", arg: 5, expect: "used", before: 2, after: 0, present: true, matches: true });
  assert.ok(g._log.includes('tsendRequest(REPAIR,{"X":-9999,"Y":-9999,"UnitAbilityType":-1})'));
  g = mk({ CONVERT_ADJACENT_INDEPENDENT_TO_CITYSTATE: { plots: [1013], after: "gone" } }, {});
  r = runPerformArgs(g, "CONVERT_ADJACENT_INDEPENDENT_TO_CITYSTATE", 5, 13, 10, { pre: 2 });
  assert.deepEqual([r.readback.present, r.readback.matches], [false, true], "a consumed unit proves a used action");
  assert.ok(g._log.includes('tsendRequest(CONVERT_ADJACENT_INDEPENDENT_TO_CITYSTATE,{"X":13,"Y":10})'), "the plot alone, as the shipped interface modes send it");
  g = mk({ REBASE: { plots: [1011], after: "moved" } }, {});
  r = runPerformArgs(g, "REBASE", 5, 11, 10, { pre: 1010 });
  assert.deepEqual([r.readback.after, r.readback.matches], [1011, true]);
  g = mk({ REINFORCE_ARMY: { plots: [1011], after: "offmap" } }, {});
  r = runPerformArgs(g, "REINFORCE_ARMY", 5, 11, 10, { pre: 1 });
  assert.deepEqual([r.readback.after, r.readback.present, r.readback.matches], [0, true, true], "travelling to the army: still in the roster, off the map");
  g = mk({}, { UPGRADE_ARMY: { plots: null, after: "gold" } });
  r = runPerformArgs(g, "UPGRADE_ARMY", 5, -1, -1, { pre: 500 });
  assert.deepEqual([r.readback.before, r.readback.after, r.readback.matches], [500, 380, true]);
  assert.ok(g._log.includes('tsendRequest(UPGRADE_ARMY,{"X":-9999,"Y":-9999,"UnitAbilityType":-1})'));
  g = mk({}, { MOVE_BY_RAIL: { plots: [1211], after: "moved" } });
  assert.equal(runPerformArgs(g, "MOVE_BY_RAIL", 5, 11, 12, { pre: 1010 }).readback.matches, true);
  g = mk({ REPAIR: { plots: null } }, {});
  assert.equal(runPerformArgs(g, "REPAIR", 5, -1, -1, { pre: 1 }).refused.code, "ACTION_EXPIRED", "moves changed since the offer");
  assert.equal(runPerformArgs(g, "REPAIR", 9, -1, -1, { pre: 2 }).refused.code, "UNKNOWN_ACTION");
  g = mk({ REBASE: { plots: [1011] } }, {});
  assert.equal(runPerformArgs(g, "REBASE", 5, 15, 15, { pre: 1010 }).refused.code, "ACTION_NOT_STARTABLE", "a plot the engine does not list is refused");
  assert.ok(!g._log.some((e) => e.startsWith("tsendRequest")));
});

// ---- first contact (the other player's id comes from the seat's own notification text)
function withFirstMeet(g, { summary = "You have met [PlayerName:2] of Abbasid Empire.", blocks = true, allow = true, notifId = 108 } = {}) {
  g.PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET = -1386024947;
  g.DiplomacyPlayerFirstMeets = { PLAYER_REALATIONSHIP_FIRSTMEET_UNKNOWN: -1, PLAYER_REALATIONSHIP_FIRSTMEET_UNFRIENDLY: -152793613, PLAYER_REALATIONSHIP_FIRSTMEET_NEUTRAL: 673478009, PLAYER_REALATIONSHIP_FIRSTMEET_FRIENDLY: 2135616342 };
  g.Players.get(1).DiplomacyTreasury = { diplomacyBalance: 796.4 };
  g.Game.Diplomacy = { getFirstMeetResponseCostAndRelDelta: () => [13, -20], getFM_RevealCapitalsString: () => "LOC_REVEAL" };
  g.Game.Notifications.getEndTurnBlockingType = () => 781;
  g.Game.Notifications.getIdsForPlayer = () => [{ owner: 1, id: notifId, type: 20 }];
  g.Game.Notifications.find = () => ({ Type: 77, BlocksTurnAdvancement: blocks });
  g.Game.Notifications.getTypeName = () => "NOTIFICATION_PLAYER_MET";
  g.Game.Notifications.getBlocksTurnAdvancement = () => blocks;
  g.Game.Notifications.getSummary = () => summary;
  const inner = g.Game.PlayerOperations;
  g.Game.PlayerOperations = {
    canStart: (pid, op, args, show) => { if (op !== -1386024947) return inner.canStart(pid, op, args, show); g._log.push(`mcanStart(${pid},${JSON.stringify(args)},${show})`); return { Success: allow }; },
    sendRequest: (pid, op, args) => { if (op !== -1386024947) return inner.sendRequest(pid, op, args); g._log.push(`msendRequest(${pid},${JSON.stringify(args)})`); },
  };
  return g;
}

test("first contact offers the three greetings for the player the seat's own notification names", () => {
  const log = [];
  const g = withFirstMeet(world({ log })); g._log = log;
  const r = runOffers(g);
  const greet = r.offers.filter((o) => o.kind === "RESPOND_DIPLOMATIC_FIRST_MEET");
  assert.deepEqual(greet.map((o) => [o.greeting, o.arg, o.arg2, o.arg3, o.pre, o.influenceCost, o.influenceBalance, o.note, o.canStart]),
    [["FRIENDLY", 2135616342, 2, 108, 108, 13, 796, "LOC_REVEAL", true],
     ["NEUTRAL", 673478009, 2, 108, 108, 13, 796, "LOC_REVEAL", true],
     ["UNFRIENDLY", -152793613, 2, 108, 108, 13, 796, "LOC_REVEAL", true]]);
  assert.ok(log.filter((e) => e.startsWith("mcanStart(")).every((e) => e.includes('"Player1":1,"Player2":2')));
  assert.ok(!log.some((e) => e.startsWith("msendRequest")));
  const none = withFirstMeet(world({ log: [] }), { summary: "You have met a new Civilization." }); none._log = [];
  assert.equal(runOffers(none).offers.filter((o) => o.kind === "RESPOND_DIPLOMATIC_FIRST_MEET").length, 0, "no id in the text means no offer");
  const done = withFirstMeet(world({ log: [] }), { blocks: false }); done._log = [];
  assert.equal(runOffers(done).offers.filter((o) => o.kind === "RESPOND_DIPLOMATIC_FIRST_MEET").length, 0, "answered contacts are not re-offered");
});

test("perform the greeting only after re-deriving the player from the still-blocking notification", () => {
  const log = [];
  const g = withFirstMeet(world({ log })); g._log = log;
  const r = runPerformArgs(g, "RESPOND_DIPLOMATIC_FIRST_MEET", 2135616342, 2, 108, { pre: 108 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  const send = log.find((e) => e.startsWith("msendRequest("));
  assert.ok(send && send.includes('"Player1":1,"Player2":2,"Type":2135616342'));
  for (const [label, mk, t, other, nid] of [
    ["not a greeting", () => withFirstMeet(world({ log: [] })), 4242, 2, 108],
    ["player mismatch", () => withFirstMeet(world({ log: [] })), 2135616342, 3, 108],
    ["notification gone", () => withFirstMeet(world({ log: [] }), { notifId: 999 }), 2135616342, 2, 108],
    ["no longer blocking", () => withFirstMeet(world({ log: [] }), { blocks: false }), 2135616342, 2, 108],
    ["canStart false", () => withFirstMeet(world({ log: [] }), { allow: false }), 2135616342, 2, 108],
    ["greeting the seat itself", () => withFirstMeet(world({ log: [] }), { summary: "You have met [PlayerName:1] of X." }), 2135616342, 1, 108],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "RESPOND_DIPLOMATIC_FIRST_MEET", t, other, nid, { pre: 108 });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("msendRequest")), `${label}: must not send`);
  }
});

// ---- trade routes: make the route in range, otherwise send the merchant walking to the city
function withTrade(g, { routes = [[{ owner: 2, id: 5, type: 1 }, "SUCCESS"]], merchant = true, inRange = true, moves = 2, active = 0, path = true, moveOk = true, moved = true } = {}) {
  const units = [unit(5, { location: { x: 10, y: 10 }, Movement: { movementMovesRemaining: moves } })];
  withUnits(g, units);
  g.GameInfo.Units = table([{ $hash: 99, UnitType: "UNIT_MERCHANT", MakeTradeRoute: merchant }]);
  g.UnitCommandTypes = { MAKE_TRADE_ROUTE: 472083904, PROMOTE: -1259482049 };
  g.UnitOperationTypes = { ...(g.UnitOperationTypes || {}), MOVE_TO: 1477390184, SKIP_TURN: 745019656 };
  g.UnitOperationMoveModifiers = { NONE: 0, ATTACK: 16, MOVE_IGNORE_UNEXPLORED_DESTINATION: 16384 };
  g.TradeRouteStatus = { INVALID: 0, SUCCESS: -327245337, DISTANCE: -1224148699 };
  const cities = { 5: { id: { owner: 2, id: 5, type: 1 }, name: "LOC_FAR", location: { x: 30, y: 30 }, getPurchasedPlots: () => [3030, 2929, 3131] } };
  g.Cities = { get: (cid) => cities[cid.id] ?? null };
  g.GameplayMap = { ...(g.GameplayMap || {}), getIndexFromXY: (x, y) => y * 100 + x, getLocationFromIndex: (i) => ({ x: i % 100, y: Math.floor(i / 100) }),
    getPlotDistance: (x1, y1, x2, y2) => Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2)) };
  g.Units = { ...(g.Units || {}), getPathTo: (uid, loc) => { g._log.push(`path(${loc.x},${loc.y})`); return path ? { plots: [1, 2, 3], turns: [1, 2, 3] } : { plots: [], turns: [] }; } };
  const me = g.Players.get(1);
  me.Trade = { projectPossibleTradeRoutes: () => routes.map(([cid, st]) => ({ targetCityId: cid, status: [g.TradeRouteStatus[st]], domain: 0, pathPlots: [1, 2, 3, 4, 5] })), countPlayerTradeRoutes: () => active };
  g.Game.UnitCommands = {
    canStart: (uid, cmd, args, show) => { g._log.push(`tcanStart(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)},${show})`); return { Success: cmd === 472083904 && inRange && args.X === 30 && args.Y === 30 }; },
    sendRequest: (uid, cmd, args) => { g._log.push(`tsendRequest(${JSON.stringify(uid)},${cmd},${JSON.stringify(args)})`); },
  };
  const prev = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { if (op !== 1477390184) return prev ? prev.canStart(uid, op, args, show) : { Success: true }; g._log.push(`mcanStart(${JSON.stringify(args)})`); return { Success: moveOk }; },
    sendRequest: (uid, op, args) => { if (op !== 1477390184) return prev ? prev.sendRequest(uid, op, args) : undefined; g._log.push(`msendRequest(${JSON.stringify(args)})`); if (moved) units[0].location = { x: 11, y: 11 }; },
  };
  return g;
}

test("a merchant in range is offered the route; one out of range is offered a walk to the nearest city plot a path reaches", () => {
  const log = [];
  const g = withTrade(world({ log })); g._log = log;
  const r = runOffers(g);
  const tr = r.offers.filter((o) => o.kind === "MAKE_TRADE_ROUTE");
  assert.deepEqual(tr.map((o) => [o.arg, o.arg2, o.arg3, o.cityName, o.targetPlayerId, o.domain, o.routeLength, o.inRange, o.activeRoutes]), [[5, 30, 30, "LOC_FAR", 2, "land", 5, true, 0]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "SEND_MERCHANT"), []);
  assert.deepEqual(r.context.tradeRoutes, { possible: 1, merchants: 1, active: 0 });
  const far = withTrade(world({ log: [] }), { inRange: false }); far._log = [];
  const fr = runOffers(far);
  assert.deepEqual(fr.offers.filter((o) => o.kind === "MAKE_TRADE_ROUTE"), []);
  const send = fr.offers.filter((o) => o.kind === "SEND_MERCHANT");
  assert.deepEqual(send.map((o) => [o.arg, o.arg2, o.arg3, o.cityName, o.inRange, o.pathTurns, o.pre]), [[5, 29, 29, "LOC_FAR", false, 3, 1010]], "the nearest plot of the city, by distance");
  assert.ok(!far._log.some((e) => e.startsWith("tsendRequest") || e.startsWith("msendRequest")));
});

test("no send without moves, without a path, past a distance-refused route, or for a unit that cannot trade", () => {
  for (const [label, opts] of [["no moves", { inRange: false, moves: 0 }], ["no path", { inRange: false, path: false }], ["engine refuses the move", { inRange: false, moveOk: false }],
                               ["route refused", { inRange: false, routes: [[{ owner: 2, id: 5, type: 1 }, "DISTANCE"]] }], ["not a merchant", { inRange: false, merchant: false }]]) {
    const g = withTrade(world({ log: [] }), opts); g._log = [];
    const r = runOffers(g);
    assert.deepEqual(r.offers.filter((o) => o.kind === "SEND_MERCHANT" || o.kind === "MAKE_TRADE_ROUTE"), [], label);
  }
});

test("perform MAKE_TRADE_ROUTE re-checks the projection and the unit's plot, then sends the destination", () => {
  const log = [];
  const g = withTrade(world({ log })); g._log = log;
  const r = runPerformArgs(g, "MAKE_TRADE_ROUTE", 5, 30, 30, { pre: 1010 });
  assert.equal(r.refused, null);
  assert.equal(r.outcome, "sent");
  assert.ok(log.find((e) => e.startsWith("tsendRequest(") && e.includes('"X":30,"Y":30')));
  for (const [label, mk, uid, x, y, pre] of [
    ["unknown unit", () => withTrade(world({ log: [] })), 9, 30, 30, 1010],
    ["unit moved", () => withTrade(world({ log: [] })), 5, 30, 30, 7],
    ["destination not projected", () => withTrade(world({ log: [] })), 5, 31, 31, 1010],
    ["route now refused", () => withTrade(world({ log: [] }), { routes: [[{ owner: 2, id: 5, type: 1 }, "DISTANCE"]] }), 5, 30, 30, 1010],
    ["out of range", () => withTrade(world({ log: [] }), { inRange: false }), 5, 30, 30, 1010],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "MAKE_TRADE_ROUTE", uid, x, y, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("tsendRequest")), `${label}: must not send`);
  }
});

test("perform SEND_MERCHANT sends a plain move with the ignore-unexplored modifier and confirms on the merchant having set off", () => {
  const log = [];
  const g = withTrade(world({ log }), { inRange: false }); g._log = log;
  const r = runPerformArgs(g, "SEND_MERCHANT", 5, 29, 29, { pre: 1010 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "SEND_MERCHANT", arg: 5, target: { x: 29, y: 29 }, from: 1010, at: 1111, matches: true });
  const send = log.find((e) => e.startsWith("msendRequest("));
  assert.ok(send.includes('"X":29,"Y":29,"Modifiers":16384') && !send.includes("16400"), "never the attack modifier");
  for (const [label, mk, uid, x, y, pre] of [
    ["unknown unit", () => withTrade(world({ log: [] }), { inRange: false }), 9, 29, 29, 1010],
    ["unit moved", () => withTrade(world({ log: [] }), { inRange: false }), 5, 29, 29, 7],
    ["no path", () => withTrade(world({ log: [] }), { inRange: false, path: false }), 5, 29, 29, 1010],
    ["engine refuses", () => withTrade(world({ log: [] }), { inRange: false, moveOk: false }), 5, 29, 29, 1010],
    ["not a merchant", () => withTrade(world({ log: [] }), { inRange: false, merchant: false }), 5, 29, 29, 1010],
  ]) {
    const h = mk(); const l = []; h._log = l;
    assert.ok(runPerformArgs(h, "SEND_MERCHANT", uid, x, y, { pre }).refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("msendRequest")), `${label}: must not send`);
  }
  const stuck = withTrade(world({ log: [] }), { inRange: false, moved: false }); stuck._log = [];
  const rr = runPerformArgs(stuck, "SEND_MERCHANT", 5, 29, 29, { pre: 1010 });
  assert.equal(rr.outcome, "sent");
  assert.equal(rr.readback.matches, false);
});

// ---- standing unit orders (fortify / alert / sleep / heal)
function withOrders(g, { allow = ["UNITOPERATION_SLEEP", "UNITOPERATION_REST_UNTIL_HEALED"], damage = 84 } = {}) {
  const units = [unit(5, { Health: { damage, maxDamage: 100 } })];
  withUnits(g, units);
  const rows = [
    { $hash: -744032280, OperationType: "UNITOPERATION_FORTIFY", VisibleInUI: true, Name: "LOC_FORT", Description: "LOC_FORT_D" },
    { $hash: -448283625, OperationType: "UNITOPERATION_ALERT", VisibleInUI: true, Name: "LOC_ALERT", Description: "LOC_ALERT_D" },
    { $hash: -41338758, OperationType: "UNITOPERATION_SLEEP", VisibleInUI: true, Name: "LOC_SLEEP", Description: "LOC_SLEEP_D" },
    { $hash: 1576905647, OperationType: "UNITOPERATION_REST_UNTIL_HEALED", VisibleInUI: true, Name: "LOC_HEAL", Description: "LOC_HEAL_D" },
    { $hash: 999, OperationType: "UNITOPERATION_PILLAGE", VisibleInUI: true, Name: "LOC_PIL", Description: "LOC_PIL_D" },
  ];
  g.GameInfo.UnitOperations = { lookup: (k) => rows.find((r) => r.$hash === k || r.OperationType === k) ?? null };
  g.GameInfo.UnitOperations[Symbol.iterator] = function* () { yield* rows; };
  const inner = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { const row = rows.find((r) => r.$hash === op); if (!row) return inner.canStart(uid, op, args, show);
      g._log.push(`ocanStart(${JSON.stringify(uid)},${row.OperationType},${JSON.stringify(args)},${show})`); return { Success: allow.includes(row.OperationType) }; },
    sendRequest: (uid, op, args) => { const row = rows.find((r) => r.$hash === op); if (!row) return inner.sendRequest(uid, op, args);
      g._log.push(`osendRequest(${JSON.stringify(uid)},${row.OperationType},${JSON.stringify(args)})`); const u = units.find((x) => x.id.id === uid.id); if (u) u.isReadyToMove = false; },
  };
  return g;
}

test("standing orders are offered only where the engine accepts them, and carry the unit's damage", () => {
  const log = [];
  const g = withOrders(world({ log })); g._log = log;
  const orders = runOffers(g).offers.filter((o) => o.kind === "UNIT_ORDER");
  assert.deepEqual(orders.map((o) => [o.arg, o.arg2, o.pre, o.orderKey, o.displayName, o.description, o.damage, o.maxDamage, o.canStart]),
    [[5, -41338758, 2, "UNITOPERATION_SLEEP", "LOC_SLEEP", "LOC_SLEEP_D", 84, 100, true],
     [5, 1576905647, 2, "UNITOPERATION_REST_UNTIL_HEALED", "LOC_HEAL", "LOC_HEAL_D", 84, 100, true]]);
  assert.ok(!orders.some((o) => o.orderKey === "UNITOPERATION_PILLAGE"), "an order needing a target is never offered here");
  assert.ok(log.filter((e) => e.startsWith("ocanStart(")).every((e) => e.includes('"X":-9999,"Y":-9999,"UnitAbilityType":-1')));
  assert.ok(!log.some((e) => e.startsWith("osendRequest")));
});

test("perform UNIT_ORDER restricts the operation to the standing set, re-checks movement, and reads back", () => {
  const log = [];
  const g = withOrders(world({ log })); g._log = log;
  const r = runPerformArgs(g, "UNIT_ORDER", 5, 1576905647, 0, { pre: 2 });
  assert.equal(r.refused, null);
  assert.deepEqual(r.readback, { kind: "UNIT_ORDER", arg: 5, order: "UNITOPERATION_REST_UNTIL_HEALED", isReadyToMove: false, matches: true });
  assert.ok(log.find((e) => e.startsWith("osendRequest(") && e.includes("REST_UNTIL_HEALED")));
  for (const [label, mk, uid, op, pre] of [
    ["unknown unit", () => withOrders(world({ log: [] })), 9, 1576905647, 2],
    ["movement changed", () => withOrders(world({ log: [] })), 5, 1576905647, 0],
    ["not a standing order", () => withOrders(world({ log: [] })), 5, 999, 2],
    ["not a definition", () => withOrders(world({ log: [] })), 5, 4242, 2],
    ["canStart false", () => withOrders(world({ log: [] }), { allow: [] }), 5, 1576905647, 2],
  ]) {
    const h = mk(); const l = []; h._log = l;
    const rr = runPerformArgs(h, "UNIT_ORDER", uid, op, 0, { pre });
    assert.ok(rr.refused, `${label}: expected refusal`);
    assert.ok(!l.some((e) => e.startsWith("osendRequest")), `${label}: must not send`);
  }
});
