#!/usr/bin/env node
// node tools/runtime-dcz-probe.ts [--json]
//
// Which registered pages does production still serve WITHOUT a shared-dictionary
// delta, and what would a delta computed at request time have cost for each?
// /garage/dictionary prints these numbers; this is the file that produces them.
//
// For every surface in config/site-manifest.json it asks production for the page
// the way a returning Chromium visitor does: `Sec-Fetch-Dest: document` plus an
// `Available-Dictionary` naming the live family dictionary (read off the
// homepage's `rel="compression-dictionary"` Link). A page answering `dcz` already
// has a build-time delta. A page answering `br` is one the Worker renders per
// request, and for those it compresses the decoded HTML against the same
// dictionary at zstd levels 3, 6 and 19, checks every frame round-trips, adds the
// 40-byte dcz header (magic, length, SHA-256), and times the call.
//
// WHY UNDER NODE. The timing is node:zlib's `zstdCompressSync`, the exact call a
// Worker would make, and workerd drops its `dictionary` option until
// cloudflare/workerd#7106 ships (tools/workerd-zstd-probe.ts watches for that).
// So these are node's numbers on whatever machine runs this, standing in for
// workerd's; say which machine when quoting them. Bun's zstd timings would be a
// different instrument.
//
// It reads production and writes nothing. curl rather than fetch because a dcz
// body has to arrive undecoded, and fetch decodes what it recognises.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ORIGIN = "https://aadhar.sh";
const LEVELS = [3, 6, 19];
const DCZ_HEADER_BYTES = 40;

interface Reply { status: number; encoding: string; type: string; cacheControl: string; body: Buffer }
// One page the Worker renders: its size, the brotli it ships, and per level the
// dcz frame size (`dcz3`) and the median milliseconds to make it (`ms3`).
type Row = { path: string; cacheControl: string; raw: number; liveBr: number } & Record<string, number | string>;

function curl(path: string, headers: string[]): Reply {
  const args = ["-s", "-D", "/dev/stderr", "-o", "-", "-A", "Mozilla/5.0 (Macintosh) Chrome/140 runtime-dcz-probe"];
  for (const h of headers) args.push("-H", h);
  const r = spawnSync("curl", [...args, ORIGIN + path], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`curl ${path} exited ${r.status}`);
  // An Early Hints 103 block precedes the real response, so read the LAST block.
  const blocks = r.stderr.toString().split(/\r?\n\r?\n/).filter((b) => b.startsWith("HTTP/"));
  const head = blocks[blocks.length - 1] ?? "";
  const field = (name: string) => head.match(new RegExp(`^${name}: *(.*)$`, "mi"))?.[1]?.trim() ?? "";
  return {
    status: Number(head.match(/^HTTP\/\S+ (\d+)/)?.[1] ?? 0),
    encoding: field("content-encoding") || "identity",
    type: field("content-type"),
    cacheControl: field("cache-control"),
    body: r.stdout,
  };
}

function medianMs(fn: () => void, runs = 25): number {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  t.sort((a, b) => a - b);
  return Number(t[runs >> 1].toFixed(3));
}

const manifest = JSON.parse(readFileSync(new URL("../config/site-manifest.json", import.meta.url), "utf8"));
const home = spawnSync("curl", ["-sI", ORIGIN + "/"]).stdout.toString();
const dictPath = home.match(/<(\/a\/page-family\.[0-9a-f]+\.dict)>; rel="compression-dictionary"/)?.[1];
if (!dictPath) throw new Error("the homepage names no family dictionary");
const dict = curl(dictPath, []).body;
const available = `Available-Dictionary: :${createHash("sha256").update(dict).digest("base64")}:`;
const asDocument = ["Sec-Fetch-Dest: document", "Accept: text/html"];

const delta: string[] = [];
const rows: Row[] = [];
for (const { path } of manifest.surfaces as { path: string }[]) {
  const live = curl(path, [...asDocument, "Accept-Encoding: br, zstd, dcz", available]);
  if (live.status !== 200 || !live.type.startsWith("text/html")) continue;
  if (live.encoding === "dcz") { delta.push(path); continue; }
  const plain = curl(path, [...asDocument, "Accept-Encoding: br"]);
  const html = plain.encoding === "br" ? brotliDecompressSync(plain.body) : plain.body;
  const row: Row = { path, cacheControl: live.cacheControl, raw: html.length, liveBr: live.body.length };
  for (const level of LEVELS) {
    const opts = { dictionary: dict, params: { [constants.ZSTD_c_compressionLevel]: level } };
    const frame = zstdCompressSync(html, opts);
    if (!zstdDecompressSync(frame, { dictionary: dict }).equals(html)) throw new Error(`${path}: level ${level} did not round-trip`);
    row[`dcz${level}`] = frame.length + DCZ_HEADER_BYTES;
    row[`ms${level}`] = medianMs(() => zstdCompressSync(html, opts));
  }
  row.msNoDictionary6 = medianMs(() => zstdCompressSync(html, { params: { [constants.ZSTD_c_compressionLevel]: 6 } }));
  rows.push(row);
}

const result = { when: new Date().toISOString(), node: process.version, zstd: process.versions.zstd, dictionary: dictPath, dictionaryBytes: dict.length, delta, rows };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result));
} else {
  const num = (r: Row, k: string) => Number(r[k]);
  const sum = (k: string) => rows.reduce((a, r) => a + num(r, k), 0);
  const live = sum("liveBr");
  console.log(`${result.when}  node ${result.node}  zstd ${result.zstd}  ${dictPath} (${dict.length} B)`);
  console.log(`${delta.length} pages already answer dcz; ${rows.length} answer br`);
  for (const r of rows) {
    console.log(`  ${r.path.padEnd(16)} ${String(r.raw).padStart(7)} raw ${String(r.liveBr).padStart(6)} br ${String(num(r, "dcz6")).padStart(6)} dcz6  ${num(r, "ms6")} ms`);
  }
  for (const level of LEVELS) {
    const times = rows.map((r) => num(r, `ms${level}`)).sort((a, b) => a - b);
    const saved = (100 * (1 - sum(`dcz${level}`) / live)).toFixed(1);
    console.log(`level ${level}: ${live} -> ${sum(`dcz${level}`)} B (${saved}% off), median ${times[times.length >> 1]} ms, max ${times[times.length - 1]} ms`);
  }
}
