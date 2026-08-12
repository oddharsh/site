#!/usr/bin/env node
// Garage page generator.
//
// A Garage page can still bring its own experiment CSS and JavaScript, but the
// document shell, Luna fonts, navigation hook, editorial card, and active-recall
// check come from this one scaffold. The old hand-authored pages remain valid;
// new pages should enter through this pipeline.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { renderUnderstanding, validatePageSpec } from "../content/page-contract.mjs";
import { DESKTOP_CHROME, DESKTOP_TOP } from "../../www/_worker.js/lib/desktop.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");   // pipelines/<name>/ -> repo root
const HOLDING = join(ROOT, "www");
const REGISTRY = JSON.parse(readFileSync(join(HERE, "pages.json"), "utf8")).pages;

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
  if (spec.pageCss != null && spec.pageCss !== "") text(spec.pageCss, `${context}.pageCss`);
  if (spec.pageJs != null && spec.pageJs !== "") text(spec.pageJs, `${context}.pageJs`);
  return spec;
}

function validateRegistry() {
  const ids = new Set();
  for (const page of REGISTRY) {
    if (!page || typeof page !== "object") fail("Garage registry: every page must be an object");
    const context = `Garage registry entry "${page.id}"`;
    if (ids.has(page.id)) fail(`${context}: duplicate id`);
    ids.add(page.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(page.id)) fail(`${context}.id: use lowercase letters, numbers, and hyphens`);
    for (const field of ["title", "summary", "status", "lastmod", "navLabel", "navHint"]) text(page[field], `${context}.${field}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(page.lastmod)) fail(`${context}.lastmod: use YYYY-MM-DD`);
    const spec = JSON.parse(readFileSync(join(HERE, "specs", `${page.id}.json`), "utf8"));
    if (spec.id !== page.id) fail(`${context}: spec id is ${spec.id}, expected ${page.id}`);
    validateGarageSpec(spec, context);
  }
  return REGISTRY;
}

const BASE_CSS = `:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}
*{box-sizing:border-box}
html,body{margin:0;padding:0}html{background:linear-gradient(180deg,oklch(56% .13 250),oklch(73% .10 236) 50%,oklch(88% .05 232) 60%,oklch(60% .16 140))}
body{background:transparent;font-family:var(--font-ui);font-size:10.5pt;line-height:1.5;color:#181818;padding:24px 12px 60px;min-height:100vh}
.window{max-width:820px;margin:0 auto;background:#fff;border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-radius:8px 8px 0 0;overflow:hidden;box-shadow:inset 1px 1px 0 #166aee,inset -1px -1px 0 #00138c,4px 4px 0 rgba(0,30,160,.35)}
.title-bar{background:linear-gradient(180deg,oklch(70% .15 258),oklch(60% .20 261) 8%,oklch(51% .225 263) 18%,oklch(50% .225 263) 86%,oklch(58% .18 260));color:#fff;font-family:var(--font-caption);font-weight:bold;font-size:11pt;padding:4px 5px 4px 8px;display:flex;align-items:center;gap:6px;text-shadow:1px 1px #0f1089;user-select:none}
.title-bar .title-text{flex:1;min-width:0;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title-bar .icon{width:14px;height:14px;flex:0 0 14px;background:#fff;border:1px solid #8f4d06;position:relative}.title-bar .icon:before{content:"✦";position:absolute;inset:0;display:grid;place-items:center;font-size:10px;color:#ef8f24;text-shadow:none}
.controls{display:inline-flex;align-items:center;gap:2px}.controls span,.controls a{position:relative;box-sizing:border-box;width:21px;height:21px;display:inline-block;overflow:hidden;font-size:0;color:transparent;border:1px solid #6696eb;border-radius:3px;text-decoration:none;cursor:pointer;background:linear-gradient(180deg,#5f8cf7,#3a71f5 22%,#3e73f5 55%,#2a70f2 82%,#1045be)}.controls .close{border-color:#d8401c;background:linear-gradient(180deg,#e8795f,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110)}.controls .min:before{content:"";position:absolute;left:5px;right:5px;bottom:5px;height:2px;background:#fff}.controls .max:before{content:"";position:absolute;left:5px;top:5px;width:11px;height:9px;border:1px solid #fff;border-top-width:2px}.controls .close:before,.controls .close:after{content:"";position:absolute;left:50%;top:50%;width:13px;height:2px;margin:-1px 0 0 -6.5px;background:#fff}.controls .close:before{transform:rotate(45deg)}.controls .close:after{transform:rotate(-45deg)}
.content{padding:18px 20px 8px;background:#fffdf6;border-top:1px solid #8d9bb0}.content h1,.content h2,.content h3{font-family:var(--font-caption);color:#0831d9;line-height:1.25}.content h1{font-size:18pt;margin:0 0 7px}.content h2{font-size:13pt;margin:18px 0 5px}.content h3{font-size:11pt;margin:13px 0 4px}.content p{margin:0 0 12px}.content a{color:#153eab}.content code,.content pre{font-family:var(--font-mono)}
.garage-intro{font-size:11pt;color:#444;max-width:70ch}.garage-meta{font-size:8.5pt;color:#69758a;border-top:1px solid #d8dfeb;margin-top:18px;padding-top:6px}.status{border-top:1px solid #d1d9e4;background:#f1f4f8;padding:4px 10px;display:flex;gap:8px;flex-wrap:wrap;font-size:8.5pt;color:#586579}.status span:after{content:"·";margin-left:8px;color:#9ca8b8}.status span:last-child:after{content:""}
@media(max-width:620px){body{padding:8px 5px 42px}.content{padding:14px 12px 6px}.window{border-radius:5px 5px 0 0}}
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
<meta property="og:image" content="https://aadhar.sh/og/garage-${spec.id}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The aadhar.sh${html(path)} interactive demo, screenshotted">
<meta name="twitter:image" content="https://aadhar.sh/og/garage-${spec.id}.png">
<style>${BASE_CSS}${pageCss}</style>
<link rel="stylesheet" href="/luna.css">
</head>
<body>
<!-- axp:desktop -->${DESKTOP_TOP}<!-- /axp:desktop -->
<div class="window">
  <div class="title-bar" aria-hidden="true">
    <span class="title-text"><span class="icon"></span>aadhar.sh${html(path)}</span>
    <span class="controls"><span class="min"></span><span class="max"></span><a class="close" href="/garage" title="back to the garage" aria-label="back to the garage"></a></span>
  </div>
  <div class="content">
${spec.bodyHtml}
    <section id="luq" aria-label="understanding check"></section>
    <p class="garage-meta">${html(spec.status)} · the understanding check is part of the page, not a gate</p>
  </div>
  <div class="status"><span>garage</span><span>${html(spec.status)}</span><span>${html(spec.added || "new")}</span></div>
</div>
${pageJs}
${renderUnderstanding(spec.understanding, "garage")}
<script src="/nav.js" defer></script>
<!-- axp:shell -->${DESKTOP_CHROME}<!-- /axp:shell -->
</body>
</html>
`;
}

function sitemapBlock(pages) {
  return pages.map((page) => `  <url>\n    <loc>https://aadhar.sh/garage/${page.id}</loc>\n    <lastmod>${page.lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.3</priority>\n  </url>`).join("\n");
}

function js(value) {
  return JSON.stringify(String(value));
}

function navBlock(pages) {
  return pages.map((page) => `    { label: ${js(`garage · ${page.navLabel}`)}, path: ${js(`/garage/${page.id}`)}, hint: ${js(page.navHint)} },`).join("\n");
}

function statusClass(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function shelfBlock(pages) {
  return pages.map((page) => `      <li class="generated-garage-page">
        <div class="title-row"><span class="name"><a href="/garage/${page.id}">${html(page.title)}</a></span><span class="status ${statusClass(page.status)}">${html(page.status)}</span></div>
        <div class="desc">${html(page.summary)}</div>
        <div class="meta">generated page · added ${html(page.lastmod)}</div>
      </li>`).join("\n");
}

function injectBetween(file, start, end, content) {
  const path = join(HOLDING, file);
  const src = readFileSync(path, "utf8");
  const i = src.indexOf(start), j = src.indexOf(end);
  if (i === -1 || j === -1 || j < i) fail(`${file}: missing or inverted generated markers`);
  const next = src.slice(0, i + start.length) + "\n" + content + "\n" + src.slice(j);
  writeFileSync(path, next);
  console.log(`  · ${file}: rewrote ${start}`);
}

export { validateGarageSpec, validateRegistry };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "page") {
    if (!arg) fail("usage: generate.mjs page <id> | generate.mjs wire");
    validateRegistry();
    const spec = JSON.parse(readFileSync(join(HERE, "specs", `${arg}.json`), "utf8"));
    const out = join(HOLDING, "garage", `${arg}.html`);
    writeFileSync(out, pageHtml(spec));
    console.log(`wrote ${out}`);
  } else if (cmd === "wire") {
    const pages = validateRegistry();
    injectBetween("garage/index.html", "<!-- generated:garage-pages:start -->", "<!-- generated:garage-pages:end -->", shelfBlock(pages));
    injectBetween("nav.js", "// generated:garage-pages:start", "// generated:garage-pages:end", navBlock(pages));
    injectBetween("sitemap.xml", "<!-- generated:garage-pages:start -->", "<!-- generated:garage-pages:end -->", sitemapBlock(pages));
  } else {
    console.log("usage: generate.mjs page <id> | generate.mjs wire");
  }
}
