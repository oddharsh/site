#!/usr/bin/env node
// gen-shell-deltas.mjs — precompute Dictionary-Compressed Brotli (dcb) deltas for the
// content-hashed shell, so a returning Chromium visitor downloads the DIFF between the
// shell it already has and the one this deploy ships.
//
//   node scripts/gen-shell-deltas.mjs            # regenerate holding/ad/*.dcb
//   node scripts/gen-shell-deltas.mjs --roll     # ...and adopt this build's shell as a
//                                                # future dictionary (holding/a-dict/)
//
// WHY THIS IS A WORKSTATION SCRIPT AND NOT PART OF build.mjs
//
// Brotli with a CUSTOM DICTIONARY is not reachable from Node: zlib exposes quality and
// window but no dictionary parameter, so this shells out to the `brotli` CLI (1.2.0+).
// build.mjs runs inside Workers Builds, where that binary does not exist, so generating
// there would fail the deploy. Instead the .dcb artifacts are committed, exactly like
// holding/i/ thumbnails, and build.mjs only stages and validates them. Same split as the
// photo pipeline: heavy encoders on the workstation, deploy stays pure Node.
//
// WHY dcb AND NOT dcz
//
// Cloudflare passes both through identically on all plans, so it is purely a quality
// question, and brotli won every measurement (2026-07-26, real deploy-to-deploy deltas):
// nav.js 1,466 vs 1,537, luna.css 489 vs 533, tooltip.js 2,085 vs 2,223. 5-8% better.
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

// dcb framing, RFC 9842 §3: a 4-byte magic then the raw SHA-256 of the dictionary, then
// a brotli stream compressed against it. The hash is what lets a client (and Cloudflare's
// cache) prove the delta is being applied to the dictionary it was built from.
const DCB_MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);

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

function brotliWithDictionary(dictPath, inputPath) {
  // -q 11 for maximum ratio (this is offline, so encode time is free) and -w 24, the
  // largest window a `Content-Encoding` response may legally use per RFC 7932 §4.
  return execFileSync("brotli", ["-q", "11", "-w", "24", "-D", dictPath, "-c", inputPath], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
}

function requireBrotliCli() {
  try {
    const v = execFileSync("brotli", ["--version"], { encoding: "utf8" }).trim();
    const m = v.match(/(\d+)\.(\d+)/);
    // -D landed well before 1.1, but be explicit rather than emit silently-wrong bytes.
    if (m && Number(m[1]) < 1) throw new Error(`brotli ${v} is too old for -D`);
    return v;
  } catch (e) {
    console.error("gen-shell-deltas: needs the `brotli` CLI (brew install brotli).");
    console.error(`  ${e.message}`);
    process.exit(1);
  }
}

const roll = process.argv.includes("--roll");
const version = requireBrotliCli();

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
  const plain = execFileSync("brotli", ["-q", "11", "-w", "24", "-c", targetPath], {
    maxBuffer: 64 * 1024 * 1024, encoding: "buffer",
  });

  for (const dict of dicts) {
    if (dict.base !== asset.base || dict.ext !== asset.ext) continue;
    const dictPath = `${DICT_DIR}/${dict.name}`;
    const dictBytes = await readFile(dictPath);

    // A browser holding the identical bytes we are about to ship would never request a
    // new URL for them, so this pair can only produce a delta nobody can ask for.
    if (dictBytes.equals(targetBytes)) continue;

    const stream = brotliWithDictionary(dictPath, targetPath);
    const out = Buffer.concat([DCB_MAGIC, sha256(dictBytes), stream]);

    // Refuse to ship a delta that lost to plain brotli. Happens when a rewrite leaves
    // almost nothing in common, and in that case the plain .br twin is the better answer.
    if (out.length >= plain.length) {
      summary.push(`  skip  ${asset.name} vs ${dict.hash8}: dcb ${out.length} >= br ${plain.length}`);
      continue;
    }

    const name = `${asset.base}.${asset.hash8}.${dictTag(dictBytes)}.dcb`;
    await writeFile(`${DELTA_DIR}/${name}`, out);
    written++; totalDelta += out.length; totalPlain += plain.length;
    const pct = (100 * (plain.length - out.length) / plain.length).toFixed(1);
    summary.push(`  dcb   ${name}  ${out.length} bytes vs ${plain.length} plain br  (-${pct}%)`);
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
  console.log(`\ngen-shell-deltas: ${written} deltas, ${totalDelta} bytes vs ${totalPlain} plain brotli (-${pct}%)`);
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
