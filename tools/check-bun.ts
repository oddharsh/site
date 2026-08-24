#!/usr/bin/env node
// bun run bun:check [--bun /path/to/bun]
//
// The cross-runtime control for the build Bun runs in normal development.
//
// It is a SCRIPT and not a CI step for the same reason `kitesurf:check` is: the
// answer only changes when someone ships a new bun, and the run costs two full
// builds (~25s). Run it when a bun release lands, record the verdict, move on.
//
// Three questions, in the order that can disqualify bun soonest:
//
//   1. Does `node:zlib`'s zstd honour `dictionary`? FIRST because it disqualifies
//      a runtime outright: build.mjs mints every dcz delta through
//      `zstdCompressSync({ dictionary })`, and an engine that accepts the option
//      and ignores it produces plain zstd that still decodes correctly against
//      the dictionary, so the API itself reports nothing. workerd does exactly
//      this (measured 2026-08-05, see /terminal) and bun did too through 1.3.14;
//      oven-sh/bun#34427 fixed it for 1.4.
//
//      What this check is NOT is the tripwire. build.mjs already feature-detects
//      the same thing and THROWS (search `expected a collapse`), which is how bun
//      1.3.14 announces itself: the build dies rather than shipping no-op deltas.
//      This runs the probe anyway, because a build that dies 40 seconds in with a
//      message about `.node-version` is a poor way to learn that your bun is too
//      old, and because the probe is the thing worth quoting in a note.
//
//   2. Is the build output BYTE-IDENTICAL to node's? This is the real bar, and
//      it is higher than "the build succeeds". `/a/` and `/i/` assets are
//      content-addressed, so one byte of difference anywhere mints a different
//      URL, invalidates every committed shell dictionary that names the old
//      hash, and changes the CSP hashes the documents are served under. A build
//      that is 2x faster and 1 byte different is not a faster build.
//
//   3. Does the contract suite pass under Bun as well as under its normal Node
//      control? The suite already carries Bun's required `.test` filename.
//
// This file MUST run under node. It uses process.execPath for the Node baseline;
// invoking it through Bun turns that into Bun and compares the runtime with
// itself, which is a green result with no control at all.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { ZSTD_DICTIONARY_PROBE, interpretZstdProbe } from "./lib/bun-pin.ts";

class SkipBuildComparison extends Error {}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, ".build");
const SHADOW = join(ROOT, ".build.node-baseline");

if (process.versions.bun) {
  console.error("bun:check must be controlled by Node; run `bun run bun:check`, which dispatches this script through node");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

function resolveBun() {
  const explicit = flag("--bun") || process.env.BUN;
  if (explicit) return explicit;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(dir, "bun");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep walking PATH.
    }
  }
  console.error("no bun found. install one, or point at a build:\n  bun run bun:check --bun /path/to/bun");
  process.exit(2);
}

const bun = resolveBun();
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

const version = run(bun, ["--revision"]).stdout?.trim() || run(bun, ["--version"]).stdout?.trim();
console.log(`bun:   ${bun}\n       ${version}`);
console.log(`node:  ${process.version}\n`);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. the silent one: does zstd honour `dictionary`?
// ---------------------------------------------------------------------------
// The probe itself lives in lib/bun-pin.ts, because `bump-bun-pin.ts` runs the
// same three compressions against a candidate runtime and two copies of one
// measurement agree on the day they are written and rot separately after. A
// contract test fails if either file re-declares it.
{
  const out = run(bun, ["-e", ZSTD_DICTIONARY_PROBE]);
  const verdict = interpretZstdProbe(out.stdout);
  record(
    "zstd honours `dictionary`",
    verdict.honoured === true,
    verdict.honoured === null
      ? `probe did not run: ${(out.stderr || "").trim().split("\n")[0] || "no output"}`
      : verdict.detail + (verdict.honoured ? "" : "  <-- SILENT: every dcz delta would be plain zstd"),
  );
}

// A failure here disqualifies the runtime, so stop rather than spend two builds
// proving it again. build.mjs's own tripwire would kill the node-vs-bun run
// partway through anyway, and a half-run comparison reads as a tooling fault.
if (results.some((r) => !r.ok)) {
  console.log("\nbun:check: NOT viable on this build — every dcz delta would be plain zstd.");
  console.log("  build.mjs feature-detects the same thing and throws, so the build would fail rather than ship no-ops.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. the real bar: byte-identical build output
// ---------------------------------------------------------------------------
function hashTree(dir) {
  const files = new Map();
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.set(relative(dir, next), createHash("sha256").update(readFileSync(next)).digest("hex"));
    }
  };
  walk(dir);
  return files;
}

