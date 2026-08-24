#!/usr/bin/env bun
// bun run bun:pin [--write] [--to X.Y.Z] [--from X.Y.Z] [--keep]
//
// Keeps `packageManager: bun@x.y.z` current, because NOTHING ELSE DOES.
//
// Dependabot owns five ecosystems here and none of them owns this string. The
// npm updater bumps `@types/bun` and never the runtime; the `bun` ecosystem
// would not help either, since it reads bun.lock rather than the field. So the
// one version with no updater is the one that compiles the site: wrangler.jsonc
// builds with `bun tools/build.ts`, and `/a/` and `/i/` URLs are content
// addressed, so the pinned bun decides what every returning visitor's cached
// dictionary is keyed against.
//
// THE ANCESTOR of this script is `.github/workflows/bun-release-watch.yml` on
// the unmerged `ci/bun-release-watch` branch, which asked one question ("has bun
// 1.4 shipped, so the migration can resume") and answered it on 2026-08-20. This
// asks the general form and, unlike that one, does not stop at noticing.
//
// FIVE GATES, ordered so the cheapest disqualifier runs first. Gate 3 is the
// only one that can be true and invisible at the same time, which is why it
// runs before the two that cost a minute.
//
//   1. Is there a newer STABLE release, and does npm carry it too? Three
//      different resolvers read this one string (the setup-bun action pulls a
//      GitHub release asset, Cloudflare's build image resolves a released
//      version, corepack-shaped tooling reads the registry), so a version that
//      only half of them can see is not a version this repo can pin.
//   2. Is it older than the install policy's own window? bunfig.toml refuses a
//      PACKAGE published in the last 24 hours; a runtime deserves at least that.
//   3. Does its zstd honour `dictionary`? The silent one. See lib/bun-pin.ts.
//   4. Can it read the committed bun.lock, and does it write the same
//      lockfileVersion? This is the gate that exists because of what 1.4 DID:
//      it raised the lockfile from v1 to v2, which broke dependabot's bun
//      updater for every repository on a current bun and did it silently, by
//      discarding the file and writing the old format back. A runtime that
//      changes the lockfile format is a migration rather than a bump.
//   5. Is the build output BYTE-IDENTICAL, and does the suite still pass? The
//      real bar, and higher than "the build succeeds": one differing byte mints
//      a different URL, orphans every a-dict snapshot naming the old hash, and
//      moves the CSP hashes documents are served under.
//
// CONTROL, and it is permanent rather than a one-off: the PREVIOUS bun is a
// known-bad runtime, so the script has a red input on hand forever.
//
//   bun run bun:pin --from 1.3.13 --to 1.3.14   # must fail at gate 3
//
// Without it, a run that reports "nothing to do" on a day when the pin is
// already current proves only that the comparison ran.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "./lib/jsonc.ts";
import {
  ZSTD_DICTIONARY_PROBE,
  compareVersions,
  interpretZstdProbe,
  minimumReleaseAgeSeconds,
  readPin,
  releaseAsset,
  releaseUrl,
  writePin,
} from "./lib/bun-pin.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, ".build");
const SHADOW = join(ROOT, ".build.pinned-baseline");
const WORK = join(ROOT, ".bun-candidate");

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

const results: { name: string; ok: boolean }[] = [];
const record = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const note = (text: string) => console.log(`       ${text}`);

// ---------------------------------------------------------------------------
// which bun is the baseline
// ---------------------------------------------------------------------------
// The running runtime IS the baseline, so it has to BE the pin. A stale bun on
// PATH would compare the candidate against a third runtime and report a
// byte-identical build that says nothing about production. This is the mirror
// image of the guard the retired check-bun.ts carried, which refused to be
// invoked through bun because that compared bun with bun.
const pin = readPin(ROOT);
const pretend = flag("--from");
const baselineVersion = process.versions.bun;
if (!baselineVersion) {
  console.error("bun:pin must run under bun: the pinned runtime is the baseline half of the comparison");
  process.exit(2);
}
if (baselineVersion !== pin.version) {
  console.error(`running bun ${baselineVersion} while package.json pins ${pin.version}.`);
  console.error("the pinned bun is the baseline, so this comparison would measure the wrong pair. install the pin first.");
  process.exit(2);
}

