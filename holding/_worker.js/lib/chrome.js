// lib/chrome.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { DESKTOP_CHROME, DESKTOP_TOP } from "./desktop.js";
import { escAttr, escHtml } from "./http.js";

// shared XP window chrome for the server-rendered pages (/around, /bot,
// /whoareyou, /rn/set). these four used to each carry their own copy of
// the body gradient + window panel + title-bar + traffic-cone icon +
// boxed controls + content padding — identical declarations save for the
// window max-width. a chrome tweak meant editing four places (which is
// how the /whoareyou and /bot h2 rules drifted apart earlier). this is
// the one shared source; page-specific rules (h1 sizes, tables, field
// grids, the whoareyou title-text + control spacing) stay inline per
// page after the call. The /*min*/ sentinel lets build.mjs minify this static
// literal on the wire; the readable source remains in git.
export function xpChromeCss() {
  return `/*min*/
  :root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}
  * { box-sizing: border-box; }
/* cross-document View Transitions: a fast, reduced-motion-safe crossfade on real
   navigations between same-origin pages. inline (not JS-injected) so the incoming
   page has opted in by parse time. the persistent shell (wallpaper/taskbar) is
   identical across pages, so visually only the changing window content fades. */
@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}::view-transition-old(root),::view-transition-new(root){animation-duration:140ms}}
  /* first-paint background is the Bliss desktop tone on the ROOT (html) too —
     the cross-document View-Transition freezes the root group, so if html were
     white you'd get a frame of white flash before nav.js paints the real desktop.
     matching html+body to the Bliss gradient kills that flash. */
  html, body {
    background: linear-gradient(180deg, oklch(56% 0.13 250) 0%, oklch(73% 0.10 236) 50%, oklch(88% 0.05 232) 60%, oklch(60% 0.16 140) 100%);
  }
  body {
    font-family: var(--font-ui);
    font-size: 10.5pt; line-height: 1.5; color: oklch(21.78% 0 0);
    text-wrap: pretty;  /* modern line-breaking; progressive, ignored where unsupported */
    margin: 0; padding: 24px 12px 60px; min-height: 100vh;
  }
  .window { max-width: var(--axp-maxw, 720px); }
  /* the canonical window chrome (title bar, gel buttons, frame, xp-button/
     input) lives in luna.css now, zero-specificity via :where() — phase D.
     Only the page-parametric width survives inline. */
  html { scrollbar-color: oklch(62% 0.14 255) oklch(91% 0.02 248); }
  /* OS-window geometry inlined as the FIRST-PAINT critical subset (no shell
     "pop" before the linked luna.css lands). luna.css carries the canonical
     full set; this is the overlap that has to paint pre-stylesheet. !important
     beats each page's own body rule; degrades with JS off (.content scrolls
     natively, the ::after strip stands in for the taskbar). The build's
     geometry tripwire checks the taskbar-floor value here matches luna.css. */
  html{height:100dvh;overflow:hidden}
  body{min-height:0 !important;height:calc(100vh - 30px) !important;height:calc(100dvh - 30px) !important;overflow-x:hidden !important;overflow-y:auto !important;box-sizing:border-box}
  body:has(.window),body:has(.np-window),body:has(.wrap){overflow:hidden !important;display:flex !important;flex-direction:column !important;align-items:center !important;padding:8px !important}
  .window,.np-window,.wrap{position:relative;z-index:2;flex:0 1 auto !important;min-height:0;max-height:100% !important;width:100%;margin:0 auto !important;box-sizing:border-box}
  .window,.np-window{display:flex;flex-direction:column}
  .window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:0 0 auto}
  .window>.content,.window>.body{flex:1 1 auto;min-height:0;overflow:auto;padding-right:12px!important}
  .np-window .np-text{flex:1 1 auto;min-height:0}
  .wrap{display:flex;flex-direction:column;padding-bottom:0 !important}.wrap>.window{flex:0 1 auto;max-height:100%}
  body::after{content:"";position:fixed;left:0;right:0;bottom:0;height:30px;z-index:1;background:linear-gradient(180deg,oklch(67% 0.15 256) 0%,oklch(58% 0.19 257) 4%,oklch(51% 0.20 258) 9%,oklch(49% 0.20 258) 50%,oklch(46% 0.20 259) 92%,oklch(40% 0.18 260) 100%)}
	`;
}

// lunaPage: the one place a worker-rendered page becomes a Luna window. Nine
// handlers hand it {title, body, css, cache} and it owns everything they used to
// hand-assemble: doctype, chrome CSS (xpChromeCss, once), title bar with the
// path as its caption, caption controls, security posture, nav.js include.
// When the window chrome changes, this function changes and nine pages follow.
export function lunaPage({
  title,
  path,
  width = 720,
  description = "",
  robots = "",
  css = "",
  head = "",
  body = "",
  status = 200,
  cache = "public, max-age=300, s-maxage=300",
  headers = {},
  titleClass = "",
  closeHref = "/",
  closeTitle = "back to aadhar.sh",
  closeLabel = closeTitle,
  scripts = "",
}) {
  const documentTitle = title || path || "aadhar.sh";
  const windowTitle = path || title || "aadhar.sh";
  const classAttr = ` class="title-text${titleClass ? " " + escAttr(titleClass) : ""}"`;
  const metaDescription = description
    ? `\n<meta name="description" content="${escAttr(description)}">`
    : "";
  const metaRobots = robots
    ? `\n<meta name="robots" content="${escAttr(robots)}">`
    : "";
  const scriptHtml = `${scripts || ""}\n<script src="/nav.js" defer></script>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="/luna.css">
<title>${escHtml(documentTitle)}</title>${metaDescription}${metaRobots}
<link rel="icon" href="/favicon.ico">
${head || ""}<style>
:root{--axp-maxw:${width}px}
${xpChromeCss()}
${css || ""}
</style>
<link rel="stylesheet" href="/luna.css">
</head>
<body>
${DESKTOP_TOP}
<div class="window">
  <div class="title-bar">
    <span${classAttr}><span class="icon"></span>${escHtml(windowTitle)}</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="${escAttr(closeHref)}" title="${escAttr(closeTitle)}" aria-label="${escAttr(closeLabel)}"></a></span>
  </div>
  <div class="content">
${body}
  </div>
</div>
${DESKTOP_CHROME}
${scriptHtml}
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cache,
      ...headers,
    },
  });
}
