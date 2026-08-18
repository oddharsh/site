#!/usr/bin/env node
// LWE page generator — Phase 1 of the lwe-publish pipeline.
//
//   node pipelines/lwe/generate.mjs page <id>   # specs/<id>.json -> public/lwe/<id>.html
//   node pipelines/lwe/generate.mjs wire         # rewrite the registry-driven regions
//                                               #   (sitemap urls now; prints buddy + nav blocks)
//
// concepts.json is the single source of truth. A page-spec (specs/<id>.json) carries
// only what is unique to one concept: the conversation, the demos, the disclosure,
// the reader model, and the understanding check.
// Everything structural — the window chrome, the messenger shell, the taskbar desktop —
// is generated here so every page stays byte-identical in its bones.
//
// CONTENT CONTRACT for specs (the voice the structuring step must hit):
//   - Apply ALL of the below together, never one subset instead of another.
//   - LRS clarity: every sentence needs a character doing an action. Kill nominalizations
//     (-tion/-ment/-ance/-ity nouns hiding a verb). Link clauses with real connectors
//     (because, although, so that), not "and"/"also".
//   - No AI shibboleths: no em dashes, straight apostrophes, contractions on, no banned
//     phrases, never the "not X, Y" negation pattern. Emojis only when they earn their
//     place (a functional glyph or a genuinely apt beat), never as filler reactions.
//   - Teacher bubbles that quote a source stay verbatim; mark them with `cite`.
//   - Every spec carries an `editorial` card (reader, problem, thesis, evidence,
//     uncertainty) and an `understanding` card (3–7 questions, one correct option,
//     feedback on every option). The shared contract validates both.
//   - DEMO DETECTION: in the source chat, a request to clarify, to re-explain, or an
//     explicit "show me" is a demo cue. Those moments become {demo:{...}} slots, authored
//     by hand. The pipeline flags them; a human builds the actual widget.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { renderUnderstanding, validatePageSpec } from "../content/page-contract.mjs";
import { DESKTOP_CHROME, DESKTOP_TOP } from "../../src/worker/lib/desktop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");   // pipelines/<name>/ -> repo root
const HOLDING = join(ROOT, "src/pages");
const REGISTRY = JSON.parse(readFileSync(join(HERE, "concepts.json"), "utf8")).concepts;
const byId = (id) => REGISTRY.find((c) => c.id === id);

// Shared structure lives in /lwe-base.css. Only concept colors, glyphs and the
// few rules containing those values stay inline, beside the page that owns them.
function chromeCss(c) {
  const soft = c.accentSoft || "#f6f1e6";
  const glyphFont = c.glyphFont || 'var(--font-caption)';
  const [g0, g1] = c.picGrad;
  return `:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace;--accent:${c.accent};--accent-soft:${soft}}
.title-bar{background:linear-gradient(180deg,oklch(70% .15 258),oklch(60% .20 261) 8%,oklch(51% .225 263) 18%,oklch(50% .225 263) 86%,oklch(58% .18 260));color:#fff;font-family:var(--font-caption);font-weight:bold;font-size:11pt;padding:4px 5px 4px 8px;display:flex;align-items:center;gap:6px;text-shadow:1px 1px #0f1089;user-select:none}
.title-bar .icon{width:14px;height:14px;flex:0 0 14px;background:#fff;border:1px solid ${c.picBorder};position:relative}
.title-bar .icon::before{content:"${c.glyph}";position:absolute;inset:0;display:grid;place-items:center;font-size:10px;color:var(--accent);font-weight:bold;text-shadow:none}
.window>.content{flex:1 1 auto;min-height:0;overflow:auto;padding-right:28px}
.msgr-head{display:flex;align-items:center;gap:9px;padding:8px 12px;background:linear-gradient(180deg,#fffdf6,#f6edd6);border-bottom:1px solid #e0cf9e}
.msgr-head .ava{width:34px;height:34px;flex:0 0 34px;border-radius:4px;border:1px solid ${c.picBorder};background:linear-gradient(180deg,${g0},${g1});position:relative}
.msgr-head .ava::before{content:"${c.glyph}";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-weight:bold;font-size:19px;font-family:${glyphFont}}
.msgr-head .who b{font-family:var(--font-caption);font-size:11pt;color:${c.nameColor}}
.disclosure b{color:${c.nameColor}}.disclosure a{color:#1a4fc4}
.msg.bot .pic{background:linear-gradient(180deg,${g0},${g1});border-color:${c.picBorder}}
.msg.bot .pic::before{content:"${c.glyph}";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-weight:bold;font-size:13px;font-family:${glyphFont}}
.msg.bot .who b{color:${c.nameColor}}.msg .who time{color:#9aa3b2;font-family:var(--font-mono);font-size:8pt;margin-left:5px}
.msg .bubble code{font-family:var(--font-mono);font-size:9.5pt;background:#f1ece0;padding:0 3px;border-radius:2px}
.demo{grid-column:1/-1;border:1px solid var(--accent);border-radius:4px;background:var(--accent-soft);margin:2px 0;overflow:hidden;box-shadow:inset 0 1px 0 #fff}
.demo>.bar{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:8.5pt;color:${c.nameColor};background:linear-gradient(180deg,#f6edd6,#ecdfb8);border-bottom:1px solid var(--accent);font-weight:bold}.demo>.pad{padding:11px 12px 13px;background:#fff}
.btn{font-family:var(--font-ui);font-size:9pt;padding:3px 9px;cursor:pointer;background:linear-gradient(to bottom,#fff,#e9edf5);border:1px solid #7d8aa3;border-radius:2px;box-shadow:inset 1px 1px 0 #fff}.btn:hover{border-color:var(--accent)}
.scrollnote{text-align:center;font-size:8pt;color:#9aa3b2;padding:3px 0 9px}.compose{border-top:1px solid #e0cf9e;background:linear-gradient(180deg,#fffdf6,#f3ead0);padding:7px 10px}.compose .ta{flex:1;min-height:30px;border:1px solid #7d8aa3;background:#fff;box-shadow:inset 1px 1px 0 #c3cbdb;padding:4px 6px;font-family:var(--font-ui);font-size:9.5pt;color:#9aa3b2}
@media(max-width:520px){body{padding:8px 4px 32px}.msgr-head .pets{display:none}}`;
}

