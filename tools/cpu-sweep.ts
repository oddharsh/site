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
// isolate, which is the cold case Workers Free bills. Before any of that it
// warms ICU in a throwaway isolate (tools/lib/warm-icu.ts): ICU's data is per
// process, workerd's processes are shared and already have it, and a cold
// process charged every date-formatting route about 10 ms that production
// doesn't pay. --cold-icu skips the warm-up, as the control.
//
// One screening sample per route; a route that reads CONFIRM_AT of its ceiling
// or more gets CONFIRMS more and is judged on the median. (Confirming everything
// over 4 ms, nine times each, took the first CI run to 112 s.) The control,
// /robots.txt through the whole dispatcher, gets SAMPLES, and its interquartile
// range is the noise floor: a run whose floor, in reference ms, is over
// FLOOR_MAX_MS is inconclusive, since the runner was too busy to read.
// FLOOR_MAX_MS is about half the tightest gap between a route's usual reading
// and its ceiling, and about twice the widest floor CI has shown (0.45 ms).
//
// CALIBRATION, BY CPU MODEL. GitHub's runners aren't one machine: on 2026-10-09
// this sweep's runs landed on five CPU models, and the same routes read up to
// 1.6x apart raw. On any one model a typical route held within ±6% from run to
// run (the worst ±17%, over 9 runs of an EPYC 7763). So the scale is a factor
// per model, in config/cpu-budget.json's `machines`, measured from
// repeat runs against the AMD EPYC 7763, whose factor is 1: a reported
// millisecond is an EPYC 7763 millisecond. A model with no factor reads raw and
// --gate judges nothing on it, with a warning naming the model so its factor can
// be added (docs/MAINTENANCE.md says how). A timed workload was the scale first
// (#1260) and was dropped: on CI it spread 12 to 29% inside one run, and on a
// laptop it spent about 40% of its CPU on GC and compiler threads where routes
// spend about 20%, so on any one model it moved while the routes held.
//
// A factor is right for a model's usual runner, and one runner can still be
// slow all over: on 2026-10-09 an EPYC 9V74 read every confirmed route 1.27x
// higher than the model's six other runs, and failed six routes on a PR that
// changed no Worker byte (#1273). The control saw it: scaled, /robots.txt read
// 33% over its usual 2.3 reference ms, where 29 ordinary runs on three models
// read between 8% under and 16% over. So the control's median, scaled, is checked
// against `control.ms` in the budget file, and a run more than `control.drift`
// off it is inconclusive. The control doesn't replace the factor as the scale:
// as one it spread 5.3% around what the routes said the run's scale was, against
// 3.9% for the model factor, since a 2 ms route is noisy on its own. The
// control's spread, checked above, can't see a slow host: that runner's floor
// was 0.30 ms, because a host that is uniformly slow isn't a noisy one.
//
// THE GATE. --gate exits 1 when a route's median is over its ceiling: GATE_MS,
// or the ceilingMs that config/cpu-budget.json allows it with a reason. An entry
// for a route the sweep doesn't know fails too, and an entry whose route now
// reads under STALE_MS is printed as stale, so the list only shrinks. CI runs it
// with --gate, each failure an annotation on the run. Without --gate it prints,
// writes .build/cpu-sweep.json and exits 0.
//
// What it can't see: KV, D1 and R2 are empty, so data routes render their
// fallback; there's no calendar secret, so /coffee/availability.json answers
// 503; and outbound fetch is refused, so /agent-ready times its error path.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { warmIcu } from "./lib/warm-icu.ts";

