// Offline tests for payloads/context.js using mocked game globals.
// Run: node --test civ7-observer/tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "context.js"), "utf8");

function run(globals) {
  const ctx = vm.createContext({ ...globals });
  const raw = vm.runInContext(source, ctx, { timeout: 1000 });
  assert.equal(typeof raw, "string", "payload must return a JSON string");
  return JSON.parse(raw);
}

test("non-game realm returns well-formed result with nulls", () => {
  const r = run({});
  assert.equal(r.probeVersion, 1);
  assert.equal(r.hasUI, false);
  assert.equal(r.inGame, null);
  assert.equal(r.hasPlayers, false);
  assert.equal(r.hasMap, false);
  assert.equal(r.localPlayerId, null);
  assert.equal(r.localObserverId, null);
  assert.equal(r.turn, null);
});

test("main-menu realm reports inGame false without player context", () => {
  const r = run({ UI: { isInGame: () => false }, Players: {}, GameplayMap: {} });
  assert.equal(r.hasUI, true);
  assert.equal(r.inGame, false);
  assert.equal(r.hasPlayers, true);
  assert.equal(r.turn, null);
});

test("loaded game realm reports identity and turn", () => {
  const r = run({
    UI: { isInGame: () => true },
    Players: {},
    GameplayMap: {},
    GameContext: { localPlayerID: 1, localObserverID: 1 },
    Game: { turn: 42 },
    location: { href: "coui://ui/shell.html" },
  });
  assert.equal(r.inGame, true);
  assert.equal(r.localPlayerId, 1);
  assert.equal(r.localObserverId, 1);
  assert.equal(r.turn, 42);
  assert.equal(r.href, "coui://ui/shell.html");
});

test("throwing accessors degrade to null instead of failing the probe", () => {
  const r = run({
    UI: { isInGame: () => { throw new Error("boom"); } },
    GameContext: { get localPlayerID() { throw new Error("no"); }, localObserverID: undefined },
    Game: { get turn() { throw new Error("no"); } },
  });
  assert.equal(r.inGame, null);
  assert.equal(r.localPlayerId, null);
  assert.equal(r.localObserverId, null);
  assert.equal(r.turn, null);
});

test("payload never enumerates or mutates hidden globals; only the match identity is read from the configuration", () => {
  const touched = [];
  const spy = new Proxy({}, { get(_, k) { touched.push(String(k)); return undefined; } });
  const cfgReads = [];
  const cfg = new Proxy({ campaignSetupGUID: "ABC", gameGUIDHexString: "" }, { get(t, k) { cfgReads.push(String(k)); return t[k]; } });
  const r = run({
    UI: { isInGame: () => true },
    GameContext: { localPlayerID: 0, localObserverID: 0 },
    Game: { turn: 1, age: 1 },
    Players: spy,
    GameplayMap: spy,
    Configuration: { getGame: () => cfg },
  });
  assert.equal(r.inGame, true);
  assert.equal(r.gameGuid, "ABC");
  assert.deepEqual(touched, [], "probe must only test presence, not read members of game collections");
  assert.ok(cfgReads.every((k) => k === "campaignSetupGUID" || k === "gameGUIDHexString"), `only the match id fields may be read from the game configuration: ${cfgReads}`);
});

test("payload source contains no forbidden operations", () => {
  for (const bad of ["Game.PlayerOperations", "sendRequest", "revealAll", "localStorage", "setTimeout", "import ", "document.", "Players.get(", "humanPlayerIDs", "aiPlayerIDs", "getRevealedState", "gameSeed"]) {
    assert.ok(!source.includes(bad), `forbidden token in payload: ${bad}`);
  }
});

test("context probe reports the game guid from the configuration", () => {
  const r = run({ UI: { isInGame: () => true }, Players: {}, GameplayMap: {}, GameContext: { localPlayerID: 1, localObserverID: 1 }, Game: { turn: 4, age: 1 }, Configuration: { getGame: () => ({ gameGUIDHexString: "ABC123" }) } });
  assert.equal(r.gameGuid, "ABC123");
  assert.equal(run({}).gameGuid, null);
});

test("context probe reports the age hash", () => {
  const r = run({ UI: { isInGame: () => true }, Players: {}, GameplayMap: {}, GameContext: { localPlayerID: 1, localObserverID: 1 }, Game: { turn: 42, age: 4242 } });
  assert.equal(r.age, 4242);
  const r2 = run({});
  assert.equal(r2.age, null);
});
