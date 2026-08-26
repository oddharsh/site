// lib/chrome.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { DESKTOP_CHROME, DESKTOP_TOP, SECTION_FAVICONS } from "./desktop.ts";
import { addressBar, taskPane } from "./explorer.ts";
import { EMPTY, Html, html, unsafeHtml } from "./html.ts";
import { SHELL_PRELOAD_LINK } from "./shell-assets.ts";
import { twinFor } from "./twins.ts";

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
  /* first-paint background is the Bliss desktop tone on the ROOT (html) too, so
     a white <html> never flashes in the gap before nav.js paints the real
     desktop. This mattered under the cross-document View Transition (which
     froze the root group) and matters MORE without it: a plain navigation has
     no held snapshot standing in, so html's own background IS the first paint. */
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
// A first-level section's tab favicon IS its taskbar tile, and it belongs in the
// document rather than in nav.js. Setting it at boot meant every section page
// painted one icon and then swapped to another, and it cost one data-favicon
// attribute per pin on all 46 pages so that 11 of them could read one. Anything
// that is not a section keeps /favicon.ico.
function faviconLink(route): Html {
  const icon = SECTION_FAVICONS[route];
  return icon
    ? html`<link rel="icon" type="image/svg+xml" href="${icon}">`
    : html`<link rel="icon" href="/favicon.ico">`;
}

/** What `lunaPage` accepts.
 *
 *  The point of writing this out is the four `Html` fields. Everything else was
 *  already text this function escapes on the caller's behalf; `head`, `body`,
 *  `scripts` and `windowAttrs` are markup it splices in verbatim, and they were
 *  plain `string`, so nothing stopped a caller interpolating a stranger's text
 *  into one. Declaring them `Html` moves that from a convention to a call-site
 *  error.
 *
 *  `css` stays `string` DELIBERATELY, and the reason is a real trap: `<style>`
 *  is a raw-text element, so HTML entities are not decoded inside it. Escaping
 *  CSS would turn `a > b` into `a &gt; b` and break the selector rather than
 *  protect anything. Escaping is the wrong tool in that context, which is why
 *  it goes through `unsafeHtml` at the one place it is spliced. */
export type LunaPageOptions = {
  title?: string;
  path?: string;
  width?: number;
  description?: string;
  robots?: string;
  /** CSS, not HTML. See the note above. */
  css?: string;
  head?: Html;
  body?: Html;
  scripts?: Html;
  status?: number;
  cache?: string;
  headers?: Record<string, string>;
  titleClass?: string;
  windowClass?: string;
  contentClass?: string;
  /** Raw attributes for the window element, e.g. `data-no-histnav`. */
  windowAttrs?: Html;
  route?: string;
  explorer?: boolean;
  explorerName?: string;
  explorerTasks?: { href: string; label: string; glyph?: string }[];
  explorerDetails?: { term: string; value: string }[];
  closeHref?: string;
  closeTitle?: string;
  closeLabel?: string;
};

export function lunaPage({
  title,
  path,
  width = 720,
  description = "",
  robots = "",
  css = "",
  head = EMPTY,
  body = EMPTY,
  status = 200,
  cache = "public, max-age=300, s-maxage=300",
  headers = {},
  titleClass = "",
  // Extra classes on the window and its content pane, plus raw attributes on
  // the window. All three default to empty, so the nine existing callers are
  // byte-identical. They exist for /terminal, which needs the SAME window
  // structure (nav.js's drag, resize and maximize all key off `body > .window`
  // and its `.title-bar`) while looking like a console rather than a document:
  // no content padding, its own icon, and — via data-no-histnav below — no
  // back/forward buttons, because a PowerShell window has no browser in it.
  //
  // Deliberately parameters here rather than a second document assembler in
  // terminal.js. The whole argument for this function is that window chrome
  // changes in one place and every page follows; a private copy of the doctype,
  // head, and desktop wiring would opt one page out of that on day one.
  windowClass = "",
  contentClass = "",
  windowAttrs = EMPTY,
  // The REQUEST path, which `path` above is not: that one is the window caption
  // and callers pass free text through it ("Security Center", "The Crawl
  // Ledger"). The Explorer chrome and the Markdown twin both need the real
  // route, so they render only for a caller that supplies one. Defaulting to
  // "" rather than guessing at `path` keeps a caption from being published as a
  // URL — "Inbox — Outlook Express" would have become a breadcrumb.
  route = "",
  // The address bar and task pane (lib/explorer.js). /terminal opts out for the
  // same reason it drops the history buttons: a console is not a folder, and
  // neither device would be telling the truth about a per-query frame.
  // `explorerName` is the object's display name, and `explorerTasks` /
  // `explorerDetails` are facts the CALLER counted — nothing here invents one.
  explorer = true,
  explorerName = "",
  explorerTasks = [],
  explorerDetails = [],
  closeHref = "/",
  closeTitle = "back to aadhar.sh",
  closeLabel = closeTitle,
  scripts = EMPTY,
}: LunaPageOptions = {}) {
  const documentTitle = title || path || "aadhar.sh";
  const windowTitle = path || title || "aadhar.sh";
  const metaDescription = description
    ? html`\n<meta name="description" content="${description}">`
    : EMPTY;
  const metaRobots = robots
    ? html`\n<meta name="robots" content="${robots}">`
    : EMPTY;
  const scriptHtml = html`${scripts}\n<script src="/nav.js" defer></script>`;

  // The Markdown twin, advertised only where the build actually wrote one, and
  // offered as this object's first task for the same reason.
  const twin = route ? twinFor(route) : null;
  const twinLink = twin
    ? html`\n<link rel="alternate" type="text/markdown" title="markdown source" href="${twin}">`
    : EMPTY;
  const chromeOptions = {
    path: route || "/",
    name: explorerName || title || "",
    tasks: twin ? [{ href: twin, label: "Read this as Markdown" }, ...explorerTasks] : explorerTasks,
    details: explorerDetails,
  };
  const showChrome = explorer && Boolean(route);
  const addressHtml = showChrome ? html`\n  ${addressBar(chromeOptions)}` : EMPTY;
  const paneHtml = showChrome ? html`${taskPane(chromeOptions)}\n` : EMPTY;

  // `document` rather than `html`, which is the tagged template now.
  const document = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="/luna.css">
<title>${documentTitle}</title>${metaDescription}${metaRobots}${twinLink}
${faviconLink(route)}
${head}<style>
:root{--axp-maxw:${width}px}
${unsafeHtml(xpChromeCss())}
${unsafeHtml(css || "")}
</style>
<link rel="stylesheet" href="/luna.css">
</head>
<body>
${unsafeHtml(DESKTOP_TOP)}
<div class="window${windowClass ? " " + windowClass : ""}"${windowAttrs === EMPTY ? EMPTY : html` ${windowAttrs}`}>
  <div class="title-bar">
    <span class="title-text${titleClass ? " " + titleClass : ""}"><span class="icon"></span>${windowTitle}</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="${closeHref}" title="${closeTitle}" aria-label="${closeLabel}"></a></span>
  </div>${addressHtml}
  ${paneHtml}<div class="content${contentClass ? " " + contentClass : ""}">
${body}
  </div>
</div>
${unsafeHtml(DESKTOP_CHROME)}
${scriptHtml}
</body>
</html>`;

  return new Response(String(document), {
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
