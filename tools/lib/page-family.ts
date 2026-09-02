// page-family.ts — the site-page dictionary as a COMMITTED, stable artifact.
//
// build.ts derives a fresh 64 KiB family corpus from the staged documents on
// every run, and until 2026-09-02 it shipped that derivation as-is at
// /a/page-family.<hash8>.dict. The hash is of the corpus bytes, and the corpus
// samples pages that carry every /a/<name>.<hash8> shell reference, so any
// deploy that touched nav.js, luna.css, quiz.js or the taskbar partial re-minted
// the dictionary URL. Every returning Chromium visitor then re-downloaded the
// 17 KB q11 twin on their next page, to hold a dictionary that was, measured on
// 2026-09-02 against 54 staged pages, 0.1 point better than the one they already
// had (13.7% off plain brotli against 13.8%). Three hashes were live across
// three adjacent commits that day. At roughly three deploys a day, the family
// tier was costing returning visitors more than it saved them: 17 KB per
// re-mint against ~1.5 KB per page view.
//
// So the dictionary that SHIPS is the committed one, whenever it is close enough
// to the fresh derivation, and the fresh one only when the committed one has
// drifted past FAMILY_DRIFT. The roll (tools/roll-shell-dictionary.ts) is what
// writes src/dict/f-dict, the same way it writes a-dict and p-dict: a dictionary
// is bytes a browser already holds, and no build can derive that from source.
//
// The threshold, in the reader's units. A re-mint costs each returning visitor
// one dictionary fetch (17 KB on the wire). Drift costs every visitor the
// difference between the two dictionaries' deltas on every page. At 10% drift
// on a 457 KB family tier over 55 pages, that difference is ~830 B per page, so
// a re-mint pays for itself only for a visitor who reads about 20 pages before
// the next one. Below that line a stable URL is cheaper for everyone; above it,
// the fresh corpus earns its fetch. 10% is generous toward stability on purpose,
// because a re-mint is paid by the whole returning population at once.
//
// Everything here is deterministic given the checkout and the runtime: same
// pages, same committed file, same choice. The build stays a pure function of
// the tree; it just reads one more committed input.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import { zstdCompressDictionaryBatch } from "./zstd-batch.ts";

export const FAMILY_DICT_DIR = "src/dict/f-dict";
export const FAMILY_DICT_SIZE = 65_536;
// The committed dictionary ships while its family tier is within this fraction
// of the fresh derivation's. See the header for the arithmetic behind the number.
export const FAMILY_DRIFT = 0.10;

const NAME = /^page-family\.([0-9a-f]{8})\.dict\.br$/;
// A zstd --train artifact opens with this magic; RFC 9842 needs RAW bytes.
const ZSTD_DICT_MAGIC = 0xec30a437;

export const hash8 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
export const familyFileName = (bytes: Uint8Array) => `page-family.${hash8(bytes)}.dict.br`;

export type CommittedFamily = { bytes: Buffer; hash8: string; name: string };

// The committed dictionary, or null when the directory is empty or absent. An
// empty directory is the documented way to FORCE a re-mint on the next build
// (delete the file; the build ships fresh; the next roll commits what shipped).
// Anything else that is not exactly one well-formed file is a hard error,
// because the alternative is a build that quietly picks one of two.
export async function readCommittedFamily(dir = FAMILY_DICT_DIR): Promise<CommittedFamily | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith("."));
  if (!names.length) return null;
  if (names.length > 1) {
    throw new Error(`${dir}: expected at most one committed family dictionary, found ${names.length}: ${names.join(", ")}`);
  }
  const [name] = names;
  const m = NAME.exec(name);
  if (!m) throw new Error(`${dir}/${name}: not a page-family.<hash8>.dict.br file`);
  const bytes = brotliDecompressSync(await readFile(`${dir}/${name}`));
  if (bytes.length !== FAMILY_DICT_SIZE) {
    throw new Error(`${dir}/${name}: decodes to ${bytes.length} B, expected ${FAMILY_DICT_SIZE}`);
  }
  if (bytes.readUInt32LE(0) === ZSTD_DICT_MAGIC) {
    throw new Error(`${dir}/${name}: starts with the zstd --train magic; dcz needs RAW bytes`);
  }
  const actual = hash8(bytes);
  if (actual !== m[1]) {
    throw new Error(`${dir}/${name}: the filename names ${m[1]} but the bytes hash to ${actual}`);
  }
  return { bytes, hash8: actual, name };
}

