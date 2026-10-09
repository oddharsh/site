// cpu-sweep.ts: CPU per request, route by route, on the Worker bundle that
// perf-budget builds.
//
//   node tools/cpu-sweep.ts [--gate] [--markdown] [--routes /a,/b] [--bundle path] [--budget file] [--out file]
//
// Workers Free allows 10 ms of CPU per request, and nothing in CI read it. The
// first sweep (2026-10-07, against a 0.22 ms floor) found five routes over 8 ms
// on a cold isolate: /coffee/availability.json 16.0, two photo queries 15.8 and
// 13.8, /agent-ready 12.4 and /finger 10.1. This is that sweep, kept.
//
// THE METHOD. Each sample is a fresh node process, because node runs V8, which is
// workerd's engine, and bun does not. It imports the dry-run bundle with
// cloudflare:workers stubbed, ASSETS read from .build/public and every other
// binding an empty stub, answers one warm-up request so node's own Request and
// Response code isn't charged to the route, then times one request with
// process.cpuUsage(). So every timed request is that route's first in its
// isolate, which is the cold case Workers Free bills.
//
// One screening sample per route; a route that reads CONFIRM_AT of its ceiling
// or more gets CONFIRMS more and is judged on the median. (Confirming everything
// over 4 ms, nine times each, took the first CI run to 112 s.) The control,
// /robots.txt through the whole dispatcher, gets SAMPLES, and its interquartile
// range is the noise floor:
// a run whose floor is over FLOOR_MAX_MS is inconclusive, since the runner was
// too busy to read.
//
// CALIBRATION. GitHub's runners aren't one machine. Three runs of this sweep
// (2026-10-09) landed on an AMD EPYC 9V45, an Intel Xeon Platinum 8573C and an
// AMD EPYC 7763, and the same routes read 20 to 25% apart. `calibrate()` below
// is a fixed workload (JSON, a regex, a sort, string building), timed cold in
// the same harness SAMPLES times, spread through the screening so it sees the
// load the routes see. Every reading is scaled by referenceMs / its median, and
// referenceMs, in config/cpu-budget.json, is its median on the Xeon. Scaled, the
// three runs agreed within 4% on every confirmed route, so a reported
// millisecond is a reference-runner millisecond. Apple silicon runs this
// workload relatively faster than it runs the routes, so a laptop reads about
// 1.4x high: CI's number is the one to trust. A compile-heavy workload (250
// generated functions, compiled and run once) was read beside it and tracked
// worse: 5.2x slower on the EPYC 7763, where the routes were 2.6x. The
// workload's text is digested; change it and --gate refuses until referenceMs
// is measured again.
//
// THE GATE. --gate exits 1 when a route's median is over its ceiling: GATE_MS,
// or the ceilingMs that config/cpu-budget.json allows it with a reason. An entry
// for a route the sweep doesn't know fails too, and an entry whose route now
// reads under GATE_MS is printed as stale, so the list only shrinks. Without
// --gate it prints, writes .build/cpu-sweep.json and exits 0.
//
// What it can't see: KV, D1 and R2 are empty, so data routes render their
// fallback; there's no calendar secret, so /coffee/availability.json answers
// 503; and outbound fetch is refused, so /agent-ready times its error path.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");
const GATE_MS = 8;
const SCREEN_MS = 4; // printed from here up
const CONFIRM_AT = 0.75; // of the route's ceiling
const CONFIRMS = 4; // so a confirmed route is the median of 5
const SAMPLES = 9; // the control and the calibration
const FLOOR_MAX_MS = 0.5;
const WIDTH = 2; // children at once: CI has 4 cores, and the build's other background steps share them
const CONTROL = "/robots.txt";
const CALIBRATION = "@calibration"; // a sample spec no route can collide with
// The routes that take a query, where the first sweep found the heavy ones. The
// pages come from the site manifest.
const QUERIES = [
  "/photos/query.json", "/photos/query.json?q=red+car", "/photos/query.json?q=classic+chrome+bridge&limit=100",
  "/search?q=brotli", "/search.json?q=brotli", "/search.json?q=what+does+he+think+about+agents",
  "/ask?query=dictionary", "/finger", "/agent-ready", "/coffee/availability.json", "POST /mcp search_site",
];

