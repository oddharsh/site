// page-family.ts — the site-page dictionary as a COMMITTED, stable artifact.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import { zstdCompressDictionaryBatch } from "./zstd-batch.ts";
import { familyDictionaryName, parseFamilyDictionary } from "../../src/worker/lib/dictionary-names.ts";

export const FAMILY_DICT_DIR = "src/dict/f-dict";
export const FAMILY_DICT_SIZE = 65_536;
export const FAMILY_DRIFT = 0.10;

// A zstd --train artifact opens with this magic; RFC 9842 needs RAW bytes.
const ZSTD_DICT_MAGIC = 0xec30a437;

export const hash8 = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
export const familyFileName = (bytes: Uint8Array) => `${familyDictionaryName(hash8(bytes))}.br`;
const committedHash8 = (name: string) => name.endsWith(".br") ? parseFamilyDictionary(name.slice(0, -3)) : null;

export type CommittedFamily = { bytes: Buffer; hash8: string; name: string };

export async function readCommittedFamily(dir = FAMILY_DICT_DIR): Promise<CommittedFamily | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith("."));
  if (!names.length) return null;
  if (names.length > 1) {
    throw new Error(`${dir}: expected at most one committed family dictionary, found ${names.length}: ${names.join(", ")}`);
  }
  const [name] = names;
  const named = committedHash8(name);
  if (!named) throw new Error(`${dir}/${name}: not a page-family.<hash8>.dict.br file`);
  const bytes = brotliDecompressSync(await readFile(`${dir}/${name}`));
  if (bytes.length !== FAMILY_DICT_SIZE) {
    throw new Error(`${dir}/${name}: decodes to ${bytes.length} B, expected ${FAMILY_DICT_SIZE}`);
  }
  if (bytes.readUInt32LE(0) === ZSTD_DICT_MAGIC) {
    throw new Error(`${dir}/${name}: starts with the zstd --train magic; dcz needs RAW bytes`);
  }
  const actual = hash8(bytes);
  if (actual !== named) {
    throw new Error(`${dir}/${name}: the filename names ${named} but the bytes hash to ${actual}`);
  }
  return { bytes, hash8: actual, name };
}

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

export type ZstdBatch = (jobs: Array<{ bytes: Uint8Array; dictionary: Uint8Array }>) => Promise<Buffer[]>;
export async function familyFrames(pages: Uint8Array[], dictionary: Uint8Array, encode: ZstdBatch = zstdCompressDictionaryBatch): Promise<Buffer[]> {
  return encode(pages.map((bytes) => ({ bytes, dictionary })));
}

export type FamilyChoice = {
  dictionary: Buffer;
  source: "committed" | "fresh";
  frames: Buffer[];
  freshTotal: number;
  committedTotal: number | null;
  drift: number | null;
  threshold: number;
};

export async function chooseFamilyDictionary(
  { fresh, committed, pages, threshold = FAMILY_DRIFT, encode = zstdCompressDictionaryBatch }:
  { fresh: Uint8Array; committed: Uint8Array | null; pages: Uint8Array[]; threshold?: number; encode?: ZstdBatch },
): Promise<FamilyChoice> {
  const freshFrames = await familyFrames(pages, fresh, encode);
  const freshTotal = freshFrames.reduce((n, f) => n + f.length, 0);
  if (!committed) {
    return { dictionary: Buffer.from(fresh), source: "fresh", frames: freshFrames, freshTotal, committedTotal: null, drift: null, threshold };
  }
  const committedFrames = await familyFrames(pages, committed, encode);
  const committedTotal = committedFrames.reduce((n, f) => n + f.length, 0);
  const drift = committedTotal / freshTotal - 1;
  if (drift <= threshold) {
    return { dictionary: Buffer.from(committed), source: "committed", frames: committedFrames, freshTotal, committedTotal, drift, threshold };
  }
  return { dictionary: Buffer.from(fresh), source: "fresh", frames: freshFrames, freshTotal, committedTotal, drift, threshold };
}

export type FamilyReport = {
  shipped: string;
  source: "committed" | "fresh";
  fresh: string;
  committed: string | null;
  freshTotal: number;
  committedTotal: number | null;
  drift: number | null;
  threshold: number;
  pages: number;
};
export const FAMILY_REPORT = ".build/page-family.json";
export const FAMILY_FRESH = ".build/page-family.fresh.dict";
