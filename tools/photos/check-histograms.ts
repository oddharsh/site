#!/usr/bin/env node

// Does the committed public/images/histograms.json reproduce from the committed
// JPG tiers, with the zenc this tree builds?
//
//   bun run histograms:check                 build zenc --locked, bake, compare
//   bun run histograms:check -- --zenc PATH  bake with a binary you already built
//
// Exit 0 reproduces, 1 the committed file differs (a finding), 2 the instrument.
//
// WHY THIS EXISTS. derive:check pinned this artifact to a hash of its inputs, and
// three of those inputs were zenc's histogram.rs, pixels.rs and Cargo.lock. Every
// zenc dependency bump therefore read as STALE, and each one was cleared by hand:
// build zenc on both lockfiles, bake 258 photos twice, diff, run a control, then
// `--lock` (#871 for cc 1.4.7, again for cc 1.5.1 on #985, both 258 of 258
// identical). A hash of the lockfile can only say the output MIGHT have moved.
// This answers whether it did, and it can, because every input the bake reads is
// committed: hashes.json names each stem's JPG tier and public/i holds it. The
// tool inputs left the digest in config/derivations.json when this landed, and
// CI's native photo validation job runs this instead. public/i stays in the
// digest, so a re-encode that skips the bake still fails on a machine with no
// cargo (gotcha 46).
//
// It WRITES NOTHING IN THE TREE. The bake lands in a temp root whose i/ is a
// symlink to public/i (zenc only reads it) and whose images/ is a real folder
// holding a copy of hashes.json, so the meta files are written there rather than
// into the pipeline's local public/images/meta.
//
// It builds zenc on every run by default rather than reusing whatever binary sits
// in target/release. extract-photo-metadata.sh builds only when that binary is
// MISSING, so a binary from an older lockfile would answer for a newer one and
// agree with itself. cargo's rebuild is a no-op when nothing moved.

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHistogramIndex } from "./build-histogram-index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");
const COMMITTED = path.join(PUBLIC, "images/histograms.json");
const ZENC_MANIFEST = path.join(ROOT, "tools/photos/zenc/Cargo.toml");
const ZENC_BUILT = path.join(ROOT, "tools/photos/zenc/target/release/zenc");

// 258 photos today. A third below catches a collapse (an empty hashes.json, a
// bake that skipped everything) without turning a deliberate cull into a red run.
const FLOOR = 150;

export type Index = Record<string, string>;
export type Comparison = { same: number; changed: string[]; missing: string[]; extra: string[] };

/** Stem-by-stem, both directions. `missing` is committed but not baked. */
export function compareIndexes(committed: Index, baked: Index): Comparison {
  const out: Comparison = { same: 0, changed: [], missing: [], extra: [] };
  for (const stem of Object.keys(committed).sort()) {
    if (!(stem in baked)) out.missing.push(stem);
    else if (baked[stem] === committed[stem]) out.same++;
    else out.changed.push(stem);
  }
  for (const stem of Object.keys(baked).sort()) if (!(stem in committed)) out.extra.push(stem);
  return out;
}

export const reproduces = (c: Comparison): boolean => !c.changed.length && !c.missing.length && !c.extra.length;

/**
 * The control: move ONE bin of ONE photo by one level, and the comparison has to
 * name exactly that stem. A comparator that cannot see this is what a pass over
 * two empty indexes, or two copies of one file, would look like.
 */
export function controlCatchesOneBin(committed: Index): boolean {
  const stem = Object.keys(committed).sort()[0];
  if (!stem) return false;
  const s = committed[stem];
  const c = s.charCodeAt(5);
  const nudged = s.slice(0, 5) + String.fromCharCode(c === 126 ? 125 : c + 1) + s.slice(6);
  const r = compareIndexes(committed, { ...committed, [stem]: nudged });
  return r.changed.length === 1 && r.changed[0] === stem && r.same === Object.keys(committed).length - 1;
}

function die(msg: string): never {
  console.error(`histograms: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--zenc");
  let zenc = ZENC_BUILT;
  if (at !== -1) {
    zenc = path.resolve(args[at + 1] ?? die("--zenc needs a path"));
  } else {
    const built = spawnSync("cargo", ["build", "--release", "--locked", "--quiet", "--manifest-path", ZENC_MANIFEST], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (built.status !== 0) die(`cargo build exited ${built.status ?? built.signal}; zenc needs cargo and libavif (see config/tools.json)`);
  }

  const version = spawnSync(zenc, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) die(`cannot run ${zenc}`);

  const committed: Index = JSON.parse(await readFile(COMMITTED, "utf8"));
  const count = Object.keys(committed).length;
  if (count < FLOOR) die(`the committed index holds ${count} photos, under the floor of ${FLOOR}`);
  if (!controlCatchesOneBin(committed)) die("the control failed: a one-bin change went unseen, so a pass would mean nothing");

  const scratch = await mkdtemp(path.join(tmpdir(), "histograms-check-"));
  try {
    await mkdir(path.join(scratch, "images"));
    await copyFile(path.join(PUBLIC, "images/hashes.json"), path.join(scratch, "images/hashes.json"));
    await symlink(path.join(PUBLIC, "i"), path.join(scratch, "i"));

    const bake = spawnSync(zenc, ["histogram", "--root", scratch], { encoding: "utf8" });
    if (bake.status !== 0) die(`zenc histogram exited ${bake.status}:\n${bake.stderr.trim()}`);

    const { index: baked } = await buildHistogramIndex(path.join(scratch, "images/meta"));
    const r = compareIndexes(committed, baked as Index);
    const who = version.stdout.trim();

    if (reproduces(r)) {
      console.log(`histograms: reproduces ${r.same} of ${count} from public/i with ${who} (control: a one-bin change is caught)`);
      return;
    }
    console.error(`histograms: the committed file does NOT reproduce with ${who}`);
    for (const [label, stems] of [["changed", r.changed], ["committed, not baked", r.missing], ["baked, not committed", r.extra]] as const) {
      if (stems.length) console.error(`  ${label} (${stems.length}): ${stems.join(", ")}`);
    }
    console.error(
      [
        "",
        "The bars a visitor sees would move. If the change is intended (a decoder bump,",
        "an edit to histogram.rs), re-bake and review the diff before committing:",
        "  tools/photos/zenc/target/release/zenc histogram --root public",
        "  bun tools/photos/build-histogram-index.ts",
      ].join("\n"),
    );
    process.exit(1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
