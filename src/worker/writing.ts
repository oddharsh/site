import { cachedRender } from "./lib/cache.ts";
import { DESKTOP_CHROME, DESKTOP_HISTNAV, DESKTOP_TOP } from "./lib/desktop.ts";
import { addressBar, taskPane } from "./lib/explorer.ts";
import { shareMeta } from "./lib/chrome.ts";
import { escAttr, escHtml } from "./lib/http.ts";
import { twinFor } from "./lib/twins.ts";

export const NOTEPAD_CSS = `/*min*/
body.np-page{margin:0;color:var(--ink);font-family:var(--font-ui);font-size:12px}
.np-window{max-width:860px;margin:0 auto;max-height:calc(100dvh - 78px);display:flex;flex-direction:column;background:oklch(100% 0 0);
border:2px solid var(--luna-44);border-right-color:var(--luna-34);border-bottom-color:var(--luna-34);border-top-left-radius:8px;border-top-right-radius:8px;overflow:hidden;
box-shadow:inset 1px 1px 0 var(--luna-56),inset 2px 2px 0 #0855dd,inset -1px -1px 0 var(--luna-31),inset -2px -2px 0 #003bda,4px 4px 0 oklch(from var(--luna-34) l c h / .35)}
.np-titlebar{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:4px 6px 4px 7px;color:oklch(100% 0 0);
font-family:var(--font-caption);font-weight:bold;font-size:var(--text-ui);text-shadow:1px 1px var(--luna-30);border-bottom:1px solid var(--blue-40);
background:var(--grad-title)}
.np-ico{flex:0 0 auto;width:14px;height:15px;background:oklch(100% 0 0);border:1px solid var(--ink-quiet);border-radius:1px;position:relative}
.np-ico::before{content:"";position:absolute;left:2px;right:3px;top:3px;height:1px;background:oklch(55% 0.16 258);box-shadow:0 3px 0 oklch(55% 0.16 258),0 6px 0 oklch(55% 0.16 258),0 9px 0 oklch(55% 0.16 258)}
.np-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;font:inherit}
.np-controls{display:flex;gap:2px}
/* the canonical Luna gel caption buttons live in luna.css now (phase D):
   its :where(.np-controls ...) twins carry this window's controls too. */
.np-menubar{flex:0 0 auto;display:flex;align-items:stretch;gap:0;padding:1px 2px;font-size:11px;position:relative;
background:oklch(93% 0.012 90);border-bottom:1px solid oklch(78% 0.02 90)}
.np-menu{border:0;background:none;font:11px var(--font-ui);color:var(--ink);padding:3px 8px;cursor:pointer;border-radius:2px}
.np-menu:hover,.np-menu:focus-visible,.np-menu[aria-expanded=true]{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-drop{position:absolute;top:100%;min-width:170px;z-index:50;background:var(--paper-cool);padding:2px;
border:1px solid var(--ink-quiet);box-shadow:2px 2px 0 oklch(0% 0 0 / .25)}
.np-item{display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:8px;width:100%;border:0;background:none;cursor:pointer;
font:11px var(--font-ui);color:var(--ink);padding:4px 8px 4px 2px;text-align:left}
.np-item:hover,.np-item:focus-visible{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-chk{text-align:center;font-size:10px}.np-acc{color:var(--ink-dim)}.np-item:hover .np-acc,.np-item:focus-visible .np-acc{color:var(--slate-90)}
.np-sep{height:0;border-top:1px solid oklch(80% 0.01 90);margin:2px 1px}
.np-text{flex:0 1 auto;field-sizing:content;min-height:8em;max-height:calc(100dvh - 150px);width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:9px 11px;background:oklch(100% 0 0);
color:oklch(16% 0 0);font-family:var(--font-mono);font-size:13px;line-height:1.55;white-space:pre-wrap;overflow:auto;tab-size:4}
.np-text.nowrap{white-space:pre;overflow:auto}
.np-edited{color:var(--ink-quiet)}
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
.np-folder{height:auto;min-height:0;--axp-maxw:560px;max-width:var(--axp-maxw)}
.np-folder-body{padding:14px 16px 6px}
.np-folder-intro{margin:0 0 12px;color:var(--ink-soft);text-wrap:pretty}
.np-files{list-style:none;margin:0;padding:0;border:1px solid var(--slate-80)}
.np-files li+li{border-top:1px solid var(--mist-92)}
.np-files a{display:flex;align-items:center;gap:10px;padding:7px 10px;text-decoration:none;color:var(--ink)}
.np-files a:hover{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-files a:nth-child(odd){background:var(--row-alt)}
.np-files a:hover{background:oklch(50% 0.22 263)}
.np-file-ico{flex:0 0 auto;width:18px;height:20px;background:oklch(100% 0 0);border:1px solid var(--ink-dim);border-radius:1px;position:relative}
.np-file-ico::before{content:"";position:absolute;left:3px;right:4px;top:4px;height:1px;background:oklch(58% 0.16 258);box-shadow:0 3px 0 oklch(58% 0.16 258),0 6px 0 oklch(58% 0.16 258),0 9px 0 oklch(58% 0.16 258)}
.np-file-name{font-weight:bold;color:inherit}.np-files a:hover .np-file-name{color:oklch(100% 0 0)}
.np-file-meta{margin-left:auto;color:var(--ink-dim);font-size:11px}.np-files a:hover .np-file-meta{color:var(--slate-90)}
/* About dialog */
.np-about::backdrop{background:transparent}
.np-about{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);margin:0;padding:0;color:inherit;width:min(340px,calc(100vw - 24px));background:oklch(100% 0 0);
border:2px solid var(--luna-44);border-right-color:var(--luna-34);border-bottom-color:var(--luna-34);box-shadow:inset 1px 1px 0 var(--luna-56),inset -1px -1px 0 var(--luna-31),4px 4px 0 oklch(from var(--luna-34) l c h / .35)}
.np-about-body{padding:12px 14px}.np-about-body p{margin:0 0 9px;line-height:1.45}
.np-about-btns{display:flex;justify-content:flex-end}
@media print{body.np-page{padding:0;background:none}#axp-taskbar,.np-titlebar,.np-menubar,.np-status{display:none}
.np-window{border:0;box-shadow:none;height:auto;max-width:none}.np-text{font-size:var(--text-lede);color:#000}}
`;

