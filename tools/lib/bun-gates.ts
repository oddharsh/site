// bun-gates.ts — the gates a candidate bun has to clear, shared by the two
// scripts that run them.
//
// `bump-bun-pin.ts` proposes a newer STABLE bun and carried these inline until
// 2026-09-14, when `canary-bun.ts` wanted the same five against the rolling
// canary. Two copies of a byte-identical-build gate agree on the day they are
// written and rot separately after, which is the argument lib/bun-pin.ts
// already makes for the zstd probe, so the gates moved here and both scripts
// call them. The bumper decides WHETHER to run them (release age, npm
// carrying the version) and what to do after (write the pin); the canary
// script never writes anything. What they share is the middle.
//
// Each gate returns a record rather than printing, so a caller can render a
// table for a terminal or a JSON file for a workflow. `ok` is the verdict,
// `detail` is one line, `notes` are the lines worth reading under a failure.
//
// The build gate THROWS on a failed build rather than exiting, because
// `process.exit()` skips `finally` and the finally is what puts `.build/`
// back. Inherited from the retired check-bun.ts, which left the tree holding
// a half-written `.build/` beside an orphan baseline the first time a bun
// old enough to fail the build ran through it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { ZSTD_DICTIONARY_PROBE, interpretZstdProbe } from "./bun-pin.ts";
import { parseJsonc } from "./jsonc.ts";

export type Gate = { name: string; ok: boolean; detail: string; notes?: string[] };

const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });

const tail = (out: { stdout?: string | null; stderr?: string | null }, lines = 2) =>
  `${out.stderr || ""}\n${out.stdout || ""}`.trim().split("\n").slice(-lines).join(" ");

/**
 * Fetch a bun binary into `work` and return its path. Two shapes: a GitHub
 * release ZIP (the rolling `canary` tag, and releases) and an npm `.tgz`
 * (`@oven/bun-<platform>`, which is where DATED canaries live). Pass the
 * registry's `integrity` for the tgz and the bytes are checked before they
 * are unpacked, which the zip path has never been able to offer. Throws.
 */
export async function downloadBun(url: string, work: string, integrity?: string): Promise<string> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const isTgz = url.endsWith(".tgz");
  const archive = join(work, isTgz ? "bun.tgz" : "bun.zip");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (integrity) {
    const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (got !== integrity) throw new Error(`${url} does not match the registry's integrity: got ${got}, registry says ${integrity}`);
  }
  writeFileSync(archive, bytes);

  const unpack = isTgz ? run("tar", ["-xzf", archive, "-C", work]) : run("unzip", ["-qo", archive, "-d", work]);
  if (unpack.status !== 0) throw new Error(`${isTgz ? "tar" : "unzip"} failed: ${(unpack.stderr || "").trim()}`);

  const findBun = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name);
      if (entry.isDirectory()) {
        const deeper = findBun(next);
        if (deeper) return deeper;
      } else if (entry.isFile() && entry.name === "bun") return next;
    }
    return null;
  };
  const exe = findBun(work);
  if (!exe) throw new Error(`no bun binary inside ${url}`);
  chmodSync(exe, 0o755);
  return exe;
}

/** `--version` is the plain triple even on a canary; `--revision` carries the suffix and commit. */
export function bunIdentity(exe: string) {
  return {
    version: run(exe, ["--version"]).stdout?.trim() || "",
    revision: run(exe, ["--revision"]).stdout?.trim() || "",
  };
}

// THE SILENT ONE. See ZSTD_DICTIONARY_PROBE for why a runtime that accepts the
// option and ignores it produces nothing an API can report.
export function zstdGate(exe: string): Gate {
  const out = run(exe, ["-e", ZSTD_DICTIONARY_PROBE]);
  const verdict = interpretZstdProbe(out.stdout);
  return {
    name: "zstd honours `dictionary`",
    ok: verdict.honoured === true,
    detail: verdict.honoured === true ? verdict.detail : `${verdict.detail}  <-- every dcz delta would be plain zstd`,
  };
}

// READ. `--dry-run` so a candidate runtime never writes into node_modules the
// pinned one is about to build with.
export function lockfileReadGate(exe: string, root: string): Gate {
  const out = run(exe, ["install", "--frozen-lockfile", "--dry-run"], { cwd: root });
  const ok = out.status === 0;
  return { name: "reads the committed bun.lock", ok, detail: ok ? "frozen install resolves" : tail(out) };
}

