// payloads/curtain.js against a fake hotseat DOM: stale curtains go, the newest stays unless raising,
// and the advisor popup's Confirm button receives the same engine input a keypress would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "src", "civ7_observer", "payloads", "curtain.js"), "utf8");

function dom({ curtains = 3, popup = true } = {}) {
  const events = [];
  const nodes = [];
  for (let i = 0; i < curtains; i++) nodes.push({ tag: "hotseat-curtain", removed: false, remove() { this.removed = true; } });
  const button = { role: "button", textContent: " Confirm Selection ", dispatchEvent(e) { events.push(e); return true; } };
  const other = { role: "button", textContent: "Cultural Advisor", dispatchEvent(e) { events.push({ wrong: true }); return true; } };
  const document = {
    querySelectorAll(sel) { if (sel === "hotseat-curtain") return nodes.filter((n) => !n.removed); if (sel === "[role=button]") return [other, button]; return []; },
    querySelector(sel) { return sel === "advisor-council-popup" && popup ? { querySelectorAll: (s) => document.querySelectorAll(s) } : null; },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; this.bubbles = init.bubbles; } }
  return { document, events, nodes, CustomEvent, UI: { isInGame: () => true }, Configuration: { getGame: () => ({ isHotseat: true }) }, Locale: { compose: (k) => (k === "LOC_ADVISOR_COUNCIL_CONFIRM" ? "Confirm Selection" : k) }, InputActionStatuses: { START: 0, FINISH: 1 } };
}
const run = (g, mode) => JSON.parse(vm.runInContext(raw.replaceAll("CURTAIN_MODE", JSON.stringify(mode)), vm.createContext(g), { timeout: 2000 }));

test("prune removes every curtain but the newest and confirms the advisor popup through an engine input", () => {
  const g = dom({ curtains: 3 });
  const r = run(g, "prune");
  assert.equal(r.refused, null);
  assert.deepEqual([r.curtainsBefore, r.curtainsRemoved, r.curtainsAfter], [3, 2, 1]);
  assert.deepEqual(g.nodes.map((n) => n.removed), [true, true, false]);
  assert.deepEqual(r.advisorPopup, { present: true, confirmed: true });
  assert.equal(g.events.length, 1);
  assert.equal(g.events[0].type, "engine-input");
  assert.equal(JSON.stringify(g.events[0].detail), JSON.stringify({ name: "keyboard-enter", status: 1 }));
});

test("raise removes every curtain; a missing popup is reported, not an error", () => {
  const g = dom({ curtains: 2, popup: false });
  const r = run(g, "raise");
  assert.deepEqual([r.curtainsBefore, r.curtainsRemoved, r.curtainsAfter], [2, 2, 0]);
  assert.deepEqual(r.advisorPopup, { present: false, confirmed: false });
  assert.equal(g.events.length, 0);
});

test("the payload refuses outside a hotseat game and for an unknown mode, touching nothing", () => {
  const g = dom(); g.Configuration = { getGame: () => ({ isHotseat: false }) };
  assert.equal(run(g, "raise").refused.code, "UNSUPPORTED_GAME_MODE");
  assert.ok(g.nodes.every((n) => !n.removed));
  const h = dom(); h.UI = { isInGame: () => false };
  assert.equal(run(h, "prune").refused.code, "NOT_IN_GAME");
  const k = dom();
  assert.equal(run(k, "dismiss").refused.code, "INVALID_ARGUMENT");
  assert.ok(k.nodes.every((n) => !n.removed));
});
