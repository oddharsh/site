// gen-og-cards.mjs — build grabby Twitter/OG cards for every garage + lwe page,
// plus the top-level page directories registered in og-pages.mjs.

import { chromium } from "playwright-core";
import { chromeChannel } from "../lib/browser-channel.ts";
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { OG_PAGE_DIRS } from "./og-pages.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
// THE SERVED TREE IS THREE DIRECTORIES, so no single constant can name it. This
// read `const HOLDING = path.join(ROOT, "www")` until 2026-08-24, and www/ was
// deleted by the 2026-08-18 split (#457), which broke every path below at once:
// the cards were written to a www/og that mkdir created and nothing serves, the
// wallpaper read missed luna.css, and the section walk found no documents. It
// went unnoticed because nobody adds a page most weeks — /garage/useragent
// shipped on 2026-08-21 with no card and nothing said so. Same family as gotcha
// 40, and the same repair: name the tree each use actually wants, so the next
// rename breaks loudly at the constant instead of silently at the output.
const PUBLIC = path.join(ROOT, "public");
const PAGES = path.join(ROOT, "src/pages");
const STYLES = path.join(ROOT, "src/styles");
const SERVE = path.join(ROOT, ".build/public");
const OUT = path.join(PUBLIC, "og");
const BASE = (process.env.OG_BASE || "https://aadhar.sh").replace(/\/$/, "");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
const CARD_W = 1200, CARD_H = 630;

const EXCLUDE = new Set(["garage-vt-b", "garage-vt-check"]);

const HERO = {
  "garage-blueprint": { hero: [".map"] },
  "garage-chunks":    { hero: [".method", "#cdc-chunks"] },
  "garage-cloudflare":{ hero: [".cf-feat", ".demo"] },
  "garage-compression": { hero: [".cmp"] },
  "garage-octane":    { hero: [".oct-demo"] },
  "garage-pqc":       { hero: [".pqc-demo"] },
  "garage-encoding":  { hero: [".demo", ".sample-grid"] },
  "garage-hidden-flags": { hero: [".hf-demo"] },
  "garage-typed-config": { hero: [".tc-demo"] },
  "garage-useragent":  { hero: [".ua-demo"] },
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
  "garage-av2":        { span: [".av2-demo", "#av2-verdict"], hero: [".av2-demo"] },
  "garage-dictionary": { hero: [".dd-chart"] },
  "garage-htmx":       { hero: [".hb-demo"] },
  "garage-ig-prep":    { span: ['h2:has-text("What the chroma choice costs")', "#ig-chroma"], hero: [".ig-conf"] },
  "garage-resample":   { hero: ["#hl-demo"] },
  "garage-round-trip": { hero: ["#rt-demo"] },
  "lwe-dac":      { hero: ["#demo-ladder", ".demo"] },
  "lwe-drivers":  { hero: ["#demo-motion", ".demo"] },
  "lwe-encoding": { hero: ["#demo-chroma", ".demo"] },
  "lwe-fhe":      { hero: ["#demo-add", ".demo"] },
  "lwe-knots":    { hero: ["#demo-knot", ".demo"] },
  "lwe-lean":     { hero: ["#demo-spec", ".demo"] },
  "lwe-mpc":      { hero: ["#demo-mpc", ".demo"] },
  "lwe-pcrypto":  { hero: ["#demo-snark", ".demo"] },
  "lwe-tee":      { hero: ["#demo-tee", ".demo"] },
  "lwe-utf8":     { hero: ["#demo-enc", "#demo-anat", ".demo"] },
  "lwe-vigenere": { hero: ["#demo-crank", ".demo"], preset: ".preset[data-crank='trans']" },
  "access": { hero: [".mmc"] },
  "pixel-peeper": { preset: "#go", presetWait: 2600, span: [".row", ".gb"], hero: [".gb", ".tiles"] },
  "dotfiles": { hero: [".sheet:has(#df-list)"] },
  "home": { span: ["h1.p-name", ".photos"], spanMaxH: 640, hero: [".photos"] },
};

