#!/usr/bin/env node
// pipeline-json.ts — the JSON the photo shell scripts used to hand to jaq.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectExifRecord } from "../lib/photo-indexes.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const byCodePoint = (a: string, b: string): number => {
  const A = Array.from(a, (c) => c.codePointAt(0)!), B = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(A.length, B.length); i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  return A.length - B.length;
};

export function sortKeysDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || value.constructor !== Object) return value;
  const record = value as { [k: string]: Json };
  return Object.fromEntries(Object.keys(record).sort(byCodePoint).map((k) => [k, sortKeysDeep(record[k])]));
}

export const pretty = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`;

export function jqUri(s: string): string {
  return Array.from(Buffer.from(s, "utf8"), (b) => (
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
  )).join("");
}

export type IndexEntry = { full: string; size: number; uploaded?: string; album?: string; heif?: string; jpeg?: string };

export function parseSpool(spool: Buffer): Record<string, Omit<IndexEntry, "uploaded">> {
  const fields = spool.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) throw new Error(`entries spool holds ${fields.length} fields, not a multiple of 5`);
  const out: Record<string, Omit<IndexEntry, "uploaded">> = {};
  for (let i = 0; i < fields.length; i += 5) {
    const [stem, full, sizeText, album, heif] = fields.slice(i, i + 5);
    const size = Number(sizeText);
    if (!stem || !full || !Number.isInteger(size) || size < 0) throw new Error(`bad spool record for ${JSON.stringify(stem)}: full=${JSON.stringify(full)} size=${JSON.stringify(sizeText)}`);
    const entry: Omit<IndexEntry, "uploaded"> = { full, size };
    if (album) entry.album = album;
    if (heif) entry.heif = heif;
    out[stem] = entry;
  }
  return out;
}

export function jxlKind(file: string): "transcode" | "direct" {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, head = Buffer.alloc(16);
    let at = 0, boxes = 0;
    while (at + 8 <= size) {
      fs.readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const kind = head.toString("latin1", 4, 8);
      if (boxes === 0 && kind !== "JXL ") throw new Error(`${file} is not a JPEG XL container`);
      if (kind === "jbrd") return "transcode";
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - at;
      if (len < 8 || at + len > size) throw new Error(`${file}: a box runs past the end of the file`);
      at += len; boxes++;
    }
    if (boxes === 0) throw new Error(`${file} is empty`);
    return "direct";
  } finally {
    fs.closeSync(fd);
  }
}

export function mergeIndex(index: Record<string, IndexEntry>, entries: Record<string, Omit<IndexEntry, "uploaded">>, now: string): Record<string, IndexEntry> {
  const merged: Record<string, IndexEntry> = { ...index };
  for (const [stem, entry] of Object.entries(entries)) {
    const old = index[stem];
    const row: IndexEntry = { ...entry, uploaded: old?.uploaded ?? now };
    if (old?.jpeg && old.full === entry.full) row.jpeg = old.jpeg;
    merged[stem] = row;
  }
  return sortKeysDeep(merged as Json) as Record<string, IndexEntry>;
}

export function pyCompactJson(value: Json): string {
  return ensureAscii(JSON.stringify(sortKeysDeep(value)));
}

export const pyPrettyJson = (value: Json): string => ensureAscii(pretty(sortKeysDeep(value)));

const ensureAscii = (json: string): string => json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export type Checkpoint = { slug: string; title: string; version: string; vnum: number; ymd: string };

export function addCheckpoint(rows: Checkpoint[], slug: string, title: string, ymd: string): { rows: Checkpoint[]; entry: Checkpoint } {
  const vnum = rows.reduce((max, r) => Math.max(max, r.vnum), 0) + 1;
  if (rows.some((r) => r.slug === slug)) throw new Error(`slug '${slug}' is already in the log, pick another`);
  const entry = { slug, title, version: `aadhar-v${vnum}-${slug}`, vnum, ymd };
  return { rows: [...rows, entry].sort((a, b) => a.vnum - b.vnum), entry };
}

type TierMap = Record<string, Record<string, string>>;

export function tierStem(name: string): string | null {
  for (const suffix of ["-400.avif", "-200.avif"]) if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  if (name.endsWith(".jpg")) return name.slice(0, -4);
  if (name.endsWith(".avif")) return name.slice(0, -5);
  return null;
}

const TIERS = [["a", "", ".avif"], ["j", "", ".jpg"], ["s", "-400", ".avif"], ["x", "-200", ".avif"]] as const;
const sourceName = (stem: string, [, suffix, ext]: typeof TIERS[number]) => `${stem}${suffix}${ext}`;
const hashedName = (stem: string, [, suffix, ext]: typeof TIERS[number], h: string) => `${stem}${suffix}.${h}${ext}`;

export function hashTiers(srcDir: string, outDir: string, mapPath: string): string[] {
  const h8 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
  const stems = [...new Set(fs.readdirSync(srcDir).map(tierStem).filter((s): s is string => Boolean(s)))].sort(byCodePoint);

  let loaded: Json = {};
  if (fs.existsSync(mapPath)) {
    const raw = fs.readFileSync(mapPath, "utf8");
    try { loaded = JSON.parse(raw); } catch (e) {
      throw new Error(
        `${mapPath} exists but is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
        "Refusing to prune /i/ against an empty map; restore it (git checkout -- public/images/hashes.json) and re-run.",
      );
    }
  }
  if (loaded === null || loaded.constructor !== Object) throw new Error(`${mapPath} is not a JSON object`);
  const hashes = loaded as TierMap;
  for (const [stem, entry] of Object.entries(hashes)) {
    if (entry === null || (entry as Json as object).constructor !== Object) throw new Error(`${mapPath}: entry for ${stem} is not an object`);
  }

  // The j-tier hash each histogram was computed from, snapshotted before this
  // run mutates the map. images/histograms.json is a pure function of those
  // exact JPEG bytes, and a re-encode mints a NEW hash, so a run that moves any
  // j leaves the committed bars describing pixels nobody is served. Not
  // hypothetical: #394 re-encoded 316 thumbnails on 2026-08-14 and re-baked
  // nothing, unseen for nine days (gotcha 46).
  const prevJ = new Map(Object.entries(hashes).map(([st, e]) => [st, e.j]));
  let copied = 0;
  for (const stem of stems) {
    const entry: Record<string, string> = {};
    for (const tier of TIERS) {
      const src = path.join(srcDir, sourceName(stem, tier));
      if (!fs.existsSync(src)) continue;
      const h = h8(src);
      const out = path.join(outDir, hashedName(stem, tier, h));
      if (!fs.existsSync(out)) { fs.copyFileSync(src, out); copied += 1; }
      entry[tier[0]] = h;
    }
    if (Object.keys(entry).length) hashes[stem] = { ...hashes[stem], ...entry };
  }

  fs.writeFileSync(mapPath, pyCompactJson(hashes as Json));

  let prunedSrc = 0, prunedI = 0;
  for (const stem of stems) {
    for (const tier of TIERS) {
      const p = path.join(srcDir, sourceName(stem, tier));
      if (fs.existsSync(p)) { fs.rmSync(p); prunedSrc += 1; }
    }
  }
  const expected = new Set<string>();
  for (const [st, e] of Object.entries(hashes)) for (const tier of TIERS) if (Object.hasOwn(e, tier[0])) expected.add(hashedName(st, tier, e[tier[0]]));
  for (const f of fs.readdirSync(outDir)) {
    if ((f.endsWith(".avif") || f.endsWith(".jpg")) && !expected.has(f)) { fs.rmSync(path.join(outDir, f)); prunedI += 1; }
  }

  const lines = [
    `hashed ${Object.keys(hashes).length} stems, copied ${copied} new files -> ${outDir}`,
    `pruned ${prunedSrc} un-hashed source tiers, ${prunedI} superseded /i/ files`,
    `map: ${mapPath}`,
  ];
  const restale = Object.entries(hashes).filter(([st, e]) => prevJ.get(st) && e.j !== prevJ.get(st)).map(([st]) => st).sort(byCodePoint);
  if (restale.length) {
    const shown = restale.slice(0, 8).join(", ") + (restale.length > 8 ? " ..." : "");
    lines.push(
      "",
      `WARNING: the JPEG tier changed for ${restale.length} photo(s): ${shown}`,
      "  images/histograms.json is computed from those exact bytes, so the",
      "  tooltip bars are now stale. Re-bake before committing:",
      "    ./tools/photos/extract-photo-metadata.sh /path/to/sooc-originals/",
      "  add-photos.sh already runs that; a standalone re-encode does not.",
    );
  }
  return lines;
}

