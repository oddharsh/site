// route-cpu.ts: CPU per request for every public page and the heavy query
// routes, against Workers Free's 10 ms, on a cold isolate. Report only.
//
//   node tools/route-cpu.ts                  needs .build/.perfbudget (bun run perf-budget)
//   node tools/route-cpu.ts --strict         exit 1 when a route's median is over 8 ms
//
// The instrument is the build-off's (buildoff/build, then the merge's
// measure.js), pointed at production's bundle: the dry-run file perf-budget
// already writes, one esbuild module with every text import inlined, so node
// can import it once `cloudflare:workers` resolves to a stub. Each sample is a
// FRESH node process, which is the cold isolate a visitor's request meets:
//   1. import the bundle, with ASSETS read from .build/public and every other
//      binding the site config declares stubbed empty (local KV, D1 and R2 are
//      empty too, so data pages render their fallback);
//   2. send the control route twice, so node's own lazy Request and Response
//      setup (about 15 ms on the first request) is never charged to a route;
//   3. time the control once more (the floor), then the route, each with
//      process.cpuUsage() around one fetch().
// Outbound fetch is refused, so a route that would call out fails fast instead
// of measuring the network.
//
// Every route gets one screening sample; one at SCREEN_MS or more gets
// SAMPLES in all, and its median is the number. A run whose control floor
// spreads past FLOOR_IQR_MS is reported as inconclusive: the machine was too
// busy for 1 ms differences to mean anything.
//
// shortcut: no calibration workload yet, so the numbers are this machine's
// milliseconds, not Cloudflare's. C1 (2026-10-08) suggested scaling by a fixed
// workload per child; add that before this gates anything.
// shortcut: /coffee/availability.json answers 503 here (no calendar secret),
// so its real cost, the one C1 found heaviest, is not measured.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const OVER_MS = 8;
const SCREEN_MS = 4;
const SAMPLES = 9;
const FLOOR_IQR_MS = 0.5;
const CONTROL = "/robots.txt";
const MARK = "ROUTE_CPU_RESULT ";

// Routes past the registered pages: the ones that take a query or a body, and
// the island fragments. C1 measured these as the heavy end on 2026-10-08.
const QUERIES = [
  "/photos/query.json", "/photos/query.json?q=red+car", "/photos/query.json?q=classic+chrome+bridge&limit=100",
  "/search?q=brotli", "/search.json?q=brotli", "/search.json?q=what+does+he+think+about+agents", "/ask?query=dictionary",
  "/finger", "/agent-ready", "/coffee/availability.json", "/llms-full.txt", "/this-page-does-not-exist",
  "/ledger/lines.html", "/inbox/mail.html", "/around/snapshot.html", "/reading/list.html", "/whoareyou/values.html",
  "/coffee/slots.html", "/garage/dyno/pulls.html", "/lens/census/table.html", "/photos/grid.html", "/rn/tracks.html",
  "POST /mcp tools/list", "POST /mcp search_site",
];

// ── one sample, in its own process ──────────────────────────────────────────
// What a binding kind answers when nothing is behind it, the way an empty
// local resource does.
function stub(kind: string): unknown {
  const none = async () => null;
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
    default: return new Proxy({}, { get: () => () => { throw new Error(`the ${kind} binding is not available to route-cpu`); } });
  }
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", json: "application/json", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", css: "text/css", js: "text/javascript", svg: "image/svg+xml", xml: "application/xml" };

function request(spec: string): Request {
  const [method, path, tool] = spec.startsWith("POST ") ? spec.split(" ") : ["GET", spec];
  const init: RequestInit = { method, headers: { "accept-encoding": "br", accept: "text/html,application/json;q=0.9", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" } };
  if (tool) init.body = JSON.stringify(tool === "search_site"
    ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_site", arguments: { q: "brotli dictionary" } } }
    : { jsonrpc: "2.0", id: 1, method: tool });
  return new Request("https://aadhar.sh" + path, init);
}

async function sample(spec: { worker: string; assets: string; env: Record<string, unknown>; bindings: Record<string, string> }, route: string) {
  registerHooks({
    resolve: (s, c, next) => s === "cloudflare:workers"
      ? { url: "data:text/javascript,export class WorkerEntrypoint{};export class WorkflowEntrypoint{};export const tracing=undefined;", shortCircuit: true }
      : next(s, c),
  });
  Object.assign(globalThis, { fetch: async (input: RequestInfo | URL) => { throw new Error(`route-cpu refuses outbound fetch: ${new Request(input).url}`); } });
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => false };
  (globalThis as unknown as { caches: unknown }).caches = { default: cache, open: async () => cache };
  const env: Record<string, unknown> = { ...spec.env };
  for (const [name, kind] of Object.entries(spec.bindings)) env[name] = stub(kind);
  env.ASSETS = {
    async fetch(input: RequestInfo | URL) {
      const path = decodeURIComponent(new URL(new Request(input).url).pathname);
      const file = join(spec.assets, path);
      if (path.includes("..") || !existsSync(file) || statSync(file).isDirectory()) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream" } });
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const worker = (await import(spec.worker)).default;
  const run = async (r: string) => { const res = await worker.fetch(request(r), env, ctx); await res.arrayBuffer(); return res.status; };
  const ms = (t: NodeJS.CpuUsage) => (t.user + t.system) / 1000;
  await run(CONTROL); await run(CONTROL);
  const c0 = process.cpuUsage(); await run(CONTROL); const floor = ms(process.cpuUsage(c0));
  const c1 = process.cpuUsage(); const status = await run(route); const cpu = ms(process.cpuUsage(c1));
  process.stdout.write(`\n${MARK}${JSON.stringify({ cpu, floor, status })}\n`);
}

// ── the run ─────────────────────────────────────────────────────────────────
type Sample = { cpu: number; floor: number; status: number };

function child(spec: string, route: string): Promise<Sample> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [import.meta.filename, "--one", route], { env: { ...process.env, ROUTE_CPU_SPEC: spec }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", () => {
      const line = out.split("\n").find((l) => l.startsWith(MARK));
      if (line) done(JSON.parse(line.slice(MARK.length)));
      else fail(new Error(`route-cpu: ${route} produced no sample. stderr ends:\n${err.slice(-800)}`));
    });
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const quartile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * q)]; };

