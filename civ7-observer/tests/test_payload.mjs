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

test("payload never enumerates or mutates hidden globals", () => {
  const touched = [];
  const spy = new Proxy({}, { get(_, k) { touched.push(String(k)); return undefined; } });
  const r = run({
    UI: { isInGame: () => true },
    GameContext: { localPlayerID: 0, localObserverID: 0 },
    Game: { turn: 1 },
    Players: spy,
    GameplayMap: spy,
    Configuration: spy,
  });
  assert.equal(r.inGame, true);
  assert.deepEqual(touched, [], "probe must only test presence, not read members of game collections");
});

test("payload source contains no forbidden operations", () => {
  for (const bad of ["Game.PlayerOperations", "sendRequest", "revealAll", "localStorage", "setTimeout", "import ", "document.", "Players.get(", "humanPlayerIDs", "aiPlayerIDs", "getRevealedState", "Configuration.getGame"]) {
    assert.ok(!source.includes(bad), `forbidden token in payload: ${bad}`);
  }
});