const ROOT = join(import.meta.dirname, "..");
const GATE_MS = 8;
const SCREEN_MS = 4; // printed from here up
const CONFIRM_AT = 0.75; // of the route's ceiling
const CONFIRMS = 4; // so a confirmed route is the median of 5
const SAMPLES = 9; // the control
const FLOOR_MAX_MS = 1; // reference ms
// Half the gate. An entry exists because a route's highest reading, plus 20%, passed
// GATE_MS; a route a little under the gate on one run can still cross it on the
// next, so only a reading this far under says the cost is gone.
const STALE_MS = GATE_MS / 2;
const WIDTH = 2; // children at once: CI has 4 cores, and the build's other background steps share them
const CONTROL = "/robots.txt";
// The routes that take a query, where the first sweep found the heavy ones, then
// the island fragments, which no manifest entry names and which render per
// request (/coffee/slots.html read 18 ms before #1262), and three more that
// tools/route-cpu.ts carried until the two tools became this one. The pages
// come from the site manifest.
const QUERIES = [
  "/photos/query.json", "/photos/query.json?q=red+car", "/photos/query.json?q=classic+chrome+bridge&limit=100",
  "/search?q=brotli", "/search.json?q=brotli", "/search.json?q=what+does+he+think+about+agents",
  "/ask?query=dictionary", "/finger", "/agent-ready", "/coffee/availability.json", "POST /mcp search_site",
  "/coffee/slots.html", "/ledger/lines.html", "/inbox/mail.html", "/around/snapshot.html", "/reading/list.html",
  "/whoareyou/values.html", "/garage/dyno/pulls.html", "/lens/census/table.html", "/photos/grid.html", "/rn/tracks.html",
  "/llms-full.txt", "/this-page-does-not-exist", "POST /mcp tools/list",
];

const { values } = parseArgs({
  options: {
    one: { type: "string" }, gate: { type: "boolean" }, markdown: { type: "boolean" },
    routes: { type: "string" }, bundle: { type: "string", default: join(ROOT, ".build/.perfbudget/index.js") },
    budget: { type: "string", default: join(ROOT, "config/cpu-budget.json") },
    out: { type: "string", default: join(ROOT, ".build/cpu-sweep.json") },
    "cold-icu": { type: "boolean" },
  },
});
// absolute, so a relative --bundle names a file rather than a package in the child
const BUNDLE = resolve(values.bundle!);

function request(spec: string): Request {
  const [method, path, tool] = spec.startsWith("POST ") ? spec.split(" ") : ["GET", spec];
  const init: RequestInit = { method, headers: { accept: "text/html,application/json", "accept-encoding": "br", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" } };
  // "tools/list" is a JSON-RPC method; any other word names a tool to call.
  if (tool) init.body = JSON.stringify(tool === "tools/list" ? { jsonrpc: "2.0", id: 1, method: tool }
    : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { q: "brotli dictionary" } } });
  return new Request("https://aadhar.sh" + path, init);
}

// ── one sample, in its own process ──────────────────────────────────────────
if (values.one) {
  if (!values["cold-icu"]) await warmIcu();
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
  // What each binding kind answers with nothing behind it, the way an empty
  // namespace, database or bucket would.
  const none = async () => null;
  const binding = (kind: string): unknown => {
    switch (kind) {
      case "kv": return { get: none, getWithMetadata: async () => ({ value: null, metadata: null }), put: none, delete: none, list: async () => ({ keys: [], list_complete: true }) };
      case "d1": {
        const stmt = { bind: () => stmt, first: none, all: async () => ({ results: [], success: true, meta: {} }), run: async () => ({ success: true, meta: {} }), raw: async () => [] };
        return { prepare: () => stmt, batch: async () => [], exec: async () => ({}) };
      }
      case "r2": return { get: none, head: none, put: none, delete: none, list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) };
      case "ae": return { writeDataPoint() {} };
      case "ratelimit": return { limit: async () => ({ success: true }) };
      case "do": return { idFromName: () => ({}), idFromString: () => ({}), newUniqueId: () => ({}), get: () => ({ fetch: async () => new Response("no Durable Object here", { status: 503 }) }) };
      case "workflow": return { create: async () => ({ id: "local" }), get: async () => ({ status: async () => ({ status: "unknown" }) }) };
      case "version": return { id: "local", tag: "", timestamp: "" };
      default: return stub();
    }
  };
  // Anything else reads as empty: a callable stub whose calls resolve to null,
  // and whose D1-shaped results are empty.
  const stub = (): any => new Proxy(function () {}, {
    get: (_, k) => (k === "then" ? undefined : stub()),
    apply: () => Object.assign(Promise.resolve(null), { all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }),
  });
  // Every binding the config declares is an OWN property, stubbed by its kind,
  // because a route can copy env and a copy keeps only own properties: cal runs
  // on { ...env, BASE_PATH }, and with the bindings only behind the proxy,
  // /coffee/slots.html read env.BOOKINGS as undefined and threw. The proxy still
  // answers any other capitalised name, which is how a secret reads.
  const { siteConfig } = await import("./lib/site-config.ts");
  const c = await siteConfig();
  const declared: Record<string, unknown> = { ASSETS, ...c.vars };
  const add = (list: { binding?: string; name?: string }[] | undefined, kind: string) => { for (const b of list ?? []) declared[b.binding ?? b.name!] = binding(kind); };
  add(c.kv_namespaces, "kv"); add(c.d1_databases, "d1"); add(c.r2_buckets, "r2"); add(c.analytics_engine_datasets, "ae");
  add(c.ratelimits, "ratelimit"); add(c.durable_objects?.bindings, "do"); add(c.workflows, "workflow");
  for (const k of ["browser", "images", "ai", "analytics"]) if (c[k]?.binding) declared[c[k].binding] = stub();
  if (c.version_metadata?.binding) declared[c.version_metadata.binding] = binding("version");
  const env = new Proxy(declared, { get: (t, k) => (k in t ? t[k as string] : /^[A-Z][A-Z0-9_]*$/.test(String(k)) ? stub() : undefined) });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const worker = (await import(pathToFileURL(BUNDLE).href)).default;
  const run = async (spec: string) => { const r = await worker.fetch(request(spec), env, ctx); await r.arrayBuffer(); return r.status; };
  await run(values.one === CONTROL ? "/favicon.ico" : CONTROL); // the warm-up is never the timed route
  const t0 = process.cpuUsage();
  const status = await run(values.one);
  const d = process.cpuUsage(t0);
  process.stdout.write(JSON.stringify({ ms: (d.user + d.system) / 1000, status }) + "\n");
  process.exit(0);
}

