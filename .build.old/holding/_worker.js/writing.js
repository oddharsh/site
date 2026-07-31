// writing.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { cachedRender } from "./lib/cache.js";
import { DESKTOP_CHROME, DESKTOP_TOP } from "./lib/desktop.js";
import { escAttr, escHtml } from "./lib/http.js";

// ── /writing — the Notepad view ───────────────────────────────────────────────
// Written content lives in plain .txt files under /writing/ + a posts.json registry.
// Each post renders as an XP Notepad window whose <textarea> is SSR-seeded with the
// canonical text: editable by nature, ephemeral by nature (no save → reload restores
// the canonical copy). The prose ships in the HTML, so it's readable/crawlable with
// JS off; notepad.js only adds the menus + Ln/Col status + the F5 date stamp.
export const NOTEPAD_CSS = `html{background:linear-gradient(oklch(56% .13 250) 0%,oklch(73% .1 236) 50%,oklch(88% .05 232) 60%,oklch(60% .16 140) 100%)}body.np-page{color:oklch(21% 0 0);min-height:100vh;font-family:var(--font-ui);background:linear-gradient(oklch(56% .13 250) 0%,oklch(73% .1 236) 50%,oklch(88% .05 232) 60%,oklch(60% .16 140) 100%);margin:0;padding:16px 12px 54px;font-size:12px}.np-window{background:oklch(100% 0 0);border:2px solid #001ea0;border-color:#0831d9 #001ea0 #001ea0 #0831d9;border-top-left-radius:8px;border-top-right-radius:8px;flex-direction:column;max-width:860px;max-height:calc(100dvh - 78px);margin:0 auto;display:flex;overflow:hidden;box-shadow:inset 1px 1px #166aee,inset 2px 2px #0855dd,inset -1px -1px #00138c,inset -2px -2px #003bda,4px 4px #001ea059}.np-titlebar{color:oklch(100% 0 0);font-family:var(--font-caption);text-shadow:1px 1px #0f1089;background:linear-gradient(oklch(70% .15 258) 0%,oklch(60% .2 261) 8%,oklch(51% .225 263) 18%,oklch(50% .225 263) 86%,oklch(58% .18 260) 100%);border-bottom:1px solid oklch(41.9% .096 250);flex:none;align-items:center;gap:5px;padding:4px 6px 4px 7px;font-size:10pt;font-weight:700;display:flex}.np-ico{background:oklch(100% 0 0);border:1px solid oklch(45% 0 0);border-radius:1px;flex:none;width:14px;height:15px;position:relative}.np-ico:before{content:"";background:oklch(55% .16 258);height:1px;position:absolute;top:3px;left:2px;right:3px;box-shadow:0 3px oklch(55% .16 258),0 6px oklch(55% .16 258),0 9px oklch(55% .16 258)}.np-title{text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.np-controls{gap:2px;display:flex}.np-menubar{background:oklch(93% .012 90);border-bottom:1px solid oklch(78% .02 90);flex:none;align-items:stretch;gap:0;padding:1px 2px;font-size:11px;display:flex;position:relative}.np-menu{font:11px var(--font-ui);color:oklch(20% 0 0);cursor:pointer;background:0 0;border:0;border-radius:2px;padding:3px 8px}.np-menu:hover,.np-menu[aria-expanded=true]{color:oklch(100% 0 0);background:oklch(50% .22 263)}.np-drop{z-index:50;background:oklch(98% .004 250);border:1px solid oklch(45% 0 0);min-width:170px;padding:2px;position:absolute;top:100%;box-shadow:2px 2px oklch(0% 0 0/.25)}.np-item{cursor:pointer;width:100%;font:11px var(--font-ui);color:oklch(20% 0 0);text-align:left;background:0 0;border:0;grid-template-columns:18px 1fr auto;align-items:center;gap:8px;padding:4px 8px 4px 2px;display:grid}.np-item:hover{color:oklch(100% 0 0);background:oklch(50% .22 263)}.np-chk{text-align:center;font-size:10px}.np-acc{color:oklch(52% 0 0)}.np-item:hover .np-acc{color:oklch(90% .02 263)}.np-sep{border-top:1px solid oklch(80% .01 90);height:0;margin:2px 1px}.np-text{field-sizing:content;box-sizing:border-box;resize:none;color:oklch(16% 0 0);width:100%;min-height:8em;max-height:calc(100dvh - 150px);font-family:var(--font-mono);white-space:pre-wrap;tab-size:4;background:oklch(100% 0 0);border:0;outline:none;flex:0 auto;padding:9px 11px;font-size:13px;line-height:1.55;overflow:auto}.np-text.nowrap{white-space:pre;overflow:auto}.np-status{color:oklch(28% 0 0);background:oklch(93% .012 90);border-top:1px solid oklch(80% .02 90);flex:none;align-items:center;gap:4px;padding:2px 3px;font-size:11px;display:flex}.np-status>span:not(.np-flex){padding:1px 8px;box-shadow:inset 1px 1px oklch(78% .02 90),inset -1px -1px oklch(100% 0 0)}.np-flex{box-shadow:none;flex:1}.np-edited{color:oklch(46% 0 0)}.np-note[popover]{width:min(720px,100vw - 32px);margin:0 auto;position:fixed;top:10px;left:0;right:0;max-height:calc(100dvh - 48px)!important}.np-note[popover]::backdrop{background:0 0}.np-note{display:none!important}.np-note:popover-open{display:flex!important}.np-folder{max-width:560px;height:auto;min-height:0}.np-folder-body{padding:14px 16px 6px}.np-folder-intro{color:oklch(40% 0 0);text-wrap:pretty;margin:0 0 12px}.np-files{border:1px solid oklch(80% .02 250);margin:0;padding:0;list-style:none}.np-files li+li{border-top:1px solid oklch(92% .01 250)}.np-files a{color:oklch(20% 0 0);align-items:center;gap:10px;padding:7px 10px;text-decoration:none;display:flex}.np-files a:hover{color:oklch(100% 0 0);background:oklch(50% .22 263)}.np-files a:nth-child(odd){background:oklch(97.5% .006 255)}.np-files a:hover{background:oklch(50% .22 263)}.np-file-ico{background:oklch(100% 0 0);border:1px solid oklch(50% 0 0);border-radius:1px;flex:none;width:18px;height:20px;position:relative}.np-file-ico:before{content:"";background:oklch(58% .16 258);height:1px;position:absolute;top:4px;left:3px;right:4px;box-shadow:0 3px oklch(58% .16 258),0 6px oklch(58% .16 258),0 9px oklch(58% .16 258)}.np-file-name{color:inherit;font-weight:700}.np-files a:hover .np-file-name{color:oklch(100% 0 0)}.np-file-meta{color:oklch(52% 0 0);margin-left:auto;font-size:11px}.np-files a:hover .np-file-meta{color:oklch(90% .02 263)}.np-modal-back{z-index:100000;position:fixed;inset:0}.np-about{z-index:100001;background:oklch(100% 0 0);border:2px solid #001ea0;border-color:#0831d9 #001ea0 #001ea0 #0831d9;width:min(340px,100vw - 24px);position:fixed;top:42%;left:50%;transform:translate(-50%,-50%);box-shadow:inset 1px 1px #166aee,inset -1px -1px #00138c,4px 4px #001ea059}.np-about-body{padding:12px 14px}.np-about-body p{margin:0 0 9px;line-height:1.45}.np-about-btns{justify-content:flex-end;display:flex}.np-btn{min-width:72px;font:12px var(--font-ui);cursor:pointer;color:oklch(18% 0 0);background:linear-gradient(oklch(99% 0 0),oklch(92% .005 263));border:1px solid oklch(50% .04 263);border-radius:3px;padding:3px 12px;box-shadow:inset 1px 1px oklch(100% 0 0),inset -1px -1px oklch(84% .02 90)}.np-btn:active{box-shadow:inset 1px 1px oklch(84% .02 90),inset -1px -1px oklch(100% 0 0)}@media print{body.np-page{background:0 0;padding:0}#axp-taskbar,.np-titlebar,.np-menubar,.np-status{display:none}.np-window{box-shadow:none;border:0;max-width:none;height:auto}.np-text{color:#000;font-size:11pt}}html{height:100dvh;overflow:hidden}body{box-sizing:border-box;height:calc(100dvh - 30px)!important;min-height:0!important;overflow:hidden auto!important}body:has(.window),body:has(.np-window),body:has(.wrap){flex-direction:column!important;align-items:center!important;padding:8px!important;display:flex!important;overflow:hidden!important}.window,.np-window,.wrap{z-index:2;box-sizing:border-box;width:100%;min-height:0;position:relative;flex:0 auto!important;max-height:100%!important;margin:0 auto!important}.window,.np-window{flex-direction:column;display:flex}.window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:none}.window>.content,.window>.body{outline-offset:-6px;background-clip:padding-box;border:6px solid #ece9d8;outline:1px solid #7f9db9;flex:auto;min-height:0;overflow:auto;padding-right:12px!important}.np-window .np-text{flex:auto;min-height:0}.wrap{flex-direction:column;display:flex;padding-bottom:0!important}.wrap>.window{flex:0 auto;max-height:100%}body.np-page:after{content:"";z-index:1;background:linear-gradient(oklch(67% .15 256) 0%,oklch(58% .19 257) 4%,oklch(51% .2 258) 9%,oklch(49% .2 258) 50%,oklch(46% .2 259) 92%,oklch(40% .18 260) 100%);height:30px;position:fixed;bottom:0;left:0;right:0}`;

