// Enforce config/retired.json: dependencies this repository replaced with
// first-party code, and the surface each one would have to come back through.
import { parse as parseToml } from "./toml.ts";
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";

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

export const BAN_KINDS: readonly string[] = ["npm", "binary", "cargo", "source"];

const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

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

export function binaryViolations(toolsJson: string, banned: string[]): string[] {
  const declared = new Set<string>();
  for (const tool of asList(JSON.parse(toolsJson).tools)) {
    const bin = asText(asRecord(tool)?.bin);
    if (bin) declared.add(bin);
  }
  return banned.filter((name) => declared.has(name));
}

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

export function cargoLockViolations(lock: string, crates: string[]): string[] {
  const present = new Set<string>();
  for (const match of lock.matchAll(/^name = "([^"]+)"$/gm)) present.add(match[1]);
  return crates.filter((crate) => present.has(crate));
}

const JS_STATIC = (spec: string) =>
  new RegExp(String.raw`^\s*(?:import|export)\b[^\n]*["']${escapeRe(spec)}(?:/[^"']*)?["']`, "m");
const JS_CALL = (spec: string) =>
  new RegExp(String.raw`\b(?:require|import)\(\s*["']${escapeRe(spec)}(?:/[^"']*)?["']\s*\)`);
const PY_IMPORT = (spec: string) =>
  new RegExp(String.raw`^\s*(?:import\s+${escapeRe(spec)}\b|from\s+${escapeRe(spec)}[\s.])`, "m");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sourceViolations(file: string, text: string, specifiers: string[]): string[] {
  const python = file.endsWith(".py");
  const js = /\.(m|c)?[jt]sx?$/.test(file);
  if (!python && !js) return [];
  if (python) return specifiers.filter((spec) => PY_IMPORT(spec).test(text));
  return specifiers.filter((spec) => JS_STATIC(spec).test(text) || JS_CALL(spec).test(text));
}

export function inTree(file: string, tree: string): boolean {
  return file === tree || file.startsWith(tree.endsWith("/") ? tree : `${tree}/`);
}
