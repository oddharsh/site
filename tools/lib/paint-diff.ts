// paint-diff.ts: the verdict half of tools/paint-diff.ts. Given paired loads of
// one page from the base and from HEAD, did first contentful paint or layout
// shift move, or is the difference the runner's noise?
//
// Loads come in pairs, base and HEAD back to back, so a pair shares whatever
// the machine was doing at that moment. The verdict is a sign test on the
// pairs: under no change, HEAD reads higher in a pair as often as lower, so 9
// of 9 pairs on one side happens 2 times in 512. A sign test makes no
// assumption about the shape of the noise, which on a shared runner has a long
// right tail (a GC or a neighbour's job lands on one load, not its pair).
// A difference that clears the test but is smaller than FLOOR is reported and
// not flagged, since a PR comment that flags 3 ms teaches people to skip it.

export type Metric = "fcp" | "cls";

/** The smallest median paired delta that gets flagged: one frame at 60 Hz, and half of browser:check's shift limit. */
export const FLOOR: Record<Metric, number> = { fcp: 16, cls: 0.005 };

/** The two-sided sign-test p-value a delta must beat to be flagged. */
export const P_MAX = 0.05;

export type Verdict = {
  base: number;
  head: number;
  /** Median of head minus base over the pairs. */
  delta: number;
  /** Pairs where HEAD read higher, lower, and the same. */
  higher: number;
  lower: number;
  p: number;
  moved: boolean;
};

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Exact two-sided sign test: the chance of a split at least this lopsided when each side is a coin flip. Ties are dropped. */
export function signTest(higher: number, lower: number): number {
  const n = higher + lower;
  if (n === 0) return 1;
  const k = Math.min(higher, lower);
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) choose = (choose * (n - i + 1)) / i;
    tail += choose;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export function verdict(metric: Metric, base: readonly number[], head: readonly number[]): Verdict {
  if (base.length !== head.length) throw new Error(`${metric}: ${base.length} base loads against ${head.length} HEAD loads`);
  const deltas = head.map((h, i) => h - base[i]);
  // CLS is summed from floats, so two loads that shifted nothing can differ in
  // the 17th digit. Anything under a thousandth of the floor is a tie.
  const tie = FLOOR[metric] / 1000;
  const higher = deltas.filter((d) => d > tie).length;
  const lower = deltas.filter((d) => d < -tie).length;
  const delta = median(deltas);
  const p = signTest(higher, lower);
  return { base: median(base), head: median(head), delta, higher, lower, p, moved: p < P_MAX && Math.abs(delta) >= FLOOR[metric] };
}
