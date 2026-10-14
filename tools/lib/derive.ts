// The derivation graph: what each committed derived artifact was made FROM,
// recorded as content hashes, so staleness is one general check rather than N
// bespoke tripwires written after N incidents.
//
// The failure this exists for has happened at least four times here, always the
// same shape and always silently. #394 re-encoded 316 thumbnails on 2026-08-14
// and re-baked no histograms, so images/histograms.json described pixels nobody
// had been served for nine days (gotcha 46). An /a/ asset changing hash orphans
// every a-dict snapshot naming the old one (gotcha 20). A cosmetic edit to a
// hashed client asset re-mints 1400 files (gotcha 35). The search index froze
// twice under two unrelated causes (the search-corpus note).
//
// ── the two tiers, and why the second one is honest rather than lazy ──────────
// PINNED     the inputs are committed bytes, so the recorded digest is checkable
//            here, now, with no tool and no network. This is the tier that
//            catches gotcha 46.
// UNVERIFIABLE  the inputs are not in this repository (SOOC originals, a live
//            production capture, a model's output). The declaration says so and
//            says WHY, and the check reports it as a note. It never counts as a
//            pass, because the alternative to an honest note is a check that
//            quietly covers less than its summary line claims. Same standing as
//            the two entries in config/tools.json that report no version.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type Tier = "pinned" | "unverifiable";

export type InputSpec = {
  paths: string[];
  include?: string[];
  exclude?: string[];
  set?: string;
  bytes?: string[];
};

export type Derivation = {
  id: string;
  tier: Tier;
  why: string;
  outputs: string[];
  inputs?: InputSpec;
  tools?: string[];
  regenerate?: string;
  unverifiable?: string;
  covers?: string;
  recorded?: Recorded;
};

export type Recorded = {
  inputs: string;
  count: number;
  tools?: Record<string, string>;
};

export type Lock = Record<string, string>;

const HASH = "sha256";

export const hashBytes = (bytes: Buffer | string): string =>
  createHash(HASH).update(bytes).digest("hex");

export const keeps = (spec: InputSpec, rel: string): boolean => {
  if (spec.include?.length && !spec.include.some((ext) => rel.endsWith(ext))) return false;
  if (spec.exclude?.some((seg) => rel.split(path.sep).includes(seg))) return false;
  return true;
};

export const claims = (spec: InputSpec, rel: string): boolean =>
  keeps(spec, rel) &&
  spec.paths.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`));

export async function resolveInputs(root: string, spec: InputSpec): Promise<string[]> {
  const found: string[] = [];
  const keep = (rel: string) => keeps(spec, rel);

  const walk = async (abs: string) => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const rel = path.relative(root, child);
        if (keep(rel)) found.push(rel);
      }
    }
  };

  for (const p of spec.paths) {
    const abs = path.join(root, p);
    const info = await stat(abs).catch(() => null);
    // A declared input that is GONE is a hard error rather than an empty set.
    // Silently hashing nothing is how a check reports a pass over an artifact
    // whose whole input tree was renamed out from under it, which is the exact
    // shape of gotcha 40.
    if (!info) throw new Error(`declared input does not exist: ${p}`);
    if (info.isDirectory()) await walk(abs);
    else found.push(path.relative(root, abs));
  }

  return found.sort();
}

export type Projection = {
  entries: Record<string, string>;
  lockName: (name: string) => string;
  owns: (lockName: string) => boolean;
  count: number;
  keys: string[];
};

export async function project(root: string, d: Derivation): Promise<Projection> {
  if (!d.inputs) throw new Error(`${d.id}: a pinned derivation must declare inputs`);
  const spec = d.inputs;
  const files = await resolveInputs(root, spec);

  if (!spec.set) {
    if (spec.bytes?.length) throw new Error(`${d.id}: \`bytes\` is set mode only; add those files to \`paths\``);
    return {
      entries: await hashInputs(root, files),
      lockName: (name) => name,
      owns: (name) => claims(spec, name),
      count: files.length,
      keys: [],
    };
  }

  const re = new RegExp(spec.set);
  const keys = new Set<string>();
  for (const rel of files) {
    const m = re.exec(rel);
    if (!m || m[1] === undefined) {
      throw new Error(`${d.id}: input ${rel} does not match the set pattern ${spec.set}`);
    }
    keys.add(m[1]);
  }
  const setEntries = Object.fromEntries([...keys].sort().map((k) => [k, "set"]));
  const byteSpec: InputSpec = { paths: spec.bytes ?? [] };
  const byteEntries = await hashInputs(root, await resolveInputs(root, byteSpec));
  for (const k of keys) {
    if (k.includes("/")) throw new Error(`${d.id}: set key ${k} contains a slash, so it could collide with a \`bytes\` path`);
  }
  const prefix = `${d.id}#`;
  return {
    entries: { ...setEntries, ...byteEntries },
    lockName: (name) => (name in byteEntries ? name : prefix + name),
    owns: (name) => name.startsWith(prefix) || claims(byteSpec, name),
    count: keys.size + Object.keys(byteEntries).length,
    keys: [...keys].sort(),
  };
}

