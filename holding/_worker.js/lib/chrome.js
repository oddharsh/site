// lib/chrome.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { escAttr, escHtml } from "./http.js";

// shared XP window chrome for the server-rendered pages (/around, /bot,
// /whoareyou, /rn/set). these four used to each carry their own copy of
// the body gradient + window panel + title-bar + traffic-cone icon +
// boxed controls + content padding — identical declarations save for the
// window max-width. a chrome tweak meant editing four places (which is
// how the /whoareyou and /bot h2 rules drifted apart earlier). this is
// the one shared source; page-specific rules (h1 sizes, tables, field
// grids, the whoareyou title-text + control spacing) stay inline per
// page after the call. only max-width is parameterized.
export function xpChromeCss(maxWidth) {
  return `
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
  .window {
    max-width: ${maxWidth}px; margin: 0 auto; background: oklch(100.00% 0 0);
    border: 1px solid oklch(61.14% 0.0611 253.60); box-shadow: 4px 4px 0 oklch(61.14% 0.0611 253.60 / 0.35);
  }
  .title-bar {
    background: linear-gradient(180deg, oklch(70% 0.15 258) 0%, oklch(60% 0.20 261) 8%, oklch(51% 0.225 263) 18%, oklch(50% 0.225 263) 86%, oklch(58% 0.18 260) 100%);
    color: oklch(100.00% 0 0); font-family: var(--font-caption);
    font-size: 10pt; font-weight: bold; padding: 4px 8px;
    border-bottom: 1px solid oklch(41.92% 0.0962 250.51); display: flex;
    align-items: center; justify-content: space-between;
    text-box-trim: trim-both; text-box-edge: cap alphabetic;
  }
  /* flex:1 keeps the title left-aligned: nav.js injects its back/forward cluster as a
     third title-bar child, and space-between would center an un-flexed title span. */
  .title-bar .title-text { display: flex; align-items: center; flex: 1; min-width: 0; }
  .title-bar .icon { display: inline-block; width: 16px; height: 16px; margin-right: 6px; background: oklch(69.58% 0.2043 43.49); position: relative; flex-shrink: 0; }
  .title-bar .icon::before { content: ""; position: absolute; inset: 2px 4px; background: oklch(87.82% 0.0877 66.27); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .title-bar .controls { display: flex; align-items: center; gap: 2px; letter-spacing: 0; }
/* authentic Luna caption buttons: 21x21 glossy "gel" lozenges with a top specular
   highlight + CSS-drawn white glyphs (no text, no images). min/max are blue, CLOSE
   is RED at rest. CLASS-BASED (.min/.max/.close) so decorative demo windows that use
   <span class="close"> get the identical skin as a real <a class="close">. sRGB hex
   traced from the Luna .msstyles bitmap, kept as hex on purpose. */
.title-bar .controls .min,
.title-bar .controls .max,
.title-bar .controls .close {
  position: relative; box-sizing: border-box;
  width: 21px; height: 21px; padding: 0; margin: 0;
  display: inline-block; overflow: hidden; font-size: 0; color: transparent;
  border: 1px solid #6696eb; border-radius: 3px;
  text-decoration: none; cursor: pointer;
  background-color: #3e73f5;
  background-image: linear-gradient(180deg, #5f8cf7 0%, #3a71f5 22%, #3e73f5 55%, #2a70f2 82%, #1045be 100%);
  transition: filter 60ms ease-out;
}
/* "wet plastic" gloss band over the top ~45% (close uses ::after for its X stroke) */
.title-bar .controls .min::after,
.title-bar .controls .max::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 45%;
  background: linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.12) 70%, rgba(255,255,255,0) 100%);
  pointer-events: none; border-radius: 2px 2px 5px 5px;
}
.title-bar .controls .min:hover, .title-bar .controls .min:focus-visible,
.title-bar .controls .max:hover, .title-bar .controls .max:focus-visible {
  border-color: #8fb4ff; background-color: #4fa4ff;
  background-image: linear-gradient(180deg, #689bff 0%, #468aff 22%, #4fa4ff 55%, #3990fc 82%, #1858c8 100%);
  outline: none;
}
/* CLOSE = red at rest */
.title-bar .controls .close {
  border-color: #d8401c; background-color: #e45f3e;
  background-image: linear-gradient(180deg, #e8795f 0%, #e45f40 30%, #e45d3d 52%, #e2552a 80%, #ae3110 100%);
}
.title-bar .controls .close:hover, .title-bar .controls .close:focus-visible {
  border-color: #ff7a66; background-color: #ff957c;
  background-image: linear-gradient(180deg, #ff8b7d 0%, #ff7463 26%, #ff957c 55%, #fd7e64 82%, #d34936 100%);
  box-shadow: 0 0 4px rgba(255,120,96,.7); outline: none;
}
.title-bar .controls .min:active,
.title-bar .controls .max:active,
.title-bar .controls .close:active { filter: brightness(.9); }
/* white glyphs drawn with pseudo-elements */
.title-bar .controls .min::before {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: 5px; height: 2px;
  background: #fff; box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.title-bar .controls .max::before {
  content: ""; position: absolute; left: 5px; top: 5px; width: 11px; height: 9px;
  box-sizing: border-box; border: 1px solid #fff; border-top-width: 2px;
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.35));
}
.title-bar .controls .close::before,
.title-bar .controls .close::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 13px; height: 2px; margin: -1px 0 0 -6.5px; background: #fff;
  box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.title-bar .controls .close::before { transform: rotate(45deg); }
.title-bar .controls .close::after  { transform: rotate(-45deg); }
/* --- Luna polish: caption text shadow + rounded top corners + 3px window frame --- */
.title-bar { text-shadow: 1px 1px #0f1089; border-top-left-radius: 8px; border-top-right-radius: 8px; }
.window {
  border: 2px solid #0831d9; border-right-color: #001ea0; border-bottom-color: #001ea0;
  border-top-left-radius: 8px; border-top-right-radius: 8px; overflow: hidden;
  box-shadow: inset 1px 1px 0 #166aee, inset 2px 2px 0 #0855dd,
              inset -1px -1px 0 #00138c, inset -2px -2px 0 #003bda,
              4px 4px 0 rgba(0,30,160,.35);
}
/* reusable Luna command button + sunken field (used by the /rn form) */
.xp-button {
  display: inline-block; min-width: 75px; padding: 3px 12px;
  font: 8pt/1.4 var(--font-ui); color: #000;
  text-align: center; text-decoration: none; cursor: pointer; user-select: none;
  border: 1px solid #8e9dad; border-radius: 3px;
  background: linear-gradient(180deg, #ffffff 0%, #fdfdfd 45%, #f3f2ec 55%, #e9e7dc 100%);
  box-shadow: inset 0 0 0 1px #ffffff, 0 0 0 1px rgba(255,255,255,.4);
}
.xp-button:hover { border-color: #e9994a; box-shadow: inset 0 0 0 1px #fdd78b, 0 0 3px 1px rgba(255,199,60,.55); }
.xp-button.default, .xp-button:focus-visible {
  border-color: #003c74; outline: none;
  box-shadow: inset 0 0 0 1px #ffffff, 0 0 0 1px #2c628b, 0 0 3px 1px rgba(44,98,139,.45);
}
.xp-button:active {
  background: linear-gradient(180deg, #e1e1d8 0%, #e9e8e0 50%, #f0efe8 100%);
  border-color: #7b9ebd; padding: 4px 11px 2px 13px;
  box-shadow: inset 1px 1px 2px rgba(181,178,164,.9), inset -1px -1px 0 rgba(255,255,255,.5);
}
.xp-input {
  box-sizing: border-box; width: 100%;
  font-family: var(--font-ui); font-size: 10.5pt;
  color: #181818; background: #ffffff; padding: 3px 6px; border-radius: 0;
  border: 1px solid #7f9db9; box-shadow: inset 1px 1px 0 rgba(0,0,0,.20), inset -1px -1px 0 #ffffff;
}
.xp-input:focus { outline: none; border-color: #316ac5; box-shadow: inset 1px 1px 0 rgba(0,0,0,.20), inset -1px -1px 0 #ffffff, 0 0 0 1px #316ac5; }
  html { scrollbar-color: oklch(62% 0.14 255) oklch(91% 0.02 248); }
  .content { padding: 12px 16px 16px; }
  /* OS-window geometry inlined so FIRST PAINT matches nav.js (no shell "pop"
     when the deferred desktop arrives). byte-identical to nav.js's app-shell
     rules; !important beats each page's own body rule; degrades with JS off
     (.content scrolls natively, the ::after strip stands in for the taskbar). */
  html{height:100dvh;overflow:hidden}
  body{min-height:0 !important;height:calc(100vh - 30px) !important;height:calc(100dvh - 30px) !important;overflow-x:hidden !important;overflow-y:auto !important;box-sizing:border-box}
  body:has(.window),body:has(.np-window),body:has(.wrap){overflow:hidden !important;display:flex !important;flex-direction:column !important;align-items:center !important;padding:8px !important}
  .window,.np-window,.wrap{position:relative;z-index:2;flex:0 1 auto !important;min-height:0;max-height:100% !important;width:100%;margin:0 auto !important;box-sizing:border-box}
  .window,.np-window{display:flex;flex-direction:column}
  .window>.title-bar,.window>.titlebar,.np-window>.np-titlebar{flex:0 0 auto}
  .window>.content,.window>.body{flex:1 1 auto;min-height:0;overflow:auto;padding-right:28px!important}
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
<title>${escHtml(documentTitle)}</title>${metaDescription}${metaRobots}
<link rel="icon" href="/favicon.ico">
${head || ""}<style>
${xpChromeCss(width)}
${css || ""}
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span${classAttr}><span class="icon"></span>${escHtml(windowTitle)}</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="${escAttr(closeHref)}" title="${escAttr(closeTitle)}" aria-label="${escAttr(closeLabel)}"></a></span>
  </div>
  <div class="content">
${body}
  </div>
</div>
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
