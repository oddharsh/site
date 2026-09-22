// zenc:bench claims to time the command add-photos.sh runs on every photo. That
// claim rots silently: somebody changes a tier or the JPEG quality in the shell
// script, the bench keeps timing the old command, and every speedup it reports
// is about bytes nobody ships. So the two are parsed into one shape and compared.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ALPHA, classify, geomean, mannWhitneyP, median, OUTPUT_FILES, pickCorpus, productionArgs, spread } from "./photos/zenc-bench.ts";

/** @typedef {{ size: string, outputs: string[] }} Tier */
/** @typedef {{ orient: string | null, filter: string | null, quality: string | null, tiers: Tier[] }} Invocation */

/** @type {Record<string, string>} */
const OUTPUT_FLAGS = { "--avif-out": "avif", "--jpeg-out": "jpeg", "--out": "png" };

// `zenc square` argv into its meaning. Tier outputs are sorted, since flag order
// inside a tier means nothing to zenc.
/** @param {string[]} tokens @returns {Invocation} */
function parseSquareArgs(tokens) {
  /** @type {Invocation} */
  const invocation = { orient: null, filter: null, quality: null, tiers: [] };
  for (let i = 0; i < tokens.length; i++) {
    const [flag, value] = [tokens[i], tokens[i + 1]];
    if (!flag.startsWith("--")) continue; // the input path
    i++;
    if (flag === "--orient") invocation.orient = value;
    else if (flag === "--filter") invocation.filter = value;
    else if (flag === "--jpeg-quality") invocation.quality = value;
    else if (flag === "--size") invocation.tiers.push({ size: value, outputs: [] });
    else {
      const kind = OUTPUT_FLAGS[flag];
      if (!kind) throw new Error(`unknown zenc square flag ${flag}`);
      const tier = invocation.tiers.at(-1);
      assert.ok(tier, `${flag} arrives before any --size`);
      tier.outputs.push(kind);
    }
  }
  for (const t of invocation.tiers) t.outputs.sort();
  return invocation;
}

// add-photos.sh's `"$ZENC" square ...` call with its defaults substituted.
/** @param {string} sh */
function addPhotosInvocation(sh) {
  const call = sh.match(/"\$ZENC" square ([\s\S]*?)>\/dev\/null/);
  assert.ok(call, "add-photos.sh no longer carries a `\"$ZENC\" square` call");
  /** @type {Record<string, string | undefined>} */
  const vars = {
    SQ: sh.match(/^SQ="\$\{SQ:-(\d+)\}"/m)?.[1],
    SQ_SM: sh.match(/^SQ_SM="\$\{SQ_SM:-(\d+)\}"/m)?.[1],
    SQ_XS: sh.match(/^SQ_XS="\$\{SQ_XS:-(\d+)\}"/m)?.[1],
    ZENC_Q: sh.match(/^ZENC_Q=(\d+)/m)?.[1],
  };
  for (const [k, v] of Object.entries(vars)) assert.ok(v, `add-photos.sh no longer defaults ${k}`);
  const tokens = call[1].replace(/\\\n/g, " ").split(/\s+/).filter(Boolean).map((t) => {
    const bare = t.replace(/^"|"$/g, "");
    const name = bare.match(/^\$(\w+)$/)?.[1];
    return (name && vars[name]) || bare;
  });
  const invocation = parseSquareArgs(tokens);
  invocation.orient = invocation.orient && "ORIENT";
  return invocation;
}

const benchInvocation = () => parseSquareArgs(productionArgs("IN", "ORIENT", "/d").slice(1));

test("zenc:bench times exactly the zenc square command add-photos.sh runs", async () => {
  const sh = await readFile(new URL("./photos/add-photos.sh", import.meta.url), "utf8");
  const production = addPhotosInvocation(sh);
  // A parser that stopped matching would compare two empty shapes and agree.
  assert.equal(production.tiers.length, 3, "expected the 600/400/200 tiers");
  assert.deepEqual(benchInvocation(), production);
});

test("the production-command comparison has teeth", async () => {
  const sh = await readFile(new URL("./photos/add-photos.sh", import.meta.url), "utf8");
  for (const [from, to] of [
    ["--filter box", "--filter lanczos3"],
    ['--size "$SQ_XS" --avif-out "$xsavif"', '--size "$SQ_XS" --avif-out "$xsavif" --jpeg-out "$xsjpg"'],
    ["ZENC_Q=84", "ZENC_Q=83"],
  ]) {
    assert.ok(sh.includes(from), `control anchor ${from} is gone from add-photos.sh`);
    assert.notDeepEqual(benchInvocation(), addPhotosInvocation(sh.replace(from, to)), `a change of ${from} went unnoticed`);
  }
});

