#!/usr/bin/env node
// gen-desktop-partial.ts — compile the XP desktop shell from authored data.
//
// shell-data.ts owns presentation (pins, profiles, icons and tray art), while
// site-manifest.json owns which public routes are taskbar applications. This
// generator projects those facts into the Worker partial, the immutable icon
// sprite, and every static HTML page that loads nav.js. Nothing is extracted
// from or evaled out of the browser runtime.
//
//   node tools/photos/gen-desktop-partial.ts

// Static pages keep the generated partial checked in so direct local serving,
// curl and JavaScript-off visits see the same desktop as production. build.ts
// independently renders these artifacts and hard-fails on any drift.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readManifest } from "../../tools/gen-manifest.ts";
import { DESKTOP, PROFILES, SECTION_ICONS, SPECULATION, TASKBAR, TRAY_ITEMS } from "./shell-data.ts";

const TOP_OPEN = "<!-- axp:desktop -->";
const TOP_CLOSE = "<!-- /axp:desktop -->";
const CHROME_OPEN = "<!-- axp:shell -->";
const CHROME_CLOSE = "<!-- /axp:shell -->";

const esc = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Any speculationrules block, sentinel-wrapped or hand-written. patchStaticShell
// strips whatever it finds before re-emitting the canonical one, so a page that
// still carries its old inline copy converges on the first gen:shell run rather
// than ending up with two rulesets, which the browser would union.
const SPECULATION_BLOCK = /[ \t]*<script\b[^>]*\btype=["']speculationrules["'][^>]*>[\s\S]*?<\/script>\n?/gi;

function stripSpeculationBlocks(input) {
  let previous;
  let next = input;
  do {
    previous = next;
    next = next.replace(SPECULATION_BLOCK, "");
  } while (next !== previous);
  return next;
}

export const speculationHtml = () =>
  `<script type="speculationrules">${JSON.stringify(SPECULATION)}</script>`;

function assertTaskbarContract(surfaces) {
  const declared = surfaces.filter((surface) => surface.flags.taskbar).map((surface) => surface.path).sort();
  const rendered = TASKBAR.map((surface) => surface.path).sort();
  if (JSON.stringify(declared) !== JSON.stringify(rendered)) {
    throw new Error(`shell-data TASKBAR paths disagree with site-manifest taskbar flags\nmanifest: ${declared.join(", ")}\nshell: ${rendered.join(", ")}`);
  }
  for (const item of TASKBAR) {
    if (!SECTION_ICONS[item.label]) throw new Error(`TASKBAR ${item.path} has no SECTION_ICONS entry for ${item.label}`);
  }
}

export function renderDesktopArtifacts(surfaces = readManifest().surfaces) {
  assertTaskbarContract(surfaces);
  const counts = new Map(TASKBAR.map((item) => [
    item.path,
    surfaces.filter((surface) => surface.path.startsWith(item.path + "/") && surface.flags.run).length,
  ]));

  const cells = [];
  let spriteY = 0;
  const gutter = 16;
  const spriteRef = (name, svg) => {
    const [x0, y0, width, height] = (svg.match(/viewBox="([^"]+)"/) || [, "0 0 32 32"])[1].split(/\s+/).map(Number);
    const inner = compactSvg(svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""));
    cells.push({ name, inner, dy: spriteY, view: `${x0} ${y0 + spriteY} ${width} ${height}`, right: x0 + width, bottom: y0 + spriteY + height });
    spriteY += height + gutter;
    return `<img src="/icons.svg#${name}" alt="">`;
  };

  const desktopHtml = '<div id="axp-desktop" aria-hidden="true"></div>';
  const iconsHtml = '<nav id="axp-icons" aria-label="desktop shortcuts">' + DESKTOP.map((item, index) => {
    const external = item.kind === "profile";
    const profile = external ? PROFILES.find((candidate) => candidate.label === item.label) : null;
    const background = profile?.background || "linear-gradient(180deg,oklch(72% 0.05 255),oklch(60% 0.07 257))";
    const glyph = profile?.glyph || item.label.charAt(0);
    return `<a class="axp-ico"${external ? ' target="_blank" rel="noopener me external"' : ""}`
      + ` title="${esc(item.hint || item.label)}${external ? " (opens in a new tab)" : ""}"`
      + ` href="${esc(item.path)}" data-key="${esc(item.label)}" style="left:9px;top:${9 + index * 86}px">`
      + `<span class="ic ${item.kind === "note" ? "note" : ""}"${external ? ` style="background:${background}"` : ""} aria-hidden="true">${external ? glyph : ""}</span>`
      + `<span class="t">${esc(item.label)}</span></a>`;
  }).join("") + "</nav>";

  const pinsHtml = TASKBAR.map((item) => {
    const name = `pin-${item.label.replace(/\s+/g, "-")}`;
    return `<a class="axp-pin" title="${esc(item.hint)}" href="${esc(item.path)}" data-count="${counts.get(item.path) || 0}">`
      + `<span class="fav" aria-hidden="true">${spriteRef(name, SECTION_ICONS[item.label])}</span>`
      + `<span class="lbl">${esc(item.label)}</span></a>`;
  }).join("");

  const trayHtml = '<div id="axp-tray"><button id="axp-sound" type="button" hidden></button>'
    + TRAY_ITEMS.map((item) => `<a id="${item.id}" class="axp-trayico"${item.hidden ? " hidden" : ""} href="${item.href}" data-kind="${item.kind}" title="${esc(item.title)}" aria-label="${esc(item.label)}">${spriteRef(`tray-${item.kind}`, item.svg)}</a>`).join("")
    + '<span id="axp-clock" aria-hidden="true"></span></div>';

  const taskbarHtml = '<div id="axp-taskbar" role="navigation" aria-label="taskbar">'
    + '<a id="axp-start" href="/run" aria-haspopup="dialog" aria-expanded="false"><span id="axp-cone" aria-hidden="true"></span>start<span class="axp-kbd" aria-hidden="true">⌘K</span></a>'
    + `<div id="axp-pins">${pinsHtml}</div><div id="axp-spacer"></div>${trayHtml}</div>`;
  // The ruleset rides the chrome because the chrome is the one projection that
  // reaches BOTH surfaces: patchStaticShell writes it into every static page and
  // lib/desktop.js hands the same bytes to the worker-rendered ones. nav.js used
  // to inject it at boot for the pages with no inline copy, which meant the
  // rules landed after first paint and could not prerender anything the visitor
  // hovered before that. In the HTML they parse with the document.
  const chromeHtml = iconsHtml + taskbarHtml + speculationHtml();
  const histnavHtml = HISTNAV_HTML;


  // The sprite banner names the generator by NAME, never by PATH. icons.svg is
  // content-hashed and served from /a/, so a path in its bytes couples the
  // repository layout to a public URL: moving this file re-mints
  // /a/icons.<hash>.svg and orphans every committed dictionary naming the old
  // one. Measured on 2026-08-16, when moving public/scripts to tools/photos did
  // exactly that and failed the build invariant.
  const moduleSource = `// lib/desktop.js — the static XP desktop shell, GENERATED by\n`
    + `// tools/photos/gen-desktop-partial.ts from shell-data.ts and\n`
    + `// site-manifest.json. Do not hand-edit; run bun run gen:shell.\n`
    + `// DESKTOP_TOP opens <body>; DESKTOP_CHROME closes it with icons/taskbar.\n`
    + `// DESKTOP_HISTNAV opens the page window's title bar (Back/Forward).\n`
    + `export const DESKTOP_TOP = ${JSON.stringify(desktopHtml)};\n`
    + `export const DESKTOP_CHROME = ${JSON.stringify(chromeHtml)};\n`
    + `export const DESKTOP_HISTNAV = ${JSON.stringify(histnavHtml)};\n`
    + `export const SECTION_FAVICONS = ${JSON.stringify(sectionFavicons(), null, 2)};\n`;

  const spriteWidth = Math.max(...cells.map((cell) => cell.right));
  const spriteHeight = Math.max(...cells.map((cell) => cell.bottom));
  const { defs, inners } = hoistDefs(cells.map((cell) => cell.inner));
  // The cells were compacted on the way in (spriteRef), so the hoist merges
  // compacted bodies and nothing here needs a second pass.
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteWidth}" height="${spriteHeight}" viewBox="0 0 ${spriteWidth} ${spriteHeight}">`
    + "<!-- GENERATED by gen-desktop-partial.ts from shell-data.ts. Do not hand-edit. Served from /a/ as q11 brotli, and as a dcz delta only behind the svg canary cookie; see SVG_DCZ_COOKIE in src/worker/lib/assets.ts. -->"
    + `<defs>${defs}</defs>`
    + cells.map((cell) => `<view id="${cell.name}" viewBox="${cell.view}"/>`).join("")
    + cells.map((cell, index) => `<g transform="translate(0 ${cell.dy})">${inners[index]}</g>`).join("")
    + "</svg>\n";

  // Object.fromEntries over an inferred (string)[][] yields Record<string, any>
  // in JS and `unknown` values once checked as TypeScript, so the pair is a
  // tuple and the map is named: slug to SVG source.
  const favicons: Record<string, string> = Object.fromEntries(TASKBAR.map((item): [string, string] => [
    faviconSlug(item.label),
    `${compactSvg(SECTION_ICONS[item.label]).replace("<svg ", '<svg width="32" height="32" ')}\n`,
  ]));

  return { desktopHtml, chromeHtml, histnavHtml, moduleSource, sprite, favicons };
}

