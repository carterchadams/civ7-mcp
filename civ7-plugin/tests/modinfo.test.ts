import { test } from "node:test";
import assert from "node:assert/strict";
import { modinfo } from "../dev/modinfo.ts";

test("the manifest declares exactly the staged files: one UI script, the rest imported assets", () => {
  const xml = modinfo({
    id: "civ7-agent-dev", version: "0.0.1", buildId: "b1",
    files: ["ui/bootstrap.js", "ui/service/service.js", "ui/service/marker.js", "build.json", "civ7-agent-dev.modinfo"],
    uiScripts: ["ui/bootstrap.js"],
  });
  assert.match(xml, /<UIScripts>\s*<Item>ui\/bootstrap\.js<\/Item>\s*<\/UIScripts>/);
  assert.match(xml, /<ImportFiles>\s*<Item>ui\/service\/service\.js<\/Item>\s*<Item>ui\/service\/marker\.js<\/Item>\s*<\/ImportFiles>/);
  assert.doesNotMatch(xml, /build\.json|\.modinfo<\/Item>/, "metadata files are not shipped as assets");
  assert.match(xml, /<AffectsSavedGames>0<\/AffectsSavedGames>/, "a UI-only mod must not mark saves");
  assert.match(xml, /scope="game"/);
  assert.match(xml, /<Mod id="civ7-agent-dev" version="1" /, "the Mod element carries the integer version the game expects");
  assert.match(xml, /<Version>0\.0\.1<\/Version>/, "the semantic version stays in Properties");
});

test("a UI script that is not staged is refused", () => {
  assert.throws(() => modinfo({ id: "x", version: "1", buildId: "b", files: ["ui/other.js"], uiScripts: ["ui/bootstrap.js"] }), /not in staged files/);
});
