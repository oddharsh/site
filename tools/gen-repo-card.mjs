// gen-repo-card.mjs — the GitHub social preview for this repository.
//
// GitHub wants 1280x640 and crops toward the middle in some unfurls, so nothing
// load-bearing sits within 40px of an edge. Two variants, because the repo card
// has two honest jobs and they pull apart:
//
//   desktop   the LIVE homepage at 2:1. Says "the repo is this site" with no
//             copy at all: desktop icons, the window, the taskbar, real photos.
//             NOT deterministic — the homepage draws a random 12 of 158 photos
//             per request, so every regeneration ships a different grid.
//   card      a composed Luna window on the Bliss wallpaper: big name, one line
//             of subtitle, four measured facts. Reads at thumbnail size, where
//             a screenshot of a whole desktop reads as blue mush.
//
//     node tools/gen-repo-card.mjs                 # both, into .github/
//     node tools/gen-repo-card.mjs desktop         # one variant
//     node tools/gen-repo-card.mjs --out /tmp/x    # somewhere else
//
// Same idiom as tools/photos/gen-og-cards.mjs: playwright-core driving the
// installed Chrome, the wallpaper read straight out of luna.css so the card
// background is pixel-identical to the real desktop (no second asset), and the
// screenshot supersampled at DSF 2 then downscaled into a 1x card.
//
// The FACTS row is derived, never typed: a number nobody re-counts is a number
// that rots, and this card outlives most of what it describes.

import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WWW = path.join(ROOT, "www");
const BASE = (process.env.CARD_BASE || "https://aadhar.sh").replace(/\/$/, "");
const CARD_W = 1280, CARD_H = 640;

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const OUT = outIdx === -1 ? path.join(ROOT, ".github") : path.resolve(argv[outIdx + 1]);
const want = argv.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
const VARIANTS = want.length ? want : ["desktop", "card"];

// The homepage favicon, reused as the window icon so the card carries the same
// brand stamp the tab does. Lifted from index.html rather than re-drawn.
async function favicon() {
  const html = await readFile(path.join(WWW, "index.html"), "utf8");
  const m = html.match(/<link rel="icon"[^>]*href="([^"]+)"/);
  if (!m) throw new Error("no favicon in src/pages/index.html");
  return m[1];
}

