// The derivation graph: what each committed derived artifact was made FROM,
// recorded as content hashes, so staleness is one general check rather than N
// bespoke tripwires written after N incidents.
//
// The failure this exists for has happened at least four times here, always the
// same shape and always silently. #394 re-encoded 316 thumbnails on 2026-08-14
// and re-baked no histograms, so images/histograms.json described pixels nobody
// had been served for nine days (gotcha 41). An /a/ asset changing hash orphans
// every a-dict snapshot naming the old one (gotcha 20). A cosmetic edit to a
// hashed client asset re-mints 1400 files (gotcha 35). The search index froze
// twice under two unrelated causes (the search-corpus note).
//
// Each of those bought one more tripwire. This is the general form: a derived
// artifact declares its INPUTS, the digest of those inputs is recorded beside the
// declaration, and one check asks whether the bytes on disk still hash to what
// the artifact was made from. No generator runs, nothing is mutated, and it
// answers from a clean checkout with no local pipeline state.
//
// ── why the check cannot simply rebuild and diff ──────────────────────────────
// The obvious design is "re-run the generator, byte-compare the output". It does
// not work for the artifacts that actually go stale. images/meta/ is a LOCAL
// pipeline artifact rather than a committed one, so histograms.json and exif.json
// are not recomputable from a checkout at all; metadata.json reads the SOOC
// originals, which live in R2 and on one laptop; og cards capture PRODUCTION.
// A rebuild-and-diff check would therefore be unrunnable on exactly the three
// families that have gone stale, while a check of INPUT bytes runs on all of them
// for the cost of a hash.
//
// That is also why a rebuild-and-diff would have to mutate the tree to work,
// which is not a thing a check may do in CI or under somebody else's uncommitted
// edits (the collaboration rule in CLAUDE.md).
//
// ── the two tiers, and why the second one is honest rather than lazy ──────────
// PINNED     the inputs are committed bytes, so the recorded digest is checkable
//            here, now, with no tool and no network. This is the tier that
//            catches gotcha 41.
// UNVERIFIABLE  the inputs are not in this repository (SOOC originals, a live
//            production capture, a model's output). The declaration says so and
//            says WHY, and the check reports it as a note. It never counts as a
//            pass, because the alternative to an honest note is a check that
//            quietly covers less than its summary line claims. Same standing as
//            the two entries in config/tools.json that report no version.
//
// A tool version can be part of a derivation's identity too. config/tools.json
// already records which encoder made the bytes committed today (its `recorded`
// field), and an artifact whose meaning depends on that encoder names the tool
// here, so swapping encoders reads as staleness rather than as nothing.
//
// ── on being extractable ──────────────────────────────────────────────────────
// Zero dependencies, node:* only, no bun globals, no knowledge of this site. The
// declaration file is data. This is meant to be liftable into any repository that
// commits derived artifacts, which is most of them.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type Tier = "pinned" | "unverifiable";

export type InputSpec = {
  /** Files and directories, relative to the repo root. A directory is walked. */
  paths: string[];
  /** Keep only these extensions. Absent means every file found. */
  include?: string[];
  /** Drop any relative path containing one of these segments. */
  exclude?: string[];
};

export type Derivation = {
  id: string;
  tier: Tier;
  why: string;
  outputs: string[];
  inputs?: InputSpec;
  /** Names in config/tools.json whose `recorded` version is part of this identity. */
  tools?: string[];
  /** The command that regenerates it. Printed on a stale result. */
  regenerate?: string;
  /** Required on the unverifiable tier: what is not in the repository, and why. */
  unverifiable?: string;
  recorded?: Recorded;
};

export type Recorded = {
  inputs: string;
  count: number;
  tools?: Record<string, string>;
};

/**
 * Per-input hashes, machine-owned, so a stale result can NAME what moved rather
 * than only that something did. FLAT and deduped across derivations on purpose:
 * three of them declare public/i, and keying by derivation id would store 660
 * hashes three times to say the same thing.
 */