const { values } = parseArgs({
  options: {
    one: { type: "string" }, gate: { type: "boolean" }, markdown: { type: "boolean" },
    routes: { type: "string" }, bundle: { type: "string", default: join(ROOT, ".build/.perfbudget/index.js") },
    budget: { type: "string", default: join(ROOT, "config/cpu-budget.json") },
    out: { type: "string", default: join(ROOT, ".build/cpu-sweep.json") },
  },
});

// The calibration workload. Pure JavaScript with no ICU (no localeCompare, no
// Intl), since ICU's first use costs page faults rather than CPU speed. About
// 5.2 ms cold on an M3 Max and 12.4 to 18.7 ms on CI's runners. Its text is
// digested, so any edit here asks for a new referenceMs.
function calibrate(): number {
  let s = "";
  for (let i = 0; i < 3000; i++) s += `{"id":${i},"title":"frame ${i % 97} on the bridge","tags":["red","car","film ${i % 13}"],"w":${(i * 7919) % 6000}},`;
  const rows: { id: number; title: string; tags: string[]; w: number }[] = JSON.parse(`[${s.slice(0, -1)}]`);
  const re = /\bfilm\s+(\d+)\b/;
  let hits = 0;
  for (const r of rows) { const m = re.exec(r.tags.join(" ")); if (m && +m[1] % 2) hits++; }
  rows.sort((a, b) => a.w - b.w || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return JSON.stringify(rows.filter((r) => r.title.includes("bridge")).map((r) => ({ id: r.id, t: r.title.toUpperCase() }))).length + hits;
}

function request(spec: string): Request {
  const [method, path, tool] = spec.startsWith("POST ") ? spec.split(" ") : ["GET", spec];
  const init: RequestInit = { method, headers: { accept: "text/html,application/json", "accept-encoding": "br", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" } };
  if (tool) init.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { q: "brotli dictionary" } } });
  return new Request("https://aadhar.sh" + path, init);
}

// ── one sample, in its own process ──────────────────────────────────────────
if (values.one) {
  registerHooks({
    resolve: (spec, ctx, next) => spec === "cloudflare:workers"
      ? { url: "data:text/javascript,export class WorkerEntrypoint{};export class WorkflowEntrypoint{};export const tracing=undefined;", shortCircuit: true }
      : next(spec, ctx),
  });
  // the Worker logs a line per request; only this process's result goes to stdout
  for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = () => {};
  Object.assign(globalThis, { fetch: async () => { throw new Error("cpu-sweep: outbound fetch refused"); } });
  const miss = { match: async () => undefined, put: async () => {}, delete: async () => false };
  Object.assign(globalThis, { caches: { default: miss, open: async () => miss } });
  const ASSETS = {
    async fetch(input: Request | string) {
      const path = decodeURIComponent(new URL(input instanceof Request ? input.url : input).pathname);
      const file = join(ROOT, ".build/public", path);
      if (path.includes("..") || path.endsWith("/") || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file));
    },
  };
  // Any other binding reads as empty: a callable stub whose calls resolve to null,
  // and whose D1-shaped results are empty.
  const stub = (): any => new Proxy(function () {}, {
    get: (_, k) => (k === "then" ? undefined : stub()),
    apply: () => Object.assign(Promise.resolve(null), { all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }),
  });
  const { siteConfig } = await import("./lib/site-config.ts");
  const vars = (await siteConfig()).vars ?? {};
  const env = new Proxy({ ASSETS, ...vars } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : /^[A-Z][A-Z0-9_]*$/.test(String(k)) ? stub() : undefined) });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const worker = (await import(values.bundle!)).default;
  const run = async (spec: string) => { const r = await worker.fetch(request(spec), env, ctx); await r.arrayBuffer(); return r.status; };
  await run(values.one === CONTROL ? "/favicon.ico" : CONTROL); // the warm-up is never the timed route
  const t0 = process.cpuUsage();
  const status = values.one === CALIBRATION ? (calibrate(), 0) : await run(values.one);
  const d = process.cpuUsage(t0);
  process.stdout.write(JSON.stringify({ ms: (d.user + d.system) / 1000, status }) + "\n");
  process.exit(0);
}

