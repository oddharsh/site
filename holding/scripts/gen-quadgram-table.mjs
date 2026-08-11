#!/usr/bin/env node
// Build the compact English quadgram table the /lwe/vigenere solver demo scores
// candidate decrypts against.
//
// WHY THIS SHAPE. The demo hill-climbs a key against an n-gram model, which is
// the one part of a Vigenere solver that needs DATA rather than code. A full
// model is 46,040 quadgrams with counts, 83.1 KB brotli, which is bigger than
// nav.js and luna.css put together for a demo nobody has clicked yet.
//
// Two cuts, both measured (2026-08-11) against the ported solver:
//
//   1. RANK ORDER ONLY, no counts. The scorer needs a monotone log-probability,
//      not the true one, so a Zipf curve over the rank reproduces the real
//      table's verdict on every test case. Counts are ~60% of the bytes.
//   2. TOP 4,000. Solves a 200-letter text under a 10-letter key, a 150-letter
//      text under a 7-letter key, and a 61-letter text under a 6-letter key.
//      It MISSES a 61-letter text under a 10-letter key, which the full table
//      gets; that case is 6 letters per column, and the demo says so out loud
//      rather than hiding it. Losing that case is what buys 7.9 KB over 83.1.
//
// Source table: buttcrack (github.com/0xdiid/buttcrack, MIT, Copyright 2026
// diid), src/buttcrack/data/english_quadgrams.txt, itself the standard
// practicalcryptography.com English quadgram counts.
//
// Usage: node holding/scripts/gen-quadgram-table.mjs <path-to-english_quadgrams.txt>

import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const KEEP = 4000;
const OUT = new URL("../lwe/quadgrams.txt", import.meta.url);

const src = process.argv[2];
if (!src) {
  console.error("usage: gen-quadgram-table.mjs <english_quadgrams.txt>");
  process.exit(1);
}

const rows = readFileSync(src, "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const [gram, count] = line.split(/\s+/);
    return [gram.toUpperCase(), Number(count)];
  })
  .filter(([gram, count]) => /^[A-Z]{4}$/.test(gram) && count > 0)
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

if (rows.length < KEEP) {
  throw new Error(`source has ${rows.length} quadgrams, need at least ${KEEP}`);
}

const total = rows.reduce((sum, [, count]) => sum + count, 0);
const kept = rows.slice(0, KEEP);
const table = kept.map(([gram]) => gram).join("");

// The solver derives every score from a gram's RANK, so the one number it needs
// from the real counts is where the curve starts: log10 of the top quadgram's
// share of the corpus. Printed here so the constant in the page can cite it.
const top = Math.log10(kept[0][1] / total);
const floor = Math.log10(0.01 / total);

writeFileSync(OUT, table);

const wire = brotliCompressSync(Buffer.from(table), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}).length;

console.log(`${KEEP} quadgrams -> ${OUT.pathname}`);
console.log(`  raw ${table.length} B, brotli q11 ${(wire / 1024).toFixed(1)} KB`);
console.log(`  TOP  = ${top.toFixed(4)}  (log10 share of "${kept[0][0]}", the most common quadgram)`);
console.log(`  FLOOR= ${floor.toFixed(4)}  (an unseen quadgram, rarer than the rarest observed)`);
console.log(`  coverage: ${((kept.reduce((s, [, c]) => s + c, 0) / total) * 100).toFixed(1)}% of corpus quadgram mass`);