// ---- message rendering ----
function renderMsg(m, c) {
  if (m.scrollnote) return `      <div class="scrollnote">${m.scrollnote}</div>`;
  if (m.demo) {
    const d = m.demo;
    return `      <div class="demo"${d.id ? ` id="${d.id}"` : ""}>\n        <div class="bar">${d.bar || "live demo"}</div>\n        <div class="pad">${d.html}</div>\n      </div>`;
  }
  const who = m.who === "you" ? "aadharsh" : (c.buddyName || c.title);
  const cite = m.cite ? ` <a href="${m.cite.url}" rel="external" title="${m.cite.title || "source"}">[src]</a>` : "";
  return `      <div class="msg ${m.who}"><div class="pic"></div><div><div class="who"><b>${who}</b>${m.time ? `<time>${m.time}</time>` : ""}</div>\n        <div class="bubble">${m.html}${cite}</div></div></div>`;
}

function demoSource(spec) {
  if (spec.demoJs && spec.demoJsFile) {
    throw new Error(`LWE spec "${spec.id}" must use either demoJs or demoJsFile, not both`);
  }
  if (!spec.demoJsFile) return spec.demoJs || "";
  if (!/^[a-z0-9-]+\.js$/.test(spec.demoJsFile)) {
    throw new Error(`LWE spec "${spec.id}" has an invalid demoJsFile`);
  }
  return readFileSync(join(HERE, "specs", spec.demoJsFile), "utf8").trimEnd();
}

