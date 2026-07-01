// writing.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { cachedRender } from "./lib/edgecache.js";
import { escAttr, escHtml } from "./lib/http.js";

// ── /writing — the Notepad view ───────────────────────────────────────────────
// Written content lives in plain .txt files under /writing/ + a posts.json registry.
// Each post renders as an XP Notepad window whose <textarea> is SSR-seeded with the
// canonical text: editable by nature, ephemeral by nature (no save → reload restores
// the canonical copy). The prose ships in the HTML, so it's readable/crawlable with
// JS off; notepad.js only adds the menus + Ln/Col status + the F5 date stamp.
export const NOTEPAD_CSS = `
html{background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%)}
body.np-page{margin:0;min-height:100vh;padding:16px 12px 54px;color:oklch(21% 0 0);font-family:var(--font-ui);font-size:12px;
background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%)}
.np-window{max-width:860px;margin:0 auto;max-height:calc(100dvh - 78px);display:flex;flex-direction:column;background:oklch(100% 0 0);
border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-top-left-radius:8px;border-top-right-radius:8px;overflow:hidden;
box-shadow:inset 1px 1px 0 #166aee,inset 2px 2px 0 #0855dd,inset -1px -1px 0 #00138c,inset -2px -2px 0 #003bda,4px 4px 0 rgba(0,30,160,.35)}
.np-titlebar{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:4px 6px 4px 7px;color:oklch(100% 0 0);
font-family:var(--font-caption);font-weight:bold;font-size:11px;text-shadow:1px 1px #0f1089;border-bottom:1px solid oklch(41.9% 0.096 250);
background:linear-gradient(180deg,oklch(70% 0.15 258) 0%,oklch(60% 0.20 261) 8%,oklch(51% 0.225 263) 18%,oklch(50% 0.225 263) 86%,oklch(58% 0.18 260) 100%)}
.np-ico{flex:0 0 auto;width:14px;height:15px;background:oklch(100% 0 0);border:1px solid oklch(45% 0 0);border-radius:1px;position:relative}
.np-ico::before{content:"";position:absolute;left:2px;right:3px;top:3px;height:1px;background:oklch(55% 0.16 258);box-shadow:0 3px 0 oklch(55% 0.16 258),0 6px 0 oklch(55% 0.16 258),0 9px 0 oklch(55% 0.16 258)}
.np-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.np-controls{display:flex;gap:2px}
/* canonical Luna caption buttons (design system): 21x21 glossy "gel" lozenges,
   min/max blue + close red, CSS-drawn white glyphs. matches .title-bar .controls
   site-wide; hex traced from the Luna .msstyles bitmap, kept hex on purpose. */
.np-controls .min,.np-controls .max,.np-controls .close{position:relative;box-sizing:border-box;width:21px;height:21px;padding:0;display:inline-block;overflow:hidden;font-size:0;color:transparent;text-decoration:none;cursor:pointer;border:1px solid #6696eb;border-radius:3px;background-color:#3e73f5;background-image:linear-gradient(180deg,#5f8cf7 0%,#3a71f5 22%,#3e73f5 55%,#2a70f2 82%,#1045be 100%);transition:filter 60ms ease-out}
.np-controls .min::after,.np-controls .max::after{content:"";position:absolute;left:0;right:0;top:0;height:45%;background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.12) 70%,rgba(255,255,255,0) 100%);pointer-events:none;border-radius:2px 2px 5px 5px}
.np-controls .min:hover,.np-controls .min:focus-visible,.np-controls .max:hover,.np-controls .max:focus-visible{border-color:#8fb4ff;background-color:#4fa4ff;background-image:linear-gradient(180deg,#689bff 0%,#468aff 22%,#4fa4ff 55%,#3990fc 82%,#1858c8 100%);outline:none}
.np-controls .min:active,.np-controls .max:active,.np-controls .close:active{filter:brightness(.9)}
.np-controls .min::before{content:"";position:absolute;left:5px;right:5px;bottom:5px;height:2px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}
.np-controls .max::before{content:"";position:absolute;left:5px;top:5px;width:11px;height:9px;box-sizing:border-box;border:1px solid #fff;border-top-width:2px;filter:drop-shadow(0 1px 0 rgba(0,0,0,.35))}
.np-controls .close{border-color:#d8401c;background-color:#e45f3e;background-image:linear-gradient(180deg,#e8795f 0%,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110 100%)}
.np-controls .close:hover,.np-controls .close:focus-visible{border-color:#ff7a66;background-color:#ff957c;background-image:linear-gradient(180deg,#ff8b7d 0%,#ff7463 26%,#ff957c 55%,#fd7e64 82%,#d34936 100%);box-shadow:0 0 4px rgba(255,120,96,.7);outline:none}
.np-controls .close::before,.np-controls .close::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:2px;margin:-1px 0 0 -6.5px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}
.np-controls .close::before{transform:rotate(45deg)}.np-controls .close::after{transform:rotate(-45deg)}
.np-menubar{flex:0 0 auto;display:flex;align-items:stretch;gap:0;padding:1px 2px;font-size:11px;position:relative;
background:oklch(93% 0.012 90);border-bottom:1px solid oklch(78% 0.02 90)}
.np-menu{border:0;background:none;font:11px var(--font-ui);color:oklch(20% 0 0);padding:3px 8px;cursor:pointer;border-radius:2px}
.np-menu:hover,.np-menu[aria-expanded=true]{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-drop{position:absolute;top:100%;min-width:170px;z-index:50;background:oklch(98% 0.004 250);padding:2px;
border:1px solid oklch(45% 0 0);box-shadow:2px 2px 0 oklch(0% 0 0 / .25)}
.np-item{display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:8px;width:100%;border:0;background:none;cursor:pointer;
font:11px var(--font-ui);color:oklch(20% 0 0);padding:4px 8px 4px 2px;text-align:left}
.np-item:hover{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-chk{text-align:center;font-size:10px}.np-acc{color:oklch(52% 0 0)}.np-item:hover .np-acc{color:oklch(90% 0.02 263)}
.np-sep{height:0;border-top:1px solid oklch(80% 0.01 90);margin:2px 1px}
.np-text{flex:0 1 auto;field-sizing:content;min-height:8em;max-height:calc(100dvh - 150px);width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:9px 11px;background:oklch(100% 0 0);
color:oklch(16% 0 0);font-family:var(--font-mono);font-size:13px;line-height:1.55;white-space:pre-wrap;overflow:auto;tab-size:4}
.np-text.nowrap{white-space:pre;overflow:auto}
.np-status{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:2px 3px;font-size:11px;color:oklch(28% 0 0);
background:oklch(93% 0.012 90);border-top:1px solid oklch(80% 0.02 90)}
.np-status>span:not(.np-flex){padding:1px 8px;box-shadow:inset 1px 1px 0 oklch(78% 0.02 90),inset -1px -1px 0 oklch(100% 0 0)}
.np-flex{flex:1;box-shadow:none}
.np-edited{color:oklch(46% 0 0)}
/* a note opened as a popover — floats over the folder ("selecting menu"),
   clears the taskbar, and keeps the window chrome (drag/resize/scrollbar). */
.np-note[popover]{position:fixed;left:0;right:0;top:10px;margin:0 auto;width:min(720px,calc(100vw - 32px));max-height:calc(100dvh - 48px) !important}
.np-note[popover]::backdrop{background:transparent}
/* CRITICAL: our .np-window{display:flex} would otherwise beat the UA
   [popover]:not(:popover-open){display:none}, leaking closed notes into flow.
   INVERTED on purpose: in a pre-Popover engine, :popover-open is an unknown
   pseudo-class — a rule hiding via :not(:popover-open) would DROP entirely
   (non-forgiving :not()), stacking every note over the folder with no UA
   rule to save us. hide-by-default survives any parser; only an engine that
   understands :popover-open (and therefore popovers) can reveal a note. */
.np-note{display:none !important}
.np-note:popover-open{display:flex !important}
/* folder index ("My Writing") */
.np-folder{height:auto;min-height:0;max-width:560px}
.np-folder-body{padding:14px 16px 6px}
.np-folder-intro{margin:0 0 12px;color:oklch(40% 0 0)}
.np-files{list-style:none;margin:0;padding:0;border:1px solid oklch(80% 0.02 250)}
.np-files li+li{border-top:1px solid oklch(92% 0.01 250)}
.np-files a{display:flex;align-items:center;gap:10px;padding:7px 10px;text-decoration:none;color:oklch(20% 0 0)}
.np-files a:hover{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-files a:nth-child(odd){background:oklch(97.5% 0.006 255)}
.np-files a:hover{background:oklch(50% 0.22 263)}
.np-file-ico{flex:0 0 auto;width:18px;height:20px;background:oklch(100% 0 0);border:1px solid oklch(50% 0 0);border-radius:1px;position:relative}
.np-file-ico::before{content:"";position:absolute;left:3px;right:4px;top:4px;height:1px;background:oklch(58% 0.16 258);box-shadow:0 3px 0 oklch(58% 0.16 258),0 6px 0 oklch(58% 0.16 258),0 9px 0 oklch(58% 0.16 258)}
.np-file-name{font-weight:bold;color:inherit}.np-files a:hover .np-file-name{color:oklch(100% 0 0)}
.np-file-meta{margin-left:auto;color:oklch(52% 0 0);font-size:11px}.np-files a:hover .np-file-meta{color:oklch(90% 0.02 263)}
/* About dialog */
.np-modal-back{position:fixed;inset:0;z-index:100000}
.np-about{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:100001;width:min(340px,calc(100vw - 24px));background:oklch(100% 0 0);
border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;box-shadow:inset 1px 1px 0 #166aee,inset -1px -1px 0 #00138c,4px 4px 0 rgba(0,30,160,.35)}
.np-about-body{padding:12px 14px}.np-about-body p{margin:0 0 9px;line-height:1.45}
.np-about-btns{display:flex;justify-content:flex-end}
.np-btn{min-width:72px;padding:3px 12px;font:12px var(--font-ui);cursor:pointer;color:oklch(18% 0 0);border:1px solid oklch(50% 0.04 263);border-radius:3px;
background:linear-gradient(180deg,oklch(99% 0 0),oklch(92% 0.005 263));box-shadow:inset 1px 1px 0 oklch(100% 0 0),inset -1px -1px 0 oklch(84% 0.02 90)}
.np-btn:active{box-shadow:inset 1px 1px 0 oklch(84% 0.02 90),inset -1px -1px 0 oklch(100% 0 0)}
@media print{body.np-page{padding:0;background:none}#axp-taskbar,.np-titlebar,.np-menubar,.np-status{display:none}
.np-window{border:0;box-shadow:none;height:auto;max-width:none}.np-text{font-size:11pt;color:#000}}
/* OS-window geometry inlined so first paint matches nav.js (no shell "pop").
   byte-identical to nav.js's app-shell rules; !important beats body.np-page's
   own padding/min-height; degrades with JS off. */
html{height:100dvh;overflow:hidden}
body{min-height:0 !important;height:calc(100vh - 30px) !important;height:calc(100dvh - 30px) !important;overflow-x:hidden !important;overflow-y:auto !important;box-sizing:border-box}
body:has(.window),body:has(.np-window),body:has(.wrap){overflow:hidden !important;display:flex !important;flex-direction:column !important;align-items:center !important;padding:8px !important}
.window,.np-window,.wrap{position:relative;z-index:2;flex:0 1 auto !important;min-height:0;max-height:100% !important;width:100%;margin:0 auto !important;box-sizing:border-box}
.window,.np-window{display:flex;flex-direction:column}
.window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:0 0 auto}
.window>.content,.window>.body{flex:1 1 auto;min-height:0;overflow:auto;padding-right:28px!important}
.np-window .np-text{flex:1 1 auto;min-height:0}
.wrap{display:flex;flex-direction:column;padding-bottom:0 !important}.wrap>.window{flex:0 1 auto;max-height:100%}
body.np-page::after{content:"";position:fixed;left:0;right:0;bottom:0;height:30px;z-index:1;background:linear-gradient(180deg,oklch(67% 0.15 256) 0%,oklch(58% 0.19 257) 4%,oklch(51% 0.20 258) 9%,oklch(49% 0.20 258) 50%,oklch(46% 0.20 259) 92%,oklch(40% 0.18 260) 100%)}
`;

