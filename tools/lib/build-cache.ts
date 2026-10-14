// build-cache.ts: a content-addressed cache in front of the build's compressors
// (many) and its minifiers (memo, at the bottom).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

export const BUILD_CACHE_DIR = "node_modules/.cache/aadhar-build";

export function buildCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.BUILD_CACHE === "0") return false;
  return !env.CI && !env.WORKERS_CI;
}

export type Encoder<T> = {
  name: string;
  keyOf: (item: T) => Array<string | Uint8Array>;
  verify: (item: T, out: Buffer) => boolean;
  encode: (items: T[]) => Promise<Buffer[]>;
};

export function buildCache({ dir = BUILD_CACHE_DIR, enabled }: { dir?: string; enabled: boolean }) {
  let hits = 0, misses = 0, writes = 0;
  const inFlight = new Map<string, Promise<Buffer>>();
  const used = new Set<string>();
  let made: Promise<unknown> | null = null;

  async function read(key: string, ok: (out: Buffer) => boolean): Promise<Buffer | null> {
    const path = `${dir}/${key}`;
    const out = await readFile(path).catch(() => null);
    if (!out) return null;
    let valid = false;
    try { valid = ok(out); } catch { }
    if (!valid) return null;
    used.add(key);
    return out;
  }

  async function write(key: string, out: Buffer) {
    await (made ??= mkdir(dir, { recursive: true }));
    used.add(key);
    const tmp = `${dir}/${key}.${process.pid}.${writes++}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, `${dir}/${key}`);
  }

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
      } catch { }
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