const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));
const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const need = (args: string[], name: string): string => { const v = flag(args, name); if (v === undefined) throw new Error(`${name} is required`); return v; };

export function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  switch (cmd) {
    case "length": {
      const v = readJson(positional[0]);
      const n = Array.isArray(v) ? v.length : Object.keys(v ?? {}).length;
      process.stdout.write(`${n}\n`);
      return 0;
    }
    case "index-merge": {
      const [indexFile] = positional;
      const entries = parseSpool(fs.readFileSync(need(args, "--entries")));
      const index = fs.existsSync(indexFile) ? readJson(indexFile) as Record<string, IndexEntry> : {};
      fs.writeFileSync(`${indexFile}.tmp`, pretty(mergeIndex(index, entries, need(args, "--now")) as Json));
      fs.renameSync(`${indexFile}.tmp`, indexFile);
      return 0;
    }
    case "prune": {
      const [file] = positional;
      const record = readJson(file) as Record<string, Json>;
      const published = readJson(need(args, "--published")) as Record<string, Json>;
      const kept: Record<string, Json> = {};
      const dropped: string[] = [];
      for (const [k, v] of Object.entries(record)) (Object.hasOwn(published, k) ? (kept[k] = v) : dropped.push(k));
      fs.writeFileSync(need(args, "--out"), pretty(kept));
      for (const k of dropped.sort(byCodePoint)) process.stdout.write(`${k}\n`);
      return 0;
    }
    case "unread": {
      const [hashesFile] = positional;
      const hashes = readJson(hashesFile) as Record<string, Json>;
      const against = readJson(need(args, "--against")) as Record<string, Json>;
      for (const k of Object.keys(hashes).filter((k) => !Object.hasOwn(against, k)).sort(byCodePoint)) process.stdout.write(`${k}\n`);
      return 0;
    }
    case "meta-split": {
      const record = readJson(positional[0]) as Record<string, Record<string, unknown>>;
      const dir = need(args, "--out-dir");
      fs.mkdirSync(dir, { recursive: true });
      for (const [stem, fields] of Object.entries(record)) fs.writeFileSync(path.join(dir, `${stem}.json`), `${JSON.stringify(projectExifRecord(fields))}\n`);
      return 0;
    }
    case "manifest-keys": {
      const manifest = readJson(positional[0]) as { photos?: { full?: string | null }[] };
      for (const p of manifest.photos ?? []) {
        const full = p?.full;
        if (full !== undefined && full !== null) process.stdout.write(`${full}\n`);
      }
      return 0;
    }
    case "uri":
      process.stdout.write(`${jqUri(positional[0] ?? "")}\n`);
      return 0;
    case "hash-tiers":
      for (const line of hashTiers(positional[0], need(args, "--out-dir"), need(args, "--map"))) process.stdout.write(`${line}\n`);
      return 0;
    case "jxl-kind":
      process.stdout.write(`${jxlKind(positional[0])}\n`);
      return 0;
    case "checkpoint-add": {
      const [file] = positional;
      const { rows, entry } = addCheckpoint(readJson(file) as Checkpoint[], need(args, "--slug"), need(args, "--title"), need(args, "--ymd"));
      fs.writeFileSync(file, pyPrettyJson(rows as Json));
      process.stdout.write(`staged: v${entry.vnum} (${entry.ymd}) as ${entry.version}\n        ${entry.title}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: pipeline-json.ts <length|index-merge|prune|unread|meta-split|manifest-keys|uri|hash-tiers|jxl-kind|checkpoint-add> ...\n");
      return 2;
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { process.stderr.write(`pipeline-json: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
}
