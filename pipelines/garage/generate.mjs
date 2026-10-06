#!/usr/bin/env node
// Garage page generator.
//
// A Garage page can still bring its own experiment CSS and JavaScript, but the
// document shell, Luna fonts, navigation hook, editorial card, and active-recall
// check come from this one scaffold. The old hand-authored pages remain valid;
// new pages should enter through this pipeline.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderUnderstanding, validatePageSpec } from "../content/page-contract.mjs";
import { DESKTOP_CHROME, DESKTOP_TOP } from "../../src/worker/lib/desktop.ts";
import { titleBar } from "../../src/worker/lib/window.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");   // pipelines/<name>/ -> repo root
const PAGES = join(ROOT, "src/pages");

function fail(message) {
  throw new Error(message);
}

function text(value, context) {
  if (typeof value !== "string" || !value.trim()) fail(`${context}: must be a non-empty string`);
  return value;
}

function html(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function validateGarageSpec(spec, context = "Garage spec") {
  validatePageSpec(spec, context, { contentField: "bodyHtml" });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) fail(`${context}.id: use lowercase letters, numbers, and hyphens`);
  text(spec.title, `${context}.title`);
  text(spec.description, `${context}.description`);
  text(spec.status, `${context}.status`);
  if (spec.added != null && !/^\d{4}-\d{2}-\d{2}$/.test(spec.added)) fail(`${context}.added: use YYYY-MM-DD`);
  // A page's own tab icon. Emitted verbatim into a double-quoted attribute, the
  // way the LWE generator writes its favicons, so it has to be an SVG data URI
  // that cannot close that attribute or open a tag.
  if (spec.favicon != null && !/^data:image\/svg\+xml,[^"<>]+$/.test(spec.favicon)) {
    fail(`${context}.favicon: use a data:image/svg+xml, URI with no " < or >`);
  }
  if (spec.pageCss != null && spec.pageCss !== "") text(spec.pageCss, `${context}.pageCss`);
  if (spec.pageJs != null && spec.pageJs !== "") text(spec.pageJs, `${context}.pageJs`);
  return spec;
}

// Page-only CSS. The window chrome (frame, title bar, caption buttons and their
// hover glow), the desktop, the window geometry and the page defaults all come
// from /luna.css, and the article typography (headings, lede, note, code, rule,
// links, callout, footer) from /prose.css, the prose kit every hand-written
// Garage page shares. What stays here is what only generated pages have: the
// star icon, paragraph rhythm, and the intro and meta lines.
const BASE_CSS = `.title-bar .icon{width:14px;height:14px;flex:0 0 14px;background:#fff;border:1px solid #8f4d06}.title-bar .icon:before{content:"✦";position:absolute;inset:0;display:grid;place-items:center;font-size:10px;color:#ef8f24;text-shadow:none}
.content p{margin:0 0 12px}.content code,.content pre{font-family:var(--font-mono)}
.garage-intro{font-size:var(--text-lede);color:var(--ink-soft);max-width:70ch}.garage-meta{font-size:var(--text-micro);color:var(--ink-dim);border-top:1px solid var(--rule);margin-top:18px;padding-top:6px}
@media(max-width:620px){.window{--axp-gutter:12px}.content{padding:14px 12px 6px}}
`;

export function pageHtml(spec) {
  validateGarageSpec(spec, `Garage spec "${spec.id}"`);
  const path = `/garage/${spec.id}`;
  const pageCss = spec.pageCss ? `\n${spec.pageCss}\n` : "";
  const pageJs = spec.pageJs ? `\n<script>\n${spec.pageJs}\n</script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="/luna.css">
<title>aadhar.sh${html(path)}: ${html(spec.title)}</title>
<meta name="description" content="${html(spec.description)}">
<link rel="canonical" href="https://aadhar.sh${html(path)}">
<meta property="og:type" content="article">
<meta property="og:title" content="aadhar.sh${html(path)}: ${html(spec.title)}">
<meta property="og:description" content="${html(spec.description)}">
<meta property="og:url" content="https://aadhar.sh${html(path)}">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:image" content="https://aadhar.sh/og/garage-${spec.id}.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The aadhar.sh${html(path)} interactive demo, screenshotted">
<meta name="twitter:image" content="https://aadhar.sh/og/garage-${spec.id}.jpg">${spec.favicon ? `\n<link rel="icon" type="image/svg+xml" href="${spec.favicon}">` : ""}
<link rel="stylesheet" href="/prose.css">
<style>${BASE_CSS}${pageCss}</style>
<link rel="stylesheet" href="/luna.css">
</head>
<body>
<!-- axp:desktop -->${DESKTOP_TOP}<!-- /axp:desktop -->
<div class="window">
  <!-- axp:window -->${titleBar({ caption: `aadhar.sh${path}`, closeHref: "/garage", closeTitle: "back to the garage" })}<!-- /axp:window -->
  <div class="content prose">
${spec.bodyHtml}
    <section id="luq" aria-label="understanding check"></section>
    <p class="garage-meta">${html(spec.status)} · the understanding check is part of the page, not a gate</p>
  </div>
  <div class="xp-statusbar"><span>garage</span><span>${html(spec.status)}</span><span>${html(spec.added || "new")}</span></div>
</div>
${pageJs}
${renderUnderstanding(spec.understanding, "garage")}
<script src="/nav.js" defer></script>
<!-- axp:shell -->${DESKTOP_CHROME}<!-- /axp:shell -->
</body>
</html>
`;
}

export { validateGarageSpec };

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "page") {
    if (!arg) fail("usage: generate.mjs page <id>");
    const spec = JSON.parse(readFileSync(join(HERE, "specs", `${arg}.json`), "utf8"));
    if (spec.id !== arg) fail(`spec id is ${spec.id}, expected ${arg}`);
    const out = join(PAGES, "garage", `${arg}.html`);
    writeFileSync(out, pageHtml(spec));
    console.log(`wrote ${out}`);
  } else if (cmd === "wire") {
    fail("Garage wire is retired. Run bun run gen:manifest; edit the Garage shelf and sitemap by hand.");
  } else {
    console.log("usage: generate.mjs page <id>");
  }
}
