// ── the contract tests of shipped code, run again inside workerd ──────────────
//
//   bun run test:workerd                 the lane: bun once, workerd once, compare
//   bun run test:workerd -- --filter lens --json out.json
//
// Runs under node (miniflare's dispatchFetch needs node's undici, see
// tools/lib/harness-dispatch.ts). Needs a staged tree: `bun run build` first.
//
// What it does, in order:
//   1. bundles every contract test, plus the Worker entries, in one esbuild pass,
//      and reads the import graph from the metafile;
//   2. keeps the tests that exercise Worker code (tools/lib/workerd-lane.ts);
//   3. runs those under bun with a JUnit report, for the baseline statuses;
//   4. mounts the repo as Data modules at /bundle, so workerd's own node:fs reads
//      it, and runs each test file as one request inside workerd;
//   5. sorts every difference into host / known gap / new, and fails on a new
//      one or a stale entry in config/workerd-gaps.json.
//
// The runtime is the pinned wrangler's miniflare, so its workerd and production's
// compatibility date and flags. One flag is added: nodejs_compat, because the
// tests themselves import node:assert and node:fs. Production runs without it,
// so a difference that only nodejs_compat explains is the lane's, not the site's.
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { repoFiles } from "./lib/repo-files.ts";
import { siteConfig } from "./lib/site-config.ts";
import { inLane, LOAD, namedImports, reachable, staleGaps, testKey, verdict } from "./lib/workerd-lane.ts";
import type { Gap, Status, WorkerdResult } from "./lib/workerd-lane.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SHARED = "tools/tests/contract-shared.ts";
const SHIM = join(ROOT, "tools/lib/workerd-node-test.ts");
const GAPS = "config/workerd-gaps.json";
// The Worker entries whose modules define "shipped code".
const WORKER_ENTRIES = ["src/worker/index.ts", "counter/src/index.ts"];
// Packages and repo modules only a host process can run. Inside workerd each is
// a Proxy that records the first call to anything it holds, then throws.
// @cloudflare/config is here because only wrangler reads the deploy config, and
// site-config.ts because it import()s cloudflare.config.ts at runtime, which in
// workerd lands on the Data module mounted at that path. The Worker imports
// neither (a test that does would leave the lane).
const HOST_ONLY = new Set(["bun", "bun:test", "wrangler", "@cloudflare/config", "esbuild", "playwright-core", "playwright", "miniflare"]);
const HOST_MODULES = new Set(["tools/lib/site-config.ts"]);
const FILE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const FILE_SIZE_MAX = 25e6;

const { values } = parseArgs({ options: { filter: { type: "string" }, json: { type: "string" } } });
const req = createRequire(join(ROOT, "package.json"));
const WRANGLER = req.resolve("wrangler");
const esbuild = req(req.resolve("esbuild", { paths: [WRANGLER] }));
const { Miniflare, convertV4MiniflareOptions } = await import(req.resolve("miniflare", { paths: [WRANGLER] }));
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

// ── 1. one bundle, one import graph ─────────────────────────────────────────
const allTests = repoFiles(["tools/tests/*.test.ts", "src/**/tests/*.test.ts"]).sort();
const scratch = mkdtempSync(join(tmpdir(), "test-workerd-"));
const harness = join(scratch, "harness.ts");
writeFileSync(
  harness,
  `import { __take, __takeTouched, __run } from ${JSON.stringify(SHIM)};
import ${JSON.stringify(join(ROOT, "tools/lib/no-network.ts"))};
const FILES = {
${allTests.map((t) => `  ${JSON.stringify(t)}: () => import(${JSON.stringify(join(ROOT, t))}),`).join("\n")}
};
export default {
  async fetch(request) {
    const f = new URL(request.url).searchParams.get("f");
    __takeTouched();
    try { await FILES[f](); }
    catch (e) { __take(); return Response.json({ file: f, loadError: String((e && e.stack) || e), fileTouched: __takeTouched() }); }
    const fileTouched = __takeTouched();
    const results = await __run(__take(), ${TEST_TIMEOUT_MS});
    return Response.json({ file: f, results, fileTouched });
  },
};
`,
);

