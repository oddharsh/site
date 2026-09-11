// Enforce config/retired.json: dependencies this repository replaced with
// first-party code, and the surface each one would have to come back through.
//
// EVERY PREDICATE HERE TAKES BYTES RATHER THAN A PATH, so the contract test can
// run each one against a fixture that violates it. A ban that has never been
// seen to fail is decoration, and three of the four kinds below are one regex
// away from matching nothing and reporting a clean pass.
//
// THE BANS NEVER READ FREE TEXT. Every retired name still appears in this tree
// on purpose, because a comment recording a retirement has to name what it
// retired. So each predicate asks a DECLARATION: a package.json dependency map,
// config/tools.json's `bin`, a Cargo manifest or lockfile, or an import
// statement anchored at the start of a line. The ledger's own header carries
// the long version of this argument.
import { parse as parseToml } from "smol-toml";
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";

/** One retirement, as config/retired.json records it. */
export interface Retirement {
  id: string;
  replaced_by: string;
  on: string;
  scope?: string;
  why: string;
  measured: string;
  bans: Bans;
}

export interface Bans {
  npm?: string[];
  binary?: string[];
  cargo?: { manifest: string; crates?: string[]; features?: { crate: string; feature: string }[] };
  source?: { specifiers: string[]; trees: string[]; except?: string[] };
}

/** The ban kinds this module implements.
 *
 *  The contract test asserts the ledger uses NOTHING ELSE. An unrecognised key
 *  would otherwise sit in the file looking like enforcement while doing
 *  nothing, which is how `.github/dependabot.yml` shipped a `labels:` list
 *  naming a label GitHub did not have.
 */
//
//  Typed as a plain string list rather than a literal tuple so a caller can ask
//  `BAN_KINDS.includes(someKey)` about a key read from JSON, which is the only
//  question it exists to answer. `Bans` above is the type-level twin.
export const BAN_KINDS: readonly string[] = ["npm", "binary", "cargo", "source"];

/** The four maps npm resolves a direct dependency from. */
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** A finding. `where` is the file, `what` names the banned thing found in it. */
export interface Violation {
  id: string;
  kind: string;
  where: string;
  what: string;
}

/** Banned packages asked for by one package.json.
 *
 *  Reads the four dependency maps and NEVER bun.lock, which is a deliberate
 *  limit rather than an oversight: `@cloudflare/workers-types` is an optional
 *  PEER of wrangler and sits in bun.lock on a tree that is correct, so a
 *  lockfile ban would fail on the state this repo is trying to hold. The claim
 *  a ban makes is that this repository does not ask for the package.
 */
export function npmViolations(manifestPath: string, text: string, banned: string[]): string[] {
  const pkg = JSON.parse(text);
  const found: string[] = [];
  for (const map of DEPENDENCY_MAPS) {
    const table = asRecord(pkg[map]);
    if (!table) continue;
    for (const name of banned) {
      if (Object.hasOwn(table, name)) found.push(`${map}.${name}`);
    }
  }
  return found;
}

/** Banned binaries declared in config/tools.json.
 *
 *  That file is the repository's census of external executables, and
 *  `tools:check` already fails on a script whose binary is missing from it. So
 *  re-adding a retired binary has to pass through here to be usable, which is
 *  what makes a name check exact where a scan of shell source could not be:
 *  four scripts carry `exiftool` and `jq` in comments that exist to record
 *  these very retirements.
 */
export function binaryViolations(toolsJson: string, banned: string[]): string[] {
  const declared = new Set<string>();
  for (const tool of asList(JSON.parse(toolsJson).tools)) {
    const bin = asText(asRecord(tool)?.bin);
    if (bin) declared.add(bin);
  }
  return banned.filter((name) => declared.has(name));
}

/** Banned crates and cargo features in one Cargo.toml.
 *
 *  Features are checked as well as crates because that is how this one came
 *  back before: `rayon` was never written down anywhere, it arrived as six
 *  transitive crates behind zenjpeg's `parallel` feature.
 */
export function cargoManifestViolations(toml: string, ban: NonNullable<Bans["cargo"]>): string[] {
  const deps = asRecord(asRecord(parseToml(toml))?.dependencies) ?? {};
  const found: string[] = [];
  for (const crate of ban.crates ?? []) {
    if (Object.hasOwn(deps, crate)) found.push(`dependencies.${crate}`);
  }
  for (const { crate, feature } of ban.features ?? []) {
    if (asList(asRecord(deps[crate])?.features).includes(feature)) found.push(`${crate}/${feature}`);
  }
  return found;
}

/** Banned crates present anywhere in a Cargo.lock.
 *
 *  The lockfile IS the right surface for Rust, which is the reverse of the npm
 *  case above, and the difference is worth stating because the two look alike.
 *  `rayon` reaches this graph through one banned feature and through nothing
 *  else, so its presence in the lock is evidence rather than noise. A package
 *  arriving as some unrelated dependency's transitive would make this the wrong
 *  check, so read a failure here as a question about how it got in.
 */
export function cargoLockViolations(lock: string, crates: string[]): string[] {
  const present = new Set<string>();
  for (const match of lock.matchAll(/^name = "([^"]+)"$/gm)) present.add(match[1]);
  return crates.filter((crate) => present.has(crate));
}

// Import statements. JS needs three forms because a bundler resolves all three;
// Python needs its two.
//
// THE STATIC FORMS ARE ANCHORED and the call forms are not, which is a
// deliberate split. A line starting with `import` or `export` is an import
// statement and nothing else, so anchoring keeps `# used to import PIL` and
// every comment recording a retirement out of the scan. A dynamic `import()` or
// `require()` legitimately appears mid-line, so anchoring those would miss real
// ones; left wide they can also match a comment quoting one. That direction
// FAILS CLOSED, the same trade the shell half of the writer census takes, and a
// false fire is a sentence to rewrite rather than a dependency to re-add.
const JS_STATIC = (spec: string) =>
  new RegExp(String.raw`^\s*(?:import|export)\b[^\n]*["']${escapeRe(spec)}(?:/[^"']*)?["']`, "m");
const JS_CALL = (spec: string) =>
  new RegExp(String.raw`\b(?:require|import)\(\s*["']${escapeRe(spec)}(?:/[^"']*)?["']\s*\)`);
const PY_IMPORT = (spec: string) =>
  new RegExp(String.raw`^\s*(?:import\s+${escapeRe(spec)}\b|from\s+${escapeRe(spec)}[\s.])`, "m");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which banned specifiers one source file imports.
 *
 *  Dialect is chosen by extension. A file this does not recognise returns no
 *  violations, so the contract test asserts the scan SAW files rather than
 *  trusting a clean pass: a scan that matched nothing and a tree that is clean
 *  are the same output.
 */
export function sourceViolations(file: string, text: string, specifiers: string[]): string[] {
  const python = file.endsWith(".py");
  const js = /\.(m|c)?[jt]sx?$/.test(file);
  if (!python && !js) return [];
  if (python) return specifiers.filter((spec) => PY_IMPORT(spec).test(text));
  return specifiers.filter((spec) => JS_STATIC(spec).test(text) || JS_CALL(spec).test(text));
}

/** True when `file` sits inside `tree`, by path segment rather than by prefix.
 *
 *  Segment-wise because a prefix test puts `tools-old/x.py` inside `tools`.
 */
export function inTree(file: string, tree: string): boolean {
  return file === tree || file.startsWith(tree.endsWith("/") ? tree : `${tree}/`);
}
