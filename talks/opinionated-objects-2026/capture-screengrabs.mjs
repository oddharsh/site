// capture-screengrabs.mjs — retake the three /lens screengrabs the deck embeds.
//
// These were hand-taken until 2026-08-14, which is why swapping the Reader
// extractor left slide 5 showing a screenshot that said "Defuddle content
// recovery" next to a score row that said Readability. A script is the fix:
// the images are now reproducible from the live site instead of from whoever
// last had the window open at the right size.
//
//     node talks/opinionated-objects-2026/capture-screengrabs.mjs
//
// Captures PRODUCTION on purpose. The deck's own run of show does a live demo
// against aadhar.sh, so a screengrab taken from anything else would disagree
// with the thing on screen behind the presenter.
//
// Deps: playwright-core (already a scripts-only devDep) driving installed Chrome.

import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(here, "screengrabs");
const BASE = (process.env.LENS_BASE || "https://aadhar.sh").replace(/\/$/, "");
const TARGET = process.env.LENS_TARGET || "https://aadhar.sh/";
const W = 1180, H = 720;

// The three frames. Anchored to ELEMENTS rather than pixel offsets, because the
// pane's height changes once the extractor has run and a magic number silently
// captures the wrong band when it does.
//
// Note what is being scrolled. nav.js's OS-window model pins each .window and
// scrolls its .content internally, so `window.scrollTo` is a no-op here: the
// document is exactly one viewport tall. Measured on the live page, .content is
// 597 visible of 1596. A first pass at this script used window.scrollTo and
// wrote two byte-identical files, which is the whole reason this comment exists.
const SHOTS = [
  { file: "01-lens-overview.png",         anchor: null },
  { file: "02-composite-agent-access.png", anchor: "COMPOSITE AGENT ACCESS", pad: 150 },
  { file: "03-three-source-evidence.png",  anchor: "content recovery",       pad: 260 },
];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars"] });
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: W, height: H } });
const page = await ctx.newPage();

const url = `${BASE}/lens?url=${encodeURIComponent(TARGET)}`;
console.log("opening", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

// The Compare view fills in from several independent fetches. Wait on the one
// that arrives last rather than a fixed sleep.
await page.waitForSelector(".lx-pane, .lx-compare", { timeout: 60000 }).catch(() => {});

// Agent-ready? is a tab, and the Reader lens behind its third source is OPT-IN,
// so the composite reads "—" until something asks for it. Open the tab, then
// press the extractor button if the pane is still offering one.
const tab = page.locator('button:has-text("Agent-ready?"), .lx-tab:has-text("Agent-ready?")').first();
if (await tab.count()) { await tab.click().catch(() => {}); }

const run = page.locator('#lx-reader-run, button:has-text("Run the extractor")').first();
if (await run.count()) {
  console.log("clicking the extractor button");
  await run.click().catch(() => {});
}

// Wait for ALL THREE composite inputs, not just the extractor. The panel says
// "Waiting for all three independent views" and shows an em dash until the
// Cloudflare scanner, the field evidence and the extractor have each landed, and
// a first pass here waited on the extractor alone and captured that placeholder
// — which is precisely the "unfinished instead of moving the goalposts" state
// the slide exists to explain, photographed as if it were the answer.
await page.waitForFunction(() => {
  const t = document.body.innerText;
  if (!/Readability content recovery/i.test(t)) return false;
  if (/extracting|Waiting for all three|Asking Cloudflare/i.test(t)) return false;
  return /\b\d{1,3}\s*\/\s*100/.test(t);
}, { timeout: 120000 }).catch(() => console.log("warning: composite did not settle in time"));

// The Human pane renders from Browser Run and arrives last. Without this the
// left third of frames 1 and 2 photographs as a blank white box.
await page.waitForFunction(() => {
  const p = document.querySelector(".lx-pane, .lx-compare");
  return p && (p.querySelector("img, iframe, canvas") || (p.innerText || "").length > 400);
}, { timeout: 60000 }).catch(() => console.log("warning: human pane did not render in time"));

await page.waitForTimeout(1500);

// Browser Run is a 10 min/day ACCOUNT-WIDE budget and each render costs ~19s, so
// iterating on this script is itself a way to spend it. When it runs dry the
// pane says so and frame 1, whose whole subject is the three-pane comparison,
// photographs a "budget is spent" notice instead of a render. Measured
// 2026-08-14: that is exactly what four capture iterations cost, and frame 1 had
// to be restored from git. Refuse rather than write a degraded overview.
const spent = await page.evaluate(() => /Browser Run budget is spent|budget is spent/i.test(document.body.innerText));
if (spent && !process.env.LENS_ALLOW_SPENT_BUDGET) {
  console.error("REFUSING TO WRITE 01: the Browser Run budget is spent, so the overview frame");
  console.error("would show a degraded pane. Wait for the daily reset, or set");
  console.error("LENS_ALLOW_SPENT_BUDGET=1 to capture frames 2 and 3 only.");
  SHOTS.splice(0, 1);
}

// A last guard against the exact bug this whole exercise is about.
const stale = await page.evaluate(() => /Defuddle/i.test(document.body.innerText));
if (stale) {
  console.error("REFUSING TO WRITE: the live page still says Defuddle. Deploy lens-reader first.");
  await browser.close();
  process.exit(1);
}

const seen = new Set();
for (const { file, anchor, pad = 0 } of SHOTS) {
  const at = await page.evaluate(({ anchor, pad }) => {
    const box = document.querySelector("div.content");
    if (!box) return -1;
    if (!anchor) { box.scrollTop = 0; return 0; }
    // Tightest match, not the first leaf. "COMPOSITE AGENT ACCESS" sits in a div
    // that has children, so a leaf-only search misses it while "content recovery"
    // happens to be a leaf and succeeds, which looked like a flaky anchor.
    // Case-INSENSITIVE, because these labels are uppercased by CSS. The DOM
    // holds "Composite agent access" while the screen and the original
    // screengrab both read "COMPOSITE AGENT ACCESS", so a literal match finds
    // nothing and reads as a missing element rather than a casing mismatch.
    const needle = anchor.toLowerCase();
    const hit = [...box.querySelectorAll("*")]
      .filter((el) => (el.textContent || "").toLowerCase().includes(needle))
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
    if (!hit) return -1;
    box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - pad;
    return box.scrollTop;
  }, { anchor, pad });

  if (at < 0) { console.error(`REFUSING TO WRITE ${file}: anchor ${JSON.stringify(anchor)} not found`); process.exitCode = 1; continue; }

  await page.waitForTimeout(400);
  const buf = await page.screenshot({ type: "png" });

  // Two frames came back byte-identical on the first run, because the scroll was
  // going to the window instead of the pane and silently doing nothing. Identical
  // output is the symptom, so it is now an error rather than a thing to notice.
  const key = buf.length + ":" + buf.subarray(0, 512).toString("base64");
  if (seen.has(key)) { console.error(`REFUSING TO WRITE ${file}: identical to an earlier frame`); process.exitCode = 1; continue; }
  seen.add(key);

  await writeFile(path.join(OUT, file), buf);
  console.log("wrote", file, `(scrollTop ${Math.round(at)})`, buf.length, "bytes");
}

await browser.close();