export async function measure(spec: string, routes: string[], jobs: number) {
  const samples = new Map<string, Sample[]>(routes.map((r) => [r, []]));
  const pool = async (work: string[]) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, work.length) }, async () => {
      while (next < work.length) { const r = work[next++]; samples.get(r)!.push(await child(spec, r)); }
    }));
  };
  await pool(routes);
  const heavy = routes.filter((r) => samples.get(r)![0].cpu >= SCREEN_MS);
  await pool(heavy.flatMap((r) => Array(SAMPLES - 1).fill(r)));
  const floors = [...samples.values()].flat().map((s) => s.floor);
  const rows = routes.map((route) => {
    const s = samples.get(route)!;
    return { route, status: s[0].status, cpu: median(s.map((x) => x.cpu)), samples: s.length };
  }).sort((a, b) => b.cpu - a.cpu);
  return { rows, floor: median(floors), floorIqr: quartile(floors, 0.75) - quartile(floors, 0.25) };
}

async function main() {
  const { values } = parseArgs({ options: {
    strict: { type: "boolean" }, worker: { type: "string" }, assets: { type: "string" }, routes: { type: "string" },
    jobs: { type: "string" }, json: { type: "string" },
  } });
  const worker = resolve(values.worker ?? ".build/.perfbudget/index.js");
  const assets = resolve(values.assets ?? ".build/public");
  if (!existsSync(worker)) {
    console.error(`route-cpu: no bundle at ${worker}. Run \`bun run perf-budget\` first; it writes the dry-run bundle this measures.`);
    process.exit(2);
  }
  // The env the Worker is deployed with: its vars, and a stub for every binding.
  let env: Record<string, unknown> = {}, bindings: Record<string, string> = {}, routes: string[];
  if (values.routes) routes = values.routes.split(",");
  else {
    const { siteConfig } = await import("./lib/site-config.ts");
    const c = await siteConfig();
    env = { ...c.vars };
    const add = (list: { binding?: string; name?: string }[] | undefined, kind: string) => { for (const b of list ?? []) bindings[b.binding ?? b.name!] = kind; };
    add(c.kv_namespaces, "kv"); add(c.d1_databases, "d1"); add(c.r2_buckets, "r2"); add(c.analytics_engine_datasets, "ae");
    add(c.ratelimits, "ratelimit"); add(c.durable_objects?.bindings, "do"); add(c.workflows, "workflow");
    for (const k of ["browser", "images", "ai", "analytics"]) if (c[k]?.binding) bindings[c[k].binding] = k;
    if (c.version_metadata?.binding) bindings[c.version_metadata.binding] = "version";
    const surfaces: { path: string }[] = JSON.parse(readFileSync("config/site-manifest.json", "utf8")).surfaces;
    routes = [...new Set([...surfaces.map((s) => s.path), ...QUERIES])];
  }
  const spec = JSON.stringify({ worker, assets, env, bindings });
  const jobs = Number(values.jobs) || Math.max(1, Math.min(2, availableParallelism() - 1));
  const t0 = performance.now();
  const { rows, floor, floorIqr } = await measure(spec, routes, jobs);
  const over = rows.filter((r) => r.cpu > OVER_MS);
  const light = rows.filter((r) => r.cpu < SCREEN_MS).map((r) => r.cpu);
  const inconclusive = floorIqr > FLOOR_IQR_MS;
  const lines = [
    `route-cpu: ${rows.length} routes, ${rows.reduce((n, r) => n + r.samples, 0)} cold samples in ${((performance.now() - t0) / 1000).toFixed(0)} s; control ${CONTROL} ${floor.toFixed(2)} ms, IQR ${floorIqr.toFixed(2)} ms${inconclusive ? " (INCONCLUSIVE: the machine was too busy)" : ""}`,
    `${over.length} over ${OVER_MS} ms:`,
    ...rows.filter((r) => r.cpu >= SCREEN_MS).map((r) => `  ${r.cpu.toFixed(2).padStart(6)} ms  ${String(r.status).padEnd(3)}  ${r.route}${r.cpu > OVER_MS ? "  OVER" : ""}  (${r.samples} samples)`),
    `${light.length} more under ${SCREEN_MS} ms (one sample each)${light.length ? `; median of those ${median(light).toFixed(2)} ms` : ""}`,
  ];
  console.log(lines.join("\n"));
  if (values.json) writeFileSync(values.json, JSON.stringify({ floor, floorIqr, inconclusive, rows }, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "### Per-route CPU (report only)\n\n```\n" + lines.join("\n") + "\n```\n", { flag: "a" });
  if (values.strict && (over.length || inconclusive)) process.exit(1);
}

if (process.argv[2] === "--one") await sample(JSON.parse(process.env.ROUTE_CPU_SPEC ?? "{}"), process.argv[3]);
else await main();
