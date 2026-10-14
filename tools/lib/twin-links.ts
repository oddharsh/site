// twin-links.ts: does every built page that has a Markdown twin say so?

export function routeOf(rel: string): string {
  const route = "/" + rel.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, "");
  return route === "/" ? "/" : route.replace(/\/+$/, "");
}

export function twinHref(route: string): string {
  return route === "/" ? "/index.md" : `${route}.md`;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

export function hasAlternateLink(html: string, href: string): boolean {
  const head = /<head\b[\s\S]*?(?:<\/head>|<body\b)/i.exec(html)?.[0] ?? "";
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("alternate") && attr(tag, "type") === "text/markdown" && attr(tag, "href") === href) return true;
  }
  return false;
}

function paneOf(html: string): string | null {
  const open = /<div\s+class="?axp-tasks"?[\s>]/i.exec(html);
  if (!open) return null;
  const close = html.indexOf("</aside>", open.index);
  return close < 0 ? html.slice(open.index) : html.slice(open.index, close);
}

export function paneOffersTwin(html: string, href: string): boolean | null {
  const pane = paneOf(html);
  if (pane === null) return null;
  for (const tag of pane.match(/<a\b[^>]*>/gi) ?? []) if (attr(tag, "href") === href) return true;
  return false;
}

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