export function writingShell(o) {
  const twin = twinFor(o.path);
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"theme-color\" content=\"#2D78BD\">" +
    "<title>" + escHtml(o.title) + "</title>" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/section-icons/writing.svg\">" +
    "<meta name=\"description\" content=\"" + escAttr(o.desc) + "\">" +
    "<link rel=\"canonical\" href=\"https://aadhar.sh" + escAttr(o.path) + "\">" +
    String(shareMeta({ title: o.title, description: o.desc, path: o.path, type: o.path === "/writing" ? "website" : "article" })) +
    (twin ? "<link rel=\"alternate\" type=\"text/markdown\" title=\"markdown source\" href=\"" + escAttr(twin) + "\">" : "") +
    "<link rel=\"alternate\" type=\"application/rss+xml\" title=\"aadhar.sh — writing\" href=\"/writing/feed.xml\">" +
    "<style>" + NOTEPAD_CSS + "</style><link rel=\"stylesheet\" href=\"/luna.css\"></head><body class=\"np-page\">" + DESKTOP_TOP +
    o.body +
    DESKTOP_CHROME + "<script src=\"/notepad.js\" defer></script><script src=\"/nav.js\" defer></script></body></html>";
}

export const OWNER_NAME = "Aadharsh Pannirselvam";
export const OWNER_URL = "https://aadhar.sh/";
const AUTHOR_CARD = "<span class=\"p-author h-card\"><data class=\"p-name\" value=\"" + OWNER_NAME + "\"></data>" +
  "<data class=\"u-url\" value=\"" + OWNER_URL + "\"></data></span>";

const permalink = (slug) => "https://aadhar.sh/writing/" + slug;

const MAX_BUTTON = "<button type=\"button\" class=\"max\" title=\"maximize\" aria-label=\"maximize\"></button>";

export function notepadWindow(filename, text, closeHref, date?, popId?, entry?: { name: string; url: string }) {
  var open = popId
    ? "<div class=\"np-window np-note\" id=\"" + escAttr(popId) + "\" popover=\"manual\">"
    : "<div class=\"np-window" + (entry ? " h-entry" : "") + "\">";
  const title = entry
    ? "<span class=\"p-name\">" + escHtml(entry.name) + "</span>" +
      escHtml(filename.startsWith(entry.name) ? filename.slice(entry.name.length) : "") +
      "<data class=\"u-url\" value=\"" + escAttr(entry.url) + "\"></data>" + AUTHOR_CARD
    : escHtml(filename);
  const stamp = entry && date
    ? "<time class=\"dt-published\" datetime=\"" + escAttr(date) + "\">" + escHtml(date) + "</time>"
    : escHtml(date);
  return open +
    "<div class=\"np-titlebar\">" + (popId ? "" : DESKTOP_HISTNAV) + "<span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      (popId ? "<span class=\"np-title\">" + title + " — Notepad</span>" : "<h1 class=\"np-title\">" + title + " — Notepad</h1>") +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span>" + (popId ? "<span class=\"max\" aria-hidden=\"true\"></span>" : MAX_BUTTON) +
      "<a class=\"close\" href=\"" + escAttr(closeHref) + "\"" + (popId ? " data-pop" : "") + " title=\"back to writing\" aria-label=\"Close\">✕</a></span></div>" +
    "<div class=\"np-menubar\" role=\"menubar\" aria-label=\"menu\">" +
      "<span class=\"np-menu\" role=\"menuitem\">File</span><span class=\"np-menu\" role=\"menuitem\">Edit</span><span class=\"np-menu\" role=\"menuitem\">Format</span><span class=\"np-menu\" role=\"menuitem\">View</span><span class=\"np-menu\" role=\"menuitem\">Help</span></div>" +
    "<textarea class=\"np-text" + (entry ? " e-content" : "") + "\" spellcheck=\"false\" aria-label=\"" + escAttr(filename) + "\">" + escHtml(text) + "</textarea>" +
    "<div class=\"xp-statusbar panes np-status\"><span class=\"np-pos\">Ln 1, Col 1</span><span class=\"np-wc fill\"></span>" +
      (date ? "<span class=\"np-edited\">last changed " + stamp + "</span>" : "") + "</div></div>";
}

