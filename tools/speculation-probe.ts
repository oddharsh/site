#!/usr/bin/env node
// speculation-probe.mjs — does a speculation rule actually fetch anything?
//
//   bun run build && node node_modules/wrangler/bin/wrangler.js dev \
//     -c .wrangler.site.jsonc -c counter/wrangler.jsonc --port 8806   # another shell
//   BASE=http://localhost:8806 bun run speculation:probe
//
// A BUILT tree, since 2026-09-30: the ruleset is a Speculation-Rules header
// naming a file the build writes, so `bun run dev` serves pages with no rules.
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
// So read the CONTROL line first every time. It injects its own ruleset for a
// URL the site's rules exclude, so it passes or fails independently of them. If
// it produces no origin hit, the run measured the instrument and says nothing
// about the rules. Step 1 then asks the site's own (header-delivered) rules.
import { chromium } from "playwright-core";
import { chromeChannel } from "./lib/browser-channel.ts";

const BASE = process.env.BASE || "http://localhost:8806";
const dwell = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: chromeChannel(), headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Where the page's ruleset came from. Since 2026-09-30 it is a Speculation-Rules
// response header naming one /a/ file, so the DOM holds no block on a built tree,
// and `inline` should read 0. The header is only present on a BUILT tree: `bun
// run dev` serves the readable source and names no ruleset at all, so run this
// against `wrangler dev` on .build (see csp-sweep's header for the recipe).
async function visible(label, response) {
  const v = await page.evaluate(() => ({
    vis: document.visibilityState,
    focus: document.hasFocus(),
    anchors: document.querySelectorAll('a[href^="/lwe/"], a[href^="/garage/"]').length,
    inline: document.querySelectorAll('script[type="speculationrules"]').length,
  }));
  const header = response?.headers()["speculation-rules"] ?? "none";
  console.log(`  [${label}] visibility=${v.vis} focus=${v.focus} matching-anchors=${v.anchors} inline-rulesets=${v.inline} Speculation-Rules=${header}`);
  return v;
}

// 0. The INSTRUMENT control, independent of the site's own rules. It adds an
// inline ruleset for one URL the site's rules EXCLUDE (/whoareyou), at
// immediate eagerness, so nothing but this block can fetch it. A GET
// /whoareyou in the server log means the browser, its visibility and the log
// can all see a speculation; its absence means the rest of this run measures
// nothing, whatever it prints.
//
// It runs in its OWN context with bypassCSP, and has to: every page here sends
// a hashed script-src, which blocks an injected inline ruleset exactly as it
// would block an injected script, so the first version of this control fetched
// nothing on a build whose own rules were working (2026-09-30). CSP is not what
// the control tests, and the site's rules in step 1 run under the real policy.
console.log("\n0. CONTROL: an injected immediate prefetch of /whoareyou, a URL the site's rules exclude");
const controlCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
const control = await controlCtx.newPage();
await control.goto(`${BASE}/lwe`, { waitUntil: "load" });
await control.evaluate(() => {
  const s = document.createElement("script");
  s.type = "speculationrules";
  s.textContent = JSON.stringify({ prefetch: [{ urls: ["/whoareyou"], eagerness: "immediate" }] });
  document.head.appendChild(s);
});
console.log("  expect GET /whoareyou in the server log within 3s");
await dwell(3000);
await controlCtx.close();

console.log("\n1. SITE RULES: does the moderate prerender fire? hover a link on /lwe");
const lweResponse = await page.goto(`${BASE}/lwe`, { waitUntil: "load" });
await visible("/lwe", lweResponse);
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
const utf8Response = await page.goto(`${BASE}/lwe/utf8`, { waitUntil: "load" });
await visible("/lwe/utf8", utf8Response);
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
