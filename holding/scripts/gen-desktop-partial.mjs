#!/usr/bin/env node
// gen-desktop-partial.mjs — compile the XP desktop shell from authored data.
//
// shell-data.mjs owns presentation (pins, profiles, icons and tray art), while
// site-manifest.json owns which public routes are taskbar applications. This
// generator projects those facts into the Worker partial, the immutable icon
// sprite, and every static HTML page that loads nav.js. Nothing is extracted
// from or evaled out of the browser runtime.
//
//   node holding/scripts/gen-desktop-partial.mjs

// Static pages keep the generated partial checked in so direct local serving,
// curl and JavaScript-off visits see the same desktop as production. build.mjs
// independently renders these artifacts and hard-fails on any drift.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readManifest } from "../../scripts/gen-manifest.mjs";
import { DESKTOP, PROFILES, SECTION_ICONS, TASKBAR, TRAY_ITEMS } from "./shell-data.mjs";

const TOP_OPEN = "<!-- axp:desktop -->";
const TOP_CLOSE = "<!-- /axp:desktop -->";
const CHROME_OPEN = "<!-- axp:shell -->";
const CHROME_CLOSE = "<!-- /axp:shell -->";

const esc = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

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
    const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
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
    + TRAY_ITEMS.map((item) => `<a id="${item.id}" class="axp-trayico" href="${item.href}" data-kind="${item.kind}" title="${esc(item.title)}" aria-label="${esc(item.label)}">${spriteRef(`tray-${item.kind}`, item.svg)}</a>`).join("")
    + '<span id="axp-clock" aria-hidden="true"></span></div>';

  const taskbarHtml = '<div id="axp-taskbar" role="navigation" aria-label="taskbar">'
    + '<a id="axp-start" href="/run" aria-haspopup="dialog" aria-expanded="false"><span id="axp-cone" aria-hidden="true"></span>start<span class="axp-kbd" aria-hidden="true">⌘K</span></a>'
    + `<div id="axp-pins">${pinsHtml}</div><div id="axp-spacer"></div>${trayHtml}</div>`;
  const chromeHtml = iconsHtml + taskbarHtml;

  const moduleSource = `// lib/desktop.js — the static XP desktop shell, GENERATED by\n`
    + `// holding/scripts/gen-desktop-partial.mjs from shell-data.mjs and\n`
    + `// site-manifest.json. Do not hand-edit; run pnpm run gen:shell.\n`
    + `// DESKTOP_TOP opens <body>; DESKTOP_CHROME closes it with icons/taskbar.\n`
    + `export const DESKTOP_TOP = ${JSON.stringify(desktopHtml)};\n`
    + `export const DESKTOP_CHROME = ${JSON.stringify(chromeHtml)};\n`;

  const spriteWidth = Math.max(...cells.map((cell) => cell.right));
  const spriteHeight = Math.max(...cells.map((cell) => cell.bottom));
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteWidth}" height="${spriteHeight}" viewBox="0 0 ${spriteWidth} ${spriteHeight}">`
    + "<!-- GENERATED by holding/scripts/gen-desktop-partial.mjs from shell-data.mjs. Do not hand-edit. Served from /a/ as plain brotli, never as a dcz dictionary delta; see DICTIONARY_TYPES in _worker.js/lib/assets.js. -->"
    + cells.map((cell) => `<view id="${cell.name}" viewBox="${cell.view}"/>`).join("")
    + cells.map((cell) => `<g transform="translate(0 ${cell.dy})">${cell.inner}</g>`).join("")
    + "</svg>\n";

  return { desktopHtml, chromeHtml, moduleSource, sprite };
}

const navScript = /<script\b[^>]*\bsrc=["']\/nav\.js["'][^>]*><\/script>/i;

export function patchStaticShell(source, artifacts) {
  const hasShell = source.includes(TOP_OPEN) || source.includes(CHROME_OPEN);
  if (!hasShell && !navScript.test(source)) return null;
  let next = source
    .replace(new RegExp(`${TOP_OPEN}[\\s\\S]*?${TOP_CLOSE}\\n?`, "g"), "")
    .replace(new RegExp(`${CHROME_OPEN}[\\s\\S]*?${CHROME_CLOSE}\\n?`, "g"), "");
  const body = next.match(/<body[^>]*>/i);
  if (!body) throw new Error("shell page has no <body>");
  if (!next.includes("</body>")) throw new Error("shell page has no </body>");
  next = next.replace(body[0], `${body[0]}\n${TOP_OPEN}${artifacts.desktopHtml}${TOP_CLOSE}`);
  next = next.replace("</body>", `${CHROME_OPEN}${artifacts.chromeHtml}${CHROME_CLOSE}\n</body>`);
  return next;
}

export function staticShellPages() {
  return readdirSync("holding", { recursive: true })
    .filter((relative) => relative.endsWith(".html"))
    .map((relative) => `holding/${relative}`)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes(TOP_OPEN) || source.includes(CHROME_OPEN) || navScript.test(source);
    })
    .sort();
}

function main() {
  const artifacts = renderDesktopArtifacts();
  writeFileSync("holding/_worker.js/lib/desktop.js", artifacts.moduleSource);
  writeFileSync("holding/icons.svg", artifacts.sprite);
  let patched = 0;
  for (const file of staticShellPages()) {
    const source = readFileSync(file, "utf8");
    const next = patchStaticShell(source, artifacts);
    if (next !== source) writeFileSync(file, next);
    patched++;
  }
  console.log(`lib/desktop.js: top ${artifacts.desktopHtml.length}B, chrome ${artifacts.chromeHtml.length}B`);
  console.log(`holding/icons.svg: ${artifacts.sprite.length}B`);
  console.log(`patched ${patched} static pages with the canonical desktop partial`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