// ── the sweep ───────────────────────────────────────────────────────────────
if (!existsSync(values.bundle!)) {
  console.error(`cpu-sweep: no bundle at ${values.bundle}; run bun run perf-budget first, which builds it`);
  process.exit(2);
}
type Budget = { calibration: { referenceMs: number; digest: string; machine: string } | null; routes: Record<string, { ceilingMs: number; why: string }> };
const budget: Budget = JSON.parse(readFileSync(values.budget!, "utf8"));
const digest = createHash("sha256").update(calibrate.toString()).digest("hex").slice(0, 16);
// Before any sampling: a reference taken on a different workload can't scale this one.
if (values.gate && budget.calibration !== null && budget.calibration.digest !== digest) {
  console.error(`cpu-sweep: --gate refuses: the calibration workload's digest is ${digest}, and ${values.budget} recorded ${budget.calibration.digest}. Measure referenceMs again on the reference machine.`);
  process.exit(2);
}
const pages: string[] = JSON.parse(readFileSync(join(ROOT, "config/site-manifest.json"), "utf8")).surfaces.map((s: { path: string }) => s.path);
const known = new Set([...pages, ...QUERIES]);
const routes = values.routes ? values.routes.split(",") : [...known];
for (const r of routes) known.add(r);

const sample = (spec: string) => new Promise<{ ms: number; status: number }>((resolve, reject) => {
  const child = spawn(process.execPath, [import.meta.filename, "--one", spec, "--bundle", values.bundle!], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", () => {
    try { resolve(JSON.parse(out.trim().split("\n").at(-1) ?? "")); }
    catch { reject(new Error(`cpu-sweep: ${spec} produced no reading\n${err.slice(-800)}`)); }
  });
});
async function pool<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: WIDTH }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }));
  return out;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const iqr = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * 0.75)] - s[Math.floor((s.length - 1) * 0.25)]; };

// The control and the calibration are spread through the screening, so both see
// the load the routes see rather than a quiet first second.
const specs = [...routes];
for (let k = 0; k < SAMPLES; k++) for (const s of [CONTROL, CALIBRATION]) specs.splice(Math.round(((k + 0.5) * specs.length) / SAMPLES), 0, s);
const screened = await pool(specs.map((s) => async () => ({ spec: s, ...(await sample(s)) })));
const control = screened.filter((r) => r.spec === CONTROL).map((r) => r.ms);
const calMs = median(screened.filter((r) => r.spec === CALIBRATION).map((r) => r.ms));
const floor = iqr(control);
// The scale, from this machine to the reference one. With no reference, or a
// reference taken on a different workload, readings stay raw and --gate refuses.
const calibrated = budget.calibration !== null && budget.calibration.digest === digest;
const scale = calibrated ? budget.calibration!.referenceMs / calMs : 1;
const screen = new Map(screened.filter((r) => r.spec !== CONTROL && r.spec !== CALIBRATION).map((r) => [r.spec, r]));
const rows = await pool(routes.map((route) => async () => {
  const first = screen.get(route)!;
  const raw = [first.ms];
  // one after another, so the run never has more than WIDTH children
  const ceilingMs = budget.routes[route]?.ceilingMs ?? GATE_MS;
  if (first.ms * scale >= ceilingMs * CONFIRM_AT) for (let k = 0; k < CONFIRMS; k++) raw.push((await sample(route)).ms);
  return { route, status: first.status, ms: median(raw) * scale, rawMs: median(raw), ceilingMs, samples: raw.length };
}));
rows.sort((a, b) => b.ms - a.ms);
const over = rows.filter((r) => r.ms > r.ceilingMs);
const unknown = Object.keys(budget.routes).filter((r) => !known.has(r));
const stale = rows.filter((r) => budget.routes[r.route] && r.ms <= GATE_MS);
const inconclusive = floor > FLOOR_MAX_MS;
const machine = cpus()[0]?.model.trim() ?? "unknown";
writeFileSync(values.out!, JSON.stringify({
  gateMs: GATE_MS, machine, calibration: { ms: calMs, digest, calibrated, scale },  control: { median: median(control), iqr: floor }, inconclusive, unknown, stale: stale.map((r) => r.route), rows,
}, null, 2) + "\n");

