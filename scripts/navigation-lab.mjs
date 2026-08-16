#!/usr/bin/env node
// navigation-lab.mjs — repeatable cold-navigation evidence for performance
// experiments. It measures a representative matrix, not every route: the
// homepage is the regression sentinel; Garage is a dense static page; Lens is
// the largest application shell; Writing is the mobile editor surface.
//
// This intentionally applies CPU throttling without CDP Network emulation.
// Attaching the Network domain suppresses Chrome's Early Hints behavior, and a
// local network throttle would mix that instrumentation bug into every result.
// Wire cost is measured deterministically by perf-snapshot.mjs instead.
//
//   pnpm run perf:nav -- --url https://aadhar.sh --out .perf-research/prod-nav.json
//   pnpm run perf:nav -- --url http://127.0.0.1:8799 --runs 9 --throttle 6

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const BASE_URL = arg("--url", "http://127.0.0.1:8799").replace(/\/$/, "");
const RUNS = Number(arg("--runs", "7"));
const THROTTLE = Number(arg("--throttle", "4"));
const OUT = arg("--out", "");
const LABEL = arg("--label", BASE_URL);
const HEADED = process.argv.includes("--headed");
const ONLY = new Set(arg("--only", "").split(",").filter(Boolean));

if (!Number.isInteger(RUNS) || RUNS < 3) throw new Error("--runs must be an integer of at least 3");
if (!Number.isFinite(THROTTLE) || THROTTLE < 1) throw new Error("--throttle must be at least 1");
try {
  const parsed = new URL(BASE_URL);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
} catch {
  throw new Error(`--url must be an http(s) origin, received ${BASE_URL}`);
}

const MATRIX = [
  { id: "home-mobile", name: "Home · mobile", path: "/", viewport: { width: 390, height: 844 } },
  { id: "home-desktop", name: "Home · desktop", path: "/", viewport: { width: 1280, height: 900 } },
  { id: "garage-desktop", name: "Garage · desktop", path: "/garage", viewport: { width: 1280, height: 900 } },
  { id: "lens-desktop", name: "Lens · desktop", path: "/lens", viewport: { width: 1280, height: 900 } },
  { id: "writing-mobile", name: "Writing · mobile", path: "/writing/in-flux", viewport: { width: 390, height: 844 } },
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

async function measureScenario(browser, scenario) {
  const samples = [];
  for (let run = 0; run < RUNS; run++) {
    const context = await browser.newContext({ viewport: scenario.viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(COLLECTOR);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    try {
      const response = await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: "load", timeout: 30_000 });
      if (!response || response.status() >= 400) throw new Error(`navigation returned HTTP ${response?.status() ?? "none"}`);
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
      samples.push(reading);
    } finally {
      await context.close();
    }
  }
  return { ...scenario, samples, summary: summarizeScenario(samples) };
}

try {
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(6_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(`cannot reach ${BASE_URL} (${error.message})`);
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
try {
  console.log(`\nNavigation lab — ${BASE_URL}   CPU ${THROTTLE}x   ${RUNS} cold runs/scenario\n`);
  const scenarios = [];
  for (const scenario of MATRIX) {
    const measured = await measureScenario(browser, scenario);
    scenarios.push(measured);
    console.log(
      `${scenario.name.padEnd(20)} ` +
      `LCP ${measured.summary.lcpMs.median.toFixed(0).padStart(5)} ms ` +
      `(p90 ${measured.summary.lcpMs.p90.toFixed(0).padStart(5)})  ` +
      `FCP ${measured.summary.fcpMs.median.toFixed(0).padStart(5)}  ` +
      `TTFB ${measured.summary.ttfbMs.median.toFixed(0).padStart(4)}  ` +
      `CLS ${measured.summary.cls.max.toFixed(3)}`
    );
  }
  const report = {
    schema: 1,
    kind: "navigation",
    label: LABEL,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    browser: browser.version(),
    platform: `${process.platform}-${process.arch}`,
    cpuThrottle: THROTTLE,
    runs: RUNS,
    cache: "fresh browser context per run",
    network: "unthrottled; CDP Network domain deliberately unattached",
    scenarios,
  };
  if (OUT) {
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${OUT}`);
  }
} finally {
  await browser.close();
}