export function writingShell(o) {
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"theme-color\" content=\"#2D78BD\">" +
    "<title>" + escHtml(o.title) + "</title>" +
    "<meta name=\"description\" content=\"" + escAttr(o.desc) + "\">" +
    "<link rel=\"canonical\" href=\"https://aadhar.sh" + escAttr(o.path) + "\">" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20x='7'%20y='3'%20width='18'%20height='26'%20rx='1'%20fill='%23ffffff'%20stroke='%230855dd'%20stroke-width='2'/%3E%3Crect%20x='10'%20y='9'%20width='12'%20height='1.6'%20fill='%23166aee'/%3E%3Crect%20x='10'%20y='14'%20width='12'%20height='1.6'%20fill='%23166aee'/%3E%3Crect%20x='10'%20y='19'%20width='8'%20height='1.6'%20fill='%23166aee'/%3E%3C/svg%3E\">" +
    "<style>:root{--font-caption:\"Trebuchet MS\",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:\"Courier New\",Courier,monospace}</style>" +
    "<style>" + NOTEPAD_CSS + "</style><link rel=\"stylesheet\" href=\"/a/luna.12fe1428.css\"></head><body class=\"np-page\">" + DESKTOP_TOP +
    o.body +
    DESKTOP_CHROME + "<script src=\"/a/notepad.be75481d.js\" defer></script><script src=\"/a/nav.f1317f11.js\" defer></script></body></html>";
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
      "<span class=\"np-menu\" role=\"menuitem\">File</span><span class=\"np-menu\" role=\"menuitem\">Edit</span><span class=\"np-menu\" role=\"menuitem\">Format</span><span class=\"np-menu\" role=\"menuitem\">View</span><span class=\"np-menu\" role=\"menuitem\">Help</span></div>" +
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
  return cachedRender(request, ctx, () => renderWritingPost(slug, env), undefined, env);
}

export async function renderWritingPost(slug, env) {
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
    // the webmention Link tells other sites where to say "I linked to you"; the
    // garage/lwe statics carry the same header from _headers. A note qualifies
    // because /writing is flagged webmention in site-manifest.json, which
    // vouches for the posts in posts.json.
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "link": '</webmention>; rel="webmention"' } });
}

export function handleWritingIndex(request, env, ctx) {
  // keyed on the bare path so /writing and /writing/ share one edge entry
  return cachedRender(request, ctx, () => renderWritingIndex(env), "/writing", env);
}

export async function renderWritingIndex(env) {
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
    // same webmention Link the individual notes carry. /writing is the surface
    // actually flagged in site-manifest.json (the notes inherit it, by vouching),
    // so the folder itself accepting a mention it never advertised was the one
    // page on the site a spec-compliant sender could not discover.
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120", "link": '</webmention>; rel="webmention"' } });
}