export async function readPosts(env) {
  try {
    const r = await env.ASSETS.fetch("https://a/writing/posts.json");
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j; }
  } catch {}
  return [];
}

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
  const body = notepadWindow(title + ".txt", text, "/writing", post.date, undefined, { name: title, url: permalink(safe) });
  return new Response(writingShell({ title: "aadhar.sh/writing/" + title + ".txt", path: "/writing/" + safe, desc: desc, body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "link": '</webmention>; rel="webmention"' } });
}

export function handleWritingIndex(request, env, ctx) {
  return cachedRender(request, ctx, () => renderWritingIndex(env), "/writing", env);
}

export async function renderWritingIndex(env) {
  const posts = await readPosts(env);
  const fmtNum = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
  const entries = await Promise.all(posts.map(async function (p) {
    const safe = String(p.slug).replace(/[^a-z0-9-]/gi, "");
    let text = "";
    try { const r = await env.ASSETS.fetch("https://a/writing/" + safe + ".txt"); if (r.ok) text = await r.text(); } catch {}
    return { p: p, safe: safe, text: text, chars: text.length };
  }));
  const files = entries.map(function (e) {
    const size = fmtNum(e.chars) + (e.chars === 1 ? " character" : " characters");
    return "<li class=\"h-entry\"><a class=\"u-url\" href=\"/writing/" + escAttr(e.p.slug) + "\" data-note=\"" + escAttr(e.safe) + "\"><span class=\"np-file-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-file-name\"><span class=\"p-name\">" + escHtml(e.p.title || e.p.slug) + "</span>.txt</span>" +
      "<span class=\"np-file-meta\">Text Document · " + size +
        (e.p.date ? " · <time class=\"dt-published\" datetime=\"" + escAttr(e.p.date) + "\">" + escHtml(e.p.date) + "</time>" : "") + "</span></a></li>";
  }).join("");
  const notes = entries.map(function (e) {
    return notepadWindow((e.p.title || e.safe) + ".txt", e.text, "/writing", e.p.date, "note-" + e.safe);
  }).join("");
  const body = "<div class=\"np-window np-folder h-feed\">" +
    "<div class=\"np-titlebar\">" + DESKTOP_HISTNAV + "<span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      "<h1 class=\"np-title\"><span class=\"p-name\">aadhar.sh/writing</span>" +
        "<data class=\"u-url\" value=\"https://aadhar.sh/writing\"></data>" + AUTHOR_CARD + "</h1>" +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span>" + MAX_BUTTON +
      "<a class=\"close\" href=\"/\" title=\"back home\" aria-label=\"Close\">✕</a></span></div>" +
    String(addressBar({ path: "/writing", name: "My Writing" })) +
    String(taskPane({
        path: "/writing",
        name: "My Writing",
        // glyph is optional (taskPane defaults it to "≡"), so the literal is
        // annotated rather than inferred — concat() types against the first
        // array, which would otherwise make the glyph mandatory.
        tasks: ([{ href: "/writing/posts.json", label: "Open the post registry", glyph: "{" }] as { href: string; label: string; glyph?: string }[])
          .concat(twinFor("/writing") ? [{ href: twinFor("/writing"), label: "Read this as Markdown" }] : []),
      details: [{ term: "Contains", value: posts.length + (posts.length === 1 ? " document" : " documents") }],
    })) +
    "<div class=\"np-folder-body\"><p class=\"np-folder-intro\">Notes, in flux. Open one: it's a real text field you can edit, though it reverts to my canonical version on reload.</p>" +
      "<ul class=\"np-files\">" + (files || "<li><a><span class=\"np-file-name\">(nothing written yet)</span></a></li>") + "</ul></div>" +
    "<div class=\"xp-statusbar panes np-status\"><span class=\"fill\">" + posts.length + (posts.length === 1 ? " document" : " documents") + "</span>" +
      "<span>" + fmtNum(entries.reduce(function (a, e) { return a + e.chars; }, 0)) + " characters</span></div></div>" +
    notes;
  return new Response(writingShell({ title: "aadhar.sh/writing", path: "/writing", desc: "Notes in flux: an editable Notepad of writing that reverts to canonical on reload.", body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120", "link": '</webmention>; rel="webmention"' } });
}
