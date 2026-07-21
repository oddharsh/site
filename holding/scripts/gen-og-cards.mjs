// gen-og-cards.mjs — build grabby Twitter/OG cards for every garage + lwe page.
//
// Each card is a 1200x630 PNG: the page's live interactive demo screenshotted
// and floated on the Bliss desktop, with a translucent XP dock naming the route.
// The demo panels already carry their own `.bar` title strip, so on the wallpaper
// they read as a little open XP app — which is exactly the "grabby, unmistakably
// this site" look we want in a link unfurl.
//
// Static by design: X's card fetcher hits the image URL once and caches it, so a
// cold on-the-fly render would risk a timeout + a blank card. We pre-bake, commit,
// and serve immutable. Regenerate when a demo's look changes:
//
//     npm run og-cards                                  # captures the LIVE site (aadhar.sh)
//     OG_BASE=http://localhost:8787 node holding/scripts/gen-og-cards.mjs   # local static server instead
//
// Captures production by default so data-driven demos (the photo grid, the live
// counters, the routing prober) render populated, not empty — which is exactly
// the alive look we want in an unfurl. The demos themselves are client-side and
// stable, so a card never depends on an undeployed edit. Point OG_BASE at a local
// server to preview a not-yet-live page (it self-boots one for localhost).
//
// Deps: playwright-core (scripts-only devDep) driving the installed Google Chrome.

import { chromium } from "playwright-core";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const HOLDING = path.join(ROOT, "holding");
const OUT = path.join(HOLDING, "og");
const BASE = (process.env.OG_BASE || "https://aadhar.sh").replace(/\/$/, "");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
const CARD_W = 1200, CARD_H = 630;

// Diagnostic/test harnesses that live under garage/ but aren't shareable content.
const EXCLUDE = new Set(["garage-vt-b", "garage-vt-check"]);

// Hero selector per page id (`<section>-<name>`). The generator tries each in
// order and takes the first visible, sensibly-sized match; anything not listed
// (or whose selectors all miss) falls back to the demo/canvas sweep, then to the
// top of the page's `.window`. `preset` clicks a control to populate a demo that
// renders empty on load.
const HERO = {
  // ── garage ──────────────────────────────────────────────────────────────
  "garage-blueprint": { hero: [".map"] },
  "garage-chunks":    { hero: [".method", "#cdc-chunks"] },
  "garage-cloudflare":{ hero: [".cf-feat", ".demo"] },
  "garage-encoding":  { hero: [".demo", ".sample-grid"] },
  "garage-gpt56":     { hero: [".workbench"] },
  "garage-horizon":   { hero: [".demo"] },
  "garage-iroh":      { hero: [".demo", ".idlabel"] },
  "garage-masonry":   { hero: [".sheet.masonry", ".masonry"] },
  "garage-pretext":   { hero: [".float-stage", "#float-canvas"] },
  "garage-safari27":  { hero: [".demo"] },
  "garage-scroll":    { hero: [".luna-scroller", ".scroll-room"] },
  "garage-teardown":  { hero: [".demo"] },
  "garage-tooltips":  { hero: [".vinyl-demo", ".recipe-grid"] },
  "garage-wire":      { hero: [".knob-panel", ".knob-grid"] },
  "garage-workers":   { hero: [".cf-feat:has(#probe-btn)"], preset: "#probe-btn" },
  // ── lwe ─────────────────────────────────────────────────────────────────
  "lwe-dac":      { hero: ["#demo-ladder", ".demo"] },
  "lwe-drivers":  { hero: ["#demo-motion", ".demo"] },
  "lwe-encoding": { hero: ["#demo-chroma", ".demo"] },
  "lwe-fhe":      { hero: ["#demo-add", ".demo"] },
  "lwe-knots":    { hero: ["#demo-knot", ".demo"] },
  "lwe-mpc":      { hero: ["#demo-mpc", ".demo"] },
  "lwe-pcrypto":  { hero: ["#demo-snark", ".demo"] },
  "lwe-tee":      { hero: ["#demo-tee", ".demo"] },
  "lwe-utf8":     { hero: ["#demo-enc", "#demo-anat", ".demo"] },
  "lwe-vigenere": { hero: ["#demo-crank", ".demo"], preset: ".preset[data-crank='trans']" },
};

// Selectors tried when a page has no HERO entry, or its listed heroes all miss.
const FALLBACK = [".demo", ".workbench", "canvas", ".map", ".content > figure"];

