// insn-count.ts: how many CPU instructions does a Worker hot path execute?
//
//   bun run insn record head.json            # Linux with valgrind; see WHERE IT RUNS
//   bun run insn compare base.json head.json # the diff, no constants
//   bun run insn record head.json --only search --n 400
//
// WHY THIS EXISTS
// A span cannot measure CPU here: Workers freeze the clock during synchronous
// execution, so `home.grid.render` reads 0ms in production AND in local dev (the
// Observability section of CLAUDE.md). Yet CPU is the budget this account runs out
// of: Workers Free clamps it under load (gotcha 36), and the fix for that storm
// was measured in CPU milliseconds, pinned by hand with version overrides. Wall
// clock on a laptop is the other option and it is noise, which is why nothing
// gates on it. Instruction counts are neither: valgrind counts every instruction
// the process retires, and `node --predictable` makes V8 single-threaded and
// deterministic, so one run is a measurement rather than a sample. Two identical
// runs measured 195,733,494 and 195,733,984 instructions (0.00025% apart).
//
// Idea from Anthropic's claude.ai sprint (claude.dev/blog/how-we-made-claude-ai-
// faster, 2026-09-23), where it found a message ID resolved three times per lookup.
// They gate on it as a ratchet. This repo already argued against gates of that
// shape (perf-diff.yml: a number that blocks a merge trains people to widen the
// threshold), so this follows perf-snapshot.ts instead: record two trees, diff
// them, fail on nothing. A deterministic count is what makes that diff worth
// reading: a +3% here is the change, never the runner.
//
// HOW A BENCH IS COUNTED. Node's startup is about 195M instructions, which would
// bury every path below. So each bench runs twice in separate processes, at N and
// at 2N iterations after the same warmup, and the result is
// (Ir(2N) - Ir(N)) / N. Startup, imports, JIT warmup and the module caches all
// cancel, and what is left is the steady-state cost of one more call.
//
// WHERE IT RUNS. Valgrind supports Linux only (no macOS arm64 port), so on a Mac
// this refuses and prints the apple/container line that runs it. Counts depend on
// the CPU architecture and the exact node build, so compare two records made on
// the same machine and node, never a record against a number somebody typed. The
// record carries both, and `compare` refuses a pair that disagrees.
//
// WHAT A BENCH IS, and the rule that decided it: COUNT ONLY OUR OWN CODE. The first
// version drove whole handlers, and two of its three benches were counting undici.
// Response and Headers are JavaScript in node and native C++ in workerd, so a bench
// that builds a Response per call mostly measures a library production never runs,
// and undici's stream and finalizer bookkeeping made those two benches the only
// NONDETERMINISTIC ones (0.96% apart across identical runs, against 0.003% for the
// bench that builds none). So a bench calls the pure function a handler wraps, with
// the module-cached maps loaded once from the built tree through a fake ASSETS
// binding. It needs `.build/public` (any build, or a dev server on wrangler.jsonc,
// leaves one).
//
// --repeat 2 records every count twice and stores the spread, which is the check
// that a bench is deterministic enough to diff. A new bench should earn that
// before anyone reads its numbers.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const BUILT = join(ROOT, ".build/public");

// A fake ASSETS binding over the built tree. Enough for the module-cached reads
// the benches reach (alt.json, histograms.json, search-index.json).
const env = {
  ASSETS: {
    // Every read here is a string URL (`https://assets.local/...`), so the fake
    // takes exactly that rather than the whole Fetcher signature.
    fetch: async (url: string) => {
      const path = new URL(url).pathname;
      const file = join(BUILT, path);
      return existsSync(file) ? new Response(readFileSync(file)) : new Response("", { status: 404 });
    },
  },
};

// n is per bench because the leftover jitter is FIXED per process, not per call:
// raw totals move about +-40k instructions out of 1.6B between identical runs
// (0.0025%, measured with ASLR on and off, which made no difference), so the
// per-call noise is that jitter divided by n. A cheap call needs a large n.
type Bench = { note: string; n: number; setup: () => Promise<(i: number) => unknown> };

// setup() does the imports and the one-time reads, then hands back the function
// that is counted. Each bench imports inside its own setup, so recording one bench
// loads one module graph.
const BENCHES: Record<string, Bench> = {
  "photo-grid": {
    note: "the /photos/grid.html body: draw 12 of the pool, render the tiles (every homepage view)",
    n: 2000,
    setup: async () => {
      const { pickRandom } = await import("../src/worker/home.ts");
      const { CURATED_POOL, getAltMap, getHistogramMap } = await import("../src/worker/photos.ts");
      const { renderPhotoSlots } = await import("../src/worker/lib/photo-grid.ts");
      const [altMap, histograms] = await Promise.all([getAltMap(env), getHistogramMap(env)]);
      return () => renderPhotoSlots(pickRandom(CURATED_POOL, 12), altMap, { deferred: false, histograms });
    },
  },
  search: {
    note: "searchSiteRanked over the built corpus, rotating five queries (/search, /ask, MCP ask)",
    n: 500,
    setup: async () => {
      const { searchSiteRanked } = await import("../src/worker/search.ts");
      const queries = ["cloudflare workers", "photo", "compression dictionary", "what does he think about agents", "zstd"];
      await searchSiteRanked(env, "warm", 1); // the one ASSETS read, outside the count
      return (i) => searchSiteRanked(env, queries[i % queries.length], 20);
    },
  },
};

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

