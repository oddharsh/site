const LOAD_DELTA_MS = 16;
const LOAD_DELTA_RATIO = 0.10;
const TAIL_DELTA_MS = 32;
const TAIL_DELTA_RATIO = 0.15;
const TTFB_DELTA_MS = 20;
const TTFB_DELTA_RATIO = 0.20;
const INP_FLOOR_MS = 16;
const CLS_DELTA = 0.02;

const finite = (value, label) => {
  if (!Number.isFinite(value)) throw new Error(`${label} is not a finite number`);
  return value;
};

const ratio = (base, candidate) => base === 0 ? 1 : candidate / base;
const faster = (base, candidate, ms = LOAD_DELTA_MS, fraction = LOAD_DELTA_RATIO) =>
  base - candidate >= ms && ratio(base, candidate) <= 1 - fraction;
const slower = (base, candidate, ms = LOAD_DELTA_MS, fraction = LOAD_DELTA_RATIO) =>
  candidate - base >= ms && ratio(base, candidate) >= 1 + fraction;

const browserMajor = (value) => String(value || "").match(/\d+/)?.[0] || "unknown";

function assertCompatible(base, candidate) {
  if (base?.schema !== 1 || candidate?.schema !== 1) {
    throw new Error("both reports must use performance-lab schema 1");
  }
  if (base.kind !== candidate.kind) {
    throw new Error(`report kinds differ (${base.kind} vs ${candidate.kind})`);
  }
  if (base.cpuThrottle !== candidate.cpuThrottle) {
    throw new Error(`CPU throttles differ (${base.cpuThrottle}x vs ${candidate.cpuThrottle}x)`);
  }
  if (base.runs !== candidate.runs) {
    throw new Error(`sample counts differ (${base.runs} vs ${candidate.runs})`);
  }
  if (base.platform !== candidate.platform) {
    throw new Error(`platforms differ (${base.platform} vs ${candidate.platform})`);
  }
  if (browserMajor(base.browser) !== browserMajor(candidate.browser)) {
    throw new Error(`browser majors differ (${base.browser} vs ${candidate.browser})`);
  }
}

const matched = (baseRows, candidateRows) => {
  const candidates = new Map(candidateRows.map((row) => [row.id, row]));
  const rows = baseRows.map((base) => {
    const candidate = candidates.get(base.id);
    if (!candidate) throw new Error(`candidate report is missing scenario ${base.id}`);
    candidates.delete(base.id);
    return { base, candidate };
  });
  if (candidates.size) throw new Error(`candidate report has extra scenarios: ${[...candidates.keys()].join(", ")}`);
  return rows;
};

const geometricMean = (values) => {
  if (!values.length) return 1;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
};

function compareNavigation(base, candidate) {
  const rows = [];
  for (const pair of matched(base.scenarios || [], candidate.scenarios || [])) {
    const b = pair.base.summary;
    const c = pair.candidate.summary;
    const bLcp = finite(b?.lcpMs?.median, `${pair.base.id} base LCP median`);
    const cLcp = finite(c?.lcpMs?.median, `${pair.base.id} candidate LCP median`);
    // p75 is the tail guard because the default seven-run lab would make p90
    // equal the single maximum. One cold-network outlier is a reason to repeat,
    // not enough evidence to reject an otherwise repeatable local candidate.
    const bTail = finite(b?.lcpMs?.p75, `${pair.base.id} base LCP p75`);
    const cTail = finite(c?.lcpMs?.p75, `${pair.base.id} candidate LCP p75`);
    const bFcp = finite(b?.fcpMs?.median, `${pair.base.id} base FCP median`);
    const cFcp = finite(c?.fcpMs?.median, `${pair.base.id} candidate FCP median`);
    const bTtfb = finite(b?.ttfbMs?.median, `${pair.base.id} base TTFB median`);
    const cTtfb = finite(c?.ttfbMs?.median, `${pair.base.id} candidate TTFB median`);
    const bCls = finite(b?.cls?.max, `${pair.base.id} base CLS max`);
    const cCls = finite(c?.cls?.max, `${pair.base.id} candidate CLS max`);
    const reasons = [];

    if (slower(bLcp, cLcp)) reasons.push("LCP median regressed");
    if (slower(bTail, cTail, TAIL_DELTA_MS, TAIL_DELTA_RATIO)) reasons.push("LCP p75 regressed");
    if (slower(bFcp, cFcp)) reasons.push("FCP median regressed");
    if (slower(bTtfb, cTtfb, TTFB_DELTA_MS, TTFB_DELTA_RATIO)) reasons.push("TTFB median regressed");
    if ((cCls > 0.1 && bCls <= 0.1) || cCls - bCls >= CLS_DELTA) reasons.push("CLS regressed");

    rows.push({
      id: pair.base.id,
      name: pair.base.name,
      base: bLcp,
      candidate: cLcp,
      ratio: ratio(bLcp, cLcp),
      improved: faster(bLcp, cLcp),
      reasons,
      detail: { baseP75: bTail, candidateP75: cTail, baseCls: bCls, candidateCls: cCls },
    });
  }
  return rows;
}