export type Lock = Record<string, string>;

const HASH = "sha256";

export const hashBytes = (bytes: Buffer | string): string =>
  createHash(HASH).update(bytes).digest("hex");

/**
 * Every file a spec resolves to, repo-relative and sorted, so the digest is a
 * function of the bytes rather than of readdir order or of the machine.
 */
export const keeps = (spec: InputSpec, rel: string): boolean => {
  if (spec.include?.length && !spec.include.some((ext) => rel.endsWith(ext))) return false;
  if (spec.exclude?.some((seg) => rel.split(path.sep).includes(seg))) return false;
  return true;
};

/** Is this repo-relative path one the spec would have collected? */
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

/** sha256 of each resolved input, keyed by repo-relative path. */
export async function hashInputs(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of files) out[rel] = hashBytes(await readFile(path.join(root, rel)));
  return out;
}

/**
 * One digest over the whole input set. Built from `path hash` lines rather than
 * from concatenated bytes, so a rename with identical content still moves the
 * digest: for a content-addressed tree the NAME is half the artifact's meaning.
 */
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
      tools: { name: string; recorded: string; now: string }[];
    };

/**
 * Compare one derivation's declaration against the bytes on disk. `toolVersions`
 * is the caller's projection of config/tools.json, passed in rather than read
 * here so this module stays free of any one repository's layout.
 */
export async function verify(
  root: string,
  d: Derivation,
  lock: Lock,
  toolVersions: Record<string, string> = {},
): Promise<Verdict> {
  if (d.tier === "unverifiable") {
    return { id: d.id, state: "unverifiable", reason: d.unverifiable ?? "no reason declared" };
  }
  if (!d.inputs) throw new Error(`${d.id}: a pinned derivation must declare inputs`);

  const files = await resolveInputs(root, d.inputs);
  const hashes = await hashInputs(root, files);
  const digest = digestOf(hashes);

  if (!d.recorded) return { id: d.id, state: "unrecorded", count: files.length, digest };

  const toolDrift = (d.tools ?? [])
    .map((name) => ({ name, recorded: d.recorded?.tools?.[name] ?? "", now: toolVersions[name] ?? "" }))
    .filter((t) => t.now && t.recorded && t.now !== t.recorded);

  if (digest === d.recorded.inputs && !toolDrift.length) {
    return { id: d.id, state: "fresh", count: files.length };
  }

  // The lock is what turns "something moved" into "these 316 files moved", which
  // is the difference between a check somebody acts on and one they re-run.
  const changed: string[] = [];
  const added: string[] = [];
  for (const [rel, sum] of Object.entries(hashes)) {
    if (!(rel in lock)) added.push(rel);
    else if (lock[rel] !== sum) changed.push(rel);
  }
  // A DELETED input still moves the digest, so it is caught either way. Naming it
  // takes the flat lock read backwards: anything this spec would have claimed,
  // that the lock knows and disk no longer has, left.
  const removed = Object.keys(lock).filter(
    (rel) => !(rel in hashes) && claims(d.inputs as InputSpec, rel),
  );

  return {
    id: d.id,
    state: "stale",
    count: files.length,
    digest,
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    tools: toolDrift,
  };
}

/** Recompute what the declaration should record. Used by the --lock path. */
export async function record(
  root: string,
  d: Derivation,
  toolVersions: Record<string, string> = {},
): Promise<{ recorded: Recorded; hashes: Record<string, string> } | null> {
  if (d.tier === "unverifiable" || !d.inputs) return null;
  const files = await resolveInputs(root, d.inputs);
  const hashes = await hashInputs(root, files);
  const recorded: Recorded = { inputs: digestOf(hashes), count: files.length };
  if (d.tools?.length) {
    recorded.tools = Object.fromEntries(
      d.tools.map((name) => [name, toolVersions[name] ?? ""]).filter(([, v]) => v),
    );
  }
  return { recorded, hashes };
}