// WRITE. A mirror of the manifests alone, resolved by each runtime back to
// back, which is what controls for registry drift: a caret range that floated
// upstream floats for both, seconds apart, so a difference between the two is
// attributable to the runtime rather than to the registry.
//
// Only the FORMAT fields fail. Comparing the whole file would fail on drift,
// measured 2026-08-24: the pinned bun does not reproduce the committed
// bun.lock byte-for-byte, because `vite` had moved 8.2.1 to 8.2.2 under a
// caret since the lockfile was written. That is a fact about the registry.
export function lockfileFormatGate(candidate: string, pinned: string, root: string, work: string): Gate {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifests = ["package.json", "bunfig.toml", ...(pkg.workspaces ?? []).map((w: string) => join(w, "package.json"))];
  const lockVersions: Record<string, string | null> = {};
  const texts: Record<string, string> = {};

  for (const [label, exe] of [["pinned", pinned], ["candidate", candidate]] as const) {
    const mirror = join(work, `lock-${label}`);
    rmSync(mirror, { recursive: true, force: true });
    for (const rel of manifests) {
      const dest = join(mirror, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, rel), dest);
    }
    const out = run(exe, ["install", "--lockfile-only"], { cwd: mirror });
    const lock = join(mirror, "bun.lock");
    if (out.status !== 0 || !existsSync(lock)) {
      lockVersions[label] = null;
      continue;
    }
    const text = readFileSync(lock, "utf8");
    texts[label] = text;
    // bun.lock is JSONC: it carries trailing commas, so `JSON.parse` rejects it.
    const parsed = parseJsonc(text);
    lockVersions[label] = `lockfileVersion ${parsed.lockfileVersion} / configVersion ${parsed.configVersion}`;
  }

  const committed = parseJsonc(readFileSync(join(root, "bun.lock"), "utf8"));
  const committedFormat = `lockfileVersion ${committed.lockfileVersion} / configVersion ${committed.configVersion}`;
  const same = lockVersions.pinned !== null && lockVersions.pinned === lockVersions.candidate && lockVersions.candidate === committedFormat;
  const notes: string[] = [];
  if (same && texts.pinned !== texts.candidate) {
    notes.push("the two runtimes resolved the same manifests to DIFFERENT lockfile contents, which registry drift");
    notes.push("cannot explain across seconds. Read the diff before merging; the format gate above passed.");
  }
  return {
    name: "writes the committed lockfile format",
    ok: same,
    detail: same ? committedFormat : `committed ${committedFormat}, pinned ${lockVersions.pinned ?? "wrote nothing"}, candidate ${lockVersions.candidate ?? "wrote nothing"}`,
    notes,
  };
}

/** sha256 of every file under `dir`, keyed by relative path. */
export function hashTree(dir: string) {
  const files = new Map<string, string>();
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.set(relative(dir, next), createHash("sha256").update(readFileSync(next)).digest("hex"));
    }
  };
  walk(dir);
  return files;
}

/** The three lists that separate two hashed trees. Empty everywhere means identical. */
export function diffTrees(a: Map<string, string>, b: Map<string, string>) {
  const onlyA = [...a.keys()].filter((k) => !b.has(k));
  const onlyB = [...b.keys()].filter((k) => !a.has(k));
  const differing = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  return { onlyA, onlyB, differing, identical: onlyA.length === 0 && onlyB.length === 0 && differing.length === 0 };
}