const workerdPlugin = {
  name: "workerd-lane",
  setup(b) {
    b.onResolve({ filter: /^node:test$/ }, () => ({ path: SHIM }));
    b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, external: true }));
    b.onResolve({ filter: /^bun(:test)?$/ }, (a) => ({ path: a.path, namespace: "host" }));
    b.onResolve({ filter: /.*/ }, (a) => {
      if (BUILTINS.has(a.path)) return { path: a.path.startsWith("node:") ? a.path : `node:${a.path}`, external: true };
      const pkg = a.path.startsWith("@") ? a.path.split("/").slice(0, 2).join("/") : a.path.split("/")[0];
      if (HOST_ONLY.has(pkg)) return { path: a.path, namespace: "host" };
      if (a.path.startsWith(".")) {
        const file = rel(join(a.resolveDir, a.path));
        if (HOST_MODULES.has(file)) return { path: file, namespace: "host" };
      }
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "host" }, (a) => ({ loader: "js", contents: hostStub(a.path) }));
    // Each repo module gets its own import.meta values, pointing where its bytes
    // are mounted. define swaps only real import.meta expressions (a string that
    // says "import.meta.url" stays a string), and esbuild renames the constants
    // per module when it hoists them into one scope.
    b.onLoad({ filter: /\.(m?[jt]s)$/ }, (a) => {
      if (a.path.includes(`${sep}node_modules${sep}`) || !a.path.startsWith(ROOT) || a.path === SHIM) return undefined;
      const file = rel(a.path);
      const dir = `/bundle/${dirname(file)}`.replace(/\/\.$/, "");
      const meta = `var __wd_url = ${JSON.stringify(`file:///bundle/${file}`)}, __wd_dir = ${JSON.stringify(dir)}, __wd_file = ${JSON.stringify(`/bundle/${file}`)};\n`;
      const source = readFileSync(a.path, "utf8");
      const shebang = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
      return { contents: shebang + meta + source.slice(shebang.length), loader: a.path.endsWith(".ts") ? "ts" : "js", resolveDir: dirname(a.path) };
    });
  },
};

const out = join(scratch, "out");
const built = await esbuild.build({
  entryPoints: [harness, ...WORKER_ENTRIES.map((e) => join(ROOT, e))],
  absWorkingDir: ROOT,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  resolveExtensions: [".ts", ".mjs", ".js", ".json"],
  loader: { ".txt": "text", ".html": "text", ".wasm": "binary", ".bin": "binary" },
  define: {
    "import.meta.url": "__wd_url",
    "import.meta.dirname": "__wd_dir",
    "import.meta.dir": "__wd_dir",
    "import.meta.filename": "__wd_file",
    "import.meta.main": "false",
  },
  outdir: out,
  write: true,
  metafile: true,
  logLevel: "error",
  plugins: [workerdPlugin],
});
const graph: Record<string, string[]> = {};
for (const [path, input] of Object.entries<any>(built.metafile.inputs)) {
  graph[path] = input.imports.filter((i) => !i.external).map((i) => i.path);
}
const workerModules = reachable(graph, WORKER_ENTRIES);
const sharedSource = namedImports(readFileSync(join(ROOT, SHARED), "utf8"), (spec) => rel(join(ROOT, dirname(SHARED), spec)));

// ── 2. the lane ─────────────────────────────────────────────────────────────
const lane = allTests.filter((t) => {
  if (values.filter && !t.includes(values.filter)) return false;
  const direct = graph[t] ?? [];
  const fromShared = namedImports(readFileSync(join(ROOT, t), "utf8"), (spec) => rel(join(ROOT, dirname(t), spec)));
  const sharedNames = [...fromShared].filter(([, from]) => from === SHARED).map(([name]) => name);
  return inLane({ directImports: direct, sharedNames, sharedSource, workerModules });
});
console.error(`lane: ${lane.length} of ${allTests.length} test files exercise code from ${workerModules.size} Worker modules`);

// ── 3. bun, for the baseline ────────────────────────────────────────────────
const junit = join(scratch, "bun.xml");
spawnSync("bun", ["test", "--preload", "./tools/lib/no-network.ts", "--timeout=30000", "--reporter=junit", `--reporter-outfile=${junit}`, ...lane], {
  cwd: ROOT,
  stdio: "ignore",
});
const bunStatus = readJunit(readFileSync(junit, "utf8"));

// ── 4. workerd ──────────────────────────────────────────────────────────────
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.isFile() ? [join(dir, d.name)] : []));
const mounted = [...new Set([...repoFiles(), ...walk(".build")])].filter((f) => {
  try {
    const s = statSync(join(ROOT, f));
    return s.isFile() && s.size < FILE_SIZE_MAX;
  } catch {
    return false; // a tracked file deleted in the working tree
  }
});
const chunks = Object.keys(built.metafile.outputs).filter((p) => p.endsWith(".js") && !p.endsWith(".map"));
const harnessOut = chunks.find((p) => p.endsWith("/harness.js"));
if (harnessOut === undefined) throw new Error(`test-workerd: esbuild wrote no harness.js among ${chunks.length} chunks`);
const modules = [
  ...[harnessOut, ...chunks.filter((p) => p !== harnessOut)].map((p) => ({
    type: "ESModule",
    path: `/__wd/${relative(out, join(ROOT, p))}`,
    contents: readFileSync(join(ROOT, p), "utf8"),
  })),
  // workerd exposes the module tree under /bundle, so a Data module at
  // /<path> reads as /bundle/<path> through node:fs.
  ...mounted.map((f) => ({ type: "Data", path: `/${f}`, contents: new Uint8Array(readFileSync(join(ROOT, f))) })),
];
const config = await siteConfig();
const boot = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: [...config.compatibility_flags, "nodejs_compat"],
      modulesRoot: "/",
      modules,
    }),
  );

