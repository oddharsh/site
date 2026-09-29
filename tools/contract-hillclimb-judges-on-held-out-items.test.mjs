// tools/lib/hillclimb.ts, the shared optimization loop. Every verdict it can
// return is reached here by a control built to reach it, because a judge that
// has only ever said "keep" has not been shown to say anything else. The noise
// band is exercised with real brotli q11 on the site's own pages, since that is
// the scorer it exists for and a synthetic corpus would miss what q11 does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants as zc } from "node:zlib";
import { band, byteNoiseBand, centered, climb, deleteAtRandom, judge, rng, sideOf, split, ZERO_BAND } from "./lib/hillclimb.ts";

test("the split is a pure function of the name: stable, near its share, and unmoved by new items", () => {
  const names = Array.from({ length: 2000 }, (_, i) => `page-${i}`);
  const first = names.map((n) => sideOf(n));
  assert.deepEqual(names.map((n) => sideOf(n)), first, "same name, same side, every call");
  const share = first.filter((s) => s === "test").length / names.length;
  assert.ok(share > 0.27 && share < 0.33, `test share ${share} should sit near 0.3`);
  // adding items never moves an existing one, which a shuffle-then-cut split would
  const grown = split([...names, ...Array.from({ length: 500 }, (_, i) => `new-${i}`)], (n) => n);
  const onTest = new Set(grown.test);
  names.forEach((n, i) => assert.equal(onTest.has(n), first[i] === "test"));
  // a different seed is a different split
  assert.notDeepEqual(names.map((n) => sideOf(n, { seed: "other" })), first);
});

test("a split with an empty side refuses rather than judging on one side", () => {
  assert.throws(() => split(["a", "b"], (n) => n, { testShare: 0 }), /0 test/);
});

test("judge reaches all four verdicts, each from the input built for it", () => {
  const noise = { train: band([-3, 2]), test: band([-3, 2]) };
  const v = (train, test) => judge({ train, test, noise }).verdict;
  assert.equal(v([-2, -2, -2], [-2, -2]), "keep");        // -6 and -4, both past -3
  assert.equal(v([-2, -2, -2], [0, 0]), "overfit");       // train clears, test flat
  assert.equal(v([-1, 0, 0], [-1, 0]), "noise");          // inside the band both sides
  assert.equal(v([-2, -2, -2], [2, 2]), "regress");       // test worse past the band
  assert.equal(v([2, 2, 2], [0, 0]), "regress");          // train worse, test not clearing
});

test("one outlier cannot carry a side: the win share gates it", () => {
  // -10 total, but it wins on one unit of five
  const j = judge({ train: [-12, 0.5, 0.5, 0.5, 0.5], test: [-12, 0.5, 0.5, 0.5, 0.5] });
  assert.equal(j.verdict, "noise");
  assert.equal(j.train.wins, 1);
  assert.equal(judge({ train: [-12, 0.5, 0.5, 0.5, 0.5], test: [-12, 0.5, 0.5, 0.5, 0.5], minWins: 0 }).verdict, "keep");
});

test("deleteAtRandom removes exactly the size asked for, reproducibly from the seed", () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  const a = deleteAtRandom(bytes, 37, 4, rng("s"));
  assert.equal(a.length, 963);
  assert.deepEqual(deleteAtRandom(bytes, 37, 4, rng("s")), a);
  assert.notDeepEqual(deleteAtRandom(bytes, 37, 4, rng("t")), a);
});

// Real pages, cut to 12 KB so the suite stays fast. What matters is that q11 on
// real markup has noise at all, and that the band tells a small edit from a
// large one.
const q11 = (b) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length;
const pagesDir = new URL("../src/pages/garage/", import.meta.url);
const pages = readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort().slice(0, 12)
  .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(new URL(f, pagesDir))).subarray(0, 12_288) }));

/**
 * @param {(b: Uint8Array) => Uint8Array} transform
 * @param {"jitter" | "arbitrary"} [against]
 */
