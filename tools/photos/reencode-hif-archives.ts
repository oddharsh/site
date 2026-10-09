#!/usr/bin/env bun
// reencode-hif-archives.ts — move every HIF photo's archive onto JPEG XL
// encoded from the HIF itself.
//
//   bun tools/photos/reencode-hif-archives.ts --hif-dir <dir> --dry-run [--jobs N] [--limit N] [stem ...]
//   bun tools/photos/reencode-hif-archives.ts --hif-dir <dir> --backup <dir> [--jobs N] [--limit N] [stem ...]
//
// Until 2026-10 a HIF photo's archive was a JPEG (zenc's q100 export, or the
// camera's own) repacked losslessly as JPEG XL. Ingest now encodes it from
// the HIF (hif-archive.ts, which carries the measurements); this brings the
// archives published before that onto the same footing. All 119 HIF photos'
// sources are local, and the bucket only shrinks: the sweep put the result at
// about -33% bytes, both metrics better on every photo.
//
// Per photo, the order is the proof:
//
//   1. read the current archive straight from R2 (wrangler, past every cache)
//      and skip it if it is already direct, so a rerun resumes;
//   2. copy it to --backup, the one place the old bytes survive once the key
//      is overwritten;
//   3. rebuild the JPEG inside it with djxl: the bar the new encode must beat;
//   4. hif-archive.ts: bisect for the largest distance that beats that JPEG on
//      both ssimulacra2 and butteraugli, and copy the HIF's EXIF and XMP on;
//      where nothing beats it, the archive is left exactly as it is;
//   5. overwrite the same R2 key, read it back, and compare byte for byte;
//   6. record the new size in photo-index.json.
//
// The key does not change, so nothing that links an original moves. What
// does change is the bytes behind a URL the Worker caches hard, so this is an
// in-place overwrite (src/worker/lib/const.ts): after the run, ship the index
// with ARCHIVE_VERSION bumped, then Purge Everything once. Bumping BEFORE the
// run would let visitors re-cache the old bytes under the new key.
//
// It stops itself after three connection or login failures in a row, as
// migrate-originals.ts does, and --dry-run writes nothing anywhere.
// Uploading is a workstation job: CI's Cloudflare token is read-only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hifArchive } from "./hif-archive.ts";
import { jxlKind, pretty, sortKeysDeep, type IndexEntry } from "./pipeline-json.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INDEX = path.join(ROOT, "src/worker/photo-index.json");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const BUCKET = "aadhar-photos";

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const dryRun = argv.includes("--dry-run");
const hifDir = opt("--hif-dir");
const backup = opt("--backup");
const jobs = Number(opt("--jobs") ?? 2);
const limit = Number(opt("--limit") ?? Infinity);
const valued = new Set(["--hif-dir", "--backup", "--jobs", "--limit"]);
const stems = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));

if (!hifDir) throw new Error("--hif-dir <folder of HIF originals> is required");
if (!dryRun && !backup) throw new Error("--backup <dir> is required: it is the only copy of an archive once its key is overwritten");
if (!fs.existsSync(WRANGLER)) throw new Error(`pinned wrangler not found at ${WRANGLER} (run: bun install)`);
const sooc = (spawnSync("exif-sooc", ["--version"], { encoding: "utf8" }).stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
if (!sooc || Number(sooc[1]) === 0 && Number(sooc[2]) < 4) throw new Error("exif-sooc 0.4.0 or later is required to copy a HIF's EXIF onto JPEG XL");

// stem -> HIF, from the folder of originals
const hifs = new Map<string, string>();
for (const rel of fs.readdirSync(hifDir, { recursive: true }) as string[]) {
  if (/\.(hif|heic|heif)$/i.test(rel)) hifs.set(path.basename(rel).replace(/\.[^.]+$/, ""), path.join(hifDir, rel));
}
const index = JSON.parse(fs.readFileSync(INDEX, "utf8")) as Record<string, IndexEntry>;
const unknown = stems.filter((s) => !index[s]);
if (unknown.length) throw new Error(`not in photo-index.json: ${unknown.join(", ")}`);
const todo = (stems.length ? stems : Object.keys(index).sort())
  .filter((s) => hifs.has(s) && index[s].full.endsWith(".jxl"))
  .slice(0, limit);
console.log(`${todo.length} HIF photos to consider${dryRun ? " (dry run: no uploads, no index writes)" : ""}, ${jobs} at a time`);

function run(cmd: string[]) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) {
    const lines = (r.stderr ?? String(r.error ?? "")).trim().split("\n").filter(Boolean);
    throw new Error(`${path.basename(cmd[0])} exited ${r.status}: ${lines.find((l) => /ERROR/.test(l)) ?? lines.at(-1) ?? ""}`);
  }
}

