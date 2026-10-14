// The bun this repository runs is declared ONCE, in config/bun-pin.json, and
// this module exists to keep it that way.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// THE SHA IS LOAD-BEARING, because a canary binary does not report its own
// npm version: `bun --version` on the tarball tagged 1.4.2-canary.20260913.1
// prints `1.4.3` (measured 2026-09-14). What it does report is `Bun.revision`,
// the full commit, and npm records that same commit as build metadata on the
// canary's platform dependencies (`1.4.2-canary.20260913.1+09bb546`). So the
// sha is how a running canary proves it IS the pin, which the baseline guard
// in bump-bun-pin.ts and canary-bun.ts needs before it compares anything.
export const PIN_FILE = "config/bun-pin.json";
const PIN_PATTERN = /("bun"\s*:\s*")(canary|\d+\.\d+\.\d+(?:-canary\.\d{8}\.\d+\+[0-9a-f]{7,40})?)(")/;

export type Channel = "stable" | "canary" | "rolling";

export function channelOf(version: string): Channel {
  if (version === "canary") return "rolling";
  return /-canary\.\d{8}\.\d+(\+[0-9a-f]+)?$/.test(version) ? "canary" : "stable";
}

export function parseVersion(version: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-canary\.(\d{8})\.(\d+)(?:\+([0-9a-f]{7,40}))?)?$/.exec(version);
  if (!m) throw new Error(`not a bun version this repo can pin: ${version}`);
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
    canary: m[4] ? ([Number(m[4]), Number(m[5])] as const) : null,
    sha: m[6] ?? null,
  };
}

export function npmVersion(version: string) {
  return version.replace(/\+[0-9a-f]+$/, "");
}

export function runningMatchesPin(pin: string, running: { version: string; revision: string }, installedRevision?: string) {
  if (pin === "canary") {
    const ok = installedRevision !== undefined && running.revision === installedRevision && /^[0-9a-f]{40}$/.test(running.revision);
    return { ok, why: `rolling canary: running ${running.revision.slice(0, 9)}, ${ok ? "matches installed receipt" : "does not match installation receipt; run .github/install-bun.sh"}` };
  }
  const parsed = parseVersion(pin);
  if (!parsed.canary) return { ok: running.version === pin, why: `running ${running.version}, pin ${pin}` };
  if (!parsed.sha) return { ok: false, why: `a canary pin must carry its build sha (${pin} has none), or nothing can prove a running bun is it` };
  const ok = running.revision.startsWith(parsed.sha);
  return { ok, why: `running revision ${running.revision.slice(0, 9)}, pin ${pin}` };
}

export function installedMatchesPin(pin: string, executable: string, running: { version: string; revision: string }) {
  if (pin !== "canary") return runningMatchesPin(pin, running);
  try {
    const receipt = JSON.parse(readFileSync(join(dirname(executable), "bun.install.json"), "utf8"));
    return runningMatchesPin(pin, running, receipt.source === "canary" ? receipt.revision : undefined);
  } catch {
    return runningMatchesPin(pin, running);
  }
}

export function readPin(root: string) {
  const text = readFileSync(join(root, PIN_FILE), "utf8");
  const found = PIN_PATTERN.exec(text);
  if (!found) throw new Error(`${PIN_FILE} carries no supported Bun source`);
  return { raw: `bun@${found[2]}`, version: found[2] };
}

export function writePin(root: string, version: string) {
  const path = join(root, PIN_FILE);
  const text = readFileSync(path, "utf8");
  if (!PIN_PATTERN.test(text)) throw new Error(`${PIN_FILE} carries no supported Bun source`);
  writeFileSync(path, text.replace(PIN_PATTERN, `$1${version}$3`));
}

export function minimumReleaseAgeSeconds(root: string) {
  const text = readFileSync(join(root, "bunfig.toml"), "utf8");
  const found = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(text);
  if (!found) throw new Error("bunfig.toml declares no minimumReleaseAge");
  return Number(found[1]);
}

export type NpmMeta = {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
};

export function newestSeasonedCanary(
  npmMeta: NpmMeta | null | undefined,
  windowSeconds: number,
  now: number = Date.now(),
): { version: string; publishedAt: number; skipped: { version: string; ageSeconds: number | null }[] } | null {
  const time = npmMeta?.time ?? {};
  const canaries = Object.keys(npmMeta?.versions ?? {})
    .filter((v) => channelOf(v) === "canary")
    .sort((a, b) => compareVersions(b, a));
  const skipped: { version: string; ageSeconds: number | null }[] = [];
  for (const version of canaries) {
    const publishedAt = time[version] ? Date.parse(time[version]) : NaN;
    if (Number.isNaN(publishedAt)) {
      skipped.push({ version, ageSeconds: null });
      continue;
    }
    const ageSeconds = Math.floor((now - publishedAt) / 1000);
    if (ageSeconds >= windowSeconds) return { version, publishedAt, skipped };
    skipped.push({ version, ageSeconds });
  }
  return null;
}

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

export function npmPlatform(platform: string = process.platform, arch: string = process.arch) {
  return releaseAsset(platform, arch).replace(/\.zip$/, "");
}

export function npmTarballUrl(version: string, platform: string = npmPlatform()) {
  return `https://registry.npmjs.org/@oven/${platform}/-/${platform}-${version}.tgz`;
}

export async function npmBunDist(version: string, platform: string = npmPlatform()) {
  const res = await fetch(`https://registry.npmjs.org/@oven/${platform}/${version}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry has no @oven/${platform}@${version} (HTTP ${res.status})`);
  const doc = await res.json();
  const tarball = String(doc?.dist?.tarball ?? "");
  const integrity = String(doc?.dist?.integrity ?? "");
  if (!tarball.endsWith(".tgz") || !integrity.startsWith("sha512-")) throw new Error(`registry document for @oven/${platform}@${version} carries no tarball or no sha512`);
  return { tarball, integrity };
}

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

export function interpretZstdProbe(stdout: unknown) {
  let parsed: { none: number; good: number; wrong: number } | null = null;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { }
  if (!parsed) return { parsed: null, honoured: null, detail: "probe did not run" };
  const honoured = parsed.good < parsed.none && parsed.wrong >= parsed.none;
  return {
    parsed,
    honoured,
    detail: `${parsed.none} none / ${parsed.good} good / ${parsed.wrong} wrong`,
  };
}
