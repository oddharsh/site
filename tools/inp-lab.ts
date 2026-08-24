#!/usr/bin/env node
// inp-lab.mjs — a local, repeatable INP measurement for the site's discrete
// interactions. This is the "controlled lab run" perf-budget.mjs names in its own
// header as the thing it deliberately does not do.
//
//   bun run inp                      # against wrangler dev on :8799
//   bun run inp --url https://aadhar.sh
//   bun run inp --throttle 6 --runs 12
//   bun run inp --headed          # watch it drive
//
// WHY THIS EXISTS
// CrUX (and PageSpeed Insights) give you an INP number with no attribution: you
// learn the page is at 50ms and nothing about WHICH interaction spent it. This
// drives each candidate interaction individually and reports them separately, so
// a regression points at a handler instead of at the site.
//
// FOUR THINGS THAT MAKE THE NUMBERS MEAN ANYTHING, each learned the hard way:
//
//   1. CPU THROTTLING IS MANDATORY. On an M-series Mac every handler is fast and
//      an unthrottled run measures the hardware, not the code. 4x is roughly a
//      mid-range phone; 6x is a slow one.
//
//   2. THE PAGE MUST ACTUALLY BE PAINTING. Event Timing still emits entries in a
//      hidden tab, but the durations are dominated by the tab not presenting, so
//      they look plausible and are fiction. (Long Animation Frames are worse: the
//      spec returns early for a hidden document, so a hidden tab reports a clean
//      zero that is indistinguishable from a fast page.) This asserts visibility
//      and refuses to report rather than emit a number it cannot stand behind.
//
//   3. INTERACTIONS MUST BE REAL. Playwright's click()/press() produce trusted
//      events with genuine presentation delay. A dispatchEvent() does not and
//      would quietly measure nothing.
//
//   4. REPORT THE MAX, NOT JUST THE MEDIAN. INP is approximately the WORST
//      interaction on the page, so an average is exactly the statistic that hides
//      what you are hunting. Both are printed; the max is the one that matters.
//
// WHAT IT DOES NOT MEASURE: drags and scrolls. INP counts click, tap, and
// keyboard only, so the three pointermove drag paths in nav.js — which is where
// most of the listener mass lives — cannot affect it and are not exercised here.

import { chromium } from "playwright-core";

// ── args ──────────────────────────────────────────────────────────────────────
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const URL_BASE = arg("--url", "http://localhost:8799");
const THROTTLE = Number(arg("--throttle", "4"));
const RUNS     = Number(arg("--runs", "9"));
const HEADED   = process.argv.includes("--headed");

// ── the interaction catalogue ─────────────────────────────────────────────────
// Deliberately only interactions that do NOT navigate: a navigation ends the
// measurement context and the entry is lost. That still covers the whole Run
// palette lifecycle, which is the site's main same-document interaction surface.
//
// This used to run twice, once with prefers-reduced-motion, to price the View
// Transition each of these handlers was wrapped in. The transitions came out on
// 2026-07-30 and the A/B went with them: both arms would now measure the same
// code. What is left is the thing worth keeping — per-interaction attribution,
// so a regression points at a handler instead of at the site.
const INTERACTIONS = [
  {
    name: "Start orb → open Run",
    note: "click; showModal + first render of the pool",
    run: async (page) => { await page.click("#axp-start"); await page.waitForTimeout(220); },
    reset: async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(220); },
  },
  {
    name: "⌘K → open Run",
    note: "keydown; same path as the orb, different entry point",
    run: async (page) => {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      await page.waitForTimeout(220);
    },
    reset: async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(220); },
  },
  {
    name: "keystroke in Run",
    note: "input → render(): scores the pool, rewrites ≤40 rows",
    setup: async (page) => {
      await page.click("#axp-start");
      await page.waitForTimeout(260);
      await page.click("#axp-run-in");
    },
    run: async (page) => { await page.keyboard.press("g"); await page.waitForTimeout(160); },
    reset: async (page) => {
      await page.fill("#axp-run-in", "").catch(() => {});
      await page.waitForTimeout(80);
    },
    teardown: async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); },
  },
  {
    name: "Esc → close Run",
    note: "keydown; dialog close + top-layer teardown",
    setup: async (page) => { await page.click("#axp-start"); await page.waitForTimeout(260); },
    run: async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(240); },
    reset: async (page) => { await page.click("#axp-start"); await page.waitForTimeout(260); },
    teardown: async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); },
  },
];

// ── in-page collector ─────────────────────────────────────────────────────────
// Groups Event Timing entries by interactionId and takes the max duration per
// group, which is the per-interaction latency INP is built from. Entries with
// interactionId === 0 are not interactions (hover, non-triggering keys) and are
// dropped. durationThreshold is floored at 16ms by the spec, so fast interactions
// legitimately produce no entry — that is reported as "<16" rather than as zero,
// because the two mean very different things.
const COLLECTOR = () => {
  window.__inp = { groups: new Map(), visible: document.visibilityState };
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.interactionId) continue;
      const prev = window.__inp.groups.get(e.interactionId) || 0;
      if (e.duration > prev) window.__inp.groups.set(e.interactionId, e.duration);
    }
  });
  po.observe({ type: "event", buffered: true, durationThreshold: 16 });
  window.__inpReset = () => { window.__inp.groups.clear(); };
  window.__inpRead  = () => ({
    max: window.__inp.groups.size ? Math.max(...window.__inp.groups.values()) : null,
    n: window.__inp.groups.size,
    visible: document.visibilityState,
  });
};

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v) => (v === null ? "  <16" : v.toFixed(1).padStart(6));

