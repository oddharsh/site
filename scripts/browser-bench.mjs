#!/usr/bin/env node

// Outcome-oriented browser smoke and performance sampler. It is intentionally
// separate from perf-budget.mjs: deterministic bytes gate CI, while browser
// timing remains evidence tied to one machine, browser build, and origin.

import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = new URL(process.argv[2] || "http://127.0.0.1:8787");
const routes = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["/", "/photos", "/writing", "/garage", "/lwe", "/lens", "/coffee", "/serendipity", "/pixel-peeper"];

const candidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
if (!executablePath) throw new Error("Chrome or Chrome Canary was not found. Set CHROME_BIN to its executable.");

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

const records = [];
for (const route of routes) {
  await page.addInitScript(() => {
    window.__bench = { lcp: 0, cls: 0 };
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      window.__bench.lcp = entries.at(-1)?.startTime ?? window.__bench.lcp;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__bench.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const startedErrors = consoleErrors.length;
  const response = await page.goto(new URL(route, base).href, { waitUntil: "load" });
  await page.waitForTimeout(100);
  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    return {
      ttfb: navigation?.responseStart ?? null,
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      lcp: window.__bench?.lcp ?? null,
      cls: window.__bench?.cls ?? null,
      requests: resources.length + 1,
      transferred: (navigation?.transferSize ?? 0) + resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
      scriptBytes: resources.filter((item) => item.initiatorType === "script").reduce((sum, item) => sum + (item.transferSize || 0), 0),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      title: document.title,
    };
  });
  records.push({
    route,
    status: response?.status() ?? null,
    ...metrics,
    consoleErrors: consoleErrors.slice(startedErrors),
  });
}

await browser.close();
console.log(JSON.stringify({
  sampledAt: new Date().toISOString(),
  browser: executablePath,
  base: base.href,
  caveat: "Lab sample, not field data. Compare shapes and regressions on the same machine; do not treat local TTFB as production TTFB.",
  records,
}, null, 2));

if (records.some((record) => record.status !== 200 || record.overflowX || record.consoleErrors.length)) process.exitCode = 1;
