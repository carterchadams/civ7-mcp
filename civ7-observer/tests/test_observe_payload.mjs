// Offline tests for payloads/observe.js (Change 3: settlements + units).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "observe.js"), "utf8");

function render(boundId, mode) {
  return raw.replaceAll("BOUND_PLAYER_ID", String(boundId)).replaceAll("ALLOWED_MODE", JSON.stringify(mode));
}
function run(globals, boundId = 1, mode = "singleplayer") {
  const ctx = vm.createContext({ ...globals });
  const out = vm.runInContext(render(boundId, mode), ctx, { timeout: 2000 });
  assert.equal(typeof out, "string");
  return JSON.parse(out);
}
function table(rows) {
  return { length: rows.length, lookup: (h) => rows.find((r) => r.$hash === h) ?? null };
}
const SP = { isHotseat: false, isLocalMultiplayer: false, isNetworkMultiplayer: false, isInternetMultiplayer: false, isLANMultiplayer: false, isAnyMultiplayer: false, isPlayByCloud: false, isMatchMaking: false };
const HOTSEAT = { ...SP, isHotseat: true, isLocalMultiplayer: true, isAnyMultiplayer: true };

function game({ log = [], flags = SP, local = 1, turnActive = true, units, cities, turnSeq } = {}) {
  const turns = turnSeq ? [...turnSeq] : null;
  const me = {
    id: local, isTurnActive: turnActive, isAlive: true, isHuman: true,
    Cities: { getCities: () => cities ?? [
      { id: { owner: local, id: 65536, type: 1 }, owner: local, name: "LOC_MADRID", location: { x: 63, y: 15 }, isTown: false, isCapital: true, population: 6, ruralPopulation: 4, urbanPopulation: 2, BuildQueue: { currentProductionTypeHash: -1563767818, isEmpty: false } },
      { id: { owner: local, id: 131073, type: 1 }, owner: local, name: "LOC_SEVILLA", location: { x: 60, y: 14 }, isTown: true, isCapital: false, population: 2, ruralPopulation: 1, urbanPopulation: 1, BuildQueue: { currentProductionTypeHash: -1, isEmpty: true } },
    ] },
    Units: { getUnits: () => units ?? [
      { id: { owner: local, id: 131072, type: 26 }, owner: local, type: 99, name: "Scout", location: { x: 59, y: 35 }, isOnMap: true, isEmbarked: false, isDead: false, isValid: true, isCommanderUnit: false, armyId: { owner: -1, id: -1, type: 0 }, Movement: { movementMovesRemaining: 2, maxMoves: 2 }, Health: { damage: 32, maxDamage: 100 } },
    ] },
  };
  const other = new Proxy({}, { get(_, k) { log.push(`other.${String(k)}`); return undefined; } });
  return {
    UI: { isInGame: () => true, isMultiplayer: () => flags.isAnyMultiplayer },
    Game: { get turn() { if (turns && turns.length > 1) return turns.shift(); return turns ? turns[0] : 15; }, age: 4242 },
    GameContext: { localPlayerID: local, localObserverID: local },
    Players: { get: (id) => { log.push(`Players.get(${id})`); return id === local ? me : other; } },
    Configuration: { getGame: () => new Proxy({ ...flags, humanPlayerIDs: [0, 1], gameSeed: 1 }, { get(t, k) { log.push(`cfg.${String(k)}`); return t[k]; } }) },
    GameplayMap: new Proxy({}, { get(_, k) { log.push(`map.${String(k)}`); return () => 0; } }),
    GameInfo: { Units: table([{ $hash: 99, UnitType: "UNIT_SCOUT" }, { $hash: -1563767818, UnitType: "UNIT_HOPLITE" }]), Constructibles: table([]), Projects: table([]), Ages: table([{ $hash: 4242, AgeType: "AGE_ANTIQUITY" }]) },
    Locale: { compose: (k) => ({ LOC_MADRID: "Madrid", LOC_SEVILLA: "Sevilla" })[k] ?? k },
  };
}

test("serializes the bound player's settlements and units with stable ids", () => {
  const r = run(game(), 1);
  assert.equal(r.refused, null);
  assert.equal(r.payloadVersion, 1);
  assert.deepEqual(r.context, { turn: 15, age: 4242, ageType: "AGE_ANTIQUITY", playerId: 1, localPlayerId: 1, localObserverId: 1, mode: "singleplayer", isTurnActive: true });
  assert.equal(r.settlements.length, 2);
  const [madrid, sevilla] = r.settlements;
  assert.deepEqual(madrid.id, { owner: 1, id: 65536, type: 1 });
  assert.equal(madrid.displayName, "Madrid");
  assert.equal(madrid.nameKey, "LOC_MADRID");
  assert.deepEqual(madrid.location, { x: 63, y: 15 });
  assert.equal(madrid.isTown, false);
  assert.equal(madrid.isCapital, true);
  assert.deepEqual(madrid.population, { total: 6, rural: 4, urban: 2 });
  assert.deepEqual(madrid.production, { status: "supported", isEmpty: false, currentType: -1563767818, currentTypeKey: "UNIT_HOPLITE", currentKind: "unit" });
  assert.equal(sevilla.isTown, true);
  assert.deepEqual(sevilla.production, { status: "supported", isEmpty: true, currentType: null, currentTypeKey: null, currentKind: null });
  const [scout] = r.units;
  assert.deepEqual(scout.id, { owner: 1, id: 131072, type: 26 });
  assert.equal(scout.typeKey, "UNIT_SCOUT");
  assert.equal(scout.displayName, "Scout");
  assert.equal(scout.locationStatus, "tile");
  assert.deepEqual(scout.location, { x: 59, y: 35 });
  assert.deepEqual(scout.movement, { remaining: 2, max: 2 });
  assert.deepEqual(scout.health, { damage: 32, maxDamage: 100 });
  assert.equal(scout.isEmbarked, false);
  assert.equal(scout.isCommander, false);
  assert.equal(scout.armyId, null);
  assert.deepEqual(r.warnings, []);
});