// ── one condition (VT on, or reduced-motion / VT off) ─────────────────────────
async function measure(browser, { reducedMotion, label }) {
  const context = await browser.newContext({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await page.goto(URL_BASE, { waitUntil: "load" });
  await page.waitForTimeout(600);          // let the deferred shell settle
  await page.evaluate(COLLECTOR);

  // Gate 2: refuse to report numbers from a page that is not presenting.
  const vis = await page.evaluate(() => document.visibilityState);
  if (vis !== "visible") {
    await context.close();
    throw new Error(
      `page reports visibilityState="${vis}" — Event Timing durations would be dominated by ` +
      `the tab not painting. Refusing to report. Try --headed.`
    );
  }
  if (!(await page.$("#axp-start"))) {
    await context.close();
    throw new Error("#axp-start not found — is nav.js loading? (a static server without the worker won't have it)");
  }

  // WARMUP — not optional, and not cosmetic. The first Run open pays one-time
  // costs the later ones never see: the dynamic import of /hoist.js (deliberately
  // deferred to first open so a visitor who never opens the palette never fetches
  // it) and the first showModal. Without this, whichever
  // interaction happens to be measured FIRST absorbs all of it and reads ~8x slower
  // than the identical interaction measured second — an ordering artifact that looks
  // exactly like a real finding.
  for (let w = 0; w < 3; w++) {
    await page.click("#axp-start");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.__inpReset());

  const results = [];
  for (const ix of INTERACTIONS) {
    const samples = [];
    if (ix.setup) await ix.setup(page);
    for (let i = 0; i < RUNS; i++) {
      await page.evaluate(() => window.__inpReset());
      await ix.run(page);
      const r = await page.evaluate(() => window.__inpRead());
      samples.push(r.max);                        // null means "under the 16ms floor"
      if (ix.reset) await ix.reset(page);
    }
    if (ix.teardown) await ix.teardown(page);
    const real = samples.filter((s) => s !== null);
    results.push({
      name: ix.name,
      note: ix.note,
      med: real.length ? median(real) : null,
      max: real.length ? Math.max(...real) : null,
      counted: real.length,
      total: samples.length,
    });
  }
  await context.close();
  return { label, results };
}

// ── main ──────────────────────────────────────────────────────────────────────
// Preflight: a dead server should say so in one line, not as a Playwright stack.
try {
  const res = await fetch(URL_BASE, { method: "GET", signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(
    `\ncannot reach ${URL_BASE} (${e.message})\n\n` +
    (URL_BASE.includes("localhost")
      ? `Start the dev server first:\n  bun run wrangler dev -c wrangler.dev.jsonc --port 8799\n\n` +
        `Or point at production:\n  bun run inp --url https://aadhar.sh\n`
      : `Check the URL is reachable.\n`)
  );
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
try {
  console.log(`\nINP lab — ${URL_BASE}   CPU ${THROTTLE}x   ${RUNS} runs/interaction\n`);

  const { results } = await measure(browser, { reducedMotion: false, label: "default" });

  const head = "interaction".padEnd(24) + "median".padStart(9) + "max".padStart(9) + "   samples";
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of results) {
    console.log(r.name.padEnd(24) + fmt(r.med) + fmt(r.max) + `   ${r.counted}/${r.total}`);
  }

  console.log();
  for (const r of results) {
    if (r.counted < r.total) {
      console.log(`  note: "${r.name}" produced an entry in ${r.counted}/${r.total} runs — ` +
                  `the rest landed under Event Timing's 16ms floor (that is a good sign).`);
    }
  }
  for (const r of results) console.log(`  ${r.name}: ${r.note}`);

  // Event Timing coarsens durations to 8ms for privacy, so nothing under 8ms is a
  // real difference and a single run cannot resolve better than that. Compare
  // against a previous run's numbers rather than reading one column as truth.
  const worst = results.reduce((m, r) => (r.max !== null && r.max > m ? r.max : m), 0);
  console.log(`\n  Event Timing quantises to 8ms, so treat anything under that as equal.`);
  console.log(
    worst >= 200
      ? `\n  Worst INP-counted interaction is ${worst.toFixed(0)}ms — past the 200ms "good"\n` +
        `  threshold. That is a real regression; the row above names the handler.\n`
      : `\n  Worst INP-counted interaction is ${worst.toFixed(0)}ms, inside the 200ms "good"\n` +
        `  threshold. Whatever INP is being spent, it is not being spent here.\n`
  );
} finally {
  await browser.close();
}