const FALLBACK = [".demo", ".workbench", "canvas", ".map", ".content > figure"];

const WORKER_PAGES = [
  {
    id: "lens",
    path: "/lens?url=https%3A%2F%2Fstripe.com%2F",
    span: [".lx-addr", ".lx-panes"],
    spanMaxH: 500,
    settle: 4000,
    preset: "#lx-browser-run",
    presetWait: 6000,
  },
];

const ONLY = process.env.OG_ONLY ? new Set(process.env.OG_ONLY.split(",").map((s) => s.trim())) : null;

async function blissBackground() {
  const css = await readFile(path.join(STYLES, "luna.css"), "utf8");
  const m = css.match(/#axp-desktop\s*\{[^}]*?background:\s*url\("([^"]+)"\)/);
  if (!m) throw new Error("could not find the Bliss wallpaper in luna.css");
  return m[1];
}

async function sectionIcon(section) {
  const file = path.join(PUBLIC, "section-icons", `${section}.svg`);
  if (!existsSync(file)) return null;
  return `data:image/svg+xml,${encodeURIComponent(await readFile(file, "utf8"))}`;
}

async function inlineRootRelative(href) {
  if (!/^\/[^/].*\.svg$/.test(href)) return href;
  const file = path.join(PUBLIC, href.slice(1));
  if (!file.startsWith(PUBLIC + path.sep) || !existsSync(file)) return href;
  return `data:image/svg+xml,${encodeURIComponent(await readFile(file, "utf8"))}`;
}

function cardHtml({ bliss, shot, favicon }) {
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
    const dir = path.join(PAGES, section);
    for (const f of (await readdir(dir)).sort()) {
      if (!f.endsWith(".html")) continue;
      const name = f.slice(0, -5);
      if (name === "index") continue;
      const id = `${section}-${name}`;
      if (EXCLUDE.has(id)) continue;
      const url = LOCAL ? `${BASE}/${section}/${f}` : `${BASE}/${section}/${name}`;
      out.push({ id, section, name, url });
    }
  }
  for (const p of WORKER_PAGES) {
    if (LOCAL) { console.log(`  - ${p.id}  skipped: worker route, and ${BASE} is the static server`); continue; }
    out.push({ id: p.id, url: BASE + p.path });
  }
  for (const p of OG_PAGE_DIRS) {
    const local = `${BASE}/${p.dir ? p.dir + "/" : ""}index.html`;
    out.push({ id: p.id, url: LOCAL ? local : `${BASE}/${p.dir}` });
  }
  return ONLY ? out.filter((p) => ONLY.has(p.id)) : out;
}

