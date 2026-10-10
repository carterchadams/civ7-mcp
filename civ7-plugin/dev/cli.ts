#!/usr/bin/env node
// Developer commands for the Step 0 loop. Host-only; none of this is reachable by an agent.
//
//   node dev/cli.ts build [--marker X]   transpile service/, stamp a build id, generate the manifest
//   node dev/cli.ts stage [buildId]      install a complete inactive build at the local Mods folder
//   node dev/cli.ts status               builds, staged/previous build, AppOptions flags, game/CDP
//   node dev/cli.ts probe                read Civ7Agent.status() from the game realm (diagnostic CDP)
//   node dev/cli.ts activate [buildId]   ask the running bootstrap to replace its service (diagnostic CDP)
//   node dev/cli.ts rollback             stage the previous build again
//
// Diagnostic CDP (probe/activate) is an investigation aid permitted by the plan; the accepted
// gameplay path must not depend on it.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { modinfo } from "./modinfo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDS = join(ROOT, "build");
const MOD_ID = "civ7-agent-dev";
const MY_GAMES = process.env.CIV7_MY_GAMES ?? join(homedir(), "snap/steam/common/My Games/Sid Meier's Civilization VII");
const MODS = join(MY_GAMES, "Mods");
const CDP = process.env.CIV7_CDP ?? "http://127.0.0.1:9444";

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

function gitRev(): string {
  try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "nogit"; }
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---- build --------------------------------------------------------------------------------------

/** Transpile one TS module to an ES module and pin every relative import to this build id so
 *  transitive modules get a fresh identity too (DEV-03). */
export function transpile(src: string, buildId: string, marker: string): string {
  const out = ts.transpileModule(readFileSync(src, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    fileName: src,
  }).outputText;
  return out
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, `$1$2.js?b=${encodeURIComponent(buildId)}$3`)
    .replace(/(import\(\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, `$1$2.js?b=${encodeURIComponent(buildId)}$3`)
    .replaceAll("__BUILD_ID__", buildId)
    .replaceAll("__MARKER__", marker);
}

export function build(): string {
  const marker = arg("--marker", "A");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const buildId = `${stamp}-${gitRev()}-${marker}`;
  const out = join(BUILDS, buildId);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "ui", "service"), { recursive: true });
  // stable bootstrap: copied with its build stamp only
  writeFileSync(join(out, "ui", "bootstrap.js"), readFileSync(join(ROOT, "mod", "ui", "bootstrap.js"), "utf8").replaceAll("__BUILD_ID__", buildId));
  for (const f of readdirSync(join(ROOT, "service")).filter((f) => f.endsWith(".ts"))) {
    writeFileSync(join(out, "ui", "service", f.replace(/\.ts$/, ".js")), transpile(join(ROOT, "service", f), buildId, marker));
  }
  const files = walk(out);
  writeFileSync(join(out, `${MOD_ID}.modinfo`), modinfo({ id: MOD_ID, version: "0.0.1", buildId, files: [...files, `${MOD_ID}.modinfo`], uiScripts: ["ui/bootstrap.js"] }));
  const manifest = { buildId, marker, createdAt: new Date().toISOString(), files: Object.fromEntries(walk(out).map((f) => [f, sha(join(out, f))])) };
  writeFileSync(join(out, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(BUILDS, "latest"), buildId + "\n");
  console.log(`built ${buildId} (${Object.keys(manifest.files).length} files) at ${relative(process.cwd(), out)}`);
  return buildId;
}

// ---- stage --------------------------------------------------------------------------------------

function latest(): string {
  const p = join(BUILDS, "latest");
  if (!existsSync(p)) throw new Error("no build yet; run `dev build`");
  return readFileSync(p, "utf8").trim();
}

