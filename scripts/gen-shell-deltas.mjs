#!/usr/bin/env node
// gen-shell-deltas.mjs — precompute Dictionary-Compressed Zstandard (dcz) deltas for the
// content-hashed shell, so a returning Chromium visitor downloads the DIFF between the
// shell it already has and the one this deploy ships.
//
//   node scripts/gen-shell-deltas.mjs            # regenerate holding/ad/*.dcz
//   node scripts/gen-shell-deltas.mjs --roll     # ...and adopt this build's shell as a
//                                                # future dictionary (holding/a-dict/)
//
// WHY THIS IS A WORKSTATION SCRIPT AND NOT PART OF build.mjs
//
// Compression with a CUSTOM DICTIONARY is not reachable from Node: zlib exposes level and
// window but no dictionary parameter, so this shells out to the `zstd` CLI (1.5+).
// build.mjs runs inside Workers Builds, where that binary does not exist, so generating
// there would fail the deploy. Instead the .dcb artifacts are committed, exactly like
// holding/i/ thumbnails, and build.mjs only stages and validates them. Same split as the
// photo pipeline: heavy encoders on the workstation, deploy stays pure Node.
//
// WHY dcz AND NOT dcb
//
// Cloudflare passes both through identically on all plans, so this is a pure engineering
// choice, and it comes down to bytes vs decode time. zstd decodes about 2x faster than
// brotli (0.046ms vs 0.094ms on a bare 46KB asset; 954 MB/s vs 471 MB/s) and 26% faster
// on a 1.7MB dictionary corpus.
//
// Brotli is nominally smaller, but on the REAL shipping pair the gap is 1 byte: luna.css
// 78b35410 -> 0f879f03 measured 79 bytes dcb against 80 dcz. The 5-8% brotli edge only
// showed up on much larger source-level deltas. So the size argument costs a byte while
// the decode win is real and grows on slower CPUs, where a mid-range phone decodes several
// times slower than the machine those numbers came from. Bytes are the proxy; latency is
// the goal. (Owner call, 2026-07-27.)
//
// `--patch-from` was measured too and buys nothing at this scale (also 80 bytes), so plain
// `-D` stays: same result, and the output is decodable by any `zstd -D`, which is exactly
// the guarantee the dcz wire format needs.
//
// WHY A COMMITTED DICTIONARY SET RATHER THAN "the previous commit"
//
// The dictionary has to be bytes the BROWSER actually holds, and what it holds is
// whichever /a/ asset it last downloaded — not whatever git says came before. So the
// candidates are tracked explicitly in holding/a-dict/. Reconstructing them from git
// would also break in Workers Builds, which may shallow-clone. Staleness is cheap: a
// dictionary 11 days old still delivered 87-93% (measured), so rolling occasionally is
// entirely sufficient.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const BUILT_SHELL = ".build/holding/a";
const DICT_DIR    = "holding/a-dict";
const DELTA_DIR   = "holding/ad";

// How many past versions of each asset stay eligible as dictionaries. Every extra
// candidate costs one .dcb per asset per deploy and widens the cache-variant fan-out,
// while buying only the visitors who skipped exactly that many deploys. Three is the
// point where the tail stops being worth the bytes.
const KEEP_DICTIONARIES = 3;

// dcz framing, RFC 9842: the dictionary hash rides in a Zstandard SKIPPABLE FRAME ahead of
// the real frame — magic 0x184D2A5E little-endian, then a 4-byte little-endian length (32),
// then the raw SHA-256. That design is why dcz is neater than dcb: the prefix is valid
// zstd, so any conforming decoder skips it instead of needing format-specific handling,
// and `zstd -d -D dict` round-trips the bytes unmodified (verified).
const DCZ_SKIPPABLE_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18]);
const dczHeader = (digest) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(digest.length, 0);        // always 32 for SHA-256
  return Buffer.concat([DCZ_SKIPPABLE_MAGIC, len, digest]);
};

const sha256 = (buf) => createHash("sha256").update(buf).digest();
// The worker has to derive this filename from a request header alone, so the tag must be
// a pure function of the dictionary bytes. 16 hex chars is 64 bits: ample against
// accidental collision across a handful of shell versions, and short enough to read.
const dictTag = (buf) => sha256(buf).toString("hex").slice(0, 16);

// /a/<base>.<hash8>.<ext> — base identifies WHICH asset, so only same-base pairs are
// dictionary candidates (compressing nav.js against luna.css would be worse than useless).
const parseShellName = (name) => {
  const m = name.match(/^(.+)\.([0-9a-f]{8})\.(js|css|svg)$/);
  return m ? { base: m[1], hash8: m[2], ext: m[3], name } : null;
};

function zstdWithDictionary(dictPath, inputPath) {
  // -19 is the top non-ultra level. This is offline, so encode time is free, but --ultra
  // -22 measured identical on real pairs and raises the decoder's window requirement for
  // nothing, so it stays off.
  return execFileSync("zstd", ["-q", "-f", "-19", "-D", dictPath, "-c", inputPath], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
}

function requireZstdCli() {
  try {
    const v = execFileSync("zstd", ["--version"], { encoding: "utf8" }).trim();
    const m = v.match(/v(\d+)\.(\d+)/);
    // Raw-content -D dictionaries need 1.4+; be explicit rather than emit wrong bytes.
    if (m && (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 4))) {
      throw new Error(`zstd ${v} is too old for raw -D dictionaries`);
    }
    return v;
  } catch (e) {
    console.error("gen-shell-deltas: needs the `zstd` CLI (brew install zstd).");
    console.error(`  ${e.message}`);
    process.exit(1);
  }
}