test("the bench's output list is every file its argv writes", () => {
  const written = productionArgs("IN", "1", "/d").filter((a) => a.startsWith("/d/")).map((a) => a.slice(3)).sort();
  assert.deepEqual(written, [...OUTPUT_FILES].sort());
  assert.deepEqual([...OUTPUT_FILES].sort(), ["200.avif", "400.avif", "600.avif", "600.jpg"]);
});

test("the corpus takes the first source of each class, in sorted order", () => {
  const probes = [
    { SourceFile: "XT507876.JPG", Orientation: 6, Model: "X-T50" },
    { SourceFile: "XT500026.HIF", Orientation: 1, Model: "X-T50" },
    { SourceFile: "XT500010.HIF", Orientation: 8, Model: "X-T50" },
    { SourceFile: "XT500002.HIF", Orientation: 8, Model: "X-T50" },
    { SourceFile: "L1000069_3.jpg", Model: "LEICA M MONOCHROM (Typ 246)" },
    { SourceFile: "L1000070.JPG", Orientation: 8, Model: "LEICA M MONOCHROM (Typ 246)" },
    { SourceFile: "XT507399.JPG", Orientation: 1, Model: "X-T50" },
    { SourceFile: "XT507333.JPG", Orientation: 8, Model: "X-T50" },
    { SourceFile: "notes.ig", Model: "" },
  ];
  const corpus = pickCorpus(probes);
  assert.deepEqual(corpus.map((s) => s.file), [
    "L1000069_3.jpg", "XT500002.HIF", "XT500026.HIF", "XT507333.JPG", "XT507399.JPG", "XT507876.JPG",
  ]);
  // Input order must not matter, or the corpus drifts with readdir.
  assert.deepEqual(pickCorpus([...probes].reverse()), corpus);
  // A missing Orientation is upright, which is what add-photos.sh does with it.
  assert.equal(corpus[0].orient, "1");
  assert.equal(classify({ SourceFile: "a.png" }), null);
});

test("the statistics the verdict rests on", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(spread([90, 100, 110]), 0.2);
  assert.ok(Math.abs(geomean([2, 0.5]) - 1) < 1e-12);
});

// Exact values by hand: C(10,5) = 252 orderings of 5 vs 5, C(14,7) = 3432 of
// 7 vs 7. The counts of orderings with U = 0..5 are 1, 1, 2, 3, 5, 7 for any
// sample at least 5 wide (partitions of k), so U <= 5 at 7 vs 7 is 19 of 3432.
test("the Mann-Whitney p the verdict rests on", () => {
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(close(mannWhitneyP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 2 / 252));
  assert.ok(close(mannWhitneyP([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]), 2 / 252), "two-sided, either direction");
  // One outlier: 7 vs 7 with U = 5.
  const old = [4.77, 4.74, 4.79, 4.82, 4.82, 5.31, 5.01];
  const neu = [4.49, 4.5, 4.51, 4.56, 4.63, 4.98, 4.73];
  assert.ok(close(mannWhitneyP(neu, old), (2 * 19) / 3432));
  // Interleaved samples carry no evidence, and ties can only raise p.
  assert.equal(mannWhitneyP([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]) > 0.5, true);
  assert.equal(mannWhitneyP([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]), 1);
  // The floor the CLI enforces: at 4 vs 4 even complete separation misses ALPHA,
  // at 5 vs 5 it clears it.
  assert.ok(mannWhitneyP([1, 2, 3, 4], [5, 6, 7, 8]) >= ALPHA);
  assert.ok(mannWhitneyP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]) < ALPHA);
});

test("the gate and its control both run before any timing is printed", async () => {
  const src = await readFile(new URL("./photos/zenc-bench.ts", import.meta.url), "utf8");
  /** @param {string} needle */
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `zenc-bench.ts no longer contains ${needle}`);
    return i;
  };
  const timer = at("// ── the timer");
  assert.ok(at("GATE FAILED") < timer, "a gate failure must exit before the timer");
  assert.ok(at("control failed") < timer, "the control must run before the timer");
  assert.ok(at("process.exit(1)") < timer);
});
