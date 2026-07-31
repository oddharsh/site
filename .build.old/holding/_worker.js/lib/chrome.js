// lib/chrome.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { DESKTOP_CHROME, DESKTOP_TOP } from "./desktop.js";
import { escAttr, escHtml } from "./http.js";
import { SHELL_PRELOAD_LINK } from "./shell-assets.js";

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
  return `:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}*{box-sizing:border-box}html,body{background:linear-gradient(oklch(56% .13 250) 0%,oklch(73% .1 236) 50%,oklch(88% .05 232) 60%,oklch(60% .16 140) 100%)}body{font-family:var(--font-ui);color:oklch(21.78% 0 0);text-wrap:pretty;min-height:100vh;margin:0;padding:24px 12px 60px;font-size:10.5pt;line-height:1.5}.window{max-width:var(--axp-maxw,720px)}html{scrollbar-color:oklch(62% .14 255) oklch(91% .02 248);height:100dvh;overflow:hidden}body{box-sizing:border-box;height:calc(100dvh - 30px)!important;min-height:0!important;overflow:hidden auto!important}body:has(.window),body:has(.np-window),body:has(.wrap){flex-direction:column!important;align-items:center!important;padding:8px!important;display:flex!important;overflow:hidden!important}.window,.np-window,.wrap{z-index:2;box-sizing:border-box;width:100%;min-height:0;position:relative;flex:0 auto!important;max-height:100%!important;margin:0 auto!important}.window,.np-window{flex-direction:column;display:flex}.window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:none}.window>.content,.window>.body{outline-offset:-6px;background-clip:padding-box;border:6px solid #ece9d8;outline:1px solid #7f9db9;flex:auto;min-height:0;overflow:auto;padding-right:12px!important}.np-window .np-text{flex:auto;min-height:0}.wrap{flex-direction:column;display:flex;padding-bottom:0!important}.wrap>.window{flex:0 auto;max-height:100%}body:after{content:"";z-index:1;background:linear-gradient(oklch(67% .15 256) 0%,oklch(58% .19 257) 4%,oklch(51% .2 258) 9%,oklch(49% .2 258) 50%,oklch(46% .2 259) 92%,oklch(40% .18 260) 100%);height:30px;position:fixed;bottom:0;left:0;right:0}`;
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
  const scriptHtml = `${scripts || ""}\n<script src="/a/nav.f1317f11.js" defer></script>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="/a/luna.12fe1428.css">
<title>${escHtml(documentTitle)}</title>${metaDescription}${metaRobots}
<link rel="icon" href="/favicon.ico">
${head || ""}<style>
:root{--axp-maxw:${width}px}
${xpChromeCss()}
${css || ""}
</style>
<link rel="stylesheet" href="/a/luna.12fe1428.css">
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
      // preload the shell assets ahead of the body (Cloudflare Early Hints
      // replays these as a 103). a caller's own `link` in headers still wins.
      "link": SHELL_PRELOAD_LINK,
      ...headers,
    },
  });
}
