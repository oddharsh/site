#!/usr/bin/env node
// navigation-lab.mjs — repeatable cold-navigation evidence for performance
// experiments. It measures a representative matrix, not every route: the
// homepage is the regression sentinel; Garage is a dense static page; Lens is
// the largest application shell; Writing is the mobile editor surface; LWE
// Encoding catches shell stability on a long interactive document.
//
// This intentionally applies CPU throttling without CDP Network emulation.
// Attaching the Network domain suppresses Chrome's Early Hints behavior, and a
// local network throttle would mix that instrumentation bug into every result.
// Wire cost is measured deterministically by perf-snapshot.mjs instead.
//
//   pnpm run perf:nav -- --url https://aadhar.sh --out .perf-research/prod-nav.json
//   pnpm run perf:nav -- --url http://127.0.0.1:8799 --runs 9 --throttle 6
//   pnpm run perf:nav -- --url http://127.0.0.1:8800 --candidate-url http://127.0.0.1:8799 \
//     --baseline-out .perf-research/base.json --candidate-out .perf-research/candidate.json

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const BASE_URL = arg("--url", "http://127.0.0.1:8799").replace(/\/$/, "");
const CANDIDATE_URL = arg("--candidate-url", "").replace(/\/$/, "");
const RUNS = Number(arg("--runs", "7"));
const THROTTLE = Number(arg("--throttle", "4"));
const OUT = arg("--out", "");
const BASELINE_OUT = arg("--baseline-out", "");
const CANDIDATE_OUT = arg("--candidate-out", "");
const LABEL = arg("--label", BASE_URL);
const CANDIDATE_LABEL = arg("--candidate-label", CANDIDATE_URL);
const HEADED = process.argv.includes("--headed");
const ONLY = new Set(arg("--only", "").split(",").filter(Boolean));

if (!Number.isInteger(RUNS) || RUNS < 3) throw new Error("--runs must be an integer of at least 3");
if (!Number.isFinite(THROTTLE) || THROTTLE < 1) throw new Error("--throttle must be at least 1");
const checkedUrl = (value, flag) => {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
    return parsed;
  } catch {
    throw new Error(`${flag} must be an http(s) origin, received ${value}`);
  }
};
checkedUrl(BASE_URL, "--url");
if (CANDIDATE_URL) checkedUrl(CANDIDATE_URL, "--candidate-url");
if (CANDIDATE_URL && OUT) throw new Error("paired mode writes --baseline-out and --candidate-out, not --out");
if (Boolean(BASELINE_OUT) !== Boolean(CANDIDATE_OUT)) {
  throw new Error("paired mode needs both --baseline-out and --candidate-out");
}
if (!CANDIDATE_URL && (BASELINE_OUT || CANDIDATE_OUT)) {
  throw new Error("--baseline-out and --candidate-out require --candidate-url");
}

const MATRIX = [
  { id: "home-mobile", name: "Home · mobile", path: "/", viewport: { width: 390, height: 844 } },
  { id: "home-desktop", name: "Home · desktop", path: "/", viewport: { width: 1280, height: 900 } },
  { id: "garage-desktop", name: "Garage · desktop", path: "/garage", viewport: { width: 1280, height: 900 } },
  { id: "lens-desktop", name: "Lens · desktop", path: "/lens", viewport: { width: 1280, height: 900 } },
  { id: "writing-mobile", name: "Writing · mobile", path: "/writing/in-flux", viewport: { width: 390, height: 844 } },
  { id: "lwe-encoding-mobile", name: "LWE Encoding · mobile", path: "/lwe/encoding", viewport: { width: 390, height: 844 } },
].filter((scenario) => !ONLY.size || ONLY.has(scenario.id));

if (!MATRIX.length) throw new Error(`--only did not match a scenario (${[...ONLY].join(", ")})`);

const COLLECTOR = () => {
  window.__navigationLab = { lcp: null, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const latest = entries[entries.length - 1];
      if (latest) window.__navigationLab.lcp = latest.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__navigationLab.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
};

const summary = (values) => ({
  min: Math.min(...values),
  median: quantile(values, 0.5),
  p75: quantile(values, 0.75),
  p90: quantile(values, 0.9),
  max: Math.max(...values),
});

const summarizeScenario = (samples) => ({
  ttfbMs: summary(samples.map((sample) => sample.ttfbMs)),
  fcpMs: summary(samples.map((sample) => sample.fcpMs)),
  lcpMs: summary(samples.map((sample) => sample.lcpMs)),
  loadMs: summary(samples.map((sample) => sample.loadMs)),
  cls: summary(samples.map((sample) => sample.cls)),
  transferBytes: summary(samples.map((sample) => sample.transferBytes)),
  requestCount: summary(samples.map((sample) => sample.requestCount)),
});

async function measureOnce(browser, scenario, baseUrl) {
  const context = await browser.newContext({ viewport: scenario.viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(COLLECTOR);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  try {
    const response = await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: "load", timeout: 30_000 });
    if (!response || response.status() >= 400) throw new Error(`navigation returned HTTP ${response?.status() ?? "none"}`);
    const expectedOrigin = new URL(baseUrl).origin;
    const finalOrigin = new URL(page.url()).origin;
    if (finalOrigin !== expectedOrigin) {
      throw new Error(`navigation left the measured origin (${expectedOrigin} -> ${finalOrigin})`);
    }
    await page.waitForTimeout(600);
    const reading = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      const resources = performance.getEntriesByType("resource");
      return {
        visible: document.visibilityState,
        ttfbMs: navigation?.responseStart ?? null,
        fcpMs: fcp?.startTime ?? null,
        lcpMs: window.__navigationLab?.lcp ?? null,
        loadMs: navigation?.loadEventEnd ?? null,
        cls: window.__navigationLab?.cls ?? null,
        transferBytes: (navigation?.transferSize || 0) + resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
        requestCount: resources.length + 1,
      };
    });
    if (reading.visible !== "visible") throw new Error(`document visibilityState was ${reading.visible}`);
    for (const metric of ["ttfbMs", "fcpMs", "lcpMs", "loadMs", "cls", "transferBytes", "requestCount"]) {
      if (!Number.isFinite(reading[metric])) throw new Error(`${metric} was not observable`);
    }
    if (errors.length) throw new Error(`page error: ${errors.join("; ")}`);
    return reading;
  } finally {
    await context.close();
  }
}

