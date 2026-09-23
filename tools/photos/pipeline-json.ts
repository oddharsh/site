#!/usr/bin/env node
// pipeline-json.ts — the JSON the photo shell scripts used to hand to jaq.
//
// Every subcommand here replaced one jaq filter on 2026-09-15, and each one
// names the filter it stands in for, because the shape of the OUTPUT is the
// contract: two of these write files that are committed (src/worker/photo-
// index.json, public/images/metadata.json), and those files carry jaq's
// pretty-printer bytes, 2-space indent and a trailing newline. A contract test
// round-trips both committed files through the matching subcommand and asserts
// byte identity, so the first ingest after this change diffs only the photo it
// added.
//
// WHY THIS EXISTS. The pipeline already ran node four times per add before this
// file (photo-inputs, the histogram index, semantics, the pipeline check), so a
// second JSON engine bought nothing, and it had cost something twice: jq's
// recursive-merge `*` pinned the extractor to one engine until exif-sooc grew
// --merge-into, and the swap to jaq misfiled a `-s` incompatibility as an
// operator bug because nobody ran the control (CLAUDE.md, the exif-sooc note).
// Two jq dialects that disagree in the corners is a class of bug; one
// JSON.parse is not.
//
//   pipeline-json.ts length <file.json>
//       jaq 'length'
//   pipeline-json.ts index-merge <index.json> --entries <spool> --now <iso>
//       the add-photos.sh entry build plus
//       jaq -S '. as $idx | ($new[0] | with_entries(.value += {uploaded:
//         ($idx[.key].uploaded // $now)})) | $idx + .'
//       <spool> is NUL-separated fields, five per entry: stem, full, size,
//       album, heif; album and heif are written only when non-empty, so an
//       entry for the site-wide pool keeps the three-key shape it always had.
//   pipeline-json.ts prune <file.json> --published <hashes.json> --out <pruned>
//       jaq 'with_entries(select(.key as $k | $pub[0] | has($k)))', and the
//       dropped keys on stdout, one per line, which was a second jaq call
//   pipeline-json.ts unread <hashes.json> --against <file.json>
//       jaq -r 'keys - ($meta[0] | keys) | .[]'
//   pipeline-json.ts meta-split <metadata.json> --out-dir <dir>
//       jaq -c 'to_entries[]' piped through a per-stem jaq literal of the 22
//       short keys, dropping nulls. That literal was the SECOND copy of the map
//       tools/lib/photo-indexes.ts ships as EXIF_KEY_MAP, held together by
//       check-photo-pipeline.ts; this calls projectExifRecord, so there is one.
//   pipeline-json.ts manifest-keys <manifest.json | ->
//       jaq -r '.photos[]?.full'
//   pipeline-json.ts uri <string>
//       jaq -nr '$key | @uri'
//   pipeline-json.ts hash-tiers <images-dir> --out-dir <i-dir> --map <hashes.json>
//       NOT a jaq filter: the Python heredoc hash-thumbnails.sh ran until
//       2026-09-22, which the 2026-09-15 sweep missed because the no-python
//       contract test read a hand-kept list of three files and this script was
//       not on it. hashes.json is committed and carries Python's json.dump
//       bytes (sort_keys, no spaces, ensure_ascii, no trailing newline), and
//       /i/ is content-addressed, so the port was diffed byte for byte against
//       the heredoc on the real library before it replaced it.
//   pipeline-json.ts checkpoint-add <checkpoints.json> --slug <s> --title <t> --ymd <date>
//       the other heredoc, bump-version.sh's, found the same day by the widened
//       test rather than by anyone looking: json.dumps(rows, indent=2,
//       sort_keys=True) + "\n" into src/worker/checkpoints.json, committed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectExifRecord } from "../lib/photo-indexes.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Key order by code point, which is what jaq -S sorts by (Rust string order
 *  over UTF-8 bytes). JS's default `<` on strings compares UTF-16 code units,
 *  which agrees inside the BMP and disagrees past it; stems are ASCII today
 *  and this keeps the tie from ever mattering. */
const byCodePoint = (a: string, b: string): number => {
  const A = Array.from(a, (c) => c.codePointAt(0)!), B = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(A.length, B.length); i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  return A.length - B.length;
};

/** jaq -S: every object's keys sorted, recursively. */
export function sortKeysDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  // JSON.parse output holds exactly four scalar shapes and one object shape,
  // and a plain object is the only one whose constructor is Object.
  if (value === null || value.constructor !== Object) return value;
  const record = value as { [k: string]: Json };
  return Object.fromEntries(Object.keys(record).sort(byCodePoint).map((k) => [k, sortKeysDeep(record[k])]));
}

