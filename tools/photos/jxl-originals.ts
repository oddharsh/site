#!/usr/bin/env bun
// jxl-originals.ts — give every published original its JPEG XL twin.
//
//   bun tools/photos/jxl-originals.ts [--dry-run] [--jobs N] [--limit N] [stem ...]
//
// Each full-resolution original in R2 is a JPEG. JPEG XL can carry a JPEG's
// own coefficients in a tighter wrapping and rebuild the exact file from them,
// so a twin is the same photo, losslessly, in fewer bytes: 8.17% fewer across
// 12 originals (2026-09-27), and a 40 MP frame decodes in 144 ms against 716 ms
// for the progressive JPEG in Chrome. The page links a twin only for browsers
// that decode JPEG XL (src/worker/lib/photo-jxl.ts); everyone else keeps the
// JPEG, which never moves.
//
// add-photos.sh makes the twin for every new photo. This is the backfill for
// the photos published before it did, and the repair for any that lack one.
// Per original, the order is the proof:
//
//   1. download it through the public URL and refuse it unless its MD5 equals
//      the ETag R2 serves (a single-part upload's ETag is the MD5 of its bytes)
//      and its length equals the size photo-index.json records;
//   2. transcode with cjxl --lossless_jpeg=1 -e 9, the effort ingest uses;
//   3. rebuild the JPEG from the twin with djxl and refuse the twin unless the
//      rebuilt bytes equal the downloaded ones;
//   4. upload the twin with the repo's pinned wrangler, as add-photos.sh does;
//   5. only then write `jxl` into photo-index.json, so the page never links a
//      twin that isn't in R2.
//
// The index is rewritten after every success (beside, then renamed), so an
// interrupted run keeps what it finished and a rerun picks up the rest.
// Uploading is a workstation job: CI's Cloudflare token is read-only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IndexEntry, pretty, sortKeysDeep } from "./pipeline-json.ts";
import { CAP, standing } from "./r2-budget.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const INDEX = path.join(ROOT, "src/worker/photo-index.json");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const ORIGIN = "https://aadhar.sh";
const BUCKET = "aadhar-photos";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const dryRun = flag("--dry-run");
const jobs = opt("--jobs", 3);
const limit = opt("--limit", Infinity);
const valued = new Set(["--jobs", "--limit"]);
const stems = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));

