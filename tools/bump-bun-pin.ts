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
// Gates 3 to 5 live in lib/bun-gates.ts since 2026-09-14, because canary-bun.ts
// runs the same five against the rolling canary every night. This script keeps
// the decisions: whether a version is proposable at all (gates 1 and 2), and
// what to do once it clears (write the pin). The canary script has neither.
//
// CONTROL, and it is permanent rather than a one-off: the PREVIOUS bun is a
// known-bad runtime, so the script has a red input on hand forever.
//
//   bun run bun:pin --from 1.3.13 --to 1.3.14   # must fail at gate 3
//
// Without it, a run that reports "nothing to do" on a day when the pin is
// already current proves only that the comparison ran.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareVersions,
  minimumReleaseAgeSeconds,
  readPin,
  releaseAsset,
  releaseUrl,
  writePin,
} from "./lib/bun-pin.ts";
import {
  type Gate,
  bunIdentity,
  byteIdenticalBuildGate,
  contractSuiteGate,
  downloadBun,
  lockfileFormatGate,
  lockfileReadGate,
  zstdGate,
} from "./lib/bun-gates.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(ROOT, ".bun-candidate");

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const results: { name: string; ok: boolean }[] = [];
const record = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const note = (text: string) => console.log(`       ${text}`);
const gate = (g: Gate) => {
  record(g.name, g.ok, g.detail);
  for (const n of g.notes ?? []) note(n);
  return g.ok;
};

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
let candidate: string;
try {
  candidate = await downloadBun(url, WORK);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(2);
}

{
  // The asset has to BE what the tag claims. Same assertion the setup-bun action
  // makes, and for the same reason: the version string is the whole guarantee
  // now that the digest pin is gone.
  const reported = bunIdentity(candidate).version;
  record("the asset reports the version it is tagged with", reported === target, `asked for ${target}, the binary reports ${reported || "nothing"}`);
  if (reported !== target) {
    console.log("\nbun:pin: refusing to go further with a binary that disagrees with its own tag.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 3. the silent one
// ---------------------------------------------------------------------------
if (!gate(zstdGate(candidate))) {
  console.log("\nbun:pin: NOT proposable. build.ts feature-detects the same collapse and throws, so this would");
  console.log("  fail the build 40 seconds in rather than ship no-op deltas, which is a poor way to learn it.");
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. the lockfile, in both directions
// ---------------------------------------------------------------------------
gate(lockfileReadGate(candidate, ROOT));
gate(lockfileFormatGate(candidate, process.execPath, ROOT, WORK));

if (results.some((r) => !r.ok)) {
  console.log(`\nbun:pin: ${target} fails a gate above. Not proposing it.`);
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. the real bar
// ---------------------------------------------------------------------------
gate(byteIdenticalBuildGate(candidate, process.execPath, ROOT));
gate(contractSuiteGate(candidate, ROOT));

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
