#!/usr/bin/env node
// LWE page generator — Phase 1 of the lwe-publish pipeline.
//
//   node lwe-pipeline/generate.mjs page <id>   # specs/<id>.json -> holding/lwe/<id>.html
//   node lwe-pipeline/generate.mjs wire         # rewrite the registry-driven regions
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
import { renderUnderstanding, validatePageSpec } from "../content-pipeline/page-contract.mjs";
import { DESKTOP_CHROME, DESKTOP_TOP } from "../holding/_worker.js/lib/desktop.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HOLDING = join(ROOT, "holding");
const REGISTRY = JSON.parse(readFileSync(join(HERE, "concepts.json"), "utf8")).concepts;
const byId = (id) => REGISTRY.find((c) => c.id === id);

// ---- shared chrome + messenger CSS, parameterized by the concept's accent + glyph ----
// Faithful to holding/lwe/utf8.html; only the accent, the glyph, and the bot avatar move.
function chromeCss(c) {
  const soft = c.accentSoft || "#f6f1e6";
  const glyphFont = c.glyphFont || 'var(--font-caption)';
  const [g0, g1] = c.picGrad;
  return `:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace; --accent:${c.accent}; --accent-soft:${soft}}
* { box-sizing: border-box; }
@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}::view-transition-old(root),::view-transition-new(root){animation-duration:140ms}}
html, body { margin: 0; padding: 0; } html{background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%)}
body { background: linear-gradient(180deg, oklch(56% 0.13 250) 0%, oklch(73% 0.10 236) 50%, oklch(88% 0.05 232) 60%, oklch(60% 0.16 140) 100%); font-family: var(--font-ui); font-size: 10.5pt; line-height: 1.5; color: oklch(21.78% 0 0); padding: 24px 12px 60px; min-height: 100vh; }
.window { max-width: 640px; margin: 0 auto; background: oklch(100% 0 0); border: 2px solid #0831d9; border-right-color: #001ea0; border-bottom-color: #001ea0; border-top-left-radius: 8px; border-top-right-radius: 8px; overflow: hidden; box-shadow: inset 1px 1px 0 #166aee, inset 2px 2px 0 #0855dd, inset -1px -1px 0 #00138c, inset -2px -2px 0 #003bda, 4px 4px 0 rgba(0,30,160,.35); }
.title-bar { background: linear-gradient(180deg, oklch(70% 0.15 258) 0%, oklch(60% 0.20 261) 8%, oklch(51% 0.225 263) 18%, oklch(50% 0.225 263) 86%, oklch(58% 0.18 260) 100%); color: #fff; font-family: var(--font-caption); font-weight: bold; font-size: 11pt; padding: 4px 5px 4px 8px; display: flex; align-items: center; gap: 6px; text-shadow: 1px 1px #0f1089; user-select: none; }
.title-bar .title-text { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title-bar .icon { width: 14px; height: 14px; flex: 0 0 14px; background: #fff; border: 1px solid ${c.picBorder}; position: relative; }
.title-bar .icon::before { content: "${c.glyph}"; position: absolute; inset: 0; display: grid; place-items: center; font-size: 10px; color: var(--accent); font-weight: bold; text-shadow: none; }
.controls { display: inline-flex; align-items: center; gap: 2px; }
.controls .min, .controls .max, .controls .close { position: relative; box-sizing: border-box; width: 21px; height: 21px; display: inline-block; overflow: hidden; font-size: 0; color: transparent; border: 1px solid #6696eb; border-radius: 3px; text-decoration: none; cursor: pointer; background-image: linear-gradient(180deg, #5f8cf7 0%, #3a71f5 22%, #3e73f5 55%, #2a70f2 82%, #1045be 100%); }
.controls .close { border-color: #d8401c; background-image: linear-gradient(180deg, #e8795f 0%, #e45f40 30%, #e45d3d 52%, #e2552a 80%, #ae3110 100%); }
.controls .min::before { content: ""; position: absolute; left: 5px; right: 5px; bottom: 5px; height: 2px; background: #fff; }
.controls .max::before { content: ""; position: absolute; left: 5px; top: 5px; width: 11px; height: 9px; box-sizing: border-box; border: 1px solid #fff; border-top-width: 2px; }
.controls .close::before, .controls .close::after { content: ""; position: absolute; left: 50%; top: 50%; width: 13px; height: 2px; margin: -1px 0 0 -6.5px; background: #fff; }
.controls .close::before { transform: rotate(45deg); } .controls .close::after { transform: rotate(-45deg); }
.content { background: oklch(99% 0.005 95); border-top: 1px solid oklch(46% 0.02 260); border-left: 1px solid oklch(46% 0.02 260); padding: 0; }
html { height: 100dvh; overflow: hidden; }
body { min-height: 0; height: calc(100vh - 30px); height: calc(100dvh - 30px); overflow: hidden; display: flex; flex-direction: column; align-items: center; padding: 8px; }
.window { flex: 0 1 auto; min-height: 0; max-height: 100%; display: flex; flex-direction: column; }
.window > .title-bar { flex: 0 0 auto; }
.window > .content { flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: 28px; }
body::after { content: ""; position: fixed; left: 0; right: 0; bottom: 0; height: 30px; z-index: 1; background: linear-gradient(180deg, oklch(67% 0.15 256) 0%, oklch(58% 0.19 257) 4%, oklch(51% 0.20 258) 9%, oklch(49% 0.20 258) 50%, oklch(46% 0.20 259) 92%, oklch(40% 0.18 260) 100%); }
.msgr { display: flex; flex-direction: column; }
.msgr-head { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: linear-gradient(180deg, #fffdf6, #f6edd6); border-bottom: 1px solid #e0cf9e; }
.msgr-head .ava { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 4px; border: 1px solid ${c.picBorder}; background: linear-gradient(180deg,${g0},${g1}); position: relative; }
.msgr-head .ava::before { content: "${c.glyph}"; position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-weight: bold; font-size: 19px; font-family: ${glyphFont}; }
.msgr-head .who { flex: 1; min-width: 0; }
.msgr-head .who b { font-family: var(--font-caption); font-size: 11pt; color: ${c.nameColor}; }
.msgr-head .who .stat { display: block; font-size: 8.5pt; color: oklch(46% 0.02 145); }
.msgr-head .who .stat::before { content: "● "; color: oklch(60% 0.18 145); }
.msgr-head .pets { font-size: 8pt; color: #6b7280; text-align: right; line-height: 1.35; }
.disclosure { font-size: 8.5pt; color: #5a6679; background: #fcfbe9; border-bottom: 1px solid #e6dfa8; padding: 5px 12px; }
.disclosure b { color: ${c.nameColor}; } .disclosure a { color: #1a4fc4; }
.log { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 11px; }
.msg { display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: start; content-visibility: auto; contain-intrinsic-size: auto 90px; }
.msg .pic { width: 26px; height: 26px; border-radius: 4px; border: 1px solid #99a; position: relative; overflow: hidden; }
.msg.bot .pic { background: linear-gradient(180deg,${g0},${g1}); border-color:${c.picBorder}; }
.msg.bot .pic::before { content: "${c.glyph}"; position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-weight: bold; font-size: 13px; font-family: ${glyphFont}; }
.msg.you .pic { background: linear-gradient(180deg,#ffb35a,#f08a25); border-color:#c96a10; }
.msg.you .pic::before { content: ":)"; position: absolute; inset: 0; display: grid; place-items: center; color: #7a3d00; font-weight: bold; font-size: 9px; transform: rotate(90deg); }
.msg .who { font-size: 8.5pt; margin-bottom: 1px; } .msg .who b { font-family: var(--font-caption); }
.msg.bot .who b { color: ${c.nameColor}; } .msg.you .who b { color: #b5560c; }
.msg .who time { color: #9aa3b2; font-family: var(--font-mono); font-size: 8pt; margin-left: 5px; }
.msg .bubble { font-size: 10.5pt; } .msg.bot .bubble { color: #15243f; } .msg.you .bubble { color: #3a2a12; }
.msg .bubble p { margin: 0 0 7px; } .msg .bubble p:last-child { margin-bottom: 0; } .msg .bubble em { font-style: italic; }
.msg .bubble code { font-family: var(--font-mono); font-size: 9.5pt; background: #f1ece0; padding: 0 3px; border-radius: 2px; }
.msg a { color: #1a4fc4; }
.demo { grid-column: 1 / -1; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent-soft); margin: 2px 0; overflow: hidden; box-shadow: inset 0 1px 0 #fff; }
.demo > .bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 8.5pt; color: ${c.nameColor}; background: linear-gradient(180deg,#f6edd6,#ecdfb8); border-bottom: 1px solid var(--accent); font-weight: bold; }
.demo > .bar::before { content: "🖥"; filter: grayscale(.2); }
.demo > .pad { padding: 11px 12px 13px; background:#fff; }
.demo .lead { font-size: 9pt; color: #4a5568; margin: 0 0 10px; } .demo .lead b { color: #15243f; }
.mono { font-family: var(--font-mono); }
.btn { font-family: var(--font-ui); font-size: 9pt; padding: 3px 9px; cursor: pointer; background: linear-gradient(to bottom,#fff,#e9edf5); border: 1px solid #7d8aa3; border-radius: 2px; box-shadow: inset 1px 1px 0 #fff; }
.btn:hover { border-color: var(--accent); }
.scrollnote { text-align: center; font-size: 8pt; color: #9aa3b2; padding: 3px 0 9px; }
.compose { border-top: 1px solid #e0cf9e; background: linear-gradient(180deg,#fffdf6,#f3ead0); padding: 7px 10px; }
.compose .box { display: flex; gap: 7px; }
.compose .ta { flex: 1; min-height: 30px; border: 1px solid #7d8aa3; background: #fff; box-shadow: inset 1px 1px 0 #c3cbdb; padding: 4px 6px; font-family: var(--font-ui); font-size: 9.5pt; color: #9aa3b2; }
@media (max-width: 520px){ body { padding: 8px 4px 32px; } .msgr-head .pets { display:none } }`;
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

// ---- the full page ----
function pageHtml(spec) {
  const c = byId(spec.id);
  if (!c) throw new Error(`no registry entry for "${spec.id}"`);
  validatePageSpec(spec, `LWE spec "${spec.id}"`);
  const titleSuffix = c.title;
  const stat = spec.buddyStat || c.navHint;
  const pets = spec.petsLine || "Learning&nbsp;With&nbsp;Errors";
  const favFill = c.accent.replace("#", "%23");
  const favFont = c.glyphFont ? c.glyphFont.replace(/"/g, "'") : "Trebuchet MS,sans-serif";
  const askScript = (spec.hasAsk ?? c.hasAsk) ? `<script src="/lwe/ask.js" defer></script>\n` : "";
  const demoJs = spec.demoJs ? `<script>\n${spec.demoJs}\n</script>\n` : "";
  const understanding = renderUnderstanding(spec.understanding, "lwe");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aadhar.sh${c.path}</title>
<meta name="description" content="${spec.description || ""}">
<link rel="canonical" href="https://aadhar.sh${c.path}">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${favFill}'/><text x='16' y='23' font-size='20' font-family='${favFont}' fill='%23fff' text-anchor='middle'>${c.glyph}</text></svg>">
<meta property="og:type" content="article">
<meta property="og:title" content="aadhar.sh${c.path} — ${titleSuffix}">
<meta property="og:url" content="https://aadhar.sh${c.path}">

<style>${chromeCss(c)}
${spec.demoCss || ""}</style>
</head>
<body>
${DESKTOP_TOP}
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

<script type="speculationrules">
{ "prerender": [ { "where": { "and": [ { "href_matches": "/*" }, { "not": { "href_matches": "/" } }, { "not": { "href_matches": "/around*" } }, { "not": { "href_matches": "/whoareyou*" } } ] }, "eagerness": "moderate" } ], "prefetch": [ { "where": { "and": [ { "or": [ { "href_matches": "/garage/*" }, { "href_matches": "/lwe/*" } ] }, { "not": { "href_matches": "/lwe/ask*" } } ] }, "eagerness": "eager" } ] }
</script>
<script>
if ("serviceWorker" in navigator) { var reg = function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); }; "requestIdleCallback" in window ? requestIdleCallback(reg, { timeout: 2000 }) : setTimeout(reg, 1000); }
</script>
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
// The buddy list (holding/lwe/index.html): the full Online group, count + list,
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
  console.log(`  · ${file}: rewrote ${start.replace(/<!--|-->|\/\//g, "").trim()} region`);
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