// The sprite ships from /a/ on every page, and the icon sources in shell-data.ts
// are written for reading: explicit closing tags, spaced path data, default
// gradient attributes. compactSvg makes three rewrites that draw the same pixels,
// measured 2026-09-26 on the built sprite as 2,706 to 2,638 B brotli (alone,
// self-closing is worth 61 B and path spacing 16). It runs on each sprite cell
// and on the section favicons, which render pixel-identical either way; the
// inline HTML keeps the authored strings.
//
// - an empty element closes itself: <stop ...></stop> is <stop .../>
// - path data drops the spaces beside a command letter, which the grammar never needs
// - linearGradient drops x1="0" y1="0" and stop drops offset="0", the defaults
// - a filter primitive drops flood-color="#000", its initial value. feDropShadow
//   keeps dx and dy, because THEIR default is 2, not 0.
// - a six-digit hex colour whose digit pairs repeat takes its three-digit form,
//   #ffffff to #fff, which CSS parses to the same colour. It exists for the
//   dedupe. The tray icons spell white #ffffff while the section tiles spell
//   it #fff, so the security icon's gloss matched garageG in every stop and
//   still missed hoistDefs below, which merges on exact text. Only a WHOLE
//   attribute value is rewritten, so a fragment like url(#abcabc) cannot be
//   read as a colour. It claims no byte saving: the built sprite read 2,451
//   to 2,424 B brotli (14,721 to 14,531 B raw), and 30 random deletions of
//   the same raw size spread -41 to +10 B, median -20, so -27 is inside what
//   any edit this size does. What it buys is one gradient fewer.
export const compactSvg = (svg: string): string => svg
  .replace(/<([a-zA-Z]+)(\s[^<>]*)?><\/\1>/g, (_m, tag: string, attrs = "") => `<${tag}${attrs}/>`)
  .replace(/ d="([^"]*)"/g, (_m, d: string) => ` d="${d.replace(/ +([MLHVCSQTAZmlhvcsqtaz])/g, "$1").replace(/([MLHVCSQTAZmlhvcsqtaz]) +/g, "$1")}"`)
  .replace(/(<linearGradient\b[^>]*?) x1="0" y1="0"/g, "$1")
  .replace(/<stop offset="0" /g, "<stop ")
  .replaceAll(' flood-color="#000"', "")
  .replace(/="#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3"/gi, (_m, r: string, g: string, b: string) => `="#${r}${g}${b}"`.toLowerCase());

