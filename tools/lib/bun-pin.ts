// The bun this repository runs is declared ONCE, in package.json's
// `packageManager`, and this module exists to keep it that way.
//
// Two consumers read that one string and neither may carry a copy:
// `.github/actions/setup-bun` reads the field in shell, and `bump-bun-pin.ts`
// proposes moving it. There were three until 2026-08-24, when `check-bun.ts`
// was retired: node cannot build this repo any more, so its node-versus-bun
// comparison had no second side.
//
// The capability probe below is shared for the same reason `MCP_SUPPORTED` is
// shared between the two MCP servers: two copies of a probe agree on the day
// they are written and rot separately after. A contract test fails if a caller
// re-declares it, and that assertion is worth keeping at one consumer, because
// the next runtime control to want this probe is exactly when a second copy
// gets pasted.
//
// WHY THE PIN MATTERS MORE THAN IT LOOKS. wrangler.jsonc's build command is
// `bun tools/build.ts`, so the bun this field names is the compiler that mints
// every content-addressed `/a/` and `/i/` URL production serves. Changing it is
// a build change wearing a version string.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A pin is a release (`1.4.2`) or a DATED CANARY WITH ITS BUILD SHA
// (`1.4.2-canary.20260913.1+09bb546`), and both are exact. bun publishes every
// canary build to npm under that dated, immutable version with
// `@oven/bun-<platform>` tarballs beside it, which is what makes a canary
// pinnable at all: the GitHub `canary` tag rolls, npm's dated version never
// moves. Since 2026-09-14 the CHANNEL is the pin's own shape, so it is declared
// once with the version rather than in a second field that could disagree.
//
// THE SHA IS LOAD-BEARING, because a canary binary does not report its own
// npm version: `bun --version` on the tarball tagged 1.4.2-canary.20260913.1
// prints `1.4.3` (measured 2026-09-14). What it does report is `Bun.revision`,
// the full commit, and npm records that same commit as build metadata on the
// canary's platform dependencies (`1.4.2-canary.20260913.1+09bb546`). So the
// sha is how a running canary proves it IS the pin, which the baseline guard
// in bump-bun-pin.ts and canary-bun.ts needs before it compares anything.
const PIN_PATTERN = /("packageManager"\s*:\s*")bun@(\d+\.\d+\.\d+(?:-canary\.\d{8}\.\d+\+[0-9a-f]{7,40})?)(")/;

export type Channel = "stable" | "canary";

/** Which channel a pin follows, read off its shape. */
export function channelOf(version: string): Channel {
  return /-canary\.\d{8}\.\d+(\+[0-9a-f]+)?$/.test(version) ? "canary" : "stable";
}

/** The parts a comparison needs: the triple, the canary date and build, and the build sha when there is one. */
export function parseVersion(version: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-canary\.(\d{8})\.(\d+)(?:\+([0-9a-f]{7,40}))?)?$/.exec(version);
  if (!m) throw new Error(`not a bun version this repo can pin: ${version}`);
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
    canary: m[4] ? ([Number(m[4]), Number(m[5])] as const) : null,
    sha: m[6] ?? null,
  };
}

/** The version as npm names it: a pin minus its build sha. */
export function npmVersion(version: string) {
  return version.replace(/\+[0-9a-f]+$/, "");
}

/**
 * Does the RUNNING bun match the pin? A release proves it by version. A canary
 * proves it by revision, since its `--version` is the next release's number.
 * Pure, so a test can hand it any pair; callers pass process.versions.bun and
 * Bun.revision.
 */
export function runningMatchesPin(pin: string, running: { version: string; revision: string }) {
  const parsed = parseVersion(pin);
  if (!parsed.canary) return { ok: running.version === pin, why: `running ${running.version}, pin ${pin}` };
  if (!parsed.sha) return { ok: false, why: `a canary pin must carry its build sha (${pin} has none), or nothing can prove a running bun is it` };
  const ok = running.revision.startsWith(parsed.sha);
  return { ok, why: `running revision ${running.revision.slice(0, 9)}, pin ${pin}` };
}

/** The bun `package.json` pins, as both the raw field and its bare version. */
export function readPin(root: string) {
  const text = readFileSync(join(root, "package.json"), "utf8");
  const found = PIN_PATTERN.exec(text);
  if (!found) throw new Error("package.json carries no `packageManager: bun@x.y.z`");
  return { raw: `bun@${found[2]}`, version: found[2] };
}

// A SURGICAL REPLACE rather than a JSON round trip. `JSON.stringify` would
// reorder nothing but would drop the file's own formatting and, more to the
// point, its five `comment:` keys carry paragraphs that a re-serialize would
// reflow into one line each. The pin is one field; edit one field.
export function writePin(root: string, version: string) {
  const path = join(root, "package.json");
  const text = readFileSync(path, "utf8");
  if (!PIN_PATTERN.test(text)) throw new Error("package.json carries no `packageManager: bun@x.y.z`");
  writeFileSync(path, text.replace(PIN_PATTERN, `$1bun@${version}$3`));
}

// Read the install policy's window instead of restating it. bunfig.toml refuses
// a package published inside `minimumReleaseAge`, and a bun release deserves at
// least the caution this repo already applies to a lightningcss patch. Restating
// the number here is how the two drift apart, which is the whole argument the
// dependabot cooldown block makes.
//
// UNIT TRAP, inherited from that file and worth repeating at every reader: bun
// counts SECONDS where pnpm counted minutes.
export function minimumReleaseAgeSeconds(root: string) {
  const text = readFileSync(join(root, "bunfig.toml"), "utf8");
  const found = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(text);
  if (!found) throw new Error("bunfig.toml declares no minimumReleaseAge");
  return Number(found[1]);
}