const twinKey = (full: string) => `${full.replace(/\.[^.]+$/, "")}.jxl`;

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${path.basename(cmd[0])} exited ${r.exitCode}: ${r.stderr.toString().trim().split("\n").at(-1)}`);
}

for (const bin of ["cjxl", "djxl"]) {
  if (!Bun.which(bin)) throw new Error(`${bin} not found in PATH (brew install jpeg-xl)`);
}
if (!dryRun && !fs.existsSync(WRANGLER)) throw new Error(`pinned wrangler not found at ${WRANGLER} (run: bun install)`);

const index = JSON.parse(fs.readFileSync(INDEX, "utf8")) as Record<string, IndexEntry>;
const unknown = stems.filter((s) => !index[s]);
if (unknown.length) throw new Error(`not in photo-index.json: ${unknown.join(", ")}`);
const todo = (stems.length ? stems : Object.keys(index))
  .filter((s) => !index[s].jxl && /\.jpe?g$/i.test(index[s].full))
  .slice(0, limit);

console.log(`${todo.length} originals without a JPEG XL twin${dryRun ? " (dry run)" : ""}, ${jobs} at a time`);

// The bucket must stay inside R2's free tier (r2-budget.ts). Each twin reserves
// its exact bytes from this headroom synchronously, before its upload starts,
// so parallel workers can't jointly overshoot; the first twin that doesn't fit
// stops the run, and a rerun after space is freed picks up from there.
const budget = standing(index);
let headroom = CAP - budget.current;
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;
console.log(`bucket: Cloudflare reports ${gb(budget.reported)}, index floor ${gb(budget.floor)}; ${headroom >= 0 ? `${gb(headroom)} under` : `${gb(-headroom)} OVER`} the ${gb(CAP)} cap`);
if (dryRun) {
  for (const s of todo) console.log(`  ${index[s].full} -> ${twinKey(index[s].full)}`);
  process.exit(0);
}
class OverBudget extends Error {}
let stopped = false;

// One write at a time: each success updates the in-memory index and replaces
// the file whole, so the chain only has to keep two renames from interleaving.
let writing = Promise.resolve();
const record = (stem: string, key: string) => {
  index[stem] = { ...index[stem], jxl: key };
  writing = writing.then(() => {
    fs.writeFileSync(`${INDEX}.tmp`, pretty(sortKeysDeep(index as never)));
    fs.renameSync(`${INDEX}.tmp`, INDEX);
  });
  return writing;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "jxl-originals-"));
let done = 0, failed = 0, jpegBytes = 0, jxlBytes = 0;

async function twin(stem: string): Promise<void> {
  const { full, size } = index[stem];
  const key = twinKey(full);
  const jpg = path.join(work, full), jxl = path.join(work, key), rebuilt = `${jxl}.rebuilt.jpg`;
  try {
    const res = await fetch(`${ORIGIN}/images/full/${encodeURIComponent(full)}`);
    if (!res.ok) throw new Error(`GET ${full}: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const etag = (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (bytes.length !== size) throw new Error(`${full}: ${bytes.length} bytes, the index records ${size}`);
    // A multipart ETag ("<hex>-<parts>") is not an MD5 of the bytes, so the
    // length check above is the only one that applies to it.
    if (/^[0-9a-f]{32}$/.test(etag) && etag !== md5) throw new Error(`${full}: MD5 ${md5} is not R2's ETag ${etag}`);
    fs.writeFileSync(jpg, bytes);

    run(["cjxl", "--quiet", "--lossless_jpeg=1", "-e", "9", jpg, jxl]);
    run(["djxl", jxl, rebuilt]);
    if (!bytes.equals(fs.readFileSync(rebuilt))) throw new Error(`${key} does not rebuild ${full} byte for byte`);

    const twinSize = fs.statSync(jxl).size;
    if (twinSize > headroom) throw new OverBudget(`${key} is ${gb(twinSize)} and only ${gb(Math.max(0, headroom))} is left under the cap`);
    headroom -= twinSize;
    run([WRANGLER, "r2", "object", "put", `${BUCKET}/${key}`, `--file=${jxl}`, "--content-type=image/jxl", "--remote"]);
    await record(stem, key);
    done++; jpegBytes += size; jxlBytes += twinSize;
    console.log(`  ✓ ${key}  ${(twinSize / 1e6).toFixed(2)} MB, ${((twinSize / size - 1) * 100).toFixed(2)}%`);
  } catch (e) {
    if (e instanceof OverBudget) {
      // Not a failed photo: the bucket is full. Stop handing out work.
      if (!stopped) console.error(`  ■ stopping at ${stem}: ${e.message}`);
      stopped = true;
      return;
    }
    failed++;
    console.error(`  ✗ ${stem}: ${(e as Error).message}`);
  } finally {
    for (const f of [jpg, jxl, rebuilt]) fs.rmSync(f, { force: true });
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let s = queue.shift(); s && !stopped; s = queue.shift()) await twin(s);
}));
await writing;
fs.rmSync(work, { recursive: true, force: true });

const saved = jpegBytes ? ((1 - jxlBytes / jpegBytes) * 100).toFixed(2) : "0";
console.log(`twins: ${done} uploaded, ${failed} failed; ${(jpegBytes / 1e9).toFixed(2)} GB of JPEG as ${(jxlBytes / 1e9).toFixed(2)} GB of JPEG XL (-${saved}%)`);
if (stopped) console.error(`stopped at the ${gb(CAP)} cap with ${queue.length + 1} or more originals left; free space, then rerun`);
process.exit(failed ? 1 : stopped ? 3 : 0);
