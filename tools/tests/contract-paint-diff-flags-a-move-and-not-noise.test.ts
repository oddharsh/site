// ── paint:diff flags a move and not noise ───────────────────────────────────
// tools/lib/paint-diff.ts calls a page's FCP or CLS moved when the paired loads
// lean one way past a sign test AND the median change clears a floor. Each half
// alone would flag too much: a consistent 3 ms is real and not worth a PR
// comment, and one 400 ms outlier is a big median-free number from a GC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOOR, P_MAX, median, signTest, verdict } from "../lib/paint-diff.ts";

test("the sign test gives the exact two-sided binomial tail", () => {
  assert.equal(signTest(9, 0), 2 / 512);
  assert.equal(signTest(0, 9), 2 / 512);
  assert.equal(signTest(8, 1), 20 / 512);
  assert.equal(signTest(7, 2), 92 / 512);
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(3, 3), 1);
  assert.ok(signTest(5, 0) >= P_MAX, "five pairs cannot validate a planted move");
  assert.ok(signTest(6, 0) < P_MAX, "six agreeing pairs can validate a planted move");
});

test("median takes the middle, or the mean of the middle two", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /median of nothing/);
});

test("FCP 20 ms later in 9 of 9 pairs is moved; the same split at 15 ms is under the floor", () => {
  const base = [300, 310, 305, 320, 298, 302, 315, 307, 311];
  const later = verdict(
    "fcp",
    base,
    base.map((b) => b + 20),
  );
  assert.deepEqual(later, { base: 307, head: 327, delta: 20, higher: 9, lower: 0, p: 2 / 512, moved: true });
  assert.equal(FLOOR.fcp, 16);
  assert.equal(
    verdict(
      "fcp",
      base,
      base.map((b) => b + 15),
    ).moved,
    false,
  );
});

test("one 400 ms outlier among even pairs is noise", () => {
  const base = [300, 310, 305, 320, 298, 302, 315, 307, 311];
  const head = [302, 306, 309, 318, 700, 300, 317, 305, 312];
  const v = verdict("fcp", base, head);
  assert.equal(v.delta, 1);
  assert.equal(v.higher, 5);
  assert.equal(v.lower, 4);
  assert.equal(v.moved, false);
});

test("8 of 9 pairs is moved, 7 of 9 is not", () => {
  const base = Array(9).fill(300);
  assert.equal(verdict("fcp", base, [340, 340, 340, 340, 340, 340, 340, 340, 290]).moved, true);
  assert.equal(verdict("fcp", base, [340, 340, 340, 340, 340, 340, 340, 290, 290]).moved, false);
});

test("CLS that shifted nothing on both sides is all ties; a 0.01 shift on HEAD is moved", () => {
  const zero = Array(9).fill(0);
  const still = verdict(
    "cls",
    zero,
    zero.map(() => 1e-17),
  );
  assert.deepEqual(still, { base: 0, head: 1e-17, delta: 1e-17, higher: 0, lower: 0, p: 1, moved: false });
  const shifted = verdict("cls", zero, Array(9).fill(0.01));
  assert.equal(shifted.moved, true);
  assert.equal(shifted.delta, 0.01);
});

test("a faster HEAD is moved too, with a negative change", () => {
  const base = Array(9).fill(400);
  const v = verdict("fcp", base, Array(9).fill(350));
  assert.equal(v.delta, -50);
  assert.equal(v.lower, 9);
  assert.equal(v.moved, true);
});

test("unpaired loads are refused", () => {
  assert.throws(() => verdict("fcp", [1, 2], [1]), /2 base loads against 1 HEAD loads/);
});