test("never touches other players, roster lists, seeds, or the map", () => {
  const log = [];
  run(game({ log }), 1);
  assert.ok(log.filter((e) => e.startsWith("Players.get(")).every((e) => e === "Players.get(1)"));
  assert.ok(!log.some((e) => e.startsWith("other.")));
  assert.ok(!log.includes("cfg.humanPlayerIDs") && !log.includes("cfg.gameSeed"));
  assert.ok(!log.some((e) => e.startsWith("map.")), `map must not be read in Change 3: ${log}`);
});

test("refuses when the bound id is not the local seat, reading nothing", () => {
  const log = [];
  const r = run(game({ log }), 0);
  assert.equal(r.refused.code, "WRONG_PLAYER");
  assert.equal(r.settlements, null);
  assert.ok(!log.some((e) => e.startsWith("Players.get(")));
});

test("refuses hotseat unless explicitly allowed, and refuses network play always", () => {
  assert.equal(run(game({ flags: HOTSEAT }), 1, "singleplayer").refused.code, "UNSUPPORTED_GAME_MODE");
  assert.equal(run(game({ flags: HOTSEAT }), 1, "local-hotseat").refused, null);
  assert.equal(run(game({ flags: SP }), 1, "local-hotseat").refused.code, "UNSUPPORTED_GAME_MODE");
  assert.equal(run(game({ flags: { ...HOTSEAT, isNetworkMultiplayer: true } }), 1, "local-hotseat").refused.code, "UNSUPPORTED_GAME_MODE");
  assert.equal(run(game({ flags: { ...SP, isHotseat: undefined } }), 1, "singleplayer").refused.code, "UNSUPPORTED_GAME_MODE");
});

test("refuses when the bound player's turn is not active", () => {
  const r = run(game({ turnActive: false }), 1);
  assert.equal(r.refused.code, "TURN_NOT_READY");
});

test("refuses when the turn changes during extraction", () => {
  const r = run(game({ turnSeq: [15, 16] }), 1);
  assert.equal(r.refused.code, "CONTEXT_CHANGED");
});

test("distinguishes tile, off-map, and invalid locations; never maps invalid to 0,0", () => {
  const mk = (id, extra) => ({ id: { owner: 1, id, type: 26 }, owner: 1, type: 99, name: "Scout", isOnMap: true, isEmbarked: false, isDead: false, isValid: true, isCommanderUnit: false, armyId: { owner: -1, id: -1, type: 0 }, Movement: { movementMovesRemaining: 1, maxMoves: 2 }, Health: { damage: 0, maxDamage: 100 }, location: { x: 1, y: 1 }, ...extra });
  const r = run(game({ units: [
    mk(1, { location: { x: 5, y: 6 } }),
    mk(2, { isOnMap: false, location: { x: -1, y: -1 } }),
    mk(3, { location: { x: -1, y: 7 } }),
    mk(4, { location: undefined }),
    mk(5, { isDead: true }),
    mk(6, { isValid: false }),
    mk(7, { Movement: undefined, isEmbarked: true, isCommanderUnit: true, armyId: { owner: 1, id: 9, type: 3 } }),
  ] }), 1);
  const by = Object.fromEntries(r.units.map((u) => [u.id.id, u]));
  assert.deepEqual([by[1].locationStatus, by[1].location], ["tile", { x: 5, y: 6 }]);
  assert.deepEqual([by[2].locationStatus, by[2].location], ["off-map", null]);
  assert.deepEqual([by[3].locationStatus, by[3].location], ["invalid", null]);
  assert.deepEqual([by[4].locationStatus, by[4].location], ["invalid", null]);
  assert.equal(by[5], undefined);
  assert.equal(by[6], undefined);
  assert.equal(by[7].movement, null);
  assert.equal(by[7].isEmbarked, true);
  assert.equal(by[7].isCommander, true);
  assert.deepEqual(by[7].armyId, { owner: 1, id: 9, type: 3 });
  assert.ok(r.warnings.some((w) => w.code === "UNITS_SKIPPED" && w.count === 2));
});

test("a throwing roster read fails the capture instead of returning an empty list", () => {
  const g = game();
  g.Players.get(1).Units.getUnits = () => { throw new Error("boom"); };
  const r = run(g, 1);
  assert.equal(r.refused.code, "API_CONTRACT_MISMATCH");
});

test("payload source contains no forbidden operations", () => {
  for (const bad of ["sendRequest", "PlayerOperations", "UnitOperations", "revealTree", "localStorage", "setTimeout", "import ", "humanPlayerIDs", "gameSeed", "getResourceType", "getRevealedState", "Players.get(GameContext"]) {
    assert.ok(!raw.includes(bad), `forbidden token in payload: ${bad}`);
  }
});