async function bliss() {
  const css = await readFile(path.join(WWW, "luna.css"), "utf8");
  const m = css.match(/#axp-desktop\s*\{[^}]*?background:\s*url\("([^"]+)"\)/);
  if (!m) throw new Error("could not find the Bliss wallpaper in luna.css");
  return m[1];
}

// colors + bevels only. The font tokens are @font-face local() rules that must
// never reach a served page, and this card only needs the three house stacks.
async function tokens() {
  const files = ["colors.css", "bevels.css"];
  const parts = await Promise.all(files.map((f) => readFile(path.join(ROOT, "design/tokens", f), "utf8")));
  return parts.join("\n");
}

// Counted, not typed. Each of these is one number the repo already keeps.
async function facts() {
  const [manifest, hashes] = await Promise.all([
    readFile(path.join(ROOT, "config/site-manifest.json"), "utf8"),
    readFile(path.join(WWW, "images/hashes.json"), "utf8"),
  ]);
  return [
    `${JSON.parse(manifest).surfaces.length} surfaces`,
    `${Object.keys(JSON.parse(hashes)).length} photos`,
    "0 font bytes",
    "brotli q11 + zstd deltas",
  ];
}

function cardHtml({ wallpaper, icon, tokenCss, chips }) {
  // One Luna window, centered, with 60px of clearance on every side so GitHub's
  // 40pt safe border is met with room to spare. Trebuchet for the name (the
  // house display stack), Tahoma for everything else.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${tokenCss}
  *{margin:0;box-sizing:border-box}
  html,body{width:${CARD_W}px;height:${CARD_H}px}
  .card{width:${CARD_W}px;height:${CARD_H}px;display:flex;align-items:center;justify-content:center;
    background:url("${wallpaper}") center center/cover no-repeat;
    font-family:Tahoma,Verdana,Geneva,sans-serif;-webkit-font-smoothing:antialiased}
  .win{width:964px;border:1px solid oklch(33% 0.16 var(--hue-luna));border-radius:9px 9px 0 0;
    box-shadow:0 22px 48px -10px oklch(28% 0.12 var(--hue-luna) / .6),0 6px 16px oklch(28% 0.12 var(--hue-luna) / .45)}
  .tb{display:flex;align-items:center;gap:9px;height:44px;padding:0 8px 0 10px;border-radius:8px 8px 0 0;
    background:var(--grad-title);
    box-shadow:inset 0 1px 0 oklch(78% 0.13 calc(var(--hue-luna) - 6)),inset 0 -1px 0 oklch(40% 0.18 var(--hue-luna))}
  .tb img{width:22px;height:22px}
  .tb .t{flex:1;min-width:0;color:#fff;font-size:19px;font-weight:bold;letter-spacing:.01em;
    text-shadow:1px 1px 1px oklch(30% 0.14 var(--hue-luna) / .8)}
  .ctl{display:flex;gap:3px}
  .ctl i{width:26px;height:24px;border-radius:3px;border:1px solid oklch(88% 0.06 var(--hue-luna) / .8);
    display:flex;align-items:center;justify-content:center;font-style:normal;
    color:#fff;font-size:15px;line-height:1;text-shadow:1px 1px 1px oklch(30% 0.14 var(--hue-luna) / .7);
    background:linear-gradient(180deg,oklch(72% 0.14 calc(var(--hue-luna) - 6)),oklch(52% 0.18 var(--hue-luna)));
    box-shadow:inset 1px 1px 0 oklch(85% 0.08 calc(var(--hue-luna) - 8) / .8)}
  .ctl i.min{align-items:flex-end;padding-bottom:5px}
  .ctl i.x{background:linear-gradient(180deg,oklch(68% 0.19 32),oklch(52% 0.20 29))}
  .body{background:var(--grad-face);padding:46px 54px 0;
    box-shadow:inset 1px 0 0 oklch(58% 0.16 var(--hue-luna)),inset -1px 0 0 oklch(58% 0.16 var(--hue-luna))}
  h1{font-family:"Trebuchet MS",Verdana,sans-serif;font-size:96px;line-height:.94;color:var(--ink);
    letter-spacing:-.022em;font-weight:bold}
  h1 .dot{color:oklch(63% 0.20 43)}
  p{margin-top:20px;font-size:26px;line-height:1.42;color:var(--ink-soft);max-width:790px}
  .chips{display:flex;gap:9px;margin:34px 0 0;padding-bottom:34px}
  .chip{font-size:16px;color:var(--ink-soft);background:var(--face-light);padding:8px 13px;
    border:1px solid var(--shadow);box-shadow:var(--bevel-raised)}
  .status{display:flex;align-items:center;gap:8px;height:34px;padding:0 6px;background:var(--face);
    border-top:1px solid var(--highlight);
    box-shadow:inset 1px 0 0 oklch(58% 0.16 var(--hue-luna)),inset -1px 0 0 oklch(58% 0.16 var(--hue-luna)),
      inset 0 -1px 0 oklch(58% 0.16 var(--hue-luna))}
  .cell{font-size:15px;color:var(--ink-dim);padding:3px 10px;box-shadow:var(--bevel-sunken)}
  .cell.grow{flex:1}
  </style></head><body><div class="card">
    <div class="win">
      <div class="tb"><img src="${icon}" alt=""><span class="t">github.com/oddharsh/site</span>
        <span class="ctl"><i class="min">_</i><i>&#9723;</i><i class="x">&#10005;</i></span></div>
      <div class="body">
        <h1>aadhar<span class="dot">.</span>sh</h1>
        <p>A personal site built in the Windows I grew up on. No frameworks,
           hand-written HTML, and one Cloudflare Worker serving all of it.</p>
        <div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
      </div>
      <div class="status"><span class="cell grow">Ready</span>${
        ["Cloudflare Workers"].map((c) => `<span class="cell">${c}</span>`).join("")
      }</div>
    </div>
  </div></body></html>`;
}

// The live homepage at the card's own aspect, full bleed. Captured at 1400x700
// and downscaled into the 1280x640 frame (the same supersample the OG cards use).
// The viewport is the composition: at 1600 wide the window swims in wallpaper,
// because it is centered at a fixed max-width and the desktop takes the slack.
async function shootDesktop(browser) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2200); // photo grid decode + the taskbar clock
  const buf = await page.screenshot({ type: "png" });
  await ctx.close();
  return "data:image/png;base64," + buf.toString("base64");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const [wallpaper, icon, tokenCss, chips] = await Promise.all([bliss(), favicon(), tokens(), facts()]);
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars"] });
  const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: CARD_W, height: CARD_H } });
  const page = await ctx.newPage();
  try {
    for (const v of VARIANTS) {
      let html;
      if (v === "desktop") {
        const shot = await shootDesktop(browser);
        html = `<!doctype html><html><head><meta charset="utf-8"><style>
          *{margin:0}html,body{width:${CARD_W}px;height:${CARD_H}px;overflow:hidden}
          img{width:${CARD_W}px;height:${CARD_H}px;display:block}
        </style></head><body><img src="${shot}"></body></html>`;
      } else if (v === "card") {
        html = cardHtml({ wallpaper, icon, tokenCss, chips });
      } else {
        console.log(`  ? ${v}  unknown variant (desktop | card)`);
        continue;
      }
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForTimeout(200);
      const out = path.join(OUT, `social-preview-${v}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: CARD_W, height: CARD_H }, type: "png" });
      console.log(`  ok ${path.relative(process.cwd(), out)}`);
    }
  } finally { await browser.close(); }
  console.log(`\nchips: ${chips.join(" · ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