// Numeric per component, so 1.10.0 reads as newer than 1.4.0. On an equal
// triple a RELEASE outranks a canary of it (semver's rule, and npm's: the
// canaries of the unreleased 1.4.3 are published as `1.4.2-canary.<date>`), and
// two canaries compare by date and then build number. Note what that means
// for the two channels: a canary pin is only ever compared with canaries, and
// a stable pin with releases, so this ordering decides "is there something
// newer on MY channel" and never proposes a crossing.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.triple[i] !== pb.triple[i]) return pa.triple[i] < pb.triple[i] ? -1 : 1;
  }
  if (!pa.canary && !pb.canary) return 0;
  if (!pa.canary) return 1;
  if (!pb.canary) return -1;
  for (let i = 0; i < 2; i++) {
    if (pa.canary[i] !== pb.canary[i]) return pa.canary[i] < pb.canary[i] ? -1 : 1;
  }
  return 0;
}

/** The npm platform package bun ships its binary in, for this host. */
export function npmPlatform(platform: string = process.platform, arch: string = process.arch) {
  return releaseAsset(platform, arch).replace(/\.zip$/, "");
}

/**
 * The registry tarball for an exact version, stable or canary. `@oven/bun-<platform>`
 * holds `package/bin/bun`; the registry document beside it carries the sha512 the
 * installer verifies, which is a guarantee the GitHub release zip never offered.
 */
export function npmTarballUrl(version: string, platform: string = npmPlatform()) {
  return `https://registry.npmjs.org/@oven/${platform}/-/${platform}-${version}.tgz`;
}

/** The registry's own record of that tarball: its URL and its sha512 integrity. */
export async function npmBunDist(version: string, platform: string = npmPlatform()) {
  const res = await fetch(`https://registry.npmjs.org/@oven/${platform}/${version}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry has no @oven/${platform}@${version} (HTTP ${res.status})`);
  const doc = await res.json();
  const tarball = String(doc?.dist?.tarball ?? "");
  const integrity = String(doc?.dist?.integrity ?? "");
  if (!tarball.endsWith(".tgz") || !integrity.startsWith("sha512-")) throw new Error(`registry document for @oven/${platform}@${version} carries no tarball or no sha512`);
  return { tarball, integrity };
}

/** The release asset for the host, in the naming oven-sh/bun tags its releases with. */
export function releaseAsset(platform: string = process.platform, arch: string = process.arch) {
  const key = `${platform}-${arch}`;
  const known: Record<string, string> = {
    "linux-x64": "bun-linux-x64.zip",
    "linux-arm64": "bun-linux-aarch64.zip",
    "darwin-x64": "bun-darwin-x64.zip",
    "darwin-arm64": "bun-darwin-aarch64.zip",
  };
  const asset = known[key];
  if (!asset) throw new Error(`no bun release asset known for ${key}`);
  return asset;
}

export function releaseUrl(version: string, asset: string = releaseAsset()) {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}`;
}

// The ROLLING tag. Its assets are replaced on every canary build (the release
// object itself dates from 2022 and its `published_at` never moves; the
// asset's `updated_at` is the honest timestamp), so nothing that pins may read
// it and canary-bun.ts, which proposes nothing, is its only consumer.
export function canaryUrl(asset: string = releaseAsset()) {
  return `https://github.com/oven-sh/bun/releases/download/canary/${asset}`;
}

// THE ONE CAPABILITY THIS BUILD CANNOT SHIP WITHOUT, and the one that fails
// silently. `build.ts` mints every dcz delta through
// `zstdCompressSync({ dictionary })`, and a runtime that ACCEPTS the option and
// ignores it produces plain zstd that still decodes correctly against the
// dictionary, so the API reports nothing and the only signal is a byte count
// that never shrank. workerd does exactly this, and bun did through 1.3.14
// (oven-sh/bun#34427 fixed it for 1.4).
//
// Three compressions of one target: no dictionary, the right one, a wrong one.
// A runtime that honours the option prints a SMALLER number for the right
// dictionary alone. One that ignores it prints the same number three times.
export const ZSTD_DICTIONARY_PROBE = `
import { zstdCompressSync } from "node:zlib";
const target = Buffer.from(("export const NAV_SHELL = {taskbar:1,start:1,clock:1};").repeat(400));
const n = (o) => zstdCompressSync(target, o).length;
console.log(JSON.stringify({
  none:  n({}),
  good:  n({ dictionary: target.subarray(0, 4096) }),
  wrong: n({ dictionary: Buffer.alloc(4096, 0x78) }),
}));
`;

/** Reads the probe's stdout. `honoured: null` means the probe never ran. */
export function interpretZstdProbe(stdout: unknown) {
  let parsed: { none: number; good: number; wrong: number } | null = null;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { /* left null on purpose */ }
  if (!parsed) return { parsed: null, honoured: null, detail: "probe did not run" };
  const honoured = parsed.good < parsed.none && parsed.wrong >= parsed.none;
  return {
    parsed,
    honoured,
    detail: `${parsed.none} none / ${parsed.good} good / ${parsed.wrong} wrong`,
  };
}