let writing = Promise.resolve();
const record = (stem: string, size: number) => {
  index[stem] = { ...index[stem], size };
  writing = writing.then(() => {
    fs.writeFileSync(`${INDEX}.tmp`, pretty(sortKeysDeep(index as never)));
    fs.renameSync(`${INDEX}.tmp`, INDEX);
  });
  return writing;
};

const SYSTEMIC = /auth token has expired|not authenticated|Unable to resolve Cloudflare|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket connection was closed/i;
const STOP_AFTER = 3;
let streak = 0;
let halted = null as string | null;
let moved = 0, kept = 0, already = 0, failed = 0, before = 0, after = 0;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "reencode-hif-archives-"));
async function one(stem: string) {
  const key = index[stem].full;
  const d = path.join(work, stem); fs.mkdirSync(d, { recursive: true });
  const cur = path.join(d, "current.jxl"), base = path.join(d, "bar.jpg"), next = path.join(d, "next.jxl"), back = path.join(d, "readback.jxl");
  try {
    run([WRANGLER, "r2", "object", "get", `${BUCKET}/${key}`, `--file=${cur}`, "--remote"]);
    if (jxlKind(cur) === "direct") { already++; streak = 0; console.log(`  · ${stem}: already encoded from its HIF`); return; }
    if (!dryRun) {
      const saved = path.join(backup!, key);
      if (!fs.existsSync(saved)) { fs.mkdirSync(backup!, { recursive: true }); fs.copyFileSync(cur, saved); }
    }
    run(["djxl", cur, base]);
    const made = await hifArchive(hifs.get(stem)!, base, next);
    const was = fs.statSync(cur).size;
    if (made.mode !== "direct") { kept++; streak = 0; console.log(`  = ${stem}: kept as is (${made.reason})`); return; }
    if (!dryRun) {
      run([WRANGLER, "r2", "object", "put", `${BUCKET}/${key}`, `--file=${next}`, "--content-type=image/jxl", "--remote"]);
      run([WRANGLER, "r2", "object", "get", `${BUCKET}/${key}`, `--file=${back}`, "--remote"]);
      if (!fs.readFileSync(back).equals(fs.readFileSync(next))) throw new Error(`${key} read back different from what was uploaded`);
      await record(stem, made.bytes);
    }
    moved++; streak = 0; before += was; after += made.bytes;
    console.log(`  ✓ ${stem}: d${made.distance}, ${(was / 1e6).toFixed(2)} -> ${(made.bytes / 1e6).toFixed(2)} MB (${((made.bytes / was - 1) * 100).toFixed(1)}%), s2 ${made.baseline.s2.toFixed(2)} -> ${made.s2.toFixed(2)}, ba3 ${made.baseline.ba3.toFixed(3)} -> ${made.ba3.toFixed(3)}${dryRun ? " (dry run)" : ""}`);
  } catch (e) {
    const message = (e as Error).message;
    failed++;
    console.error(`  ✗ ${stem}: ${message}`);
    streak = SYSTEMIC.test(message) ? streak + 1 : 0;
    if (streak >= STOP_AFTER && !halted) halted = message;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (!halted && queue.length) await one(queue.shift() as string);
}));
await writing;
fs.rmSync(work, { recursive: true, force: true });

console.log(`re-encoded ${moved}, kept ${kept}, already direct ${already}, failed ${failed}; ${(before / 1e9).toFixed(2)} GB -> ${(after / 1e9).toFixed(2)} GB${before ? ` (${((after / before - 1) * 100).toFixed(1)}%)` : ""}`);
if (halted) console.error(`stopped after ${STOP_AFTER} connection or login failures in a row, ${queue.length} photos not attempted: ${halted}\n  check the connection, run \`bun run wrangler:site login\`, and rerun; finished photos are skipped`);
if (moved && !dryRun) console.log("next: ship photo-index.json with ARCHIVE_VERSION bumped (src/worker/lib/const.ts), then Purge Everything once");
process.exit(failed ? 1 : 0);