const measuredScenario = (scenario, samples) => ({
  ...scenario,
  samples,
  summary: summarizeScenario(samples),
});

async function measureScenario(browser, scenario, baseUrl) {
  const samples = [];
  for (let run = 0; run < RUNS; run++) samples.push(await measureOnce(browser, scenario, baseUrl));
  return measuredScenario(scenario, samples);
}

async function measurePairedScenario(browser, scenario) {
  const baseSamples = [];
  const candidateSamples = [];
  for (let run = 0; run < RUNS; run++) {
    const arms = run % 2 === 0
      ? [[BASE_URL, baseSamples], [CANDIDATE_URL, candidateSamples]]
      : [[CANDIDATE_URL, candidateSamples], [BASE_URL, baseSamples]];
    for (const [url, samples] of arms) samples.push(await measureOnce(browser, scenario, url));
  }
  return {
    base: measuredScenario(scenario, baseSamples),
    candidate: measuredScenario(scenario, candidateSamples),
  };
}

async function reachable(baseUrl) {
  const response = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
try { await reachable(BASE_URL); } catch (error) { console.error(`cannot reach ${BASE_URL} (${error.message})`); process.exit(1); }
if (CANDIDATE_URL) {
  try { await reachable(CANDIDATE_URL); } catch (error) { console.error(`cannot reach ${CANDIDATE_URL} (${error.message})`); process.exit(1); }
}

const printScenario = (prefix, measured) => console.log(
  `${prefix}${measured.name.padEnd(22 - prefix.length)} ` +
  `LCP ${measured.summary.lcpMs.median.toFixed(0).padStart(5)} ms ` +
  `(p90 ${measured.summary.lcpMs.p90.toFixed(0).padStart(5)})  ` +
  `FCP ${measured.summary.fcpMs.median.toFixed(0).padStart(5)}  ` +
  `TTFB ${measured.summary.ttfbMs.median.toFixed(0).padStart(4)}  ` +
  `CLS ${measured.summary.cls.max.toFixed(3)}`
);

const reportFor = (browser, label, baseUrl, scenarios) => ({
  schema: 1,
  kind: "navigation",
  label,
  generatedAt: new Date().toISOString(),
  baseUrl,
  browser: browser.version(),
  platform: `${process.platform}-${process.arch}`,
  cpuThrottle: THROTTLE,
  runs: RUNS,
  cache: "fresh browser context per run",
  network: "unthrottled; CDP Network domain deliberately unattached",
  sampling: CANDIDATE_URL ? "paired and order-alternated in one browser process" : "single arm",
  scenarios,
});

async function writeReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${path}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
try {
  if (CANDIDATE_URL) {
    console.log(`\nNavigation lab — paired ${BASE_URL} ↔ ${CANDIDATE_URL}   CPU ${THROTTLE}x   ${RUNS} pairs/scenario\n`);
    const baseScenarios = [];
    const candidateScenarios = [];
    for (const scenario of MATRIX) {
      const measured = await measurePairedScenario(browser, scenario);
      baseScenarios.push(measured.base);
      candidateScenarios.push(measured.candidate);
      printScenario("A ", measured.base);
      printScenario("B ", measured.candidate);
    }
    await writeReport(BASELINE_OUT, reportFor(browser, LABEL, BASE_URL, baseScenarios));
    await writeReport(CANDIDATE_OUT, reportFor(browser, CANDIDATE_LABEL, CANDIDATE_URL, candidateScenarios));
  } else {
    console.log(`\nNavigation lab — ${BASE_URL}   CPU ${THROTTLE}x   ${RUNS} cold runs/scenario\n`);
    const scenarios = [];
    for (const scenario of MATRIX) {
      const measured = await measureScenario(browser, scenario, BASE_URL);
      scenarios.push(measured);
      printScenario("", measured);
    }
    await writeReport(OUT, reportFor(browser, LABEL, BASE_URL, scenarios));
  }
} finally {
  await browser.close();
}