async function capture(page, cardPage, p, bliss) {
  await page.setViewportSize({ width: 1440, height: 1680 });
  await page.goto(p.url, { waitUntil: "networkidle", timeout: 25000 });
  await page.waitForTimeout(900);

  const cfg = HERO[p.id] || WORKER_PAGES.find((w) => w.id === p.id) || {};
  if (cfg.settle) await page.waitForTimeout(cfg.settle);
  if (cfg.preset) {
    const btn = page.locator(cfg.preset).first();
    if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(cfg.presetWait || 1600); }
  }

  const route = (await page.locator(".window .title-bar .title-text").first().textContent().catch(() => null))
    ?.replace(/\s+/g, " ").trim() || (p.section ? `aadhar.sh/${p.section}/${p.name}` : `aadhar.sh${p.url.replace(BASE, "")}`);
  const declared = await page.getAttribute('link[rel="icon"]', "href").catch(() => null);
  const favicon = (declared ? await inlineRootRelative(declared) : null) || (p.section ? await sectionIcon(p.section) : null);

  let box = null;
  if (cfg.span && cfg.span.length === 2) {
    const a = await page.locator(cfg.span[0]).first().boundingBox().catch(() => null);
    const b = await page.locator(cfg.span[1]).first().boundingBox().catch(() => null);
    if (a && b) {
      const x = Math.min(a.x, b.x);
      const spanH = b.y + b.height - a.y;
      box = { x, y: a.y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: cfg.spanMaxH ? Math.min(spanH, cfg.spanMaxH) : spanH, exact: true };
    }
  }
  const candidates = [...(cfg.hero || []), ...FALLBACK];
  for (const sel of candidates) {
    if (box) break;
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(120);
    const b = await el.boundingBox();
    if (b && b.width >= 220 && b.height >= 120) { box = b; break; }
  }

  let clip;
  if (box) {
    const h = box.exact ? Math.min(box.height, 900) : Math.min(box.height, Math.max(box.width * 0.72, 340), 900);
    clip = { x: box.x, y: Math.max(box.y, 0), width: box.width, height: h };
  } else {
    const win = await page.locator(".window").first().boundingBox();
    clip = { x: win.x, y: Math.max(win.y, 0), width: win.width, height: Math.min(win.height, 760) };
  }

  const shotBuf = await page.screenshot({ clip, type: "png", animations: "disabled" });
  const shot = "data:image/png;base64," + shotBuf.toString("base64");

  await cardPage.setContent(cardHtml({ bliss, shot, favicon }), { waitUntil: "load" });
  await cardPage.waitForTimeout(150);
  const cardBuf = await cardPage.screenshot({ clip: { x: 0, y: 0, width: CARD_W, height: CARD_H }, type: "png", animations: "disabled" });
  await writeCard(p.id, cardBuf);
  return { id: p.id, route, usedFallback: !box };
}

const ZENC = path.join(ROOT, "tools", "photos", "zenc", "target", "release", "zenc");
async function writeCard(id, pngBuf) {
  if (!existsSync(ZENC)) {
    throw new Error(`zenc is not built: cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml`);
  }
  const tmp = path.join(OUT, `.${id}.capture.png`);
  await writeFile(tmp, pngBuf);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ZENC, [tmp, path.join(OUT, `${id}.jpg`), "-q", "92", "--yuv", "444"], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`zenc exited ${code} on ${id}`)));
      child.on("error", reject);
    });
  } finally {
    await rm(tmp, { force: true });
  }
}

function waitForPort(port, ms = 8000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tick() {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(undefined); });
      s.once("error", () => { s.destroy(); Date.now() > deadline ? reject(new Error(`static server never came up on :${port}`)) : setTimeout(tick, 150); });
    })();
  });
}
async function maybeStartServer() {
  if (!LOCAL) return null;
  const port = 8787;
  if (!existsSync(SERVE)) {
    throw new Error(`${SERVE} is missing — run \`bun run build\` before capturing against a local server`);
  }
  const srv = spawn("python3", ["-m", "http.server", String(port), "--directory", SERVE], { stdio: "ignore" });
  await waitForPort(port);
  console.log(`static server up on :${port} (serving .build/public)`);
  return srv;
}

async function main() {
  if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });
  const server = await maybeStartServer();
  const bliss = await blissBackground();
  const pages = await listPages();
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true, args: ["--hide-scrollbars"] });
  const ctxHi = await browser.newContext({ deviceScaleFactor: 2 });
  const ctxLo = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: CARD_W, height: CARD_H } });
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
  console.log(`\n${ok}/${results.length} cards written to public/og/  (${fb} used the window fallback)`);
  if (fb) console.log("fallback pages may want a hero selector in HERO{} — check the gallery.");
  // A card that failed keeps its old JPEG, so the tree reads clean. Without a
  // non-zero exit, og-cards.yml reported "Every card already matches what
  // production renders" on a bake that wrote 0/1 cards (run 38481736111,
  // gotcha 62).
  if (ok < results.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