// Write ONE committed dictionary, replacing whatever was there. Stored brotli'd
// like the p-dict snapshots: build input only, never served, and the raw bytes
// round-trip exactly.
export async function writeCommittedFamily(bytes: Uint8Array, dir = FAMILY_DICT_DIR): Promise<string> {
  if (bytes.length !== FAMILY_DICT_SIZE) {
    throw new Error(`refusing to commit a ${bytes.length} B family dictionary; the build derives ${FAMILY_DICT_SIZE}`);
  }
  await mkdir(dir, { recursive: true });
  const name = familyFileName(bytes);
  for (const stale of await readdir(dir)) {
    if (stale !== name && !stale.startsWith(".")) await rm(`${dir}/${stale}`, { force: true });
  }
  await writeFile(`${dir}/${name}`, brotliCompressSync(bytes, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 24 },
  }));
  return name;
}

// The family tier's wire cost for one dictionary: every page's zstd frame against
// it, at the level the build ships. Frames are returned too, so a caller that goes
// on to ship these bytes does not encode them twice.
export async function familyFrames(pages: Uint8Array[], dictionary: Uint8Array): Promise<Buffer[]> {
  return zstdCompressDictionaryBatch(pages.map((bytes) => ({ bytes, dictionary })));
}

export type FamilyChoice = {
  dictionary: Buffer;
  source: "committed" | "fresh";
  frames: Buffer[];            // the chosen dictionary's frame per page, in `pages` order
  freshTotal: number;
  committedTotal: number | null;
  drift: number | null;        // committedTotal / freshTotal - 1, or null with nothing committed
  threshold: number;
};

// Which dictionary ships. Committed wins whenever its total is within
// FAMILY_DRIFT of the fresh derivation's; otherwise the fresh corpus does, and
// the next roll commits it. With nothing committed, fresh ships (first run, or a
// deliberate re-mint).
export async function chooseFamilyDictionary(
  { fresh, committed, pages, threshold = FAMILY_DRIFT }:
  { fresh: Uint8Array; committed: Uint8Array | null; pages: Uint8Array[]; threshold?: number },
): Promise<FamilyChoice> {
  const freshFrames = await familyFrames(pages, fresh);
  const freshTotal = freshFrames.reduce((n, f) => n + f.length, 0);
  if (!committed) {
    return { dictionary: Buffer.from(fresh), source: "fresh", frames: freshFrames, freshTotal, committedTotal: null, drift: null, threshold };
  }
  const committedFrames = await familyFrames(pages, committed);
  const committedTotal = committedFrames.reduce((n, f) => n + f.length, 0);
  const drift = committedTotal / freshTotal - 1;
  if (drift <= threshold) {
    return { dictionary: Buffer.from(committed), source: "committed", frames: committedFrames, freshTotal, committedTotal, drift, threshold };
  }
  return { dictionary: Buffer.from(fresh), source: "fresh", frames: freshFrames, freshTotal, committedTotal, drift, threshold };
}

// The build's record of what it decided, written OUTSIDE the served tree so the
// roll can read it without re-deriving anything. Every field is a number or a
// hash8; the roll compares, it does not recompute.
export type FamilyReport = {
  shipped: string;             // hash8 of the dictionary at /a/page-family.<hash8>.dict
  source: "committed" | "fresh";
  fresh: string;               // hash8 of this build's fresh derivation
  committed: string | null;    // hash8 of src/dict/f-dict's file, if any
  freshTotal: number;
  committedTotal: number | null;
  drift: number | null;
  threshold: number;
  pages: number;
};
export const FAMILY_REPORT = ".build/page-family.json";
export const FAMILY_FRESH = ".build/page-family.fresh.dict";
