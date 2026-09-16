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
    default:
      process.stderr.write("usage: pipeline-json.ts <length|index-merge|prune|unread|manifest-keys|uri> ...\n");
      return 2;
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { process.stderr.write(`pipeline-json: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
}