const current = pretend || pin.version;
console.log(`pinned:    bun@${pin.version}${pretend ? `  (comparing as if ${pretend}, so nothing will be written)` : ""}`);
console.log(`baseline:  ${process.execPath}\n`);

// ---------------------------------------------------------------------------
// 1. is there a newer stable release, and can every resolver see it?
// ---------------------------------------------------------------------------
const explicitTarget = flag("--to");
let target = explicitTarget;
let publishedAt: number | null = null;

if (!target) {
  // `releases/latest` skips drafts and prereleases, which is what keeps the
  // rolling `canary` tag out. A canary is not pinnable anyway: the setup-bun
  // action's whole argument for dropping its SHA-256 was that a RELEASED tag is
  // immutable while `canary` changed daily.
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "aadhar.sh bun:pin",
  };
  // Raises the unauthenticated 60/hr per-IP limit that shared runners exhaust,
  // the same reason infra:check passes one for the rulesets tier. Optional, so
  // a workstation with no token still runs this.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch("https://api.github.com/repos/oven-sh/bun/releases/latest", { headers });
  if (!res.ok) {
    console.error(`could not read oven-sh/bun releases: HTTP ${res.status}`);
    process.exit(2);
  }
  const latest = await res.json();
  const tag = String(latest.tag_name || "");
  const found = /^bun-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!found) {
    console.error(`newest release is tagged ${tag || "(nothing)"}, which is not a plain bun-vX.Y.Z; refusing to guess`);
    process.exit(2);
  }
  target = found[1];
}

if (compareVersions(target, current) <= 0) {
  console.log(`bun:pin: nothing to do. ${target} is the newest stable release and the pin is ${current}.`);
  console.log("  the control is `bun run bun:pin --from 1.3.13 --to 1.3.14`, which must fail at the zstd gate.");
  process.exit(0);
}

console.log(`candidate: bun@${target}\n`);

// npm has to carry it too. The registry is also where the publish time comes
// from, which is the field bunfig.toml's own note tells you to read.
{
  const res = await fetch(`https://registry.npmjs.org/bun`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    record("npm carries the release", false, `registry answered HTTP ${res.status}`);
  } else {
    const meta = await res.json();
    const known = Boolean(meta.versions?.[target]);
    publishedAt = meta.time?.[target] ? Date.parse(meta.time[target]) : null;
    record("npm carries the release", known, known ? `bun@${target} published ${meta.time?.[target] ?? "at an unstated time"}` : `the registry has no bun@${target} yet, so half the resolvers cannot see it`);
  }
}

// ---------------------------------------------------------------------------
// 2. the install policy's own window
// ---------------------------------------------------------------------------
{
  const window = minimumReleaseAgeSeconds(ROOT);
  if (publishedAt === null) {
    record("older than the install policy's window", false, "no publish time to read; treat an unknown age as too young");
  } else {
    const ageSeconds = Math.floor((Date.now() - publishedAt) / 1000);
    const hours = (ageSeconds / 3600).toFixed(0);
    record(
      "older than the install policy's window",
      ageSeconds >= window,
      `${hours} h old against bunfig's ${(window / 3600).toFixed(0)} h`,
    );
  }
}