let mf = boot();
// A file either failed to load or ran its tests; the harness answers one or the other.
type FileRun = { file: string; fileTouched: string[]; loadError: string } | { file: string; fileTouched: string[]; results: WorkerdResult[] };
const files: FileRun[] = [];
for (const file of lane) {
  try {
    const res = await mf.dispatchFetch(`http://wd/?f=${encodeURIComponent(file)}`, {
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      files.push(JSON.parse(text));
    } catch {
      files.push({ file, loadError: `HTTP ${res.status}: ${text.slice(0, 2000)}`, fileTouched: [] });
    }
  } catch (e) {
    files.push({ file, loadError: `harness: ${e.message}`, fileTouched: [] });
    await mf.dispose().catch(() => {}); // the runtime is replaced either way
    mf = boot();
  }
}
await mf.dispose();
rmSync(scratch, { recursive: true, force: true });

// ── 5. compare ──────────────────────────────────────────────────────────────
const gaps = new Map<string, Gap>((JSON.parse(readFileSync(join(ROOT, GAPS), "utf8")) as Gap[]).map((g) => [g.test, g]));
const tally = { agree: 0, host: 0, known: 0, new: 0 };
const differing = new Set<string>();
const fresh: string[] = [];
for (const f of files) {
  const rows: [string, WorkerdResult, Status | undefined][] =
    "loadError" in f
      ? [[testKey(f.file, LOAD), { name: LOAD, status: "fail", error: f.loadError, touched: [] }, bunFileStatus(f.file)]]
      : f.results.map((r) => [testKey(f.file, r.name), r, bunStatus.get(testKey(f.file, r.name))]);
  for (const [key, workerd, bun] of rows) {
    const v = verdict({ key, workerd, bun, fileTouched: f.fileTouched, gaps });
    tally[v.kind]++;
    if (v.kind === "known" || v.kind === "new") differing.add(key);
    if (v.kind === "new") fresh.push(`  NEW  ${key}\n       ${v.status}: ${v.error}`);
  }
}
const stale = values.filter ? [] : staleGaps(gaps, differing);
console.log(`workerd lane: ${tally.agree} agree, ${tally.host} need a host, ${tally.known} known gaps, ${tally.new} new, ${stale.length} stale`);
for (const line of fresh) console.log(line);
for (const g of stale) console.log(`  STALE ${g.test}\n        no longer differs: drop it from ${GAPS}`);
if (values.json) writeFileSync(values.json, JSON.stringify({ tally, files }, null, 1));
process.exitCode = fresh.length || stale.length ? 1 : 0;

// `<file> :: <name>` to status, from bun's JUnit report. Nested suites (a
// describe) join their names with " > ", the way the shim names them.
function readJunit(xml: string): Map<string, Status> {
  const statuses = new Map<string, Status>();
  const unescape = (s: string) =>
    s
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const stack: string[] = [];
  let file = "";
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>|<(failure|skipped)\b/g)) {
    if (m[5]) {
      const last = [...statuses.keys()].at(-1);
      if (last) statuses.set(last, m[5] === "failure" ? "fail" : "skip");
      continue;
    }
    const [, closing, tag, attrs, selfClosing] = m;
    const name = unescape(/\bname="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "");
    if (tag === "testsuite") {
      if (closing) stack.pop();
      else {
        const f = /\bfile="([^"]*)"/.exec(attrs)?.[1];
        if (stack.length === 0 || f === name) file = f ?? name;
        stack.push(stack.length === 0 || f === name ? "" : name);
      }
    } else if (!closing) {
      const path = [...stack.filter(Boolean), name].join(" > ");
      statuses.set(testKey(file, path), "pass");
      if (selfClosing === "/") continue;
    }
  }
  return statuses;
}

function bunFileStatus(file: string): Status | undefined {
  const mine = [...bunStatus].filter(([k]) => k.startsWith(`${file} :: `)).map(([, s]) => s);
  return mine.length === 0 ? undefined : mine.includes("pass") ? "pass" : mine[0];
}

// A CommonJS stand-in for something only a host can run. esbuild reads named
// imports through __toESM, which copies own keys (this Proxy reports none) onto
// an object built from the module's prototype, so the prototype is a second
// Proxy that answers every name. Reading a name records the touch (a constant
// from a host module is a host fact too); calling anything records it and throws.
function hostStub(what: string): string {
  return `const TOUCHED = Symbol.for("aadhar.sh/workerd-host-touched");
const touch = (k) => { (globalThis[TOUCHED] ??= new Set()).add(${JSON.stringify(what)}); throw new Error(${JSON.stringify(`host-only ${what} (`)} + k + ") is not available inside workerd"); };
const held = (k) => new Proxy(function () {}, { get: (_, p) => (p === "then" ? undefined : held(k + "." + String(p))), apply: () => touch(k), construct: () => touch(k) });
const read = (k) => { if (typeof k === "string" && k !== "then" && k !== "__esModule") (globalThis[TOUCHED] ??= new Set()).add(${JSON.stringify(what)}); return k === "then" ? undefined : held(String(k)); };
const names = new Proxy({}, { get: (_, k) => read(k) });
module.exports = new Proxy({}, { get: (_, k) => (k === "__esModule" ? true : read(k)), getPrototypeOf: () => names });`;
}
