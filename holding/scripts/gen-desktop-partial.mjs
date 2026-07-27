#!/usr/bin/env node
// gen-desktop-partial.mjs — bake the XP desktop shell (wallpaper + icons +
// taskbar) as static markup, generated FROM nav.js's own data blocks so the
// two can't drift silently (shell rewrite, phase B).
//
// nav.js used to construct this DOM on every page load; now every document
// ships it as HTML (desktop exists for curl, readers, and JS-off visitors;
// CLS 0), and nav.js's builders ADOPT the markup and only wire behavior.
// Run this after editing PROFILES / SUBPAGES / SECTION_ICONS / the tray
// template in nav.js, then re-insert into the static pages:
//
//   node holding/scripts/gen-desktop-partial.mjs          # regen lib/desktop.js + patch static pages
//
// Deliberate deltas from the constructed DOM:
//   - the Start orb ships as <a href="/run"> (the palette's no-script floor);
//   - the sound toggle ships hidden + unpainted (sounds need JS; wireTaskbar
//     unhides and paints it);
//   - the clock span ships empty (a wrong clock never renders);
//   - .axp-kbd ships "⌘K" (wireTaskbar rewrites per platform);
//   - tray aria-haspopup/expanded are added by wiring, not markup, so with
//     JS off the tray icons are honest plain links.

import { readFileSync, writeFileSync } from "node:fs";

const NAV = readFileSync("holding/nav.js", "utf8");
const lines = NAV.split("\n");

function sliceBlock(startMarker, endMarker) {
  const s = lines.findIndex(l => l.includes(startMarker));
  if (s === -1) throw new Error("missing " + startMarker);
  let e = s;
  while (!lines[e].trimEnd().endsWith(endMarker)) e++;
  return lines.slice(s, e + 1).join("\n");
}

// data blocks, evaled from the source so nav.js stays the single truth
const evalVar = (start, end) =>
  eval(sliceBlock(start, end).replace(/^\s*var \w+ =/, "(").replace(/;\s*$/, "") + ")");
const PROFILES = evalVar("var PROFILES = [", "];");
const SUBPAGES = evalVar("var SUBPAGES = [", "];");
// SECTION_ICONS is built with the sectionTile() helper right above it
const sectionTile = eval("(" + sliceBlock("function sectionTile(", "  }") + ")");
const SECTION_ICONS = evalVar("var SECTION_ICONS = {", "};");
const qlColor = eval("(" + sliceBlock("function qlColor(", "  }") + ")");
const qlGlyph = eval("(" + sliceBlock("function qlGlyph(", "  }") + ")");
// the tray is a plain string-concatenation template in buildTaskbar — eval it
const trayExpr = sliceBlock("var tray = el('<div id=\"axp-tray\">'", "</div>');")
  .replace(/^\s*var tray = el\(/, "(").replace(/\);\s*$/, ")");
const TRAY_HTML = eval(trayExpr);

// nav.js tags profiles before boot: shared refs gain path + kind
PROFILES.forEach(p => { p.path = p.url; p.kind = "profile"; });
const DESKTOP = [{ label: "Notepad", path: "/writing", kind: "note", hint: "writing, in flux" }].concat(PROFILES);

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ── the icon sprite ──
// The 12 taskbar + tray icons are the single largest thing in the partial:
// 16.2KB raw / 2.2KB brotli, billed on EVERY document, because HTML ships
// private, no-cache and there is no cache to amortise them against. They are
// byte-identical on all ~30 pages, so they belong in one immutable file fetched
// once. Only the PARTIAL gets sprite refs: nav.js keeps its inline SECTION_ICONS
// because that same markup is also serialized into a per-route
// data:image/svg+xml favicon (setFavicon, nav.js), and a sprite ref cannot
// resolve inside a data URI. So the sprite is GENERATED from those bytes rather
// than replacing them, and nav.js stays the single source of truth.
//
// The refs are <img src="icons.svg#name"> against <view> elements, NOT <svg><use>
// against <symbol>s. <use> shipped first and rendered every icon hollow in Safari:
// WebKit will not resolve a url(#…) PAINT SERVER reference from inside a <use>
// shadow tree, and all 12 of these are gradient art, so the tiles came out
// transparent with only the strokes and the white pictogram left. Measured in
// WebKit 26.5 across six variants — external and inline, <symbol> and <g>,
// gradients in the symbol's own <defs> and hoisted to the sprite root — and all
// six failed, so moving the <defs> around does not rescue it. Rendering each icon
// as an IMAGE sidesteps the whole question: the sprite is its own document, so
// its gradients and filters resolve locally, the way they do when nav.js inlines
// the same bytes. Verified identical in WebKit 26.5 and Chromium; <view> fragments
// have been supported since Firefox 15.
//
// Layout is a single column, each icon at its NATIVE viewBox with no scaling (the
// tray's 24-unit art stays 24 units), so the sprite is the same picture the
// symbols held. GUTTER is the reason for the gaps: feDropShadow filter regions run
// ~5 units past the art, and without slack one icon's shadow bleeds into the next
// icon's view window.
const GUTTER = 16;
const cells = [];
let spriteY = 0;
function spriteRef(name, svg) {
  const [x0, y0, w, h] = (svg.match(/viewBox="([^"]+)"/) || [, "0 0 32 32"])[1].split(/\s+/).map(Number);
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  cells.push({ name, inner, dy: spriteY, view: `${x0} ${y0 + spriteY} ${w} ${h}`, right: x0 + w, bottom: y0 + spriteY + h });
  spriteY += h + GUTTER;
  // luna.css sizes the box (.axp-pin .fav img, .axp-trayico img); the <view>'s
  // viewBox crops the strip back down to this one icon at its original geometry.
  return `<img src="/icons.svg#${name}" alt="">`;
}