// ── the sweep ───────────────────────────────────────────────────────────────
if (!existsSync(BUNDLE)) {
  console.error(`cpu-sweep: no bundle at ${BUNDLE}; run bun run perf-budget first, which builds it`);
  process.exit(2);
}
type Budget = {
  machines: Record<string, { factor: number; runs: number }>;
  // the control's usual median in reference ms, and how far a run may read from it
  control?: { ms: number; drift: number };
  routes: Record<string, { ceilingMs: number; why: string }>;
};
const budget: Budget = JSON.parse(readFileSync(values.budget!, "utf8"));
// The scale, from this CPU model to the EPYC 7763. A model with no factor reads
// raw, and --gate judges nothing on it.
const machine = cpus()[0]?.model.trim() ?? "unknown";
const calibrated = machine in budget.machines;
const scale = calibrated ? budget.machines[machine].factor : 1;
const pages: string[] = JSON.parse(readFileSync(join(ROOT, "config/site-manifest.json"), "utf8")).surfaces.map((s: { path: string }) => s.path);
const known = new Set([...pages, ...QUERIES]);
const routes = values.routes ? values.routes.split(",") : [...known];
for (const r of routes) known.add(r);

const sample = (spec: string) => new Promise<{ ms: number; status: number }>((resolve, reject) => {
  const child = spawn(process.execPath, [import.meta.filename, "--one", spec, "--bundle", BUNDLE, ...(values["cold-icu"] ? ["--cold-icu"] : [])], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

// The control is spread through the screening, so it sees the load the routes
// see rather than a quiet first second.
const specs = [...routes];
for (let k = 0; k < SAMPLES; k++) specs.splice(Math.round(((k + 0.5) * specs.length) / SAMPLES), 0, CONTROL);
const screened = await pool(specs.map((s) => async () => ({ spec: s, ...(await sample(s)) })));
const control = screened.filter((r) => r.spec === CONTROL).map((r) => r.ms);
const floor = iqr(control);
const screen = new Map(screened.filter((r) => r.spec !== CONTROL).map((r) => [r.spec, r]));
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
const stale = rows.filter((r) => budget.routes[r.route] && r.ms < STALE_MS);
const noisy = floor * scale > FLOOR_MAX_MS;
// How far this run's control, scaled, reads from the reference: a runner slower
// or faster all over than its model's factor says. Only a calibrated run has
// reference ms to compare.
const drift = calibrated && budget.control ? (median(control) * scale) / budget.control.ms - 1 : 0;
const offModel = budget.control !== undefined && Math.abs(drift) > budget.control.drift;
const inconclusive = noisy || offModel;
writeFileSync(values.out!, JSON.stringify({
  gateMs: GATE_MS, machine, calibration: { calibrated, scale }, control: { median: median(control), iqr: floor, drift }, inconclusive, unknown, stale: stale.map((r) => r.route), rows,
}, null, 2) + "\n");

const units = calibrated ? `EPYC 7763 ms (x${scale.toFixed(3)} for this CPU model)`
  : `raw ms: config/cpu-budget.json has no factor for this CPU model, so the gate judges nothing`;
const pct = (x: number) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;
const verdict = noisy ? `inconclusive: the control's spread was ${(floor * scale).toFixed(2)} ms (over ${FLOOR_MAX_MS})`
  : offModel ? `inconclusive: the control read ${(median(control) * scale).toFixed(2)} ms, ${pct(drift)} off the ${budget.control!.ms} ms this model's factor expects (over ±${Math.round(budget.control!.drift * 100)}%), so this runner is off its model`
  : `${over.length} of ${rows.length} routes over their ceiling, against a ${(floor * scale).toFixed(2)} ms floor`;
const notes = [
  ...unknown.map((r) => `config/cpu-budget.json allows ${r}, which the sweep doesn't know`),
  ...stale.map((r) => `${r.route} reads ${r.ms.toFixed(2)} ms, under ${STALE_MS} ms, half the gate: drop its entry from config/cpu-budget.json`),
];
const shown = rows.filter((r) => r.ms > SCREEN_MS || r.ms > r.ceilingMs);
if (values.markdown) {
  // Printed for the log, and appended to the job summary when there is one, so
  // the workflow commands below never land in the summary as text.
  const md = [
    `### CPU per request, cold isolate\n\n${verdict}. Units: ${units}, on ${machine}.\n`,
    ...(shown.length ? [`| route | status | CPU ms (median) | ceiling | samples |\n|---|--:|--:|--:|--:|\n${shown.map((r) => `| \`${r.route}\` | ${r.status} | ${r.ms > r.ceilingMs ? "**" + r.ms.toFixed(2) + "**" : r.ms.toFixed(2)} | ${r.ceilingMs} | ${r.samples} |`).join("\n")}`] : []),
    `\n${rows.length - shown.length} more routes read under ${SCREEN_MS} ms. The control (\`${CONTROL}\`) read ${(median(control) * scale).toFixed(2)} ms.`,
    ...notes.map((n) => `\n- ${n}`),
  ].join("\n") + "\n";
  process.stdout.write(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
} else {
  console.log(`cpu-sweep: ${verdict}; units: ${units}; ${machine}; control ${CONTROL} ${(median(control) * scale).toFixed(2)} ms`);
  for (const r of shown) console.log(`  ${r.ms > r.ceilingMs ? "over " : "     "} ${r.ms.toFixed(2).padStart(6)} ms  ceiling ${String(r.ceilingMs).padStart(4)}  ${String(r.status).padEnd(4)} ${r.route}`);
  for (const n of notes) console.log(`  note: ${n}`);
}
// Under --gate, each failure and each skipped verdict also reach the workflow
// run's annotations, where they read without opening the log.
const judged = calibrated && !inconclusive;
const annotate = (level: "error" | "warning", text: string) => console.log(process.env.GITHUB_ACTIONS ? `::${level} title=CPU per route::${text}` : `cpu-sweep: ${text}`);
if (values.gate) {
  if (!calibrated) annotate("warning", `--gate judged nothing: config/cpu-budget.json has no factor for "${machine}"`);
  else if (inconclusive) annotate("warning", `--gate judged nothing, because the run was ${verdict}`);
  else for (const r of over) annotate("error", `${r.route} read ${r.ms.toFixed(2)} ms, over ${budget.routes[r.route] ? `the ${r.ceilingMs} ms ceiling config/cpu-budget.json allows it` : `the ${GATE_MS} ms gate`}`);
  for (const r of unknown) annotate("error", `config/cpu-budget.json allows ${r}, which the sweep doesn't know`);
}
process.exit(values.gate && ((judged && over.length) || unknown.length) ? 1 : 0);
