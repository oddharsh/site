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
// pipeline artifact rather than a committed one, so histograms.json is not
// recomputable from a checkout at all; metadata.json reads the SOOC originals,
// which live in R2 and on one laptop; og cards capture PRODUCTION.
//
// exif.json was named here too until 2026-08-29, and the fix was to stop
// committing it: it IS recomputable from a checkout, being a projection of
// metadata.json, so build.ts step 1a derives it and this graph has nothing left
// to say about it. Worth reading as the preferred outcome rather than an
// exception. An artifact a checkout can rebuild does not want a digest, it wants
// to be build output; a digest is what you record when rebuilding is impossible.
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
  /**
   * SET MODE. A regex with one capture group, applied to each resolved path. The
   * digest is taken over the sorted unique captures rather than over file bytes.
   *
   * This exists because some artifacts depend on WHICH inputs exist rather than
   * on what is in them. images/semantics.json is keyed by stem, and re-encoding a
   * photo does not change what is in the picture, so pinning it to pixel bytes
   * would report it stale on every re-encode and train somebody to re-record it
   * without looking. Pinned to the stem SET it goes stale for the one reason it
   * can actually be stale: a photo arrived or left.
   *
   * Every resolved path must match. A projection that silently skips what it
   * cannot parse is the shape of scanner that reports a pass over an empty set,
   * which is what every floor in this repo exists to refuse.
   */
  set?: string;
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
  /**
   * A JSON output whose TOP-LEVEL KEYS must cover every input key. Set mode only.
   *
   * The digest answers "did the input set move since this was made". That is the
   * wrong question on its own for an artifact built one key at a time: a resumable
   * generator that dies halfway leaves a file covering most of the set, and
   * re-recording the digest afterwards would call it fresh forever. This asks the
   * question the reader actually has, which is whether the artifact HAS an entry
   * for every input, and it is what caught semantics.json sitting at 158 of 165.
   */
  covers?: string;
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

/**
 * What one derivation's digest is taken over, plus how those entries are named in
 * the flat lock. Two modes behind one shape, so verify() and record() never
 * branch on the mode and the lock stays a single flat map.
 */
export type Projection = {
  entries: Record<string, string>;
  /** How an entry appears in the lock. Namespaced in set mode so stems from two
   *  derivations cannot collide, and so removals can be attributed. */
  lockName: (name: string) => string;
  /** Does a lock entry belong to this derivation? Used to name what was removed. */
  owns: (lockName: string) => boolean;
  count: number;
};

export async function project(root: string, d: Derivation): Promise<Projection> {
  if (!d.inputs) throw new Error(`${d.id}: a pinned derivation must declare inputs`);
  const spec = d.inputs;
  const files = await resolveInputs(root, spec);

  if (!spec.set) {
    return {
      entries: await hashInputs(root, files),
      lockName: (name) => name,
      owns: (name) => claims(spec, name),
      count: files.length,
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
  // The digest is over the BARE keys, never over the namespaced lock names, so
  // renaming a derivation does not move its digest.
  const entries = Object.fromEntries([...keys].sort().map((k) => [k, "set"]));
  const prefix = `${d.id}#`;
  return {
    entries,
    lockName: (name) => prefix + name,
    owns: (name) => name.startsWith(prefix),
    count: keys.size,
  };
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
      uncovered: string[];
      orphaned: string[];
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
  const { entries, lockName, owns, count } = await project(root, d);
  const digest = digestOf(entries);
  const { uncovered, orphaned } = await coverage(root, d, entries);

  if (!d.recorded) return { id: d.id, state: "unrecorded", count, digest };

  const toolDrift = (d.tools ?? [])
    .map((name) => ({ name, recorded: d.recorded?.tools?.[name] ?? "", now: toolVersions[name] ?? "" }))
    .filter((t) => t.now && t.recorded && t.now !== t.recorded);

  if (digest === d.recorded.inputs && !toolDrift.length && !uncovered.length) {
    return { id: d.id, state: "fresh", count };
  }

  // The lock is what turns "something moved" into "these 316 files moved", which
  // is the difference between a check somebody acts on and one they re-run.
  const changed: string[] = [];
  const added: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    const key = lockName(name);
    if (!(key in lock)) added.push(name);
    else if (lock[key] !== value) changed.push(name);
  }
  // A DELETED input still moves the digest, so it is caught either way. Naming it
  // takes the flat lock read backwards: anything this derivation owns, that the
  // lock knows and the projection no longer produces, left.
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

/**
 * Which input keys the covering artifact has no entry for, and which entries it
 * carries for inputs that are gone. An orphan is reported rather than failed: it
 * is dead weight rather than a missing answer, and the deletion that created it
 * has already moved the digest.
 */
async function coverage(
  root: string,
  d: Derivation,
  entries: Record<string, string>,
): Promise<{ uncovered: string[]; orphaned: string[] }> {
  if (!d.covers) return { uncovered: [], orphaned: [] };
  const parsed = JSON.parse(await readFile(path.join(root, d.covers), "utf8"));
  const have = new Set(Object.keys(parsed));
  const want = Object.keys(entries);
  return {
    uncovered: want.filter((k) => !have.has(k)).sort(),
    orphaned: [...have].filter((k) => !(k in entries)).sort(),
  };
}

/** Recompute what the declaration should record. Used by the --lock path. */
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

/**
 * The lock after ONE derivation re-records: its fresh rows in, and the rows it
 * OWNS that the projection no longer produces out.
 *
 * The pruning half is the whole point, and merging alone is what the --lock path
 * did until 2026-08-29. public/i is content-addressed, so a re-encode does not
 * edit a row, it mints a new filename beside the old one and leaves the old row
 * with nothing behind it. Measured on the commit that added this: 1493 rows
 * describing 660 files, 498 of them naming a path no checkout can open, 495 of
 * those minted by one full-library re-encode (#660). Every future re-encode adds
 * another ~495. It reports nothing wrong, because verify() hashes the inputs on
 * disk rather than reading the lock, so a dead row cannot produce a wrong
 * verdict; what it costs is a machine-owned file whose own $comment says it
 * exists "so a stale result can name what moved" filling with rows that can never
 * be what moved.
 *
 * SCOPED TO `owns`, because --only re-records one derivation at a time and must
 * leave every other derivation's rows exactly as it found them. A key is dropped
 * for one reason: this derivation would have collected it and did not, which for
 * a path spec means the file is gone and for a set spec means the key left the
 * set. Two derivations declaring the same tree (fingerprints and hashes both
 * declare public/i) project the same entries, so either one prunes the same rows.
 *
 * The trade that buys: under --only, a row this derivation owns and prunes may
 * also be owned by a derivation NOT being recorded, which then loses the ability
 * to name that file in its `removed` list. Its verdict does not move, since the
 * digest lives on the declaration rather than in the lock, so the cost is one
 * shorter diagnostic line on a result that is already STALE. A full --lock run
 * records every pinned derivation and has no such gap.
 *
 * It returns what it dropped rather than only how many, so the caller can NAME
 * them without re-deciding the rule. A second copy of that predicate at the call
 * site is a second thing to keep in agreement, and the one that would rot is the
 * printed count, which nothing checks.
 */
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