// ── the three chunks ──
const desktopHtml = '<div id="axp-desktop" aria-hidden="true"></div>';

const iconsHtml = '<nav id="axp-icons" aria-label="desktop shortcuts">' +
  DESKTOP.map((it, i) => {
    const ext = it.kind === "profile";
    const cls = it.kind === "note" ? "note" : "";
    const style = ext ? ` style="background:${qlColor(it.icon || it.label)}"` : "";
    const inner = ext ? qlGlyph(it.icon || it.label) : "";
    return `<a class="axp-ico"${ext ? ' target="_blank" rel="noopener me external"' : ""}` +
      ` title="${esc(it.hint || it.label)}${ext ? " (opens in a new tab)" : ""}"` +
      ` href="${esc(it.path)}" data-key="${esc(it.label)}" style="left:9px;top:${9 + i * 86}px">` +
      `<span class="ic ${cls}"${style} aria-hidden="true">${inner}</span>` +
      `<span class="t">${esc(it.label)}</span></a>`;
  }).join("") + "</nav>";

const pinsHtml = SUBPAGES.map(s =>
  `<a class="axp-pin" title="${esc(s.hint)}" href="${esc(s.path)}">` +
  // the sprite name becomes an SVG <view> id, which cannot carry a space, so a
  // multi-word pin label ("pixel peeper") is slugged. nav.js keeps keying
  // SECTION_ICONS by the raw label — only the sprite id is constrained.
  `<span class="fav" aria-hidden="true">${SECTION_ICONS[s.label] ? spriteRef("pin-" + s.label.replace(/\s+/g, "-"), SECTION_ICONS[s.label]) : ""}</span>` +
  `<span class="lbl">${esc(s.label)}</span></a>`).join("");

// the tray template carries its three icons inline; swap each for a sprite ref
// keyed by the anchor's data-kind, which is already the stable name here.
const trayWithSound = TRAY_HTML
  .replace(/data-kind="([a-z]+)"([\s\S]*?)(<svg[\s\S]*?<\/svg>)/g,
    (_, kind, between, svg) => `data-kind="${kind}"${between}${spriteRef("tray-" + kind, svg)}`)
  .replace('<div id="axp-tray">',
    '<div id="axp-tray"><button id="axp-sound" type="button" hidden></button>');

const taskbarHtml =
  '<div id="axp-taskbar" role="navigation" aria-label="taskbar">' +
  '<a id="axp-start" href="/run" aria-haspopup="dialog" aria-expanded="false">' +
  '<span id="axp-cone" aria-hidden="true"></span>start' +
  '<span class="axp-kbd" aria-hidden="true">⌘K</span></a>' +
  `<div id="axp-pins">${pinsHtml}</div>` +
  '<div id="axp-spacer"></div>' +
  trayWithSound + "</div>";

