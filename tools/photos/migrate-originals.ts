#!/usr/bin/env bun
// migrate-originals.ts — move every JPEG original in R2 to lossless JPEG XL.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IndexEntry, pretty, sortKeysDeep } from "./pipeline-json.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const INDEX = path.join(ROOT, "src/worker/photo-index.json");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const ORIGIN = process.env.PHOTO_SOURCE_ORIGIN ?? "https://aadhar.sh";
const BUCKET = "aadhar-photos";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const dryRun = flag("--dry-run");
const del = flag("--delete");
const jobs = opt("--jobs", 3);
const limit = opt("--limit", Infinity);
const valued = new Set(["--jobs", "--limit"]);
const stems = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));

const isJpeg = (key: string) => /\.jpe?g$/i.test(key);
const jxlKey = (full: string) => `${full.replace(/\.[^.]+$/, "")}.jxl`;
const url = (key: string) => `${ORIGIN}/images/full/${encodeURIComponent(key)}`;

// wrangler ends its stderr with "Logs were written to ...", so the last line
// says nothing about the failure; its ERROR line does.
const reason = (stderr: string) => {
  const lines = stderr.trim().split("\n").filter(Boolean);
  return lines.find((l) => /ERROR/.test(l)) ?? lines.at(-1) ?? "";
};

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${path.basename(cmd[0])} exited ${r.exitCode}: ${reason(r.stderr.toString())}`);
}

for (const bin of ["cjxl", "djxl"]) {
  if (!Bun.which(bin)) throw new Error(`${bin} not found in PATH (brew install jpeg-xl)`);
}
if (!fs.existsSync(WRANGLER)) throw new Error(`pinned wrangler not found at ${WRANGLER} (run: bun install)`);

const index = JSON.parse(fs.readFileSync(INDEX, "utf8")) as Record<string, IndexEntry>;
const unknown = stems.filter((s) => !index[s]);
if (unknown.length) throw new Error(`not in photo-index.json: ${unknown.join(", ")}`);
const scope = stems.length ? stems : Object.keys(index);
const pending = scope.filter((s) => isJpeg(index[s].full)).slice(0, limit);
const leftover = del ? scope.filter((s) => index[s].jpeg && !isJpeg(index[s].full)) : [];

console.log(`${pending.length} JPEG originals to move${del ? `, ${leftover.length} moved JPEGs to delete` : " (no uploads or deletes without --delete)"}${dryRun ? " (dry run)" : ""}`);
if (dryRun) {
  for (const s of pending) console.log(`  ${index[s].full} -> ${jxlKey(index[s].full)}`);
  for (const s of leftover) console.log(`  delete ${index[s].jpeg}`);
  process.exit(0);
}

if (del) {
  const sample = Object.values(index).find((e) => e.jpeg && !isJpeg(e.full));
  if (!sample?.jpeg) throw new Error("no moved photo in photo-index.json to check the redirect with; ship a run without --delete first");
  const res = await fetch(`${url(sample.jpeg)}?redirect-check=${Date.now()}`, { redirect: "manual", headers: { range: "bytes=0-0" } });
  const location = res.headers.get("location") ?? "";
  if (res.status !== 301 || !location.endsWith(`/images/full/${sample.full}`)) {
    throw new Error(`production answered ${res.status} ${location} for ${sample.jpeg}, not a 301 to ${sample.full}; deploy the redirect and this index first`);
  }
  console.log(`  redirect live: ${sample.jpeg} -> ${sample.full}`);
}

let writing = Promise.resolve();
const record = (stem: string, row: IndexEntry) => {
  index[stem] = row;
  writing = writing.then(() => {
    fs.writeFileSync(`${INDEX}.tmp`, pretty(sortKeysDeep(index as never)));
    fs.renameSync(`${INDEX}.tmp`, INDEX);
  });
  return writing;
};
const remove = (key: string) => run([WRANGLER, "r2", "object", "delete", `${BUCKET}/${key}`, "--remote"]);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-originals-"));
let moved = 0, skipped = 0, failed = 0, deleted = 0, started = 0, jpegBytes = 0, jxlBytes = 0;

const SYSTEMIC = /auth token has expired|not authenticated|Unable to resolve Cloudflare|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket connection was closed/i;
const STOP_AFTER = 3;
let streak = 0;
// Typed by assertion: it is only ever set inside failure(), so flow analysis
// would narrow it to null at every read below.
let halted = null as string | null;
const succeeded = () => { streak = 0; };
const failure = (stem: string, message: string) => {
  failed++;
  console.error(`  ✗ ${stem}: ${message}`);
  streak = SYSTEMIC.test(message) ? streak + 1 : 0;
  if (streak >= STOP_AFTER && !halted) halted = message;
};

async function move(stem: string): Promise<void> {
  started++;
  const entry = index[stem];
  const { full, size } = entry;
  const key = jxlKey(full);
  const jpg = path.join(work, full), jxl = path.join(work, key), rebuilt = `${jxl}.rebuilt.jpg`;
  try {
    const get = Bun.spawnSync([WRANGLER, "r2", "object", "get", `${BUCKET}/${key}`, `--file=${jxl}`, "--remote"], { stdout: "pipe", stderr: "pipe" });
    const missing = get.exitCode !== 0 && /The specified key does not exist/.test(get.stderr.toString());
    if (get.exitCode !== 0 && !missing) throw new Error(`r2 get ${key}: ${reason(get.stderr.toString())}`);
    if (missing && !del) {
      succeeded();
      skipped++;
      console.log(`  · ${stem}: no .jxl in R2 yet; --delete makes one`);
      return;
    }

    const res = await fetch(url(full), { redirect: "manual" });
    if (res.status !== 200) throw new Error(`GET ${full}: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const etag = (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (bytes.length !== size) throw new Error(`${full}: ${bytes.length} bytes, the index records ${size}`);
    // A multipart ETag ("<hex>-<parts>") is not an MD5 of the bytes, so the
    // length check above is the only one that applies to it.
    if (/^[0-9a-f]{32}$/.test(etag) && etag !== md5) throw new Error(`${full}: MD5 ${md5} is not R2's ETag ${etag}`);
    fs.writeFileSync(jpg, bytes);

    const made = missing;
    if (made) run(["cjxl", "--quiet", "--lossless_jpeg=1", "-e", "9", jpg, jxl]);
    run(["djxl", jxl, rebuilt]);
    if (!bytes.equals(fs.readFileSync(rebuilt))) throw new Error(`${key} does not rebuild ${full} byte for byte`);

    if (made) run([WRANGLER, "r2", "object", "put", `${BUCKET}/${key}`, `--file=${jxl}`, "--content-type=image/jxl", "--remote"]);
    const jxlSize = fs.statSync(jxl).size;
    await record(stem, { ...entry, full: key, size: jxlSize, jpeg: full });
    if (del) { remove(full); deleted++; }
    succeeded();
    moved++; jpegBytes += size; jxlBytes += jxlSize;
    console.log(`  ✓ ${full} -> ${key}  ${(jxlSize / 1e6).toFixed(2)} MB, ${((jxlSize / size - 1) * 100).toFixed(2)}%${made ? ", uploaded" : ""}${del ? ", JPEG deleted" : ""}`);
  } catch (e) {
    failure(stem, (e as Error).message);
  } finally {
    for (const f of [jpg, jxl, rebuilt]) fs.rmSync(f, { force: true });
  }
}

for (const stem of leftover) {
  if (halted) break;
  try { remove(index[stem].jpeg as string); succeeded(); deleted++; console.log(`  ✓ deleted ${index[stem].jpeg}`); }
  catch (e) { failure(stem, (e as Error).message); }
}

const queue = halted ? [] : [...pending];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (!halted && queue.length) await move(queue.shift() as string);
}));
await writing;
fs.rmSync(work, { recursive: true, force: true });

const saved = jpegBytes ? ((1 - jxlBytes / jpegBytes) * 100).toFixed(2) : "0";
console.log(`moved ${moved}, skipped ${skipped}, failed ${failed}, JPEGs deleted ${deleted}; ${(jpegBytes / 1e9).toFixed(2)} GB of JPEG as ${(jxlBytes / 1e9).toFixed(2)} GB of JPEG XL (-${saved}%)`);
if (halted) {
  console.error(`stopped after ${STOP_AFTER} connection or login failures in a row, ${pending.length - started} photos not attempted: ${halted}`);
  console.error("  a failed photo is untouched, or recorded with its JPEG still in R2; check the connection, run `bun run wrangler:site login`, and rerun to finish both");
}
process.exit(failed ? 1 : 0);
