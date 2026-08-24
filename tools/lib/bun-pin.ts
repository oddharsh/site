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

const PIN_PATTERN = /("packageManager"\s*:\s*")bun@(\d+\.\d+\.\d+)(")/;

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

/** Numeric per component, so 1.10.0 reads as newer than 1.4.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
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
