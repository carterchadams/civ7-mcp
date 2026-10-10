// Experiment B: N alternating A/B build → stage → activate → probe cycles in the same loaded game.
// Records per-cycle wall times and checks marker, identity, disposal and owned-element counts.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 10);
const run = (...args: string[]) => execFileSync("node", ["dev/cli.ts", ...args], { encoding: "utf8" });
const rows: any[] = [];
let incarnation: string | null = null;
for (let i = 0; i < N; i++) {
  const marker = i % 2 === 0 ? "B" : "A";
  const t0 = Date.now();
  const buildId = run("build", "--marker", marker).match(/built (\S+)/)![1];
  const t1 = Date.now();
  run("stage", buildId);
  const t2 = Date.now();
  const before = JSON.parse(run("probe"));
  run("activate", buildId);
  const t3 = Date.now();
  const after = JSON.parse(run("probe"));
  const t4 = Date.now();
  incarnation ??= after.incarnation;
  const svc = after.service;
  const ok = svc.marker === marker && svc.serviceBuildId === buildId && after.incarnation === incarnation && after.loads === before.loads + 1 &&
    after.disposals === before.disposals + 1 && svc.badge.count === 1 && svc.badge.styles === 1 && svc.owned.timers === 1 && after.errors.length === 0 &&
    /^rgba?\((\d+), (\d+), (\d+)/.exec(svc.badge.background)?.slice(1).join(",") === (marker === "A" ? "0,96,160" : "160,64,0");   // Cohtml reports rgba(...)
  rows.push({ cycle: i + 1, marker, buildId, ok, buildMs: t1 - t0, stageMs: t2 - t1, activateMs: t3 - t2, probeMs: t4 - t3, loads: after.loads, disposals: after.disposals, incarnation: after.incarnation, badge: svc.badge, errors: after.errors });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
writeFileSync("docs/traces/experiment-b-cycles.json", JSON.stringify(rows, null, 2) + "\n");
const med = (k: string) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`cycles ${rows.length}, all ok: ${rows.every((r) => r.ok)}; median ms build ${med("buildMs")} stage ${med("stageMs")} activate ${med("activateMs")}; max activate ${Math.max(...rows.map((r) => r.activateMs))}`);