async function blissBackground() {
  // Reuse the exact wallpaper the live desktop paints, straight out of luna.css,
  // so the card background is pixel-identical to the real site (no second asset).
  const css = await readFile(path.join(HOLDING, "luna.css"), "utf8");
  const m = css.match(/#axp-desktop\s*\{[^}]*?background:\s*url\("([^"]+)"\)/);
  if (!m) throw new Error("could not find the Bliss wallpaper in luna.css");
  return m[1];
}

function cardHtml({ bliss, shot, favicon }) {
  // shot: data URI of the demo screenshot (captured at DSF 2, downscaled by the
  // browser to fit). Top-anchor so the grabbiest part (title bar + controls +
  // first result) survives. The only chrome is the page's favicon as a small
  // brand stamp bottom-left; the route reads fine from the tweet's own link text.
  const fav = favicon
    ? `<img class="fav" src="${favicon}" width="42" height="42" alt="">`
    : `<span class="fav fav--fallback"></span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${CARD_W}px;height:${CARD_H}px}
  .card{position:relative;width:${CARD_W}px;height:${CARD_H}px;overflow:hidden;
    background:url("${bliss}") center center/cover no-repeat;
    font-family:Tahoma,Verdana,Geneva,sans-serif}
  .stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:44px 54px 70px}
  .shot{max-width:1092px;max-height:500px;width:auto;height:auto;object-fit:contain;object-position:top center;
    border:1px solid rgba(0,0,0,.35);border-radius:7px 7px 5px 5px;
    box-shadow:0 18px 40px -8px rgba(8,26,54,.55),0 4px 12px rgba(8,26,54,.4)}
  .fav{position:absolute;left:34px;bottom:22px;border-radius:8px;box-shadow:0 2px 6px rgba(0,10,30,.5)}
  .fav--fallback{width:42px;height:42px;display:inline-block;border-radius:8px;
    background:linear-gradient(180deg,#4aa3ef,#1e63c8)}
  </style></head><body><div class="card">
    <div class="stage"><img class="shot" src="${shot}"></div>
    ${fav}
  </div></body></html>`;
}

async function listPages() {
  const out = [];
  for (const section of ["garage", "lwe"]) {
    const dir = path.join(HOLDING, section);
    for (const f of (await readdir(dir)).sort()) {
      if (!f.endsWith(".html")) continue;
      const name = f.slice(0, -5);
      if (name === "index") continue; // folder listings get no demo card
      const id = `${section}-${name}`;
      if (EXCLUDE.has(id)) continue;
      // clean routes on the live worker; the local static server needs the .html
      const url = LOCAL ? `${BASE}/${section}/${f}` : `${BASE}/${section}/${name}`;
      out.push({ id, section, name, url });
    }
  }
  return out;
}

async function capture(page, cardPage, p, bliss) {
  await page.setViewportSize({ width: 1440, height: 1680 });
  await page.goto(p.url, { waitUntil: "networkidle", timeout: 25000 });
  await page.waitForTimeout(900); // let demo JS + canvases settle

  const cfg = HERO[p.id] || {};
  if (cfg.preset) {
    const btn = page.locator(cfg.preset).first();
    if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(1600); }
  }

  // route label: reuse the page's own title-bar text (already "aadhar.sh/…").
  const route = (await page.locator(".window .title-bar .title-text").first().textContent().catch(() => null))
    ?.replace(/\s+/g, " ").trim() || `aadhar.sh/${p.section}/${p.name}`;
  const favicon = await page.getAttribute('link[rel="icon"]', "href").catch(() => null);

  // pick the hero element
  const candidates = [...(cfg.hero || []), ...FALLBACK];
  let box = null;
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(120);
    const b = await el.boundingBox();
    if (b && b.width >= 220 && b.height >= 120) { box = b; break; }
  }

  let clip;
  if (box) {
    // cap the height so a very tall demo doesn't shrink to a stamp
    const h = Math.min(box.height, Math.max(box.width * 0.72, 340), 900);
    clip = { x: box.x, y: Math.max(box.y, 0), width: box.width, height: h };
  } else {
    // last resort: the top of the page window (title bar + first screenful)
    const win = await page.locator(".window").first().boundingBox();
    clip = { x: win.x, y: Math.max(win.y, 0), width: win.width, height: Math.min(win.height, 760) };
  }

  // the demo is captured at 2x (supersampled); the card renders at 1x/1200x630
  // (the standard OG size), so the downscaled demo stays crisp while the file
  // stays a quarter the size of a full 2x card.
  const shotBuf = await page.screenshot({ clip, type: "png" });
  const shot = "data:image/png;base64," + shotBuf.toString("base64");

  await cardPage.setContent(cardHtml({ bliss, shot, favicon }), { waitUntil: "load" });
  await cardPage.waitForTimeout(150);
  const cardBuf = await cardPage.screenshot({ clip: { x: 0, y: 0, width: CARD_W, height: CARD_H }, type: "png" });
  await writeFile(path.join(OUT, `${p.id}.png`), cardBuf);
  return { id: p.id, route, usedFallback: !box };
}

// Boot a throwaway static server over holding/ so the generator is one command.
// Skipped when OG_BASE is set (reuse a dev server you already have running).
function waitForPort(port, ms = 8000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tick() {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => { s.destroy(); Date.now() > deadline ? reject(new Error(`static server never came up on :${port}`)) : setTimeout(tick, 150); });
    })();
  });
}
async function maybeStartServer() {
  if (!LOCAL) return null; // capturing a remote origin (production) — nothing to boot
  const port = 8787;
  const srv = spawn("python3", ["-m", "http.server", String(port), "--directory", HOLDING], { stdio: "ignore" });
  await waitForPort(port);
  console.log(`static server up on :${port} (serving holding/)`);
  return srv;
}

async function main() {
  if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });
  const server = await maybeStartServer();
  const bliss = await blissBackground();
  const pages = await listPages();
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars"] });
  const ctxHi = await browser.newContext({ deviceScaleFactor: 2 }); // demo capture (supersampled)
  const ctxLo = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: CARD_W, height: CARD_H } }); // 1200x630 card
  const cardPage = await ctxLo.newPage();
  const results = [];
  try {
    for (const p of pages) {
      const page = await ctxHi.newPage();
      try {
        const r = await capture(page, cardPage, p, bliss);
        results.push(r);
        console.log(`  ✓ ${r.id}${r.usedFallback ? "  (fallback: window top)" : ""}  ${r.route}`);
      } catch (e) {
        console.log(`  ✗ ${p.id}  ${e.message}`);
        results.push({ id: p.id, error: e.message });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); if (server) server.kill(); }

  const ok = results.filter(r => !r.error).length;
  const fb = results.filter(r => r.usedFallback).length;
  console.log(`\n${ok}/${results.length} cards written to holding/og/  (${fb} used the window fallback)`);
  if (fb) console.log("fallback pages may want a hero selector in HERO{} — check the gallery.");
}

main().catch(e => { console.error(e); process.exit(1); });
