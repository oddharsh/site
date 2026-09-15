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
//   1. Is there a newer version ON THE PIN'S CHANNEL, and does npm carry it?
//      A release pin follows GitHub releases; a dated-canary pin follows npm's
//      `canary` dist-tag. Either way npm has to carry it, because that is
//      where the setup-bun action installs from (an `@oven/bun-<platform>`
//      tarball with a registry sha512) and what Cloudflare's build image
//      resolves. The channel is the pin's own SHAPE (lib/bun-pin.ts), so this
//      script walks one channel and never crosses to the other.
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
  channelOf,
  compareVersions,
  minimumReleaseAgeSeconds,
  npmBunDist,
  npmVersion,
  readPin,
  runningMatchesPin,
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
// `baselineVersion !== pin.version` is the release-channel form of this guard;
// a canary proves itself by revision, since its --version is the next release's.
const baseline = runningMatchesPin(pin.version, { version: baselineVersion, revision: Bun.revision });
if (!baseline.ok) {
  console.error(`${baseline.why}: this bun is not the pin (baselineVersion !== pin.version).`);
  console.error("the pinned bun is the baseline, so this comparison would measure the wrong pair. install the pin first.");
  process.exit(2);
}

const current = pretend || pin.version;
console.log(`pinned:    bun@${pin.version}${pretend ? `  (comparing as if ${pretend}, so nothing will be written)` : ""}`);
console.log(`baseline:  ${process.execPath}\n`);

// ---------------------------------------------------------------------------
// 1. is there a newer release ON THE PIN'S CHANNEL, and can every resolver see it?
// ---------------------------------------------------------------------------
// THE CHANNEL IS THE PIN'S SHAPE (lib/bun-pin.ts). A release pin follows
// releases; a dated-canary pin follows npm's `canary` dist-tag, which names the
// newest DATED canary and is immutable once published. Crossing channels is a
// hand edit of packageManager and never something this script does on its own,
// in either direction: a stable pin must not wake up on a canary, and a canary
// pin must not quietly fall back to the release line the day one ships.
const channel = channelOf(pin.version);
const explicitTarget = flag("--to");
let target = explicitTarget;
let publishedAt: number | null = null;

// npm has to carry the version either way, and it is also where the publish
// time comes from, which is the field bunfig.toml's own note tells you to read.
const npmRes = await fetch(`https://registry.npmjs.org/bun`, { headers: { accept: "application/json" } });
const npmMeta = npmRes.ok ? await npmRes.json() : null;

if (!target && channel === "stable") {
  // `releases/latest` skips drafts and prereleases, which is what keeps the
  // rolling `canary` tag out of the STABLE channel. That tag is not pinnable
  // anyway: it changes daily, and a pin has to name bytes that never move.
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

if (!target && channel === "canary") {
  // The dated canary npm publishes daily. Its value is an immutable version
  // string, so unlike the GitHub tag it can be pinned, compared and re-fetched.
  const tagged = String(npmMeta?.["dist-tags"]?.canary ?? "");
  if (channelOf(tagged) !== "canary") {
    console.error(`npm's canary dist-tag reads ${JSON.stringify(tagged)}, which is not a dated canary; refusing to guess`);
    process.exit(2);
  }
  target = tagged;
}

if (!target) {
  console.error("no candidate version could be resolved; nothing to compare");
  process.exit(2);
}

// A canary pin carries its build sha, and npm records it as build metadata on
// the canary's own platform dependencies (`1.4.2-canary.20260913.1+09bb546`).
// Read it from there rather than from a binary, so the pin names the commit
// before anything is downloaded.
if (channelOf(target) === "canary" && !target.includes("+")) {
  const dep = String(npmMeta?.versions?.[target]?.optionalDependencies?.["@oven/bun-linux-x64"] ?? "");
  const sha = dep.split("+")[1];
  if (!sha) {
    console.error(`npm records no build sha for bun@${target}, so it cannot be pinned as a canary`);
    process.exit(2);
  }
  target = `${target}+${sha}`;
}

if (channelOf(target) !== channel) {
  console.error(`${target} is on the ${channelOf(target)} channel while the pin ${pin.version} is on ${channel}.`);
  console.error("switching channels is a hand edit of packageManager, never a bump; this script only walks the channel it is on.");
  process.exit(2);
}

if (compareVersions(target, current) <= 0) {
  console.log(`bun:pin: nothing to do. ${target} is the newest ${channel} release and the pin is ${current}.`);
  console.log("  the control is `bun run bun:pin --from 1.3.13 --to 1.3.14`, which must fail at the zstd gate.");
  process.exit(0);
}

console.log(`candidate: bun@${target}  (${channel} channel)\n`);

{
  if (!npmMeta) {
    record("npm carries the release", false, `registry answered HTTP ${npmRes.status}`);
  } else {
    const onNpm = npmVersion(target);
    const known = Boolean(npmMeta.versions?.[onNpm]);
    publishedAt = npmMeta.time?.[onNpm] ? Date.parse(npmMeta.time[onNpm]) : null;
    record("npm carries the release", known, known ? `bun@${onNpm} published ${npmMeta.time?.[onNpm] ?? "at an unstated time"}` : `the registry has no bun@${onNpm} yet, so half the resolvers cannot see it`);
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
// A release comes from its GitHub tag, as it always has. A dated canary has no
// per-day GitHub asset and comes from npm's `@oven/bun-<platform>` tarball,
// whose sha512 the registry records at publish time and which is verified
// before the archive is opened.
let candidate: string;
try {
  if (channel === "stable") {
    candidate = await downloadBun(releaseUrl(target, releaseAsset()), WORK);
  } else {
    const dist = await npmBunDist(npmVersion(target));
    candidate = await downloadBun(dist.tarball, WORK, dist.integrity);
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(2);
}

{
  // The asset has to BE what it claims. A release binary reports its own
  // version. A canary binary reports the NEXT release (`1.4.3` for a tarball
  // tagged 1.4.2-canary.20260913.1, measured 2026-09-14), so for that channel
  // the identity is the tarball's own package.json, and the revision is printed
  // because it is what an upstream bug report needs.
  const identity = bunIdentity(candidate);
  const packaged = channel === "stable"
    ? identity.version
    : String(JSON.parse(readFileSync(join(WORK, "package", "package.json"), "utf8")).version ?? "");
  const sha = target.split("+")[1] ?? "";
  const same = channel === "stable"
    ? packaged === target
    : packaged === npmVersion(target) && identity.revision.includes(`+${sha}`);
  record(
    channel === "stable" ? "the asset reports the version it is tagged with" : "the tarball and the binary both name the pinned canary",
    same,
    `asked for ${target}, ${channel === "stable" ? "the binary reports" : "the tarball says"} ${packaged || "nothing"}${channel === "canary" ? `, binary revision ${identity.revision}` : ""}`,
  );
  if (!same) {
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