export function writingShell(o) {
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + escHtml(o.title) + "</title>" +
    "<meta name=\"description\" content=\"" + escAttr(o.desc) + "\">" +
    "<link rel=\"canonical\" href=\"https://aadhar.sh" + escAttr(o.path) + "\">" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='7' y='3' width='18' height='26' rx='1' fill='%23ffffff' stroke='%230855dd' stroke-width='2'/><rect x='10' y='9' width='12' height='1.6' fill='%23166aee'/><rect x='10' y='14' width='12' height='1.6' fill='%23166aee'/><rect x='10' y='19' width='8' height='1.6' fill='%23166aee'/></svg>\">" +
    "<style>:root{--font-caption:\"Trebuchet MS\",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:\"Courier New\",Courier,monospace}</style>" +
    "<style>" + NOTEPAD_CSS + "</style></head><body class=\"np-page\">" +
    o.body +
    "<script src=\"/notepad.js\" defer></script><script src=\"/nav.js\" defer></script></body></html>";
}

// popId (optional): render the window as an inline popover (id + popover="auto")
// so it can composite over the folder index instead of being its own page.
export function notepadWindow(filename, text, closeHref, date, popId) {
  var open = popId
    ? "<div class=\"np-window np-note\" id=\"" + escAttr(popId) + "\" popover=\"manual\">"
    : "<div class=\"np-window\">";
  return open +
    "<div class=\"np-titlebar\"><span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-title\">" + escHtml(filename) + " — Notepad</span>" +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span>" +
      "<a class=\"close\" href=\"" + escAttr(closeHref) + "\"" + (popId ? " data-pop" : "") + " title=\"back to writing\" aria-label=\"Close\">✕</a></span></div>" +
    "<div class=\"np-menubar\" role=\"menubar\" aria-label=\"menu\">" +
      "<span class=\"np-menu\">File</span><span class=\"np-menu\">Edit</span><span class=\"np-menu\">Format</span><span class=\"np-menu\">View</span><span class=\"np-menu\">Help</span></div>" +
    "<textarea class=\"np-text\" spellcheck=\"false\" aria-label=\"" + escAttr(filename) + "\">" + escHtml(text) + "</textarea>" +
    "<div class=\"np-status\"><span class=\"np-pos\">Ln 1, Col 1</span><span class=\"np-wc\"></span><span class=\"np-flex\"></span>" +
      (date ? "<span class=\"np-edited\">last changed " + escHtml(date) + "</span>" : "") + "</div></div>";
}

