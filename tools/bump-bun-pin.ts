#!/usr/bin/env bun
// bun run bun:pin [--write] [--to X.Y.Z] [--from X.Y.Z] [--keep] [--json <path>]

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "timbrado/report";

import {
  channelOf,
  compareVersions,
  minimumReleaseAgeSeconds,
  newestSeasonedCanary,
  npmBunDist,
  npmVersion,
  readPin,
  installedMatchesPin,
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
import { ensureTimbradoEngine } from "./lib/upstream-watches.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(ROOT, ".bun-candidate");

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const results: { name: string; ok: boolean; detail: string; notes?: string[] }[] = [];
const record = (name: string, ok: boolean, detail?: string, notes?: string[]) => {
  results.push({ name, ok, detail: detail ?? "", notes });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const note = (text: string) => console.log(`       ${text}`);
const gate = (g: Gate) => {
  record(g.name, g.ok, g.detail, g.notes);
  for (const n of g.notes ?? []) note(n);
  return g.ok;
};

const jsonPath = flag("--json");
const report = (verdict: "green" | "red", subject: Record<string, string>, reason?: string) => {
  if (!jsonPath) return;
  const failing = results.filter((r) => !r.ok).map((r) => r.name);
  const out: Report = {
    schemaVersion: 1,
    target: "bun-pin",
    verdict,
    subject,
    signature: verdict === "green" ? "green" : `red:${failing.join("|") || reason || "unknown"}`,
    gates: results,
    reason,
  };
  writeFileSync(jsonPath, JSON.stringify(out, null, 2) + "\n");
};

const pin = readPin(ROOT);
const pretend = flag("--from");
const baselineVersion = process.versions.bun;
if (!baselineVersion) {
  console.error("bun:pin must run under bun: the pinned runtime is the baseline half of the comparison");
  process.exit(2);
}
// `baselineVersion !== pin.version` is the release-channel form of this guard;
// a canary proves itself by revision, since its --version is the next release's.
const baseline = installedMatchesPin(pin.version, process.execPath, { version: baselineVersion, revision: Bun.revision });
if (!baseline.ok) {
  console.error(`${baseline.why}: this bun is not the pin (baselineVersion !== pin.version).`);
  console.error("the pinned bun is the baseline, so this comparison would measure the wrong pair. install the pin first.");
  process.exit(2);
}

if (pin.version === "canary") {
  if (flag("--to") || pretend) {
    console.error("bun:pin: rolling canary is selected; declare an exact npm pin before comparing explicit versions");
    process.exit(2);
  }
  console.log(`bun:pin: rolling GitHub canary selected, installed revision ${Bun.revision}. Nothing to rewrite.`);
  report("green", { pin: "bun@canary", revision: Bun.revision }, "rolling source resolves during installation");
  process.exit(0);
}

const current = pretend || pin.version;
console.log(`pinned:    bun@${pin.version}${pretend ? `  (comparing as if ${pretend}, so nothing will be written)` : ""}`);
console.log(`baseline:  ${process.execPath}\n`);

const channel = channelOf(pin.version);
const explicitTarget = flag("--to");
let target = explicitTarget;
let publishedAt: number | null = null;

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
  const window = minimumReleaseAgeSeconds(ROOT);
  const seasoned = newestSeasonedCanary(npmMeta, window);
  if (!seasoned) {
    console.error(`npm lists no dated canary older than bunfig's ${(window / 3600).toFixed(0)} h window; refusing to guess`);
    process.exit(2);
  }
  target = seasoned.version;
  if (seasoned.skipped.length) {
    const ages = seasoned.skipped.map((s) => `${npmVersion(s.version)} (${s.ageSeconds === null ? "no publish time" : `${(s.ageSeconds / 3600).toFixed(0)} h`})`);
    console.log(`skipping ${seasoned.skipped.length} newer canar${seasoned.skipped.length === 1 ? "y" : "ies"} inside bunfig's ${(window / 3600).toFixed(0)} h window: ${ages.join(", ")}`);
  }
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
  console.error("switching channels is a hand edit of config/bun-pin.json, never a bump; this script only walks the channel it is on.");
  process.exit(2);
}

if (compareVersions(target, current) <= 0) {
  console.log(`bun:pin: nothing to do. ${target} is the newest ${channel} release and the pin is ${current}.`);
  console.log("  the control is `bun run bun:pin --from 1.3.13 --to 1.3.14`, which must fail at the zstd gate.");
  if (!pretend) report("green", { pin: `bun@${pin.version}` }, "the pin is current");
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

const subject = { pin: `bun@${pin.version}`, candidate: `bun@${target}` };
const red = (reason?: string) => {
  if (!pretend) report("red", subject, reason);
};

try {
  ensureTimbradoEngine();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("bun:pin: timbrado's Rust engine could not be built, so the contract suite cannot run its watches");
  process.exit(2);
}

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
  // The canary tarball's manifest names the version WITH its build sha, so it
  // equals the whole pin; a release tarball names the bare version, which is
  // the whole pin too. The binary's revision is the second witness.
  const sha = target.split("+")[1] ?? "";
  const same = channel === "stable"
    ? packaged === target
    : packaged === target && identity.revision.includes(`+${sha}`);
  record(
    channel === "stable" ? "the asset reports the version it is tagged with" : "the tarball and the binary both name the pinned canary",
    same,
    `asked for ${target}, ${channel === "stable" ? "the binary reports" : "the tarball says"} ${packaged || "nothing"}${channel === "canary" ? `, binary revision ${identity.revision}` : ""}`,
  );
  if (!same) {
    console.log("\nbun:pin: refusing to go further with a binary that disagrees with its own tag.");
    red();
    process.exit(1);
  }
}

if (!gate(zstdGate(candidate))) {
  console.log("\nbun:pin: NOT proposable. build.ts feature-detects the same collapse and throws, so this would");
  console.log("  fail the build 40 seconds in rather than ship no-op deltas, which is a poor way to learn it.");
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  red();
  process.exit(1);
}

gate(lockfileReadGate(candidate, ROOT));
gate(lockfileFormatGate(candidate, process.execPath, ROOT, WORK));

if (results.some((r) => !r.ok)) {
  console.log(`\nbun:pin: ${target} fails a gate above. Not proposing it.`);
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  red();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. the real bar: a pin change must preserve build bytes (gotcha 28)
// ---------------------------------------------------------------------------
gate(byteIdenticalBuildGate(candidate, process.execPath, ROOT));
gate(contractSuiteGate(candidate, ROOT));

if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`bun:pin: ${target} is NOT proposable — ${failed.map((r) => r.name).join("; ")}`);
  red();
  process.exit(1);
}

const types = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies?.["@types/bun"];
if (types && types !== target) {
  note(`@types/bun is ${types}; dependabot owns that pin and usually follows within a day.`);
}

if (pretend) {
  console.log(`bun:pin: ${target} clears every gate. Nothing written, because --from means this was a control run.`);
  process.exit(0);
}

report("green", subject);

if (has("--write")) {
  writePin(ROOT, target);
  console.log(`bun:pin: wrote config/bun-pin.json: bun ${target}. Every gate green.`);
} else {
  console.log(`bun:pin: ${target} clears every gate. Re-run with --write to move the pin.`);
}