// ── child mode: run one bench N times after a warmup, inside valgrind ─────────
if (argv[0] === "__run") {
  const run = await BENCHES[argv[1]].setup();
  const n = Number(argv[2]);
  const warm = Number(argv[3]);
  for (let i = 0; i < warm; i++) await run(i);
  for (let i = 0; i < n; i++) await run(warm + i);
  process.exit(0);
}

type Record_ = { label: string; arch: string; node: string; warm: number; benches: Record<string, { note: string; n: number; perCall: number; irN: number; ir2N: number; spread?: number }> };

// ── record ────────────────────────────────────────────────────────────────────
if (argv[0] === "record") {
  const out = argv[1];
  if (!out) throw new Error("usage: insn-count record <out.json> [--only a,b] [--n <iterations>] [--warm 200] [--repeat 2]");
  const hasValgrind = spawnSync("valgrind", ["--version"]).status === 0;
  if (platform() !== "linux" || !hasValgrind) {
    console.error(`insn-count: needs Linux with valgrind (this is ${platform()}/${arch()}${hasValgrind ? "" : ", no valgrind on PATH"}).`);
    console.error("On a Mac, through apple/container (build the image once; it is node plus valgrind):");
    console.error("  container build -t node-valgrind -f tools/insn-count.Dockerfile tools");
    console.error(`  container run --rm --memory 6g --cpus 6 -v "$PWD":/w -w /w node-valgrind node tools/insn-count.ts record ${out}`);
    process.exit(2);
  }
  if (!existsSync(join(BUILT, "search-index.json"))) throw new Error("insn-count: .build/public has no search-index.json; build first");
  const nOverride = flag("--n", "");
  const warm = Number(flag("--warm", "200"));
  const repeat = Math.max(1, Number(flag("--repeat", "1")));
  const only = flag("--only", "");
  const names = only ? only.split(",") : Object.keys(BENCHES);
  const count = (name: string, iters: number): number => {
    // cachegrind with the cache model off is the cheapest tool that reports Ir.
    // --predictable: single-threaded, deterministic V8. --random-seed pins
    // Math.random, which the photo grid draws with.
    const res = spawnSync("valgrind", [
      "--tool=cachegrind", "--cache-sim=no", "--cachegrind-out-file=/dev/null",
      process.execPath, "--predictable", "--predictable-gc-schedule", "--random-seed=1", "--hash-seed=1", SELF, "__run", name, String(iters), String(warm),
    ], { encoding: "utf8" });
    const m = /I\s+refs:\s+([\d,]+)/.exec(res.stderr);
    if (res.status !== 0 || !m) throw new Error(`insn-count: ${name} x${iters} failed (exit ${res.status})\n${res.stderr.slice(-800)}`);
    return Number(m[1].replace(/,/g, ""));
  };
  const record: Record_ = { label: flag("--label", ""), arch: arch(), node: process.version, warm, benches: {} };
  for (const name of names) {
    if (!BENCHES[name]) throw new Error(`insn-count: no bench named ${name} (have ${Object.keys(BENCHES).join(", ")})`);
    const n = nOverride ? Number(nOverride) : BENCHES[name].n;
    const samples = Array.from({ length: repeat }, () => {
      const irN = count(name, n), ir2N = count(name, 2 * n);
      return { irN, ir2N, perCall: Math.round((ir2N - irN) / n) };
    });
    const { irN, ir2N, perCall } = samples[0];
    const per = samples.map((x) => x.perCall);
    const spread = repeat > 1 ? (Math.max(...per) - Math.min(...per)) / Math.min(...per) : undefined;
    record.benches[name] = { note: BENCHES[name].note, n, perCall, irN, ir2N, spread };
    console.log(`${name.padEnd(18)} ${perCall.toLocaleString("en-US").padStart(12)} instructions/call${spread === undefined ? "" : `  (spread over ${repeat} records: ${(spread * 100).toFixed(3)}%)`}`);
  }
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  process.exit(0);
}

// ── compare ───────────────────────────────────────────────────────────────────
if (argv[0] === "compare") {
  const [a, b] = [argv[1], argv[2]].map((f) => JSON.parse(readFileSync(f, "utf8")) as Record_);
  if (a.arch !== b.arch || a.node !== b.node) {
    console.error(`insn-count: these were recorded on different machines (${a.arch} ${a.node} vs ${b.arch} ${b.node}); the counts are not comparable.`);
    process.exit(2);
  }
  console.log(`| bench | ${a.label || "base"} | ${b.label || "head"} | change |\n|---|--:|--:|--:|`);
  for (const name of Object.keys({ ...a.benches, ...b.benches })) {
    const x = a.benches[name]?.perCall, y = b.benches[name]?.perCall;
    const pct = x && y ? `${(((y - x) / x) * 100).toFixed(2)}%` : "n/a";
    console.log(`| ${name} | ${x?.toLocaleString("en-US") ?? "-"} | ${y?.toLocaleString("en-US") ?? "-"} | ${pct} |`);
  }
  process.exit(0);
}

console.error("usage: insn-count record <out.json> | compare <base.json> <head.json>");
process.exit(2);