// ---- the full page ----
function pageHtml(spec) {
  const c = byId(spec.id);
  if (!c) throw new Error(`no registry entry for "${spec.id}"`);
  validatePageSpec(spec, `LWE spec "${spec.id}"`);
  const titleSuffix = c.title;
  const stat = spec.buddyStat || c.navHint;
  const pets = spec.petsLine || "Learning&nbsp;With&nbsp;Errors";
  const favFill = c.accent.replaceAll("#", "%23");
  const favFont = c.glyphFont ? c.glyphFont.replace(/"/g, "'") : "Trebuchet MS,sans-serif";
  const askScript = (spec.hasAsk ?? c.hasAsk) ? `<script src="/lwe/ask.js" defer></script>\n` : "";
  const demoProgram = demoSource(spec);
  const demoJs = demoProgram ? `<script>\n${demoProgram}\n</script>\n` : "";
  const understanding = renderUnderstanding(spec.understanding, "lwe");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preload" as="style" href="/luna.css">
<title>aadhar.sh${c.path}</title>
<meta name="description" content="${spec.description || ""}">
<link rel="canonical" href="https://aadhar.sh${c.path}">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${favFill}'/><text x='16' y='23' font-size='20' font-family='${favFont}' fill='%23fff' text-anchor='middle'>${c.glyph}</text></svg>">
<meta property="og:type" content="article">
<meta property="og:title" content="aadhar.sh${c.path} — ${titleSuffix}">
<meta property="og:url" content="https://aadhar.sh${c.path}">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:image" content="https://aadhar.sh/og/${c.path.slice(1).replace(/\//g, "-")}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The aadhar.sh${c.path} interactive demo, screenshotted">
<meta name="twitter:image" content="https://aadhar.sh/og/${c.path.slice(1).replace(/\//g, "-")}.png">

<link rel="stylesheet" href="/lwe-base.css">
<style>${chromeCss(c)}
${spec.demoCss || ""}</style>
<link rel="stylesheet" href="/luna.css">
</head>
<body>
<!-- axp:desktop -->${DESKTOP_TOP}<!-- /axp:desktop -->
<div class="window">
  <div class="title-bar" aria-hidden="true">
    <span class="title-text"><span class="icon"></span>aadhar.sh/lwe — ${titleSuffix}</span>
    <span class="controls"><span class="min" title="minimize"></span><span class="max" title="maximize"></span><a class="close" href="/lwe" title="back to Learning With Errors" aria-label="back to Learning With Errors"></a></span>
  </div>
  <div class="content">
    <div class="msgr">

      <div class="msgr-head">
        <div class="ava" aria-hidden="true"></div>
        <div class="who"><b>${c.buddyName}</b><span class="stat">Online, ${stat}</span></div>
        <div class="pets">${pets}</div>
      </div>

      <p class="disclosure">${spec.disclosure}</p>

      <div class="log">

${spec.messages.map((m) => renderMsg(m, c)).join("\n\n")}

      </div>
      <div class="compose"><div class="box"><div class="ta">${spec.composeNote || "This is a recorded conversation. Type into the demos above."}</div></div></div>
    </div>
  </div>
</div>

${demoJs}${askScript}${understanding}
<script src="/nav.js" defer></script>
<!-- axp:shell -->${DESKTOP_CHROME}<!-- /axp:shell -->
</body>
</html>
`;
}

// ---- registry-driven wiring ----
function sitemapBlock(concepts) {
  const online = concepts.filter((c) => c.status === "online");
  const rows = online.map((c) => `  <url>\n    <loc>https://aadhar.sh${c.path}</loc>\n    <lastmod>${c.lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.3</priority>\n  </url>`);
  return rows.join("\n");
}
// The buddy list (src/pages/lwe/index.html): the full Online group, count + list,
// emitted to match the hand-authored markup exactly. Status badge per concept
// (chat = live ask box, read = page only). The per-buddy .pic CSS stays hand-authored.
function buddyGroup(concepts) {
  const online = concepts.filter((c) => c.status === "online");
  const items = online.map((c) =>
`      <li><a class="buddy ${c.buddyClass}" href="${c.path}">
        <span class="pic" aria-hidden="true"></span>
        <span class="nm"><b>${c.buddyName}</b><span class="pm">${c.pm}</span></span>
        <span class="st on">${c.badge}</span>
      </a></li>`).join("\n");
  return `    <div class="grp">Online <span class="n">· ${online.length}</span></div>\n    <ul class="buddies">\n${items}\n    </ul>`;
}
function navBlock(concepts) {
  return concepts.filter((c) => c.status === "online")
    .map((c) => `    { label: "lwe · ${c.navLabel}", path: "${c.path}", hint: "${c.navHint}" },`).join("\n");
}
// The ask.js CONCEPTS allow-list: only concepts with hasAsk + a grounded corpus.
// Keeps the include set from drifting (a page ships ask.js only when hasAsk is true).
function conceptsBlock(concepts) {
  const entries = concepts.filter((c) => c.hasAsk).map((c) => `"${c.path}": "${c.id}"`).join(", ");
  return `  var CONCEPTS = { ${entries} };`;
}

// Replace the text between an explicit start/end marker pair. Markers are passed
// in full so each file can use its own comment syntax (HTML for .xml/.html, // for .js).
function injectBetween(file, start, end, content) {
  const path = join(HOLDING, file);
  const src = readFileSync(path, "utf8");
  const i = src.indexOf(start), j = src.indexOf(end);
  if (i === -1 || j === -1) { console.log(`  · ${file}: markers not found, skipped (${start})`); return false; }
  const next = src.slice(0, i + start.length) + "\n" + content + "\n" + src.slice(j);
  writeFileSync(path, next);
  console.log(`  · ${file}: rewrote ${start.replace(/[^\w:-]+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "")} region`);
  return true;
}

export { pageHtml, chromeCss, renderMsg };

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "page") {
    const spec = JSON.parse(readFileSync(join(HERE, "specs", `${arg}.json`), "utf8"));
    const out = join(HOLDING, "lwe", `${arg}.html`);
    writeFileSync(out, pageHtml(spec));
    console.log(`wrote ${out}`);
  } else if (cmd === "wire") {
    console.log("wiring from concepts.json:");
    injectBetween("sitemap.xml", "<!-- generated:lwe:start -->", "<!-- generated:lwe:end -->", sitemapBlock(REGISTRY));
    injectBetween("lwe/index.html", "<!-- generated:buddies:start -->", "<!-- generated:buddies:end -->", buddyGroup(REGISTRY));
    injectBetween("nav.js", "// generated:lwe-pages:start", "// generated:lwe-pages:end", navBlock(REGISTRY));
    injectBetween("lwe/ask.js", "// generated:concepts:start", "// generated:concepts:end", conceptsBlock(REGISTRY));
  } else {
    console.log("usage: generate.mjs page <id> | generate.mjs wire");
  }
}
