#!/usr/bin/env node
// speculation-probe.mjs — does a speculation rule actually fetch anything?
//
//   bun run dev            # in another shell, then
//   BASE=http://localhost:8787 bun run speculation:probe
//
// Written to settle whether the eager /garage/* + /lwe/* prefetch rule earned its
// place (#338). It did not: zero documents when /lwe offered it 12 matching
// anchors at load, and zero when the Run palette injected 30 more, while the
// control in the same run reached the origin. Kept because the next person to
// reason about a rule by reading it deserves the same control.
//
// TWO instrument traps here, and each produces a confident false zero.
//
// The measurement is the DEV SERVER's request log, NEVER Resource Timing. A
// speculation fetch is issued by the browser's preloading machinery and never
// appears in the initiating document's resource entries, so
// performance.getEntriesByType("resource") reports nothing for a rule that is
// working perfectly.
//
// And Chrome gates speculation on VISIBILITY. Every agent-driven browser surface
// here backgrounds its tab between calls, which disables the feature silently:
// measured hidden in both, with a hover landing on a real anchor and dwelling
// four seconds for nothing. Hence a real headful window. It also attaches no CDP
// session, which gotcha 15 used to give a reason for; that reason did not survive
// re-measurement, so treat it as one less variable rather than a known hazard.
//
// So read the CONTROL line first every time. If hovering a link produces no
// origin hit, the run measured the instrument and says nothing about the rules.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:8806";
const dwell = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function visible(label) {
  const v = await page.evaluate(() => ({
    vis: document.visibilityState,
    focus: document.hasFocus(),
    anchors: document.querySelectorAll('a[href^="/lwe/"], a[href^="/garage/"]').length,
    rules: !!document.querySelector('script[type="speculationrules"]'),
  }));
  console.log(`  [${label}] visibility=${v.vis} focus=${v.focus} matching-anchors=${v.anchors} ruleset=${v.rules}`);
  return v;
}

console.log("\n1. CONTROL: does moderate prerender fire at all? hover a link on /lwe");
await page.goto(`${BASE}/lwe`, { waitUntil: "load" });
await visible("/lwe");
await dwell(1500);
const link = page.locator('a[href^="/lwe/"]').first();
const href = await link.getAttribute("href");
await link.hover();
console.log(`  hovering ${href} for 4s`);
await dwell(4000);

console.log("\n2. EAGER: /lwe carries 12 matching anchors at load. anything prefetched?");
await page.goto(`${BASE}/lwe`, { waitUntil: "load" });
await dwell(4000);

console.log("\n3. RUN BURST: open the palette on a leaf page with 0 matching anchors");
await page.goto(`${BASE}/lwe/utf8`, { waitUntil: "load" });
await visible("/lwe/utf8");
await dwell(1500);
await page.keyboard.press("Meta+k");
await dwell(1200);
const injected = await page.evaluate(
  () => document.querySelectorAll('#axp-run a[href^="/lwe/"], #axp-run a[href^="/garage/"], .axp-run a[href^="/lwe/"], .axp-run a[href^="/garage/"], a.opt[href^="/lwe/"], a.opt[href^="/garage/"]').length,
);
console.log(`  palette injected ${injected} anchors matching the eager rule`);
await dwell(5000);

await browser.close();
console.log("\ndone. read the dev server log for what the origin actually saw.\n");