// Back and Forward, at the head of the page window's title bar. nav.js used to
// CREATE this span at boot, two animation frames after the static paint on
// purpose, so the title text slid ~50px right on every windowed page after it
// had painted (bun run cls: 65 of 65 pages at desktop width), and on a phone a
// long caption wrapped onto a second line and pushed the document down 19px.
// Baked into the HTML it has geometry at first paint, and nav.js only wires it.
// Its CSS lives in luna.css, which hides it when scripting is off (dead buttons
// otherwise) and below 720px, where the phone's own back gesture does the job
// and 50px of a 370px caption is the difference between one line and two.
export const HISTNAV_HTML = '<span class="axp-histnav">'
  + '<button type="button" class="axp-back" aria-label="Back" title="Back"></button>'
  + '<button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>';

// Any baked histnav, canonical or from an older generator, so a markup change
// converges on the next gen:shell run instead of stacking a second pair.
const HISTNAV_BLOCK = /<span class="axp-histnav">(?:<button\b[^>]*><\/button>)*<\/span>/g;

// The page window's title bar: the first `body > .window` (or .np-window) whose
// first element child is a title bar, with comments and whitespace allowed
// between (the homepage carries one). This is the element nav.js's
// initWindowControls() resolves, and a string match rather than a parse keeps
// every other byte of the authored page untouched. `data-no-histnav` on the
// window opts it out, the same attribute nav.js honours.
//
// A comment body is `(?:[^-]|-(?!->))*`, which cannot contain `-->`, rather than
// a lazy `[\s\S]*?`. The lazy form could swallow `--><!--` too, so a run of N
// comments had exponentially many parses and a near-miss backtracked through
// all of them (CodeQL, code-scanning alert 109). This form parses each comment
// exactly one way.
const WINDOW_TITLE_BAR = /(<div class="(?:window|np-window)(?:\s[^"]*)?"([^>]*)>(?:\s|<!--(?:[^-]|-(?!->))*-->)*<div class="(?:title-bar|np-titlebar|titlebar)(?:\s[^"]*)?"[^>]*>)/;

export function bakeHistnav(source, histnavHtml = HISTNAV_HTML) {
  const stripped = source.replace(HISTNAV_BLOCK, "");
  const match = stripped.match(WINDOW_TITLE_BAR);
  if (!match || /\bdata-no-histnav\b/.test(match[2])) return stripped;
  const at = match.index + match[1].length;
  return stripped.slice(0, at) + histnavHtml + stripped.slice(at);
}

// The sprite is ONE document, so a paint-server id is document-wide, and the
// fourteen cells had been carrying their own copies: ten section tiles each
// defined the same gloss gradient and the same drop-shadow filter, and four tray
// icons repeat each other's gradients. This lifts every definition into one
// <defs>, keeps the first of each identical body and repoints url(#...) at it.
// Measured 2026-09-26 on top of compactSvg (with its flood-color rule): the
// built sprite goes 2,638 B brotli to 2,451.
//
// Moving a definition out of its cell cannot move what it paints. Every one here
// is objectBoundingBox (the default), and even a userSpaceOnUse one resolves in
// the REFERENCING element's user space, translate included, wherever its
// <defs> sits. Two definitions merge only when everything but the id matches.
const PAINT_DEF = /<(filter|linearGradient|radialGradient|clipPath|mask|pattern)\b([^>]*?)\bid="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g;
export function hoistDefs(inners: string[]) {
  const kept = new Map<string, string>();
  const alias = new Map<string, string>();
  const defs: string[] = [];
  for (const inner of inners) {
    for (const match of inner.matchAll(PAINT_DEF)) {
      const body = `${match[1]}${match[2]}${match[4]}>${match[5]}`;
      const first = kept.get(body);
      if (first) alias.set(match[3], first);
      else { kept.set(body, match[3]); defs.push(match[0]); }
    }
  }
  return {
    defs: defs.join(""),
    inners: inners.map((inner) => [...alias].reduce(
      (text, [duplicate, first]) => text.replaceAll(`url(#${duplicate})`, `url(#${first})`),
      inner.replace(/<defs>[\s\S]*?<\/defs>/g, ""),
    )),
  };
}

// A section's favicon is addressed by ROUTE, because that is what both consumers
// have in hand: lunaPage knows its own route, and a static page is patched by the
// path it lives at. The slug is the label with its one space folded, so
// "pixel peeper" files as pixel-peeper.svg.
export const faviconSlug = (label) => label.replace(/\s+/g, "-");
export const faviconHref = (label) => `/section-icons/${faviconSlug(label)}.svg`;
export const sectionFavicons = () =>
  Object.fromEntries(TASKBAR.map((item) => [item.path, faviconHref(item.label)]));

const navScript = /<script\b[^>]*\bsrc=["']\/nav\.js["'][^>]*><\/script>/i;

export function patchStaticShell(source, artifacts) {
  const hasShell = source.includes(TOP_OPEN) || source.includes(CHROME_OPEN);
  if (!hasShell && !navScript.test(source)) return null;
  let next = source
    .replace(new RegExp(`${TOP_OPEN}[\\s\\S]*?${TOP_CLOSE}\\n?`, "g"), "")
    .replace(new RegExp(`${CHROME_OPEN}[\\s\\S]*?${CHROME_CLOSE}\\n?`, "g"), "");
  next = stripSpeculationBlocks(next);
  const body = next.match(/<body[^>]*>/i);
  if (!body) throw new Error("shell page has no <body>");
  if (!next.includes("</body>")) throw new Error("shell page has no </body>");
  next = next.replace(body[0], `${body[0]}\n${TOP_OPEN}${artifacts.desktopHtml}${TOP_CLOSE}`);
  next = next.replace("</body>", `${CHROME_OPEN}${artifacts.chromeHtml}${CHROME_CLOSE}\n</body>`);
  return bakeHistnav(next, artifacts.histnavHtml);
}

export function staticShellPages() {
  // Every HTML document is authored under src/pages now; public/ holds assets
  // and carries none. Reading the wrong root here is silent: the freshness check
  // that consumes this list would report a clean shell it never looked at.
  return (readdirSync("src/pages", { recursive: true }) as string[])
    .filter((relative) => relative.endsWith(".html"))
    .map((relative) => `src/pages/${relative}`)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes(TOP_OPEN) || source.includes(CHROME_OPEN) || navScript.test(source);
    })
    .sort();
}

function main() {
  const artifacts = renderDesktopArtifacts();
  writeFileSync("src/worker/lib/desktop.ts", artifacts.moduleSource);
  writeFileSync("public/icons.svg", artifacts.sprite);
  mkdirSync("public/section-icons", { recursive: true });
  for (const [name, svg] of Object.entries(artifacts.favicons)) {
    writeFileSync(`public/section-icons/${name}.svg`, svg);
  }
  let patched = 0;
  for (const file of staticShellPages()) {
    const source = readFileSync(file, "utf8");
    const next = patchStaticShell(source, artifacts);
    if (next !== source) writeFileSync(file, next);
    patched++;
  }
  console.log(`lib/desktop.js: top ${artifacts.desktopHtml.length}B, chrome ${artifacts.chromeHtml.length}B`);
  console.log(`public/icons.svg: ${artifacts.sprite.length}B`);
  console.log(`public/section-icons: ${Object.keys(artifacts.favicons).length} compiled favicons`);
  console.log(`patched ${patched} static pages with the canonical desktop partial`);
}

if (import.meta.main) main();
