// record.ts: PREVIEW recorder for og:video clips. Drives a page's live demo
// through a scripted timeline, records the compositor with CDP screencast, and
// composes each frame onto the same Bliss card gen-og-cards.ts bakes.
//
//   bun tools/photos/og-video/record.ts <out-dir> [clip-id,...]
//
// Screencast frames arrive whenever the compositor paints, with a timestamp,
// so they are resampled to a fixed FPS by time instead of being taken as fast
// as screenshot() returns (that came out at 10 to 20 uneven fps and stuttered).
// Frame 0 is the page before any step runs, which is the still card's state.
import { chromium, type Browser } from "playwright-core";
import { chromeChannel } from "../../lib/browser-channel.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CLIPS, type Clip } from "./clips.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const BASE = (process.env.OG_BASE || "https://aadhar.sh").replace(/\/$/, "");
const CARD_W = 1200,
  CARD_H = 630,
  FPS = 30,
  DSF = 2;

// The wallpaper and the HyperCam 2 bitmap, both read out of luna.css so the
// card paints the bytes the desktop paints. HYPERCAM=0 leaves the mark off.
async function lunaAssets() {
  const css = await readFile(path.join(ROOT, "src/styles/luna.css"), "utf8");
  const m = css.match(/#axp-desktop\s*\{[^}]*?background:\s*url\("([^"]+)"\)/);
  if (!m) throw new Error("no Bliss wallpaper in luna.css");
  const hc = css.match(/body::before\{[^}]*?url\("(data:image\/svg\+xml,[^"]+)"\)/);
  return { bg: m[1], hypercam: process.env.HYPERCAM === "0" ? null : (hc?.[1] ?? null) };
}

async function favicon(page, section) {
  const href = await page.getAttribute('link[rel="icon"]', "href").catch(() => null);
  const svg = (rel) => {
    const f = path.join(ROOT, "public", rel);
    return existsSync(f) ? readFile(f, "utf8").then((s) => `data:image/svg+xml,${encodeURIComponent(s)}`) : null;
  };
  if (href?.startsWith("data:")) return href;
  if (href && /^\/[^/].*\.svg$/.test(href)) return svg(href.slice(1));
  return section ? svg(`section-icons/${section}.svg`) : null;
}

// The card document, with the demo drawn from a viewport-sized frame through a
// background crop so one screencast frame serves any clip box.
function cardHtml({ bg, hypercam }, fav, clip, vw, vh) {
  const s = Math.min(1092 / clip.width, 500 / clip.height);
  const w = Math.round(clip.width * s),
    h = Math.round(clip.height * s);
  const favEl = fav ? `<img class="fav" src="${fav}" width="42" height="42">` : `<span class="fav fb"></span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}html,body{width:${CARD_W}px;height:${CARD_H}px}
  .card{position:relative;width:${CARD_W}px;height:${CARD_H}px;overflow:hidden;background:url("${bg}") center/cover no-repeat}
  .stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:44px 54px 70px}
  .shot{width:${w}px;height:${h}px;background-repeat:no-repeat;
    background-size:${vw * s}px ${vh * s}px;background-position:${-clip.x * s}px ${-clip.y * s}px;
    border:1px solid rgba(0,0,0,.35);border-radius:7px 7px 5px 5px;
    box-shadow:0 18px 40px -8px rgba(8,26,54,.55),0 4px 12px rgba(8,26,54,.4)}
  .fav{position:absolute;left:34px;bottom:22px;border-radius:8px;box-shadow:0 2px 6px rgba(0,10,30,.5)}
  /* two bitmap px per System-font px: 336x32, the quarter-width HyperCam took of a 640px capture */
  .hc{position:absolute;left:0;top:0;width:336px;height:32px;background:#fff url("${hypercam}") 0 0/100% 100% no-repeat;image-rendering:pixelated}
  .fb{width:42px;height:42px;display:inline-block;background:linear-gradient(180deg,#4aa3ef,#1e63c8)}
  </style></head><body><div class="card"><div class="stage"><div class="shot" id="s"></div></div>${favEl}${hypercam ? '<div class="hc"></div>' : ""}</div></body></html>`;
}

async function cropBox(page, c: Clip) {
  const box = async (sel) =>
    page
      .locator(sel)
      .first()
      .boundingBox()
      .catch(() => null);
  if (c.span) {
    const a = await box(c.span[0]),
      b = await box(c.span[1]);
    if (a && b) {
      const x = Math.min(a.x, b.x);
      const h = b.y + b.height - a.y;
      return { x, y: a.y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: c.maxH ? Math.min(h, c.maxH) : h };
    }
  }
  for (const sel of c.hero) {
    const b = await box(sel);
    if (b && b.width >= 200 && b.height >= 100) return { ...b, height: c.maxH ? Math.min(b.height, c.maxH) : b.height };
  }
  throw new Error(`${c.id}: no crop selector matched`);
}

async function runStep(page, s) {
  switch (s.do) {
    case "wait":
      return page.waitForTimeout(s.ms);
    case "click":
      return page.locator(s.sel).first().click({ timeout: 3000 });
    case "hover":
      return page.locator(s.sel).first().hover({ timeout: 3000 });
    case "unhover":
      return page.mouse.move(2, 2);
    case "fill":
      return page.locator(s.sel).first().fill(s.value);
    case "type":
      return page
        .locator(s.sel)
        .first()
        .pressSequentially(s.value, { delay: s.delay ?? 90 });
    case "key":
      return page.keyboard.press(s.value);
    case "eval":
      return page.evaluate(s.fn, s.arg);
    case "waitFor":
      return page.waitForFunction(s.fn, s.arg, { timeout: s.ms ?? 15000 });
    case "scroll":
      return page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), s.sel);
    case "focus":
      return page.locator(s.sel).first().focus();
    // Pointer to a point inside an element, as fractions of its box.
    case "mouseTo": {
      const b = await page.locator(s.sel).first().boundingBox();
      if (!b) throw new Error(`no box for ${s.sel}`);
      return page.mouse.move(b.x + b.width * (s.rx ?? 0.5) + (s.dx ?? 0), b.y + b.height * (s.ry ?? 0.5) + (s.dy ?? 0), { steps: s.steps ?? 1 });
    }
    // Sweep a range input from `from` to `to` over `ms`, firing input events
    // the way a dragged thumb does.
    case "range": {
      const steps = Math.max(2, Math.round(s.ms / 40));
      for (let i = 0; i <= steps; i++) {
        const v = s.from + ((s.to - s.from) * i) / steps;
        await page
          .locator(s.sel)
          .first()
          .evaluate((el, v) => {
            el.value = String(v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, v);
        await page.waitForTimeout(s.ms / steps);
      }
      return;
    }
    default:
      throw new Error(`unknown step ${s.do}`);
  }
}

async function record(browser, cardPage, luna, c: Clip, out) {
  const vw = c.viewport?.width ?? 1440,
    vh = c.viewport?.height ?? 1000;
  // Screencast frames come back at CSS-pixel size from a DSF 2 context alone
  // (1440 wide, measured); the launch flag --force-device-scale-factor is what
  // makes the compositor paint 2880. html zoom also reached 2880, but doubled
  // every popover placed from clientX (the loupes, the balloon tips).
  const ctx = await browser.newContext({ deviceScaleFactor: DSF, viewport: { width: vw, height: vh } });
  // Pages that shuffle (masonry, pixel-peeper's trials) draw the same take every run.
  if (c.seed != null)
    await ctx.addInitScript((seed) => {
      let a = seed >>> 0;
      Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }, c.seed);
  const page = await ctx.newPage();
  await page.goto(BASE + c.path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(c.settle ?? 900);
  const fav = c.fav ?? (await favicon(page, c.section));
  for (const s of c.setup ?? []) await runStep(page, s);
  // The body doesn't scroll (overflow: hidden), the window's content pane
  // does, so scrollIntoView finds the right scroller where scrollBy can't.
  const anchor = c.span?.[0] ?? c.hero[0];
  // A spacer at the end of the scroller, so a demo that shrinks mid-clip
  // (utf8's table when its input empties) can't clamp the scroll and slide
  // the crop off it.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    let sc = el.parentElement;
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const pad = document.createElement("div");
    pad.style.height = "3000px";
    (sc ?? document.body).appendChild(pad);
    el.scrollIntoView({ block: "start" });
  }, anchor);
  await page.waitForTimeout(300);
  const raw0 = await cropBox(page, c);
  // Hold the demo at its starting height: a demo that shrinks mid-clip (utf8's
  // table while its input is empty) otherwise pulls the prose below it up into
  // a crop that doesn't move.
  await page.evaluate(
    (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) el.style.minHeight = `${el.getBoundingClientRect().height}px`;
      }
    },
    c.span ?? c.hero.slice(0, 1),
  );
  const pad = { top: 0, right: 0, bottom: 0, left: 0, ...c.pad };
  const clip = {
    x: Math.max(0, raw0.x - pad.left),
    y: Math.max(0, raw0.y - pad.top),
    width: raw0.width + pad.left + pad.right,
    height: raw0.height + pad.top + pad.bottom,
  };

  const cdp = await ctx.newCDPSession(page);
  const raw: { t: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (f) => {
    raw.push({ t: f.metadata.timestamp * 1000, data: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: vw * DSF, maxHeight: vh * DSF, everyNthFrame: 1 });
  // A screencast only emits on paint; nudge one so frame 0 exists before step 1.
  await page.evaluate(() => {
    document.body.style.outline = "0 solid transparent";
  });
  await page.waitForTimeout(400);
  const t0 = Date.now();
  for (const s of c.steps) await runStep(page, s);
  await page.waitForTimeout(c.tail ?? 300);
  const wallMs = Date.now() - t0 + 400;
  await cdp.send("Page.stopScreencast");
  await ctx.close();
  if (!raw.length) throw new Error(`${c.id}: screencast produced no frames`);

  // Resample: for each output tick, the latest frame painted at or before it.
  const start = raw[0].t;
  const total = Math.min(c.maxMs ?? 8000, Math.max(wallMs, raw[raw.length - 1].t - start + 33));
  const n = Math.round((total / 1000) * FPS);
  await cardPage.setContent(cardHtml(luna, fav, clip, vw, vh), { waitUntil: "load" });
  const dir = path.join(out, c.id, "frames");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let j = 0,
    last = -1;
  for (let i = 0; i < n; i++) {
    const t = start + (i * 1000) / FPS;
    while (j + 1 < raw.length && raw[j + 1].t <= t) j++;
    if (j !== last) {
      // Decode before swapping it in, or the screenshot can catch a blank shot.
      await cardPage.evaluate(async (d) => {
        const url = `data:image/png;base64,${d}`;
        const im = new Image();
        im.src = url;
        await im.decode();
        (document.getElementById("s") as HTMLElement).style.backgroundImage = `url(${url})`;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, raw[j].data);
      last = j;
    }
    const buf = await cardPage.screenshot({ type: "png" });
    await writeFile(path.join(dir, `f${String(i).padStart(4, "0")}.png`), buf);
  }
  return { id: c.id, frames: n, painted: raw.length, ms: Math.round(total) };
}

/** Record the clips in `only` (every clip when null) into <out>/<id>/frames.
 *  Returns the ids that recorded; a clip that fails is logged and skipped. */
export async function recordClips(out: string, only: Set<string> | null = null): Promise<string[]> {
  const luna = await lunaAssets();
  const launch = (extra: string[] = []) => chromium.launch({ channel: chromeChannel(), headless: true, args: ["--hide-scrollbars", ...extra] });
  const browser = await launch([`--force-device-scale-factor=${DSF}`]);
  // display: grid-lanes ships behind the experimental flag in Chrome, so the
  // masonry clip gets its own browser rather than turning the flag on everywhere.
  let flagged: Browser | null = null;
  // The card is composed in a browser WITHOUT the forced scale, or the
  // 1200x630 card would come back 2400x1260.
  const cardBrowser = await launch();
  const cardCtx = await cardBrowser.newContext({ deviceScaleFactor: 1, viewport: { width: CARD_W, height: CARD_H } });
  const cardPage = await cardCtx.newPage();
  const done: string[] = [];
  try {
    for (const c of CLIPS.filter((c) => !only || only.has(c.id))) {
      try {
        const b = c.experimental ? (flagged ??= await launch([`--force-device-scale-factor=${DSF}`, "--enable-experimental-web-platform-features"])) : browser;
        const r = await record(b, cardPage, luna, c, out);
        console.log(`  ok ${r.id}  ${r.frames} frames from ${r.painted} paints, ${r.ms} ms`);
        done.push(c.id);
      } catch (e) {
        console.log(`  FAIL ${c.id}  ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
    await cardBrowser.close();
    await flagged?.close();
  }
  return done;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: record.ts <out-dir> [ids]");
  await recordClips(out, process.argv[3] ? new Set(process.argv[3].split(",")) : null);
}
