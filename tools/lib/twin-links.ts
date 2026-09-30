// twin-links.ts: does every built page that has a Markdown twin say so?
//
// A page advertises its twin two ways: a `<link rel="alternate"
// type="text/markdown">` in <head>, and a "Read this as Markdown" task in the
// explorer pane where the page carries one. lunaPage writes both from
// `lib/twins.ts`, and build step 1g2 writes both into the pages that already
// exist by then. Neither path can see a twin it was never told about, and until
// 2026-09-30 the pages baked at step 5b were told about none: they rendered
// against a copy of `lib/twins.ts` the build had loaded before 1g2 filled it in.
// Nothing failed, because a page with no link still serves, and negotiation and
// the `.md` URL still answer.
//
// So the TWIN SET here comes from the Markdown files the build actually wrote,
// never from `TWIN_PATHS`. A renderer holding a stale or empty list then shows
// up as pages missing their link, which is the failure this exists to catch.

/** The canonical request path a staged page answers at. */
export function routeOf(rel: string): string {
  const route = "/" + rel.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, "");
  return route === "/" ? "/" : route.replace(/\/+$/, "");
}

/** The twin URL for a canonical path, the same mapping lib/twins.ts uses. */
export function twinHref(route: string): string {
  return route === "/" ? "/index.md" : `${route}.md`;
}

// Attribute values arrive quoted from the renderers and unquoted after
// minify-html, so both are read.
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** Does the document's <head> carry an alternate link to this twin? */
export function hasAlternateLink(html: string, href: string): boolean {
  const head = /<head\b[\s\S]*?(?:<\/head>|<body\b)/i.exec(html)?.[0] ?? "";
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("alternate") && attr(tag, "type") === "text/markdown" && attr(tag, "href") === href) return true;
  }
  return false;
}

/** The explorer pane's markup, or null when the page carries none. */
function paneOf(html: string): string | null {
  const open = /<div\s+class="?axp-tasks"?[\s>]/i.exec(html);
  if (!open) return null;
  const close = html.indexOf("</aside>", open.index);
  return close < 0 ? html.slice(open.index) : html.slice(open.index, close);
}

/** Does the pane (when there is one) offer the twin as a task? */
export function paneOffersTwin(html: string, href: string): boolean | null {
  const pane = paneOf(html);
  if (pane === null) return null;
  for (const tag of pane.match(/<a\b[^>]*>/gi) ?? []) if (attr(tag, "href") === href) return true;
  return false;
}

/**
 * Every problem, one line each. `pages` is every staged document (rel path under
 * the served root, and its bytes); `twinRoutes` is the set of canonical paths a
 * `.md` twin was written for.
 */
export function twinLinkProblems(pages: { rel: string; html: string }[], twinRoutes: Iterable<string>): string[] {
  const twins = new Set(twinRoutes);
  const problems: string[] = [];
  for (const { rel, html } of pages) {
    const route = routeOf(rel);
    if (!twins.has(route)) continue;
    const href = twinHref(route);
    if (!hasAlternateLink(html, href)) problems.push(`${rel}: no <link rel="alternate" type="text/markdown" href="${href}">`);
    if (paneOffersTwin(html, href) === false) problems.push(`${rel}: its explorer pane does not offer ${href}`);
  }
  return problems;
}
