import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// importing dev/cli.ts runs nothing: its command dispatch is guarded by argv
process.argv[1] = "not-the-cli";
const { transpile } = await import("../dev/cli.ts");

test("a built module pins every relative import to the build id and stamps build and marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "civ7-build-"));
  const src = join(dir, "service.ts");
  writeFileSync(src, `import { MARKER } from "./marker.ts";\nimport type { X } from "./types.ts";\nexport const id: string = "__BUILD_ID__";\nexport const m = MARKER + "__MARKER__";\nexport const lazy = () => import("./late.ts");\n`);
  const out = transpile(src, "b-1", "B");
  assert.match(out, /from "\.\/marker\.js\?b=b-1"/, "static import pinned");
  assert.match(out, /import\("\.\/late\.js\?b=b-1"\)/, "dynamic import pinned");
  assert.doesNotMatch(out, /types\.ts|import type/, "type-only imports are erased");
  assert.match(out, /"b-1"/);
  assert.match(out, /MARKER \+ "B"/);
  assert.doesNotMatch(out, /__BUILD_ID__|__MARKER__/);
});