function measure(transform, against = "jitter") {
  const sides = split(pages, (p) => p.name);
  /** @param {typeof pages} set */
  const read = (set) => {
    const items = set.map((p) => ({ ...p, after: transform(p.bytes) }));
    return {
      deltas: items.map((it) => q11(it.after) - q11(it.bytes)),
      band: byteNoiseBand(items.map((it) => ({ name: it.name, bytes: it.bytes, changed: it.bytes.length - it.after.length })), q11, { runs: 12, against }),
    };
  };
  const train = read(sides.train), test = read(sides.test);
  const noise = { train: train.band, test: test.band };
  return { ...judge({ train: train.deltas, test: test.deltas, noise }), noise };
}

test("brotli q11 on real pages has a noise band, and a 2-byte edit sits inside it", () => {
  // the first doubled space in each page, gone: the size of edit the q11 noise
  // floor memory says cannot be credited without a control
  const tiny = (b) => {
    for (let i = 1; i < b.length; i++) if (b[i] === 32 && b[i - 1] === 32) return Uint8Array.from([...b.subarray(0, i - 1), ...b.subarray(i + 1)]);
    return b;
  };
  const r = measure(tiny);
  assert.ok(r.noise.train.hi > r.noise.train.lo, "q11 should move under random same-size deletions");
  assert.notEqual(r.verdict, "keep", r.reason);
});

test("a real, large edit clears the jitter band, and still loses to arbitrary deletions of its size", () => {
  // leading indentation stripped, which is several hundred bytes per page
  const dedent = (b) => new TextEncoder().encode(new TextDecoder().decode(b).replace(/\n[ \t]+/g, "\n"));
  const jitter = measure(dedent);
  assert.equal(jitter.verdict, "keep", jitter.reason);
  // The two nulls disagree on purpose. Whitespace compresses almost for free,
  // so removing it saves less than removing as many arbitrary bytes; the raw
  // band sits below zero and a real win reads as a loss against it.
  const arbitrary = measure(dedent, "arbitrary");
  assert.ok(arbitrary.noise.train.hi < 0, "random deletions save bytes on their own");
  assert.notEqual(arbitrary.verdict, "keep", arbitrary.reason);
});

test("centering keeps the spread and moves its median to zero", () => {
  const b = band([-40, -20, -20, 10]);
  assert.equal(b.median, -20);
  assert.deepEqual(centered(b), { lo: -20, hi: 30, n: 4, median: 0 });
});

test("climb reverts a candidate that memorizes the train side, keeps a real one, and stops on a plateau", async () => {
  const items = Array.from({ length: 200 }, (_, i) => `item-${i}`);
  const trainNames = new Set(split(items, (n) => n).train);
  const score = (c, name) => 100 - c.gain - (c.memo.has(name) ? 5 : 0);
  const ledger = join(mkdtempSync(join(tmpdir(), "hillclimb-")), "ledger.jsonl");
  const lines = [];
  const out = await climb({
    items, nameOf: (n) => n, baseline: { gain: 0, memo: new Set() }, score, ledger, log: (l) => lines.push(l),
    candidates: [
      // eval leaking into the harness: it only helps the items it has seen
      { name: "memorize", apply: (b) => ({ ...b, memo: trainNames }) },
      { name: "real", apply: (b) => ({ ...b, gain: b.gain + 1 }) },
      { name: "no-op 1", apply: (b) => b },
      { name: "no-op 2", apply: (b) => b },
      { name: "no-op 3", apply: (b) => b },
      { name: "never reached", apply: (b) => ({ ...b, gain: b.gain + 10 }) },
    ],
  });
  assert.deepEqual(out.rows.map((r) => r.verdict), ["overfit", "keep", "noise", "noise", "noise"]);
  assert.deepEqual(out.kept, ["real"]);
  assert.equal(out.best.gain, 1);
  assert.equal(out.best.memo.size, 0, "the overfit candidate must not survive into the best config");
  assert.equal(out.stalled, true);
  assert.ok(lines.some((l) => /stalled/.test(l)));
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 5);
  assert.deepEqual(ZERO_BAND, { lo: 0, hi: 0, n: 0, median: 0 });
});