if (results.some((r) => !r.ok)) {
  console.log(`\nbun:pin: ${target} is not proposable yet. Nothing downloaded, nothing built.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// fetch the candidate
// ---------------------------------------------------------------------------
const asset = releaseAsset();
const url = releaseUrl(target, asset);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const zipPath = join(WORK, asset);

{
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`could not download ${url}: HTTP ${res.status}`);
    process.exit(2);
  }
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
}

const unzip = run("unzip", ["-qo", zipPath, "-d", WORK]);
if (unzip.status !== 0) {
  console.error(`unzip failed: ${(unzip.stderr || "").trim()}`);
  process.exit(2);
}

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
const candidate = findBun(WORK);
if (!candidate) {
  console.error(`no bun binary inside ${asset}`);
  process.exit(2);
}
chmodSync(candidate, 0o755);

{
  // The asset has to BE what the tag claims. Same assertion the setup-bun action
  // makes, and for the same reason: the version string is the whole guarantee
  // now that the digest pin is gone.
  const reported = run(candidate, ["--version"]).stdout?.trim();
  record("the asset reports the version it is tagged with", reported === target, `asked for ${target}, the binary reports ${reported || "nothing"}`);
  if (reported !== target) {
    console.log("\nbun:pin: refusing to go further with a binary that disagrees with its own tag.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 3. the silent one
// ---------------------------------------------------------------------------
{
  const out = run(candidate, ["-e", ZSTD_DICTIONARY_PROBE]);
  const verdict = interpretZstdProbe(out.stdout);
  record(
    "zstd honours `dictionary`",
    verdict.honoured === true,
    verdict.honoured === true
      ? verdict.detail
      : `${verdict.detail}  <-- every dcz delta would be plain zstd`,
  );
  if (verdict.honoured !== true) {
    console.log("\nbun:pin: NOT proposable. build.ts feature-detects the same collapse and throws, so this would");
    console.log("  fail the build 40 seconds in rather than ship no-op deltas, which is a poor way to learn it.");
    if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 4. the lockfile, in both directions
// ---------------------------------------------------------------------------
{
  // READ. `--dry-run` so a candidate runtime never writes into node_modules the
  // pinned one is about to build with.
  const out = run(candidate, ["install", "--frozen-lockfile", "--dry-run"]);
  const ok = out.status === 0;
  record("reads the committed bun.lock", ok, ok ? "frozen install resolves" : (out.stderr || out.stdout || "").trim().split("\n").slice(-2).join(" "));
}

{
  // WRITE. A mirror of the manifests alone, resolved by each runtime back to
  // back, which is what controls for registry drift: a caret range that floated
  // upstream floats for both, seconds apart, so a difference between the two is
  // attributable to the runtime rather than to the registry.
  //
  // Only the FORMAT fields fail. Comparing the whole file would fail on drift,
  // measured 2026-08-24: the pinned bun does not reproduce the committed
  // bun.lock byte-for-byte, because `vite` had moved 8.2.1 to 8.2.2 under a
  // caret since the lockfile was written. That is a fact about the registry.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifests = ["package.json", "bunfig.toml", ...(pkg.workspaces ?? []).map((w) => join(w, "package.json"))];
  const lockVersions: Record<string, string | null> = {};
  const texts: Record<string, string> = {};

  for (const [label, exe] of [["pinned", process.execPath], ["candidate", candidate]]) {
    const mirror = join(WORK, `lock-${label}`);
    rmSync(mirror, { recursive: true, force: true });
    for (const rel of manifests) {
      const dest = join(mirror, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(ROOT, rel), dest);
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

  const committed = parseJsonc(readFileSync(join(ROOT, "bun.lock"), "utf8"));
  const committedFormat = `lockfileVersion ${committed.lockfileVersion} / configVersion ${committed.configVersion}`;
  const same = lockVersions.pinned !== null && lockVersions.pinned === lockVersions.candidate && lockVersions.candidate === committedFormat;
  record(
    "writes the committed lockfile format",
    same,
    same ? committedFormat : `committed ${committedFormat}, pinned ${lockVersions.pinned ?? "wrote nothing"}, candidate ${lockVersions.candidate ?? "wrote nothing"}`,
  );
  if (same && texts.pinned !== texts.candidate) {
    note("the two runtimes resolved the same manifests to DIFFERENT lockfile contents, which registry drift");
    note("cannot explain across seconds. Read the diff before merging; the format gate above passed.");
  }
}

if (results.some((r) => !r.ok)) {
  console.log(`\nbun:pin: ${target} fails a gate above. Not proposing it.`);
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. the real bar
// ---------------------------------------------------------------------------
function hashTree(dir: string) {
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

// THROWS rather than exits, because `process.exit()` skips `finally` and the
// finally is what puts `.build/` back. Inherited from the retired check-bun.ts,
// which learned it the hard way: the first run against a bun old enough to fail
// the build left the tree holding a half-written `.build/` beside an orphan
// baseline.
const build = (label: string, exe: string) => {
  const started = process.hrtime.bigint();
  const out = run(exe, ["tools/build.ts"], { stdio: ["ignore", "pipe", "pipe"] });
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
  const pinnedMs = build("pinned", process.execPath);
  renameSync(BUILD, SHADOW);
  const candidateMs = build("candidate", candidate);

  const a = hashTree(SHADOW);
  const b = hashTree(BUILD);
  const onlyPinned = [...a.keys()].filter((k) => !b.has(k));
  const onlyCandidate = [...b.keys()].filter((k) => !a.has(k));
  const differing = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  const identical = onlyPinned.length === 0 && onlyCandidate.length === 0 && differing.length === 0;

  record(
    "build output is byte-identical",
    identical,
    identical
      ? `${a.size} files, pinned ${(pinnedMs / 1000).toFixed(1)}s vs candidate ${(candidateMs / 1000).toFixed(1)}s`
      : `${differing.length} differing, ${onlyPinned.length} pinned-only, ${onlyCandidate.length} candidate-only`,
  );
  for (const f of [...differing, ...onlyPinned, ...onlyCandidate].slice(0, 20)) note(f);

  // Leave `.build/` holding the PINNED output. A tree staged by a runtime this
  // repo has not adopted is not something a later `wrangler deploy` should find.
  rmSync(BUILD, { recursive: true, force: true });
  renameSync(SHADOW, BUILD);
  restored = true;
} finally {
  if (!restored && existsSync(SHADOW)) {
    rmSync(BUILD, { recursive: true, force: true });
    renameSync(SHADOW, BUILD);
  }
}

{
  // The preload is not decoration: `bun run test` carries it, so a suite run
  // without it is a different suite from the one `validate` gates on.
  const out = run(candidate, ["test", "--preload", "./tools/lib/no-network.ts", "tools/"]);
  const text = `${out.stdout}\n${out.stderr}`;
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
  record("contract suite passes under the candidate", fail === 0 && pass > 0, `${pass} pass, ${fail} fail`);
  for (const line of text.split("\n").filter((l) => l.includes("(fail)")).slice(0, 10)) note(line.trim());
}

// ---------------------------------------------------------------------------
if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`bun:pin: ${target} is NOT proposable — ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}

// `@types/bun` is DEPENDABOT'S, and the two are allowed to disagree for a day.
// DEPENDENCIES.md already worked this through: the release-age policy delayed
// the types pin behind the runtime once and it caught up on its own, which is a
// wait rather than a fork. Say it, never enforce it.
const types = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies?.["@types/bun"];
if (types && types !== target) {
  note(`@types/bun is ${types}; dependabot owns that pin and usually follows within a day.`);
}

if (pretend) {
  console.log(`bun:pin: ${target} clears every gate. Nothing written, because --from means this was a control run.`);
  process.exit(0);
}

if (has("--write")) {
  writePin(ROOT, target);
  console.log(`bun:pin: wrote packageManager: bun@${target}. Every gate green.`);
} else {
  console.log(`bun:pin: ${target} clears every gate. Re-run with --write to move the pin.`);
}