/** jaq's default pretty-printer: 2-space indent, one trailing newline. */
export const pretty = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`;

/** jq's @uri: percent-encode every byte outside the unreserved set, uppercase
 *  hex. encodeURIComponent would leave !'()* alone, which @uri does not. */
export function jqUri(s: string): string {
  return Array.from(Buffer.from(s, "utf8"), (b) => (
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
  )).join("");
}

export type IndexEntry = { full: string; size: number; uploaded?: string; album?: string; heif?: string };

/** The entry build from add-photos.sh's loop, five NUL-separated fields per
 *  photo, in the order the shell wrote them. A trailing NUL after the last
 *  field is what printf '%s\0' produces, so an empty spool is zero entries and
 *  a partial record (a count not divisible by five) is refused rather than
 *  read as a photo with a blank size. */
export function parseSpool(spool: Buffer): Record<string, Omit<IndexEntry, "uploaded">> {
  const fields = spool.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) throw new Error(`entries spool holds ${fields.length} fields, not a multiple of 5`);
  const out: Record<string, Omit<IndexEntry, "uploaded">> = {};
  for (let i = 0; i < fields.length; i += 5) {
    const [stem, full, sizeText, album, heif] = fields.slice(i, i + 5);
    const size = Number(sizeText);
    if (!stem || !full || !Number.isInteger(size) || size < 0) throw new Error(`bad spool record for ${JSON.stringify(stem)}: full=${JSON.stringify(full)} size=${JSON.stringify(sizeText)}`);
    // `album` and `heif` are written only when set, never as an empty string.
    const entry: Omit<IndexEntry, "uploaded"> = { full, size };
    if (album) entry.album = album;
    if (heif) entry.heif = heif;
    out[stem] = entry;
  }
  return out;
}

/** `$idx + .` with `.value += {uploaded: ($idx[.key].uploaded // $now)}`: a
 *  new entry replaces the old one whole, keeping only the upload date it had. */
export function mergeIndex(index: Record<string, IndexEntry>, entries: Record<string, Omit<IndexEntry, "uploaded">>, now: string): Record<string, IndexEntry> {
  const merged: Record<string, IndexEntry> = { ...index };
  for (const [stem, entry] of Object.entries(entries)) merged[stem] = { ...entry, uploaded: index[stem]?.uploaded ?? now };
  return sortKeysDeep(merged as Json) as Record<string, IndexEntry>;
}

/** Python's json.dumps(v, sort_keys=True, separators=(",", ":")), byte for
 *  byte. JSON.stringify already escapes the same control characters in the
 *  same lowercase form; what it does not do is ensure_ascii, which escapes
 *  every code unit outside space..~ (DEL included) as \uXXXX. A JS string is
 *  UTF-16, so an astral character comes out as the same surrogate pair Python
 *  writes. */
export function pyCompactJson(value: Json): string {
  return ensureAscii(JSON.stringify(sortKeysDeep(value)));
}

/** json.dumps(v, indent=2, sort_keys=True) + "\n". With an indent Python drops
 *  the space after the item comma and keeps the one after the colon, which is
 *  exactly JSON.stringify's 2-space shape; ensure_ascii is again the one gap. */
export const pyPrettyJson = (value: Json): string => ensureAscii(pretty(sortKeysDeep(value)));

const ensureAscii = (json: string): string => json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export type Checkpoint = { slug: string; title: string; version: string; vnum: number; ymd: string };

/** bump-version.sh's body: mint the next vnum from the PROJECTION (so staging a
 *  release needs no D1, no network and no credential), refuse a slug already in
 *  the log, append, and keep the rows in vnum order. */
export function addCheckpoint(rows: Checkpoint[], slug: string, title: string, ymd: string): { rows: Checkpoint[]; entry: Checkpoint } {
  const vnum = rows.reduce((max, r) => Math.max(max, r.vnum), 0) + 1;
  if (rows.some((r) => r.slug === slug)) throw new Error(`slug '${slug}' is already in the log, pick another`);
  const entry = { slug, title, version: `aadhar-v${vnum}-${slug}`, vnum, ymd };
  // Array.prototype.sort is stable, as Python's list.sort is.
  return { rows: [...rows, entry].sort((a, b) => a.vnum - b.vnum), entry };
}

type TierMap = Record<string, Record<string, string>>;

/** The stem a tier file belongs to, from ANY tier rather than the JPG alone. A
 *  full re-encode writes every tier, so the JPG was a fine proxy; an ADDITIVE
 *  run (TIERS=xs in reencode-thumbnails.sh, which is how the 200px tier was
 *  backfilled without reminting the other three hashes) writes one AVIF and no
 *  JPG, and a JPG-only scan finds nothing and silently hashes zero photos. The
 *  suffix order is the heredoc's: the sized AVIFs are tested before the bare
 *  extensions, so `X-400.avif` is stem X rather than stem `X-400`. */
export function tierStem(name: string): string | null {
  for (const suffix of ["-400.avif", "-200.avif"]) if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  if (name.endsWith(".jpg")) return name.slice(0, -4);
  if (name.endsWith(".avif")) return name.slice(0, -5);
  return null;
}

/** The four tiers as [map key, name suffix, extension], in the heredoc's order.
 *  A source is `<stem><suffix><ext>` and its address `<stem><suffix>.<h8><ext>`. */
const TIERS = [["a", "", ".avif"], ["j", "", ".jpg"], ["s", "-400", ".avif"], ["x", "-200", ".avif"]] as const;
const sourceName = (stem: string, [, suffix, ext]: typeof TIERS[number]) => `${stem}${suffix}${ext}`;
const hashedName = (stem: string, [, suffix, ext]: typeof TIERS[number], h: string) => `${stem}${suffix}.${h}${ext}`;

/** hash-thumbnails.sh's body: address every tier in `srcDir` into `outDir`
 *  under its hash8, MERGE the result into the map at `mapPath`, then prune the
 *  addressed sources and any /i/ file the merged map no longer names. Returns
 *  the lines the heredoc printed, in its order. See hash-thumbnails.sh for why
 *  each half exists; this is the mechanism, kept statement for statement. */
export function hashTiers(srcDir: string, outDir: string, mapPath: string): string[] {
  const h8 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
  const stems = [...new Set(fs.readdirSync(srcDir).map(tierStem).filter((s): s is string => Boolean(s)))].sort(byCodePoint);

  // A MISSING map starts empty, because a first run has none. A map that EXISTS
  // and does not parse is refused here, above the first copy, so the run writes
  // nothing and deletes nothing. This is the one place the port parts from the
  // heredoc on purpose: Python read that case as `{}` (`except Exception`), and
  // the prune below deletes every /i/ file the new map does not name, so an
  // empty prior map reads as "all of /i/ is superseded". Measured on a scratch
  // copy during #896: a corrupt map took i/ from 1,032 files to 1. The realistic
  // way in is a git conflict, since hashes.json is one line and no merge driver
  // claims it, so the markers cover the whole file. The fix is to restore the
  // file, never to rebuild it from whatever sources are lying in images/.
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
  // Python crashed on a map that parsed to anything but an object of objects
  // (`.items()` on a list, `.update` on a string); refusing keeps that loud.
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
    // MERGE per stem too: an additive run carries only the tier it generated.
    if (Object.keys(entry).length) hashes[stem] = { ...hashes[stem], ...entry };
  }

  fs.writeFileSync(mapPath, pyCompactJson(hashes as Json));

  // Clean up so the tree matches the map: drop the un-hashed source tiers just
  // addressed (they live in /i/ now; metadata.json, alt.json, hashes.json and
  // meta/ stay put), then drop every /i/ file a re-encode superseded, so /i/ is
  // 1:1 with hashes.json and check-photo-pipeline.ts passes.
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
  // `prev_j.get(st)` is truthy-tested, so a prior entry with no j never warns.
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

/** `-` reads stdin, for the one caller that pipes curl straight in. */
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));
const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const need = (args: string[], name: string): string => { const v = flag(args, name); if (v === undefined) throw new Error(`${name} is required`); return v; };

