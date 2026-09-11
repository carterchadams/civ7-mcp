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
const SP = { isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false };
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
    Locale: { compose: (k) => ({ LOC_P: "Pottery", LOC_W: "Writing", LOC_M: "Mysticism" })[k] ?? k },
    document: { getElementById: (id) => (id === "hotseat-screen-curtain" && curtain ? {} : null) },
  };
}
const renderOffers = (id, mode) => offersRaw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode));
const renderPerform = (id, mode, kind, arg, turn, age, arg2 = 0, arg3 = 0) => performRaw.replaceAll("BOUND_PLAYER_ID", String(id)).replaceAll("ALLOWED_MODE", JSON.stringify(mode)).replaceAll("OP_KIND", JSON.stringify(kind)).replaceAll("OP_ARG2", String(arg2)).replaceAll("OP_ARG3", String(arg3)).replaceAll("OP_ARG", String(arg)).replaceAll("EXPECTED_TURN", String(turn)).replaceAll("EXPECTED_AGE", String(age));
const runPerformArgs = (g, kind, arg, arg2, arg3, { id = 1, mode = "singleplayer", turn = 10, age = 4242 } = {}) => JSON.parse(vm.runInContext(renderPerform(id, mode, kind, arg, turn, age, arg2, arg3), vm.createContext({ ...g }), { timeout: 2000 }));
const runOffers = (g, id = 1, mode = "singleplayer") => JSON.parse(vm.runInContext(renderOffers(id, mode), vm.createContext({ ...g }), { timeout: 2000 }));
const runPerform = (g, kind, arg, { id = 1, mode = "singleplayer", turn = 10, age = 4242 } = {}) => JSON.parse(vm.runInContext(renderPerform(id, mode, kind, arg, turn, age), vm.createContext({ ...g }), { timeout: 2000 }));

// ---- offers.js

test("offers enumerate research/civic choices with native canStart and an end-turn offer with native blocker state", () => {
  const log = [];
  const r = runOffers(world({ log }));
  assert.equal(r.refused, null);
  assert.deepEqual(r.context, { turn: 10, age: 4242, playerId: 1, localPlayerId: 1, localObserverId: 1, mode: "singleplayer", isTurnActive: true, curtainDisplayed: false });
  const research = r.offers.filter((o) => o.kind === "SET_TECH_TREE_NODE");
  assert.deepEqual(research.map((o) => [o.arg, o.typeKey, o.displayName, o.tree, o.cost, o.turns, o.canStart]), [[701, "NODE_TECH_AQ_POTTERY", "Pottery", "TREE_TECHS_AQ", 60, 4, true], [702, "NODE_TECH_AQ_WRITING", "Writing", "TREE_TECHS_AQ", 100, 7, true]]);
  assert.deepEqual(r.offers.filter((o) => o.kind === "SET_CULTURE_TREE_NODE").map((o) => o.typeKey), ["NODE_CIVIC_AQ_MAIN_MYSTICISM"]);
  const end = r.offers.find((o) => o.kind === "END_TURN");
  assert.deepEqual(end, { kind: "END_TURN", arg: 0, canStart: true, blockingType: null, alreadySent: false });
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
  const r = runPerform(world({ researchAfter: 702 }), "SET_TECH_TREE_NODE", 701);
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
function withMap(g, { hiddenAt = [], moveOk = true } = {}) {
  g.UnitOperationTypes = { ...(g.UnitOperationTypes || {}), SKIP_TURN: 745019656, MOVE_TO: 1477390184 };
  g.UnitOperationMoveModifiers = { NONE: 0, ATTACK: 16, MOVE_IGNORE_UNEXPLORED_DESTINATION: 16384 };
  g.RevealedStates = { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 };
  g.DirectionTypes = { NO_DIRECTION: -1, DIRECTION_NORTHEAST: 0, DIRECTION_EAST: 1, DIRECTION_SOUTHEAST: 2, DIRECTION_SOUTHWEST: 3, DIRECTION_WEST: 4, DIRECTION_NORTHWEST: 5, NUM_DIRECTION_TYPES: 6 };
  const neighbours = (loc, d) => [{ x: loc.x, y: loc.y + 1 }, { x: loc.x + 1, y: loc.y }, { x: loc.x, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y - 1 }, { x: loc.x - 1, y: loc.y }, { x: loc.x - 1, y: loc.y + 1 }][d];
  g.GameplayMap = { getAdjacentPlotLocation: (loc, d) => { g._log.push(`adj(${loc.x},${loc.y},${d})`); return neighbours(loc, d); }, getRevealedState: (pid, x, y) => { g._log.push(`vis(${pid},${x},${y})`); return hiddenAt.some(([hx, hy]) => hx === x && hy === y) ? 0 : 2; }, getTerrainType: () => 1 };
  g.GameInfo.Terrains = table([{ $hash: 1, TerrainType: "TERRAIN_FLAT" }]);
  const prev = g.Game.UnitOperations;
  g.Game.UnitOperations = {
    canStart: (uid, op, args, show) => { g._log.push(`ucanStart(${JSON.stringify(uid)},${op},${JSON.stringify(args)},${show})`); if (op === 1477390184) return { Success: moveOk && uid.owner === 1 }; return prev ? prev.canStart(uid, op, args, show) : { Success: true }; },
    sendRequest: (uid, op, args) => { g._log.push(`usendRequest(${JSON.stringify(uid)},${op},${JSON.stringify(args)})`); if (op === 1477390184) { const u = g.Players.get(1).Units.getUnits().find((x) => x.id.id === uid.id); if (u) u.location = { x: args.X, y: args.Y }; } else if (prev) prev.sendRequest(uid, op, args); },
  };
  return g;
}

test("move offers cover adjacent known plots only, with canStart(MOVE_TO) and Modifiers NONE", () => {
  const log = [];
  const g = withMap(withUnits(world({ log }), [unit(5, { location: { x: 10, y: 10 } })]), { hiddenAt: [[11, 10]] }); g._log = log;
  const r = runOffers(g);
  const moves = r.offers.filter((o) => o.kind === "MOVE_UNIT");
  assert.equal(moves.length, 5, "six neighbours minus one hidden");
  assert.ok(moves.every((o) => o.arg === 5 && o.canStart === true && typeof o.x === "number" && typeof o.y === "number" && o.direction >= 0 && o.terrainKey === "TERRAIN_FLAT"));
  assert.ok(!moves.some((o) => o.x === 11 && o.y === 10), "hidden plot must not be offered");
  const moveChecks = log.filter((e) => e.startsWith("ucanStart(") && e.includes("1477390184"));
  assert.equal(moveChecks.length, 5);
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
  ]) {
    const g = mk(); const log = []; g._log = log;
    const r = runPerformArgs(g, "MOVE_UNIT", uid, x, y);
    assert.ok(r.refused, `${label}: expected refusal`);
    assert.ok(!log.some((e) => e.startsWith("usendRequest")), `${label}: must not send`);
  }
});