function compareInp(base, candidate) {
  const rows = [];
  for (const pair of matched(base.results || [], candidate.results || [])) {
    const bMed = pair.base.med ?? INP_FLOOR_MS;
    const cMed = pair.candidate.med ?? INP_FLOOR_MS;
    const bMax = pair.base.max ?? INP_FLOOR_MS;
    const cMax = pair.candidate.max ?? INP_FLOOR_MS;
    finite(bMed, `${pair.base.id} base INP median`);
    finite(cMed, `${pair.base.id} candidate INP median`);
    finite(bMax, `${pair.base.id} base INP max`);
    finite(cMax, `${pair.base.id} candidate INP max`);
    const reasons = [];

    if (slower(bMed, cMed)) reasons.push("interaction median regressed");
    if (slower(bMax, cMax, LOAD_DELTA_MS, 0.20)) reasons.push("interaction max regressed");
    if (cMax >= 200 && bMax < 200) reasons.push("interaction crossed the 200ms INP threshold");

    rows.push({
      id: pair.base.id,
      name: pair.base.name,
      base: bMed,
      candidate: cMed,
      ratio: ratio(bMed, cMed),
      improved: faster(bMed, cMed),
      reasons,
      detail: { baseMax: bMax, candidateMax: cMax },
    });
  }
  return rows;
}

export function compareReports(base, candidate) {
  assertCompatible(base, candidate);
  const rows = base.kind === "navigation"
    ? compareNavigation(base, candidate)
    : base.kind === "inp"
      ? compareInp(base, candidate)
      : (() => { throw new Error(`unsupported report kind ${base.kind}`); })();
  const regressions = rows.filter((row) => row.reasons.length);
  const improvements = rows.filter((row) => row.improved);
  const score = geometricMean(rows.map((row) => row.ratio));
  const decision = regressions.length ? "reject" : improvements.length ? "promote" : "inconclusive";
  return {
    schema: 1,
    kind: base.kind,
    base: base.label,
    candidate: candidate.label,
    decision,
    score,
    speedup: score === 0 ? null : 1 / score,
    improvements: improvements.map((row) => row.id),
    regressions: regressions.map((row) => ({ id: row.id, reasons: row.reasons })),
    rows,
  };
}

const ms = (value) => `${value.toFixed(1)} ms`;
const pct = (value) => `${value > 1 ? "+" : ""}${((value - 1) * 100).toFixed(1)}%`;

export function renderComparison(result) {
  const lines = [
    `# Performance experiment: ${result.decision}`,
    "",
    `\`${result.base}\` → \`${result.candidate}\` · normalized geomean ${result.score.toFixed(3)} (${result.speedup.toFixed(2)}×)`,
    "",
    "| scenario | base | candidate | delta | verdict |",
    "|---|--:|--:|--:|---|",
  ];
  for (const row of result.rows) {
    const verdict = row.reasons.length ? row.reasons.join("; ") : row.improved ? "material improvement" : "within resolution";
    lines.push(`| ${row.name} | ${ms(row.base)} | ${ms(row.candidate)} | ${pct(row.ratio)} | ${verdict} |`);
  }
  lines.push(
    "",
    result.decision === "promote"
      ? "At least one scenario improved by both 10% and 16 ms, with no material regression. This clears the browser-evidence gate; correctness and wire-size checks still have to pass."
      : result.decision === "reject"
        ? "A protected scenario regressed. Keep any useful idea in its beam, but do not promote this candidate as measured."
        : "The movement is below the lab's resolution. Record it as inconclusive; do not promote it as a performance win.",
    "",
  );
  return lines.join("\n");
}

export const PERF_RESEARCH_THRESHOLDS = Object.freeze({
  loadDeltaMs: LOAD_DELTA_MS,
  loadDeltaRatio: LOAD_DELTA_RATIO,
  tailDeltaMs: TAIL_DELTA_MS,
  tailDeltaRatio: TAIL_DELTA_RATIO,
  ttfbDeltaMs: TTFB_DELTA_MS,
  ttfbDeltaRatio: TTFB_DELTA_RATIO,
  inpFloorMs: INP_FLOOR_MS,
  clsDelta: CLS_DELTA,
});
