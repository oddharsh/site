#!/usr/bin/env node
// pnpm run bun:check [--bun /path/to/bun]
//
// The control for "could this repo's build run on bun instead of node?".
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
//   3. Does the contract suite pass? Bun's test runner needs `.test` in the
//      filename, so this stands up a symlink and takes it down again.
//
// The verdict this printed on 2026-08-10, node v26.7.0 vs bun 1.4.0-canary.1:
// all three green, 1975 files identical, 17.0s -> 8.3s. The blocker is release
// timing rather than behaviour, because 1.3.14 is the newest STABLE bun and it
// fails question 1.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, ".build");
const SHADOW = join(ROOT, ".build.node-baseline");
const TEST_LINK = join(ROOT, "tools", "contract-tests.test.mjs");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

function resolveBun() {
  const explicit = flag("--bun") || process.env.BUN;
  if (explicit) return explicit;
  const found = spawnSync("command", ["-v", "bun"], { shell: true, encoding: "utf8" });
  const path = found.stdout?.trim();
  if (!path) {
    console.error("no bun found. install one, or point at a build:\n  pnpm run bun:check --bun /path/to/bun");
    process.exit(2);
  }
  return path;
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
// Three compressions of one target: no dictionary, the right dictionary, a
// wrong one. An engine that honours the option prints a SMALLER number for the
// right dictionary alone. An engine that ignores it prints the same number
// three times, which is why the byte count is the only available signal.
const PROBE = `
import { zstdCompressSync } from "node:zlib";
const target = Buffer.from(("export const NAV_SHELL = {taskbar:1,start:1,clock:1};").repeat(400));
const n = (o) => zstdCompressSync(target, o).length;
console.log(JSON.stringify({
  none:  n({}),
  good:  n({ dictionary: target.subarray(0, 4096) }),
  wrong: n({ dictionary: Buffer.alloc(4096, 0x78) }),
}));
`;
{
  const out = run(bun, ["-e", PROBE]);
  let parsed = null;
  try { parsed = JSON.parse(out.stdout.trim()); } catch { /* left null on purpose */ }
  if (!parsed) {
    record("zstd honours `dictionary`", false, `probe did not run: ${(out.stderr || "").trim().split("\n")[0] || "no output"}`);
  } else {
    const honoured = parsed.good < parsed.none && parsed.wrong >= parsed.none;
    record(
      "zstd honours `dictionary`",
      honoured,
      `${parsed.none} none / ${parsed.good} good / ${parsed.wrong} wrong` +
        (honoured ? "" : "  <-- SILENT: every dcz delta would be plain zstd"),
    );
  }
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

if (existsSync(SHADOW)) rmSync(SHADOW, { recursive: true, force: true });
let restored = false;
try {
  rmSync(BUILD, { recursive: true, force: true });
  const nodeMs = timedBuild("node", process.execPath, ["tools/build.mjs"]);
  renameSync(BUILD, SHADOW);

  const bunMs = timedBuild("bun", bun, ["tools/build.mjs"]);

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
} finally {
  if (!restored && existsSync(SHADOW)) {
    rmSync(BUILD, { recursive: true, force: true });
    renameSync(SHADOW, BUILD);
  }
}

// ---------------------------------------------------------------------------
// 3. the contract suite
// ---------------------------------------------------------------------------
// `bun test` filters on `.test`/`_test_`/`.spec` in the filename and the suite
// is `contract-tests.test.mjs`, so it needs a symlink. It lives beside the real file
// because the tests resolve fixtures off `import.meta.url`.
try {
  if (existsSync(TEST_LINK)) unlinkSync(TEST_LINK);
  symlinkSync("contract-tests.test.mjs", TEST_LINK);
  const out = run(bun, ["test", "tools/contract-tests.test.mjs"]);
  const text = `${out.stdout}\n${out.stderr}`;
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
  record("contract suite passes under bun", fail === 0 && pass > 0, `${pass} pass, ${fail} fail`);
  if (fail > 0) {
    for (const line of text.split("\n").filter((l) => l.includes("(fail)"))) console.log(`         ${line.trim()}`);
  }
} finally {
  if (existsSync(TEST_LINK) && statSync(TEST_LINK, { throwIfNoEntry: false })) unlinkSync(TEST_LINK);
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`bun:check: NOT viable — ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}
console.log("bun:check: all green on this build. Note that VIABLE is not ADOPTED:");
console.log("  wrangler + miniflare + workerd is the deploy and route-oracle path and is node-pinned,");
console.log("  and a canary is not something the build path may depend on. See gotcha 28.");
try {
  // `pnpm` rather than `npm` since #306: this repo pins `packageManager`, and the
  // one stray npm invocation here was the only thing left asking for the other
  // client. stderr is dropped because pnpm warns about workspace configuration on
  // stdout-only reads, and a registry lookup's grumbling should not land in the
  // middle of a verdict. The registry is still npm's — only the client changed.
  const stable = execFileSync("pnpm", ["view", "bun", "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`  newest STABLE bun on npm: ${stable}`);
} catch { /* offline, or no pnpm on PATH; the verdict above does not depend on it */ }
