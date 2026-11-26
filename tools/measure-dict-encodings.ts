#!/usr/bin/env bun
// Measures dcb (brotli + raw dictionary) against dcz (zstd + raw dictionary) and
// writes the one record every copy of the result derives from:
//
//   bun tools/measure-dict-encodings.ts
//
// writes src/worker/dict-measured.json and the figures table on
// /garage/compression (between its markers). The prose and quiz on that page
// carry an argument, so they stay hand-written; contract-dict-measured-matches-
// the-page fails until they quote the new figures.
//
// Workstation only: decode timing is this machine's, and the C benchmark links
// Homebrew's libbrotlidec and libzstd (`brew install brotli zstd pkg-config`).
//
// Corpus: every consecutive pair of versions in src/dict/a-dict and p-dict,
// ordered by the commit that first added each file (ties by name), with the
// older version as the raw dictionary for the newer. Encoders are the build's
// own: node:zlib brotli at compressQ11's params plus the dictionary, and zstd at
// DCZ_ZSTD_LEVEL plus the same dictionary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrotliOptions } from "node:zlib";
import { brotliCompressSync, brotliDecompressSync, zstdCompressSync, constants as zlib } from "node:zlib";
import { DCZ_ZSTD_LEVEL } from "../src/worker/lib/dictionary-names.ts";
import { TABLE_END, TABLE_START, dictFacts, parseDictMeasured, renderDictTable } from "../src/worker/dict-measured.ts";

const ROOT = join(import.meta.dir, "..");
const RECORD = join(ROOT, "src/worker/dict-measured.json");
const PAGE = join(ROOT, "src/pages/garage/compression.html");
const DIRS = ["src/dict/a-dict", "src/dict/p-dict"] as const;
// RFC 9842 framing: dcb is 4 B of magic and a 32 B SHA-256, dcz 8 B and 32 B.
const DCB_HEADER_BYTES = 36;
const DCZ_HEADER_BYTES = 40;
// A version pair cap, so a dictionary history that grows by thousands can't
// turn one run into an afternoon. Hitting it is an error, not a silent sample.
const PAIRS_MAX = 5000;
// Odd, so the median is one run's own pair of means rather than a blend.
const DECODE_RUNS = 5;

function firstAdded(): Map<string, number> {
  const log = execFileSync("git", ["log", "--no-renames", "--diff-filter=A", "--format=@%ct", "--name-only", "--", ...DIRS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const added = new Map<string, number>();
  let time = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("@")) time = Number(line.slice(1));
    else if (line !== "") added.set(line, Math.min(added.get(line) ?? Infinity, time));
  }
  return added;
}

// a-dict/nav.024dbefa.js -> shell nav.js; p-dict/about.0296adcd52e5523d.html.br -> page about
function family(dir: string, name: string): { key: string; page: boolean } {
  const parts = name.split(".");
  return dir.endsWith("p-dict") ? { key: `page ${parts[0]}`, page: true } : { key: `${parts[0]}.${parts.at(-1)}`, page: false };
}

const read = (path: string): Buffer => (path.endsWith(".br") ? brotliDecompressSync(readFileSync(path)) : readFileSync(path));

function buildDecodeBench(out: string): string {
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "libbrotlidec", "libzstd"], { encoding: "utf8" }).trim().split(/\s+/);
  const binary = join(out, "dict-decode");
  execFileSync("clang", ["-O2", "-DNDEBUG", "-o", binary, join(ROOT, "tools/bench/dict-decode.c"), ...flags], { stdio: "inherit" });
  return binary;
}