export async function readPosts(env) {
  try {
    const r = await env.ASSETS.fetch("https://a/writing/posts.json");
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j; }
  } catch {}
  return [];
}

// both /writing views are shared-content renders (no per-visitor bytes), so they
// ride the caches.default layer: edge TTL = each response's max-age (120s index /
// 300s post). the 404 post path is excluded by cachedRender's 200-only put.
export function handleWritingPost(request, slug, env, ctx) {
  return cachedRender(request, ctx, () => renderWritingPost(slug, env));
}

async function renderWritingPost(slug, env) {
  const safe = String(slug).replace(/[^a-z0-9-]/gi, "");
  const posts = await readPosts(env);
  const post = posts.find(function (p) { return p.slug === safe; });
  let text = null;
  if (post) {
    try { const r = await env.ASSETS.fetch("https://a/writing/" + safe + ".txt"); if (r.ok) text = await r.text(); } catch {}
  }
  if (!post || text == null) {
    const body = notepadWindow("(not found).txt", "This note doesn't exist yet. Maybe I haven't written it.\n\nThe index lives at /writing.", "/writing");
    return new Response(writingShell({ title: "aadhar.sh/writing/not found", path: "/writing/" + safe, desc: "No such note.", body: body }),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30, must-revalidate" } });
  }
  const title = post.title || safe;
  const desc = text.replace(/\s+/g, " ").trim().slice(0, 155);
  const body = notepadWindow(title + ".txt", text, "/writing", post.date);
  return new Response(writingShell({ title: "aadhar.sh/writing/" + title + ".txt", path: "/writing/" + safe, desc: desc, body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

export function handleWritingIndex(request, env, ctx) {
  // keyed on the bare path so /writing and /writing/ share one edge entry
  return cachedRender(request, ctx, () => renderWritingIndex(env), "/writing");
}

async function renderWritingIndex(env) {
  const posts = await readPosts(env);
  // fetch each note's .txt once: the same text feeds the char count shown in
  // the folder listing (so you see a file's size before you open it) AND the
  // inline popover Notepad window below. notes are tiny — cheap to inline.
  const fmtNum = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
  const entries = await Promise.all(posts.map(async function (p) {
    const safe = String(p.slug).replace(/[^a-z0-9-]/gi, "");
    let text = "";
    try { const r = await env.ASSETS.fetch("https://a/writing/" + safe + ".txt"); if (r.ok) text = await r.text(); } catch {}
    return { p: p, safe: safe, text: text, chars: text.length };
  }));
  const files = entries.map(function (e) {
    const size = fmtNum(e.chars) + (e.chars === 1 ? " character" : " characters");
    return "<li><a href=\"/writing/" + escAttr(e.p.slug) + "\" data-note=\"" + escAttr(e.safe) + "\"><span class=\"np-file-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-file-name\">" + escHtml(e.p.title || e.p.slug) + ".txt</span>" +
      "<span class=\"np-file-meta\">Text Document · " + size + (e.p.date ? " · " + escHtml(e.p.date) : "") + "</span></a></li>";
  }).join("");
  // the list <a>'s real href is the no-JS / permalink path; opening one composites
  // its popover Notepad over the folder (the "selecting menu") with no navigation.
  const notes = entries.map(function (e) {
    return notepadWindow((e.p.title || e.safe) + ".txt", e.text, "/writing", e.p.date, "note-" + e.safe);
  }).join("");
  const body = "<div class=\"np-window np-folder\">" +
    "<div class=\"np-titlebar\"><span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-title\">aadhar.sh/writing</span>" +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span>" +
      "<a class=\"close\" href=\"/\" title=\"back home\" aria-label=\"Close\">✕</a></span></div>" +
    "<div class=\"np-folder-body\"><p class=\"np-folder-intro\">Notes, in flux. Open one: it's a real text field you can edit, though it reverts to my canonical version on reload.</p>" +
      "<ul class=\"np-files\">" + (files || "<li><a><span class=\"np-file-name\">(nothing written yet)</span></a></li>") + "</ul></div>" +
    "<div class=\"np-status\"><span>" + posts.length + (posts.length === 1 ? " document" : " documents") + "</span>" +
      "<span>" + fmtNum(entries.reduce(function (a, e) { return a + e.chars; }, 0)) + " characters</span></div></div>" +
    notes;
  return new Response(writingShell({ title: "aadhar.sh/writing", path: "/writing", desc: "Notes in flux: an editable Notepad of writing that reverts to canonical on reload.", body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" } });
}