function stagedBuild(dir: string): string | null {
  const p = join(dir, "build.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).buildId as string) : null;
}

const PREVIOUS = join(BUILDS, "previous");   // the build id staged before the current one, for rollback

/** Install a complete build as an inactive directory swap: copy to a staging directory outside the
 *  Mods folder, verify it, then replace the install in one rename. Files are never copied one by one
 *  into a loaded module graph, and nothing but the one mod directory ever sits under Mods/: the game
 *  scans every manifest there, so a kept ".prev" copy showed up as a second mod (2026-09-18). */
export function stage(buildId = latest()): void {
  const src = join(BUILDS, buildId);
  if (!existsSync(join(src, "build.json"))) throw new Error(`no such build: ${buildId}`);
  mkdirSync(MODS, { recursive: true });
  const target = join(MODS, MOD_ID);
  const staging = join(BUILDS, ".staging");
  rmSync(staging, { recursive: true, force: true });
  cpSync(src, staging, { recursive: true });
  // verify the copy before it becomes visible
  const want = JSON.parse(readFileSync(join(src, "build.json"), "utf8")).files as Record<string, string>;
  for (const [f, h] of Object.entries(want)) {
    if (sha(join(staging, f)) !== h) throw new Error(`staged copy differs from build for ${f}`);
  }
  const previous = stagedBuild(target);
  if (previous && previous !== buildId) writeFileSync(PREVIOUS, previous + "\n");
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(staging, target);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    cpSync(staging, target, { recursive: true });   // Mods/ on another filesystem: whole-tree copy, then verify
    rmSync(staging, { recursive: true, force: true });
    for (const [f, h] of Object.entries(want)) {
      if (sha(join(target, f)) !== h) throw new Error(`installed copy differs from build for ${f}`);
    }
  }
  console.log(`staged ${buildId} at ${target}` + (previous && previous !== buildId ? ` (previous ${previous} recorded for rollback)` : ""));
}

export function rollback(): void {
  if (!existsSync(PREVIOUS)) throw new Error("no previous build to roll back to");
  stage(readFileSync(PREVIOUS, "utf8").trim());
}

// ---- status / probe -------------------------------------------------------------------------------

function appOption(key: string): string {
  const p = join(MY_GAMES, "AppOptions.txt");
  if (!existsSync(p)) return "no AppOptions.txt";
  const m = readFileSync(p, "utf8").match(new RegExp(`^(;?)${key}\\s+(\\S+)`, "m"));
  return m ? (m[1] ? `default (commented: ${m[2]})` : m[2]) : "absent";
}

async function cdpTargets(): Promise<Array<{ id: string; title: string; url: string; webSocketDebuggerUrl?: string }>> {
  const r = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()) as any;
}

async function evaluate(expression: string): Promise<unknown> {
  const { WebSocket } = await import("ws");
  const targets = (await cdpTargets()).filter((t) => t.webSocketDebuggerUrl);
  if (!targets.length) throw new Error("no CDP page target");
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl!);
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP evaluate timed out")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description ?? "exception"));
      else resolvePromise(m.result?.result?.value);
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function status(): Promise<void> {
  const builds = existsSync(BUILDS) ? readdirSync(BUILDS).filter((d) => existsSync(join(BUILDS, d, "build.json"))).sort() : [];
  console.log(`builds: ${builds.length}` + (builds.length ? `, latest ${latest()}` : ""));
  console.log(`staged: ${stagedBuild(join(MODS, MOD_ID)) ?? "none"}; previous: ${existsSync(PREVIOUS) ? readFileSync(PREVIOUS, "utf8").trim() : "none"}`);
  const strays = existsSync(MODS) ? readdirSync(MODS).filter((d) => d !== MOD_ID) : [];
  if (strays.length) console.log(`Mods/ also contains: ${strays.join(", ")} (the game scans every manifest there)`);
  console.log(`AppOptions: UIFileWatcher=${appOption("UIFileWatcher")} UIDebugger=${appOption("UIDebugger")}`);
  try {
    const t = await cdpTargets();
    console.log(`CDP: reachable, ${t.length} target(s): ${t.map((x) => x.url).join(", ")}`);
  } catch {
    console.log("CDP: not reachable (debugger disabled or game not running)");
  }
}

export async function probe(): Promise<void> {
  const v = await evaluate("JSON.stringify(globalThis.Civ7Agent ? globalThis.Civ7Agent.status() : null)");
  console.log(JSON.stringify(JSON.parse(String(v)), null, 2));
}

export async function activate(buildId = stagedBuild(join(MODS, MOD_ID)) ?? latest()): Promise<void> {
  const v = await evaluate(`globalThis.Civ7Agent ? globalThis.Civ7Agent.load(${JSON.stringify(buildId)}).then(s => JSON.stringify(s)) : "null"`);
  console.log(JSON.stringify(JSON.parse(String(v)), null, 2));
}

// ---- main -----------------------------------------------------------------------------------------

const cmd = process.argv[2];
const commands: Record<string, () => unknown> = {
  build: () => build(),
  stage: () => stage(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined),
  rollback: () => rollback(),
  status: () => status(),
  probe: () => probe(),
  activate: () => activate(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined),
};
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dev/cli.ts")) {
  if (!cmd || !commands[cmd]) {
    console.error(`usage: node dev/cli.ts <${Object.keys(commands).join("|")}>`);
    process.exit(2);
  }
  Promise.resolve(commands[cmd]()).catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
}