function main(): void {
  const added = firstAdded();
  const families = new Map<string, { page: boolean; paths: string[] }>();
  for (const dir of DIRS) {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (!added.has(rel)) throw new Error(`${rel} has no add commit; commit it before measuring`);
      const { key, page } = family(dir, name);
      const entry = families.get(key) ?? families.set(key, { page, paths: [] }).get(key)!;
      entry.paths.push(rel);
    }
  }

  const work = mkdtempSync(join(tmpdir(), "dict-measure-"));
  try {
    const ids: string[] = [];
    const meta = new Map<string, { page: boolean; file: string; raw: number; dcb: number; dcz: number }>();
    for (const [key, { page, paths }] of families) {
      paths.sort((a, b) => added.get(a)! - added.get(b)! || a.localeCompare(b));
      for (let i = 1; i < paths.length; i++) {
        const dictionary = read(join(ROOT, paths[i - 1]));
        const raw = read(join(ROOT, paths[i]));
        if (dictionary.equals(raw)) continue;
        if (ids.length >= PAIRS_MAX) throw new Error(`more than ${PAIRS_MAX} pairs; raise PAIRS_MAX on purpose`);
        // Node 26 and Bun take a brotli `dictionary`; @types/node doesn't
        // declare it yet, so the option rides on a widened type, not a cast.
        const brotliOptions: BrotliOptions & { dictionary: Buffer } = {
          dictionary,
          params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_LGWIN]: 24, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length },
        };
        const dcb = brotliCompressSync(raw, brotliOptions);
        const dcz = zstdCompressSync(raw, { dictionary, params: { [zlib.ZSTD_c_compressionLevel]: DCZ_ZSTD_LEVEL } });
        const id = String(ids.length).padStart(5, "0");
        ids.push(id);
        writeFileSync(join(work, `${id}.raw`), raw);
        writeFileSync(join(work, `${id}.dict`), dictionary);
        writeFileSync(join(work, `${id}.dcb`), dcb);
        writeFileSync(join(work, `${id}.dcz`), dcz);
        meta.set(id, { page, file: page ? key.slice(5) : key, raw: raw.length, dcb: dcb.length + DCB_HEADER_BYTES, dcz: dcz.length + DCZ_HEADER_BYTES });
      }
    }

    const bench = buildDecodeBench(work);
    // Two back-to-back runs on 2026-11-26 agreed on the ratio (2.0x, 2.1x) and
    // disagreed 2x on absolute time (dcb 18.5 us, then 9.3 us), which moved the
    // break-even from 47 to 92 Mbps. So the record keeps every run's means and
    // quotes the median run. Batches keep argv under the OS limit; the benchmark
    // checks every rebuild before timing it.
    const runs: { dcbUs: number; dczUs: number }[] = [];
    for (let run = 0; run < DECODE_RUNS; run++) {
      let dcbUs = 0;
      let dczUs = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const rows = execFileSync(bench, [work, ...ids.slice(i, i + 200)], { encoding: "utf8" })
          .trim()
          .split("\n");
        for (const row of rows) {
          const [, , dcb, dcz] = row.split("\t");
          dcbUs += Number(dcb);
          dczUs += Number(dcz);
        }
      }
      runs.push({ dcbUs: Number((dcbUs / ids.length).toFixed(2)), dczUs: Number((dczUs / ids.length).toFixed(2)) });
    }
    const median = [...runs].sort((a, b) => a.dcbUs - b.dcbUs)[Math.floor(DECODE_RUNS / 2)];

    const all = [...meta.values()];
    const widest = all.reduce((best, m) => (m.dcz - m.dcb > best.dcz - best.dcb ? m : best));
    const version = (lib: string) => execFileSync("pkg-config", ["--modversion", lib], { encoding: "utf8" }).trim();
    const record = {
      $comment: "Written by tools/measure-dict-encodings.ts; edit the tool, not this file. src/worker/dict-measured.ts reads it.",
      measured: new Date().toISOString().slice(0, 10),
      machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${process.platform}`,
      decoders: { brotli: version("libbrotlidec"), zstd: version("libzstd") },
      pairs: {
        total: all.length,
        shell: all.filter((m) => !m.page).length,
        pages: all.filter((m) => m.page).length,
        rawBytes: all.reduce((s, m) => s + m.raw, 0),
      },
      size: {
        dcbBytes: all.reduce((s, m) => s + m.dcb, 0),
        dczBytes: all.reduce((s, m) => s + m.dcz, 0),
        dcbSmallerOn: all.filter((m) => m.dcb < m.dcz).length,
        widest: { file: widest.file, dcbBytes: widest.dcb, dczBytes: widest.dcz },
      },
      decode: { dcbUs: median.dcbUs, dczUs: median.dczUs, runs },
      // Assumptions, not measurements: the site's planning link speed (memory:
      // perf-assume-50-mbps) and an unmeasured phone that decodes 3x slower.
      assumed: { linkMbps: 50, phoneDecodeSlowdown: 3 },
    };
    const facts = dictFacts(parseDictMeasured(record));
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);

    const page = readFileSync(PAGE, "utf8");
    const start = page.indexOf(TABLE_START);
    const end = page.indexOf(TABLE_END);
    if (start < 0 || end < start) throw new Error(`${PAGE} lost its dict-measured table markers`);
    writeFileSync(PAGE, `${page.slice(0, start + TABLE_START.length)}\n${renderDictTable(facts)}\n        ${page.slice(end)}`);

    console.log(
      `dict-measured: ${record.pairs.total} pairs, dcb ${facts.dcbSmaller} smaller, decode ${facts.decodeRatio} (${facts.dcbUs} vs ${facts.dczUs}), break-even ${facts.breakEvenMbps}`,
    );
    console.log(
      "dict-measured: wrote the record and the page table; now update the page's prose and quiz until contract-dict-measured-matches-the-page passes",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
