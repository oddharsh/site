// build-cache.ts: a content-addressed cache in front of the build's compressors
// (many) and its minifiers (memo, at the bottom).
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
// Local builds only. CI and Workers Builds (CI, WORKERS_CI) run cold, and so
// does anything wrangler publishes from a workstation: wrangler.config.ts's
// build command sets BUILD_CACHE=0. No published byte comes from an entry.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

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
  // every key this build read or wrote, which prune() never removes
  const used = new Set<string>();
  // Made on the first write, so a cache that only memoizes or only hits leaves
  // no mkdir in flight when its caller removes the directory afterward.
  let made: Promise<unknown> | null = null;

  async function read(key: string, ok: (out: Buffer) => boolean): Promise<Buffer | null> {
    const path = `${dir}/${key}`;
    const out = await readFile(path).catch(() => null);
    if (!out) return null;
    let valid = false;
    try { valid = ok(out); } catch { /* a decoder that throws is a miss */ }
    if (!valid) return null;
    used.add(key);
    return out;
  }

  async function write(key: string, out: Buffer) {
    await (made ??= mkdir(dir, { recursive: true }));
    // write then rename, so a build killed mid-write leaves no torn entry
    used.add(key);
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

  // The synchronous form, for a pure transform whose output cannot be decoded
  // back into its input (a minifier). `name` must carry everything besides the
  // input that the output depends on: the tool's installed version, its options,
  // and the source of any repo code wrapped around it. With nothing to decode,
  // an entry carries the digest of its own text, so a damaged file is a miss.
  // A transform that throws is never cached, so a failure always repeats.
  const memos = new Map<string, string>();
  function memo(name: string, parts: Array<string | Uint8Array>, produce: () => string): string {
    const h = createHash("sha256").update(name);
    for (const part of parts) h.update("\0").update(part);
    const key = h.digest("hex");
    const known = memos.get(key);
    if (known !== undefined) { hits++; return known; }
    if (enabled) {
      const path = `${dir}/${key}`;
      try {
        const file = readFileSync(path, "utf8");
        const cut = file.indexOf("\n");
        const text = file.slice(cut + 1);
        if (cut === 64 && file.slice(0, 64) === createHash("sha256").update(text).digest("hex")) {
          hits++;
          memos.set(key, text);
          used.add(key);
          return text;
        }
      } catch { /* a miss */ }
    }
    misses++;
    const text = produce();
    memos.set(key, text);
    if (enabled) {
      mkdirSync(dir, { recursive: true });
      used.add(key);
      const tmp = `${dir}/${key}.${process.pid}.${writes++}.tmp`;
      writeFileSync(tmp, `${createHash("sha256").update(text).digest("hex")}\n${text}`);
      renameSync(tmp, `${dir}/${key}`);
    }
    return text;
  }

  // At most once a day, remove every entry this build did not use that was
  // written more than maxAgeDays ago: the current tree's entries always
  // survive, and another branch's go two weeks after they were made. A hit
  // used to refresh its entry's mtime instead, which cost a syscall per hit,
  // and the sweep stat'd every entry on every build (about 1,200 files).
  async function prune(maxAgeDays = 14): Promise<number> {
    if (!enabled) return 0;
    const stamp = `${dir}/.pruned`;
    const last = await stat(stamp).catch(() => null);
    if (last && Date.now() - last.mtimeMs < 86_400_000) return 0;
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n !== ".pruned" && !used.has(n));
    const gone = await Promise.all(names.map(async (name) => {
      const s = await stat(`${dir}/${name}`).catch(() => null);
      if (!s || s.mtimeMs >= cutoff) return false;
      await rm(`${dir}/${name}`, { force: true });
      return true;
    }));
    await mkdir(dir, { recursive: true });
    await writeFile(stamp, "");
    return gone.filter(Boolean).length;
  }

  return { many, memo, prune, stats: () => ({ hits, misses }) };
}