// THROWS rather than exits, on purpose: `process.exit()` skips `finally`, and the
// finally below is what puts `.build/` back. Caught that the first time this ran
// against a bun old enough to fail the build, which left the tree holding a
// half-written `.build/` beside an orphan baseline.
const timedBuild = (label, cmd, args) => {
  const started = process.hrtime.bigint();
  const out = run(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (out.status !== 0) {
    const tail = (out.stderr || out.stdout || "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`${label} build failed (exit ${out.status}):\n${tail}`);
  }
  return ms;
};

// NODE CANNOT RUN THIS BUILD ANY MORE, so the baseline half of this comparison
// is gone. Measured 2026-08-24 on unmodified main: `lib/link-integrity.ts` has
// parsed documents with HTMLRewriter since 2026-08-20 rather than
// pattern-matching them, HTMLRewriter is a bun and workerd global, and `node
// tools/build.ts` dies with `ReferenceError: HTMLRewriter is not defined`
// before writing anything. The same line took the nightly dictionary roll down
// for three nights (#567).
//
// A 20ms probe rather than a 25s build that ends in a stack trace, because the
// question is settled and the reason is worth naming at the point of failure.
//
// WHAT REPLACES IT is `bun run bun:pin`, which compares a CANDIDATE bun against
// the PINNED one and is the comparison that matters now: production builds with
// `bun tools/build.ts`, so bun-versus-bun is the pair that decides whether a
// content-addressed URL moves. Node was the right baseline while the question
// was whether to adopt bun at all. That question is answered, and this control
// is a candidate for retirement rather than repair.
const nodeCanBuild = run(process.execPath, ["-e", "new HTMLRewriter()"]).status === 0;
if (!nodeCanBuild) {
  record(
    "build output is byte-identical",
    false,
    "node cannot run this build at all (HTMLRewriter is not defined), so there is no baseline to diff against",
  );
  console.log("         `bun run bun:pin` is the live form of this check: candidate bun against the pinned one.");
}

if (existsSync(SHADOW)) rmSync(SHADOW, { recursive: true, force: true });
let restored = false;
try {
  if (!nodeCanBuild) throw new SkipBuildComparison();
  rmSync(BUILD, { recursive: true, force: true });
  const nodeMs = timedBuild("node", process.execPath, ["tools/build.ts"]);
  renameSync(BUILD, SHADOW);

  const bunMs = timedBuild("bun", bun, ["tools/build.ts"]);

  const a = hashTree(SHADOW);
  const b = hashTree(BUILD);
  const onlyNode = [...a.keys()].filter((k) => !b.has(k));
  const onlyBun = [...b.keys()].filter((k) => !a.has(k));
  const differing = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  const identical = onlyNode.length === 0 && onlyBun.length === 0 && differing.length === 0;

  record(
    "build output is byte-identical",
    identical,
    identical
      ? `${a.size} files, node ${(nodeMs / 1000).toFixed(1)}s vs bun ${(bunMs / 1000).toFixed(1)}s`
      : `${differing.length} differing, ${onlyNode.length} node-only, ${onlyBun.length} bun-only`,
  );
  for (const f of [...differing, ...onlyNode, ...onlyBun].slice(0, 20)) console.log(`         ${f}`);

  // Leave `.build/` holding NODE's output. A half-checked tree staged by an
  // unreleased runtime is not something a later `wrangler deploy` should find.
  rmSync(BUILD, { recursive: true, force: true });
  renameSync(SHADOW, BUILD);
  restored = true;
} catch (err) {
  // A skip is not a crash. Anything else still is.
  if (!(err instanceof SkipBuildComparison)) throw err;
} finally {
  if (!restored && existsSync(SHADOW)) {
    rmSync(BUILD, { recursive: true, force: true });
    renameSync(SHADOW, BUILD);
  }
}

// ---------------------------------------------------------------------------
// 3. the contract suite
// ---------------------------------------------------------------------------
// The suite already has a Bun-discoverable name. Never stage a link over this
// path: an older version did that after the source was renamed and unlinked the
// real tracked file before the test runner started.
{
  const out = run(bun, ["test", "tools/"]);
  const text = `${out.stdout}\n${out.stderr}`;
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
  record("contract suite passes under bun", fail === 0 && pass > 0, `${pass} pass, ${fail} fail`);
  if (fail > 0) {
    for (const line of text.split("\n").filter((l) => l.includes("(fail)"))) console.log(`         ${line.trim()}`);
  }
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  // "NOT viable" is a verdict about BUN, and the dead baseline is a verdict
  // about this script. Saying the first when the second is true would report a
  // perfectly good runtime as disqualified, which is the wrong way round.
  if (!nodeCanBuild && failed.length === 1) {
    console.log("bun:check: cannot run. Bun cleared every question this script can still ask;");
    console.log("  the node baseline is gone, so the byte-identical comparison has no second side.");
    console.log("  Use `bun run bun:pin` instead, which compares a candidate bun against the pinned one.");
    process.exit(2);
  }
  console.log(`bun:check: NOT viable — ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}
console.log("bun:check: all green on this build.");
console.log("  Node remains the control because wrangler, the route oracle, and historical gzip measurements are node-pinned.");
