// build-cache.ts: a content-addressed cache in front of the build's compressors.
//
// The twin stages are most of a clean build's CPU: brotli q11 for every page
// and static text file, zstd level 19 for the family-dictionary choice and the
// page deltas. Measured on 2026-10-08, the stages holding them took 1.6 of 2.9 s
// wall and 11 s of CPU, and nearly every input was unchanged since the build
// before. Both encoders are deterministic for one build of the encoder and one
// parameter set, so an entry keyed on those plus the input holds exactly the
// bytes a fresh run would produce.
//
// The encoder string a caller passes names its parameters and the runtime by
// Bun.revision: production builds with a rolling canary, and a new revision
// misses every entry instead of trusting another encoder's output. Every hit is
// also decoded and compared with its input before it is used, so a truncated or
// foreign entry costs a recompression and never ships.
//
// Local builds only. CI and Workers Builds (CI, WORKERS_CI) run cold, so the
// release path's bytes come from the encoders exactly as before.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";

export const BUILD_CACHE_DIR = "node_modules/.cache/aadhar-build";

export function buildCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.BUILD_CACHE === "0") return false;
  return !env.CI && !env.WORKERS_CI;
}

export type Encoder<T> = {
  // names the algorithm, its parameters and the runtime build
  name: string;
  // what the output is a pure function of, besides the encoder
  keyOf: (item: T) => Array<string | Uint8Array>;
  // true when `out` decodes back to this item's input
  verify: (item: T, out: Buffer) => boolean;
  // encodes the items that missed, one output each, in order
  encode: (items: T[]) => Promise<Buffer[]>;
};

export function buildCache({ dir = BUILD_CACHE_DIR, enabled }: { dir?: string; enabled: boolean }) {
  let hits = 0, misses = 0, writes = 0;
  // Two staged files can hold the same bytes, and with them the same key: they
  // share one lookup, so the bytes encode once and the entry is written once.
  const inFlight = new Map<string, Promise<Buffer>>();
  const made = enabled ? mkdir(dir, { recursive: true }) : null;

  async function read(key: string, ok: (out: Buffer) => boolean): Promise<Buffer | null> {
    const path = `${dir}/${key}`;
    const out = await readFile(path).catch(() => null);
    if (!out) return null;
    let valid = false;
    try { valid = ok(out); } catch { /* a decoder that throws is a miss */ }
    if (!valid) return null;
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return out;
  }

  async function write(key: string, out: Buffer) {
    await made;
    // write then rename, so a build killed mid-write leaves no torn entry
    const tmp = `${dir}/${key}.${process.pid}.${writes++}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, `${dir}/${key}`);
  }

  // Sharing runs with the disk cache off too (CI): it never reads or writes a
  // file, and it only hands one encoder output to two callers whose inputs
  // and encoder are identical.
  async function many<T>(items: T[], enc: Encoder<T>): Promise<Buffer[]> {
    type Owned = { i: number; key: string; resolve: (b: Buffer) => void; reject: (e: unknown) => void };
    const owned: Owned[] = [];
    const results = items.map((item, i) => {
      const h = createHash("sha256").update(enc.name);
      for (const part of enc.keyOf(item)) h.update("\0").update(part);
      const key = h.digest("hex");
      const shared = inFlight.get(key);
      if (shared) { hits++; return shared; }
      const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
      inFlight.set(key, promise);
      owned.push({ i, key, resolve, reject });
      return promise;
    });
    const missed: Owned[] = [];
    await Promise.all(owned.map(async (o) => {
      const out = enabled ? await read(o.key, (b) => enc.verify(items[o.i], b)) : null;
      if (out) { hits++; o.resolve(out); } else missed.push(o);
    }));
    if (missed.length) {
      misses += missed.length;
      missed.sort((a, b) => a.i - b.i);
      try {
        const outs = await enc.encode(missed.map((o) => items[o.i]));
        await Promise.all(missed.map(async (o, j) => {
          if (enabled) await write(o.key, outs[j]);
          o.resolve(outs[j]);
        }));
      } catch (error) {
        for (const o of missed) o.reject(error);
      }
    }
    return Promise.all(results);
  }

  // Entries a build reads keep a fresh mtime; anything unread for maxAgeDays
  // goes, which holds the directory near one build's worth.
  async function prune(maxAgeDays = 14): Promise<number> {
    if (!enabled) return 0;
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(`${dir}/${name}`).catch(() => null);
      if (s && s.mtimeMs < cutoff) { await rm(`${dir}/${name}`, { force: true }); removed++; }
    }
    return removed;
  }

  return { many, prune, stats: () => ({ hits, misses }) };
}