export async function hashInputs(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of files) out[rel] = hashBytes(await readFile(path.join(root, rel)));
  return out;
}

export const digestOf = (hashes: Record<string, string>): string =>
  hashBytes(
    Object.keys(hashes)
      .sort()
      .map((rel) => `${rel} ${hashes[rel]}`)
      .join("\n"),
  );

export type Verdict =
  | { id: string; state: "fresh"; count: number }
  | { id: string; state: "unverifiable"; reason: string }
  | { id: string; state: "unrecorded"; count: number; digest: string }
  | {
      id: string;
      state: "stale";
      count: number;
      digest: string;
      changed: string[];
      added: string[];
      removed: string[];
      uncovered: string[];
      orphaned: string[];
      tools: { name: string; recorded: string; now: string }[];
    };

export async function verify(
  root: string,
  d: Derivation,
  lock: Lock,
  toolVersions: Record<string, string> = {},
): Promise<Verdict> {
  if (d.tier === "unverifiable") {
    return { id: d.id, state: "unverifiable", reason: d.unverifiable ?? "no reason declared" };
  }
  const { entries, lockName, owns, count, keys } = await project(root, d);
  const digest = digestOf(entries);
  const { uncovered, orphaned } = await coverage(root, d, keys);

  if (!d.recorded) return { id: d.id, state: "unrecorded", count, digest };

  const toolDrift = (d.tools ?? [])
    .map((name) => ({ name, recorded: d.recorded?.tools?.[name] ?? "", now: toolVersions[name] ?? "" }))
    .filter((t) => t.now && t.recorded && t.now !== t.recorded);

  if (digest === d.recorded.inputs && !toolDrift.length && !uncovered.length) {
    return { id: d.id, state: "fresh", count };
  }

  const changed: string[] = [];
  const added: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    const key = lockName(name);
    if (!(key in lock)) added.push(name);
    else if (lock[key] !== value) changed.push(name);
  }
  const present = new Set(Object.keys(entries).map(lockName));
  const removed = Object.keys(lock)
    .filter((key) => owns(key) && !present.has(key))
    .map((key) => key.replace(`${d.id}#`, ""));

  return {
    id: d.id,
    state: "stale",
    count,
    digest,
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    uncovered,
    orphaned,
    tools: toolDrift,
  };
}

async function coverage(
  root: string,
  d: Derivation,
  keys: string[],
): Promise<{ uncovered: string[]; orphaned: string[] }> {
  if (!d.covers) return { uncovered: [], orphaned: [] };
  const parsed = JSON.parse(await readFile(path.join(root, d.covers), "utf8"));
  const have = new Set(Object.keys(parsed));
  const want = new Set(keys);
  return {
    uncovered: keys.filter((k) => !have.has(k)).sort(),
    orphaned: [...have].filter((k) => !want.has(k)).sort(),
  };
}

export async function record(
  root: string,
  d: Derivation,
  toolVersions: Record<string, string> = {},
): Promise<{ recorded: Recorded; hashes: Record<string, string>; owns: (lockName: string) => boolean } | null> {
  if (d.tier === "unverifiable" || !d.inputs) return null;
  const { entries, lockName, owns, count } = await project(root, d);
  const recorded: Recorded = { inputs: digestOf(entries), count };
  if (d.tools?.length) {
    recorded.tools = Object.fromEntries(
      d.tools.map((name) => [name, toolVersions[name] ?? ""]).filter(([, v]) => v),
    );
  }
  const hashes = Object.fromEntries(Object.entries(entries).map(([n, v]) => [lockName(n), v]));
  return { recorded, hashes, owns };
}

export function relock(
  lock: Lock,
  fresh: Record<string, string>,
  owns: (lockName: string) => boolean,
): { next: Lock; pruned: string[] } {
  const next: Lock = {};
  const pruned: string[] = [];
  for (const [key, value] of Object.entries(lock)) {
    if (owns(key) && !(key in fresh)) {
      pruned.push(key);
      continue;
    }
    next[key] = value;
  }
  return { next: { ...next, ...fresh }, pruned };
}