// THE REAL BAR, and higher than "the build succeeds": one differing byte
// mints a different URL, orphans every a-dict snapshot naming the old hash,
// and moves the CSP hashes documents are served under.
//
// Leaves `.build/` holding the PINNED output. A tree staged by a runtime this
// repo has not adopted is not something a later `wrangler deploy` should find.
export function byteIdenticalBuildGate(candidate: string, pinned: string, root: string): Gate {
  const BUILD = join(root, ".build");
  const SHADOW = join(root, ".build.pinned-baseline");

  const build = (label: string, exe: string) => {
    const started = process.hrtime.bigint();
    const out = run(exe, ["tools/build.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (out.status !== 0) {
      throw new Error(`${label} build failed (exit ${out.status}):\n${tail(out, 6)}`);
    }
    return ms;
  };

  if (existsSync(SHADOW)) rmSync(SHADOW, { recursive: true, force: true });
  let restored = false;
  try {
    rmSync(BUILD, { recursive: true, force: true });
    const pinnedMs = build("pinned", pinned);
    renameSync(BUILD, SHADOW);
    const candidateMs = build("candidate", candidate);

    const a = hashTree(SHADOW);
    const b = hashTree(BUILD);
    const d = diffTrees(a, b);

    rmSync(BUILD, { recursive: true, force: true });
    renameSync(SHADOW, BUILD);
    restored = true;

    return {
      name: "build output is byte-identical",
      ok: d.identical,
      detail: d.identical
        ? `${a.size} files, pinned ${(pinnedMs / 1000).toFixed(1)}s vs candidate ${(candidateMs / 1000).toFixed(1)}s`
        : `${d.differing.length} differing, ${d.onlyA.length} pinned-only, ${d.onlyB.length} candidate-only`,
      notes: [...d.differing, ...d.onlyA, ...d.onlyB].slice(0, 20),
    };
  } finally {
    if (!restored && existsSync(SHADOW)) {
      rmSync(BUILD, { recursive: true, force: true });
      renameSync(SHADOW, BUILD);
    }
  }
}

/**
 * The arguments `bun run test` hands to `bun test`, read out of package.json
 * rather than restated. A suite run with different flags is a different suite
 * from the one `validate` gates on, and a restated copy is how the two drift.
 */
export function suiteArgs(root: string): string[] {
  const script = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test ?? "");
  const [cmd, sub, ...args] = script.trim().split(/\s+/);
  if (cmd !== "bun" || sub !== "test" || !args.length) throw new Error(`package.json's test script is ${JSON.stringify(script)}; the suite gate expects \`bun test <flags> <paths>\``);
  return args;
}

// THE GATE RUNS `bun run test`'s OWN FLAGS, and restating them is what broke
// it. It used to pass `--preload` alone, on the argument that a suite without
// the preload is a different suite from `validate`'s. True, and the same holds
// for `--timeout=30000`, which it dropped: the suite ran on bun's 5s per-test
// default, so the one test that cargo-builds timbrado's engine cold was killed
// at 5010ms every night from 2026-09-15, and the bumper proposed nothing while
// exiting green. The notes carry the `error:` lines as well as the `(fail)`
// ones, because a gate that names only the failing test leaves the reader to
// reproduce it before they learn why.
export function contractSuiteGate(exe: string, root: string, timeoutMs = 15 * 60_000): Gate {
  const out = run(exe, ["test", ...suiteArgs(root)], { cwd: root, timeout: timeoutMs });
  const text = `${out.stdout}\n${out.stderr}`;
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
  const timedOut = out.signal === "SIGTERM";
  const telling = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("(fail)") || l.startsWith("error:"));
  return {
    name: "contract suite passes under the candidate",
    ok: !timedOut && fail === 0 && pass > 0,
    detail: timedOut ? `hung past ${timeoutMs / 1000}s` : `${pass} pass, ${fail} fail`,
    notes: [...new Set(telling)].slice(0, 10),
  };
}

// Cal's suite boots wrangler's own harness under bun, which is the one
// runtime-sensitive thing in the tree the contract suite never touches:
// oven-sh/bun#39247 is a hang in exactly that harness (the undici shim ignores
// the `dispatcher` init option miniflare passes), and a fix that lands or a
// regression that returns shows up here first. The timeout is what makes a
// hang a verdict rather than a stuck job.
export function calSuiteGate(exe: string, root: string, timeoutMs = 5 * 60_000): Gate {
  const out = run(exe, ["run", "--filter", "cal-aadhar-sh", "test"], { cwd: root, timeout: timeoutMs });
  const text = `${out.stdout}\n${out.stderr}`;
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
  const timedOut = out.signal === "SIGTERM";
  return {
    name: "cal suite passes under the candidate (wrangler harness)",
    ok: !timedOut && fail === 0 && pass > 0 && out.status === 0,
    detail: timedOut ? `hung past ${timeoutMs / 1000}s, which is the shape of oven-sh/bun#39247` : `${pass} pass, ${fail} fail`,
    notes: text.split("\n").filter((l) => l.includes("(fail)")).slice(0, 10).map((l) => l.trim()),
  };
}