export function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  switch (cmd) {
    case "length": {
      // Every caller hands this an object file; jaq's `length` on an array is
      // its element count, and that is the one other shape kept.
      const v = readJson(positional[0]);
      const n = Array.isArray(v) ? v.length : Object.keys(v ?? {}).length;
      process.stdout.write(`${n}\n`);
      return 0;
    }
    case "index-merge": {
      const [indexFile] = positional;
      const entries = parseSpool(fs.readFileSync(need(args, "--entries")));
      const index = fs.existsSync(indexFile) ? readJson(indexFile) as Record<string, IndexEntry> : {};
      // Write beside and rename, so a failure part-way leaves the committed file
      // exactly as it was; the shell used the same .tmp then mv shape.
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
      // Insertion order is preserved, as jaq preserves it: this file is not -S.
      for (const [k, v] of Object.entries(record)) (Object.hasOwn(published, k) ? (kept[k] = v) : dropped.push(k));
      fs.writeFileSync(need(args, "--out"), pretty(kept));
      // `keys - ...` in jaq sorts; the dropped list is a notice, so it sorts too.
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
      // jaq -c's shape: compact, one trailing newline. Key order is the map's,
      // which is the order the old literal wrote them in.
      for (const [stem, fields] of Object.entries(record)) fs.writeFileSync(path.join(dir, `${stem}.json`), `${JSON.stringify(projectExifRecord(fields))}\n`);
      return 0;
    }
    case "manifest-keys": {
      // `.photos[]?.full` with -r. The manifest is this site's own
      // (buildImagesManifest), where `full` is the R2 object key, a string.
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
    case "checkpoint-add": {
      const [file] = positional;
      const { rows, entry } = addCheckpoint(readJson(file) as Checkpoint[], need(args, "--slug"), need(args, "--title"), need(args, "--ymd"));
      fs.writeFileSync(file, pyPrettyJson(rows as Json));
      process.stdout.write(`staged: v${entry.vnum} (${entry.ymd}) as ${entry.version}\n        ${entry.title}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: pipeline-json.ts <length|index-merge|prune|unread|meta-split|manifest-keys|uri|hash-tiers|checkpoint-add> ...\n");
      return 2;
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { process.stderr.write(`pipeline-json: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
}
