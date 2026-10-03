// lib/chrome.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { DESKTOP_CHROME, DESKTOP_TOP, SECTION_FAVICONS } from "./desktop.ts";
import { addressBar, taskPane } from "./explorer.ts";
import { EMPTY, Html, html, unsafeHtml } from "./html.ts";
import { inlineScriptPolicy } from "./inline-csp.ts";
import { SHELL_PRELOAD_LINK } from "./shell-assets.ts";
import { twinFor } from "./twins.ts";
import { titleBar } from "./window.ts";

// The page-level CSS every server-rendered Luna window shares. Everything a
// window LOOKS like (frame, title bar, gel caption buttons, desktop, taskbar
// floor, the OS-window flex model, the client edge, scrollbars) is luna.css's,
// which lunaPage links render-blocking, so it is already applied at first paint
// and a copy here would paint nothing. What stays is what luna does not set:
// body type, the margin reset, the page's measure (--axp-maxw, from lunaPage's
// `width`). Page-specific
// rules stay inline per page after the call. The /*min*/ sentinel lets build.ts
// minify this static literal on the wire; the readable source remains in git.
export function xpChromeCss() {
  return `/*min*/
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-ui);
    font-size: 10.5pt; line-height: 1.5; color: var(--ink);
    margin: 0;
  }
  .window { max-width: var(--axp-maxw, 720px); }
  /* the page heading. Zero-specificity :where() so a page's own h1 rule, which
     comes after this in the same <style>, still wins for a deliberate size. */
  :where(.content) h1 { font-family: var(--font-caption); font-size: var(--text-h1); color: var(--text-heading); margin: 0 0 4px; }
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
 *  it goes through `unsafeHtml(` at the one place it is spliced. */
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
  // byte-identical. They were added for the /terminal console (retired 2026-09-16),
  // which needed the SAME window
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
  // The address bar and task pane (lib/explorer.js). The /terminal console opted out for the
  // same reason it dropped the history buttons: a console is not a folder, and
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
  // rel=canonical names the one URL a search engine should index, so the
  // ?query and trailing-slash variants the Worker also answers fold onto it.
  // Only for a page that takes indexing at all: a canonical on a noindex page
  // asks a crawler to index the URL the robots tag just told it to drop.
  const linkCanonical = route && !/\bnoindex\b/.test(robots)
    ? html`\n<link rel="canonical" href="https://aadhar.sh${route}">`
    : EMPTY;
  const scriptHtml = html`${scripts}\n<script src="/nav.js" defer></script>`;
  // Back/Forward ship in the HTML so the caption has its final geometry at first
  // paint (gen-desktop-partial.ts, HISTNAV_HTML, says what injecting it cost).
  // A window that opts out with data-no-histnav gets none, as nav.js would.
  const histnav = !/\bdata-no-histnav\b/.test(String(windowAttrs));

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
<title>${documentTitle}</title>${metaDescription}${metaRobots}${linkCanonical}${twinLink}
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
  ${titleBar({ caption: windowTitle, titleClass, histnav, closeHref, closeTitle, closeLabel })}${addressHtml}
  ${paneHtml}<div class="content${contentClass ? " " + contentClass : ""}">
${body}
  </div>
</div>
${unsafeHtml(DESKTOP_CHROME)}
${scriptHtml}
</body>
</html>`;

  const bytes = String(document);
  // A hashed script-src for exactly these bytes (lib/inline-csp.ts). This is
  // what takes a per-request page off 'unsafe-inline': the build's hash map only
  // knows staged documents. null means the page carries something a hash cannot
  // cover, and then no header is set here, so withSecurityHeaders stamps the
  // loose default as before. A caller's own policy in `headers` still wins
  // (lens.ts's framed view composes one).
  const out: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": cache,
    // preload the shell assets ahead of the body (Cloudflare Early Hints
    // replays these as a 103). a caller's own `link` in headers still wins.
    "link": SHELL_PRELOAD_LINK,
  };
  const policy = inlineScriptPolicy(bytes);
  if (policy) out["content-security-policy"] = policy;
  return new Response(bytes, { status, headers: { ...out, ...headers } });
}