// ── lib/desktop.js for the worker templates ──
const mod = `// lib/desktop.js — the static XP desktop shell, GENERATED by
// scripts/gen-desktop-partial.mjs from nav.js's own data (do not hand-edit;
// re-run the generator after changing PROFILES/SUBPAGES/SECTION_ICONS there).
// DESKTOP_TOP opens <body> (the wallpaper layer, painted by luna.css);
// DESKTOP_CHROME sits at the end of <body> (icons + taskbar). nav.js adopts
// both and only wires behavior.
export const DESKTOP_TOP = ${JSON.stringify(desktopHtml)};
export const DESKTOP_CHROME = ${JSON.stringify(iconsHtml + taskbarHtml)};
`;
writeFileSync("holding/_worker.js/lib/desktop.js", mod);
console.log(`lib/desktop.js: top ${desktopHtml.length}B, chrome ${(iconsHtml + taskbarHtml).length}B`);

// ── holding/icons.svg — the sprite the partial's <img> refs crop into ──
// Must be written AFTER the chunks above, since spriteRef() fills `cells` as a
// side effect of building them. Served same-origin (CSP img-src 'self' covers it)
// and content-hashed into /a/ by build.mjs, so the unhashed /icons.svg stays only
// as the fallback for stale HTML. The root carries a real width/height/viewBox
// rather than the symbol sprite's display:none, because this file is now rendered
// as an image: a bare /icons.svg load shows the whole strip, which is a useful
// thing to be able to eyeball.
const spriteW = Math.max(...cells.map(c => c.right));
const spriteH = Math.max(...cells.map(c => c.bottom));
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteW}" height="${spriteH}" viewBox="0 0 ${spriteW} ${spriteH}">` +
  "<!-- GENERATED by scripts/gen-desktop-partial.mjs from nav.js SECTION_ICONS + the tray template. Do not hand-edit. -->" +
  cells.map(c => `<view id="${c.name}" viewBox="${c.view}"/>`).join("") +
  cells.map(c => `<g transform="translate(0 ${c.dy})">${c.inner}</g>`).join("") + "</svg>\n";
writeFileSync("holding/icons.svg", sprite);
console.log(`holding/icons.svg: ${cells.length} views, ${spriteW}x${spriteH}, ${sprite.length}B`);

// ── patch the static pages, idempotently, between markers ──
const TOP_OPEN = "<!-- axp:desktop -->", TOP_CLOSE = "<!-- /axp:desktop -->";
const CHROME_OPEN = "<!-- axp:shell -->", CHROME_CLOSE = "<!-- /axp:shell -->";
const topBlock = `${TOP_OPEN}${desktopHtml}${TOP_CLOSE}`;
const chromeBlock = `${CHROME_OPEN}${iconsHtml}${taskbarHtml}${CHROME_CLOSE}`;

import { readdirSync } from "node:fs";
// vt-check/vt-b are deliberately shell-free diagnostic mules — they test the
// bare platform, so the desktop partial must never touch them
const BARE = new Set(["vt-check.html", "vt-b.html"]);
const pages = ["holding/index.html", "holding/pixel-peeper/index.html"]
  .concat(readdirSync("holding/garage").filter(f => f.endsWith(".html") && !BARE.has(f)).map(f => "holding/garage/" + f))
  .concat(readdirSync("holding/lwe").filter(f => f.endsWith(".html")).map(f => "holding/lwe/" + f));

let patched = 0;
for (const f of pages) {
  let src = readFileSync(f, "utf8");
  // replace existing blocks (regen) or insert fresh. The /g matters: replace()
  // with a non-global RegExp strips only the FIRST match, so a page carrying two
  // marker blocks kept the second and gained a third on every run. /garage/gpt56
  // hit exactly that, having wrapped its own <script src="/nav.js"> in the
  // markers; a regen ate the shell script and duplicated the desktop chrome.
  src = src.replace(new RegExp(`${TOP_OPEN}[\\s\\S]*?${TOP_CLOSE}\\n?`, "g"), "");
  src = src.replace(new RegExp(`${CHROME_OPEN}[\\s\\S]*?${CHROME_CLOSE}\\n?`, "g"), "");
  const bodyOpen = src.match(/<body[^>]*>/);
  if (!bodyOpen) { console.error("no <body> in " + f); continue; }
  src = src.replace(bodyOpen[0], bodyOpen[0] + "\n" + topBlock);
  if (!src.includes("</body>")) { console.error("no </body> in " + f); continue; }
  src = src.replace("</body>", chromeBlock + "\n</body>");
  writeFileSync(f, src);
  patched++;
}
console.log(`patched ${patched} static pages with the desktop partial`);