const units = calibrated ? `reference ms (x${scale.toFixed(2)} from ${calMs.toFixed(2)} ms of calibration here)`
  : budget.calibration === null ? `raw ms on this machine (no calibration recorded; the workload read ${calMs.toFixed(2)} ms, digest ${digest})`
  : `raw ms on this machine (the calibration workload changed: digest ${digest}, recorded ${budget.calibration.digest}; it read ${calMs.toFixed(2)} ms)`;
const verdict = inconclusive ? `inconclusive: the control's spread was ${floor.toFixed(2)} ms (over ${FLOOR_MAX_MS})`
  : `${over.length} of ${rows.length} routes over their ceiling, against a ${floor.toFixed(2)} ms floor`;
const notes = [
  // measured on an M3 Max against the three CI runners (2026-10-09)
  ...(calibrated && process.arch === "arm64" ? [`this machine is arm64, where the calibration workload runs relatively faster than the routes: readings run 1.3 to 1.4x above CI's, so trust CI's verdict`] : []),
  ...unknown.map((r) => `config/cpu-budget.json allows ${r}, which the sweep doesn't know`),
  ...stale.map((r) => `${r.route} reads ${r.ms.toFixed(2)} ms, under the ${GATE_MS} ms gate: drop its entry from config/cpu-budget.json`),
];
const shown = rows.filter((r) => r.ms > SCREEN_MS || r.ms > r.ceilingMs);
if (values.markdown) {
  console.log(`### CPU per request, cold isolate\n\n${verdict}. Units: ${units}, on ${machine}.\n`);
  if (shown.length) console.log(`| route | status | CPU ms (median) | ceiling | samples |\n|---|--:|--:|--:|--:|\n${shown.map((r) => `| \`${r.route}\` | ${r.status} | ${r.ms > r.ceilingMs ? "**" + r.ms.toFixed(2) + "**" : r.ms.toFixed(2)} | ${r.ceilingMs} | ${r.samples} |`).join("\n")}`);
  console.log(`\n${rows.length - shown.length} more routes read under ${SCREEN_MS} ms. The control (\`${CONTROL}\`) read ${(median(control) * scale).toFixed(2)} ms.`);
  for (const n of notes) console.log(`\n- ${n}`);
} else {
  console.log(`cpu-sweep: ${verdict}; units: ${units}; ${machine}; control ${CONTROL} ${(median(control) * scale).toFixed(2)} ms`);
  for (const r of shown) console.log(`  ${r.ms > r.ceilingMs ? "over " : "     "} ${r.ms.toFixed(2).padStart(6)} ms  ceiling ${String(r.ceilingMs).padStart(2)}  ${String(r.status).padEnd(4)} ${r.route}`);
  for (const n of notes) console.log(`  note: ${n}`);
}
process.exit(values.gate && !inconclusive && (over.length || unknown.length) ? 1 : 0);
