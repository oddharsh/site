// lib/chrome.ts: the Luna page shell every worker-rendered page wears
// (lunaPage), with its share metadata and the XP chrome CSS.

import { DESKTOP_CHROME, DESKTOP_TOP, SECTION_FAVICONS } from "./desktop.ts";
import { addressBar, taskPane } from "./explorer.ts";
import { EMPTY, Html, html, unsafeHtml } from "./html.ts";
import { inlineScriptPolicy } from "./inline-csp.ts";
import { SHELL_PRELOAD_LINK } from "./shell-assets.ts";
import { twinFor } from "./twins.ts";
import { titleBar } from "./window.ts";

export function xpChromeCss() {
  return `/*min*/
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-ui);
    font-size: var(--text-body); line-height: 1.5; color: var(--ink);
    margin: 0;
  }
  .window { max-width: var(--axp-maxw, 720px); }
  /* the page heading. Zero-specificity :where() so a page's own h1 rule, which
     comes after this in the same <style>, still wins for a deliberate size. */
  :where(.content) h1 { font-family: var(--font-caption); font-size: var(--text-h1); color: var(--text-heading); margin: 0 0 4px; }
	`;
}

function faviconLink(route): Html {
  const icon = SECTION_FAVICONS[route];
  return icon
    ? html`<link rel="icon" type="image/svg+xml" href="${icon}">`
    : html`<link rel="icon" href="/favicon.ico">`;
}

export function shareMeta({ title, description = "", path, type = "website", image = "", imageAlt = "" }: {
  title: string; description?: string; path: string; type?: string; image?: string; imageAlt?: string;
}): Html {
  const url = `https://aadhar.sh${path}`;
  const img = image ? `https://aadhar.sh${image}` : "";
  return html`
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="aadhar.sh">
<meta property="og:title" content="${title}">${description ? html`
<meta property="og:description" content="${description}">` : EMPTY}
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">${img ? html`
<meta property="og:image" content="${img}">
<meta name="twitter:image" content="${img}">${imageAlt ? html`
<meta property="og:image:alt" content="${imageAlt}">` : EMPTY}` : EMPTY}`;
}

export type LunaPageOptions = {
  title?: string;
  path?: string;
  width?: number;
  description?: string;
  robots?: string;
  ogImage?: string;
  ogImageAlt?: string;
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
  ogImage = "",
  ogImageAlt = "",
  css = "",
  head = EMPTY,
  body = EMPTY,
  status = 200,
  cache = "public, max-age=300, s-maxage=300",
  headers = {},
  titleClass = "",
  windowClass = "",
  contentClass = "",
  windowAttrs = EMPTY,
  route = "",
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
  const histnav = !/\bdata-no-histnav\b/.test(String(windowAttrs));

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

  const document = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="/luna.css">
<title>${documentTitle}</title>${metaDescription}${metaRobots}${linkCanonical}${route ? shareMeta({ title: documentTitle, description, path: route, image: ogImage, imageAlt: ogImageAlt }) : EMPTY}${twinLink}
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