const roll = process.argv.includes("--roll");
const version = requireZstdCli();

if (!existsSync(BUILT_SHELL)) {
  console.error(`gen-shell-deltas: ${BUILT_SHELL} is missing. Run \`node build.mjs\` first —`);
  console.error("  the /a/ hashes come from the MINIFIED bytes, so the built tree is the only");
  console.error("  place the real dictionary and target bytes exist.");
  process.exit(1);
}

await mkdir(DICT_DIR, { recursive: true });
// Deltas are a pure function of (shell, dictionary set). Rebuilding from scratch keeps
// stale .dcb files for retired hashes from accumulating forever in git.
await rm(DELTA_DIR, { recursive: true, force: true });
await mkdir(DELTA_DIR, { recursive: true });

const shell = (await readdir(BUILT_SHELL)).map(parseShellName).filter(Boolean);
const dicts = (await readdir(DICT_DIR)).map(parseShellName).filter(Boolean);

if (!shell.length) {
  console.error(`gen-shell-deltas: no /a/<name>.<hash8>.<ext> assets in ${BUILT_SHELL}`);
  process.exit(1);
}

console.log(`gen-shell-deltas: ${version}, ${shell.length} shell assets, ${dicts.length} dictionary candidates`);

let written = 0, totalDelta = 0, totalPlain = 0;
const summary = [];

for (const asset of shell) {
  const targetPath = `${BUILT_SHELL}/${asset.name}`;
  const targetBytes = await readFile(targetPath);
  // The honest comparison for "was the delta worth it" is against the SAME encoder with
  // no dictionary, not against whatever the edge would have produced.
  const plain = execFileSync("zstd", ["-q", "-f", "-19", "-c", targetPath], {
    maxBuffer: 64 * 1024 * 1024, encoding: "buffer",
  });

  for (const dict of dicts) {
    if (dict.base !== asset.base || dict.ext !== asset.ext) continue;
    const dictPath = `${DICT_DIR}/${dict.name}`;
    const dictBytes = await readFile(dictPath);

    // A browser holding the identical bytes we are about to ship would never request a
    // new URL for them, so this pair can only produce a delta nobody can ask for.
    if (dictBytes.equals(targetBytes)) continue;

    const stream = zstdWithDictionary(dictPath, targetPath);
    const out = Buffer.concat([dczHeader(sha256(dictBytes)), stream]);

    // Refuse to ship a delta that lost to plain zstd. Happens when a rewrite leaves almost
    // nothing in common, and in that case the plain .br twin is the better answer.
    if (out.length >= plain.length) {
      summary.push(`  skip  ${asset.name} vs ${dict.hash8}: dcz ${out.length} >= zstd ${plain.length}`);
      continue;
    }

    const name = `${asset.base}.${asset.hash8}.${dictTag(dictBytes)}.dcz`;
    await writeFile(`${DELTA_DIR}/${name}`, out);
    written++; totalDelta += out.length; totalPlain += plain.length;
    const pct = (100 * (plain.length - out.length) / plain.length).toFixed(1);
    summary.push(`  dcz   ${name}  ${out.length} bytes vs ${plain.length} plain zstd  (-${pct}%)`);
  }
}

for (const line of summary) console.log(line);

if (!written) {
  console.log("\ngen-shell-deltas: no deltas written.");
  console.log("  Expected on a FIRST run, or when the shell has not changed since the last roll:");
  console.log("  every dictionary candidate is byte-identical to what is shipping, and a browser");
  console.log("  never re-requests an unchanged content-hashed URL. Deltas appear on the next");
  console.log("  deploy that actually changes nav.js / luna.css / lens.js / icons.svg.");
} else {
  const pct = (100 * (totalPlain - totalDelta) / totalPlain).toFixed(1);
  console.log(`\ngen-shell-deltas: ${written} deltas, ${totalDelta} bytes vs ${totalPlain} plain zstd (-${pct}%)`);
}

if (roll) {
  // Adopt this build's shell as a dictionary for future deploys, then prune. Pruning is
  // per-base so a rarely-changing asset (icons.svg) keeps its history instead of being
  // evicted by a churny neighbour (nav.js).
  let adopted = 0;
  for (const asset of shell) {
    const dest = `${DICT_DIR}/${asset.name}`;
    if (existsSync(dest)) continue;
    await writeFile(dest, await readFile(`${BUILT_SHELL}/${asset.name}`));
    adopted++;
  }
  const after = (await readdir(DICT_DIR)).map(parseShellName).filter(Boolean);
  const byBase = new Map();
  for (const d of after) {
    if (!byBase.has(d.base)) byBase.set(d.base, []);
    byBase.get(d.base).push(d);
  }
  let pruned = 0;
  for (const [, group] of byBase) {
    if (group.length <= KEEP_DICTIONARIES) continue;
    // mtime order is the only signal available for "which shipped more recently"; a
    // content hash carries no ordering. Oldest files go first.
    const stats = await Promise.all(
      group.map(async (g) => ({ g, t: (await stat(`${DICT_DIR}/${g.name}`)).mtimeMs })),
    );
    stats.sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, stats.length - KEEP_DICTIONARIES)) {
      await rm(`${DICT_DIR}/${s.g.name}`, { force: true });
      pruned++;
    }
  }
  console.log(`gen-shell-deltas: --roll adopted ${adopted}, pruned ${pruned}, keeping ${KEEP_DICTIONARIES} per asset`);
  console.log("  Commit holding/a-dict/ AND holding/ad/ together: a delta names its dictionary");
  console.log("  by hash, so shipping one without the other just means no client ever matches.");
}
