// The pure half of tools/webmcp-catalog.ts: what a page SHOULD register into
// the browser's WebMCP catalog, and how that differs from what it did.
//
// The catalog is shared and append-only (contract-webmcp-one-door-onto-the-
// browser-catalog has the measurements), so a lost registration is silent: a
// duplicate name is dropped, a rejected schema is dropped, and the page keeps
// working. Reading the live catalog is the only way to see one, and these are
// the rules that reading is checked against.

/**
 * The Lens page tools, read from the one array literal in lens-webmcp.js that
 * declares them. Only that array is read, so a `name:` in some unrelated object
 * can't inflate the list. Throws when the array can't be found, because an
 * empty list here would turn every check that uses it into a pass.
 */
export function lensPageToolNames(src: string): string[] {
  const start = src.indexOf("const defs = [");
  if (start < 0) throw new Error("lens-webmcp.js no longer declares its page tools as `const defs = [`; update lensPageToolNames()");
  const end = src.indexOf("\n  ];", start);
  if (end < start) throw new Error("could not find the end of lens-webmcp.js's page-tool array");
  return [...src.slice(start, end).matchAll(/^\s+name:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

/**
 * Every page with nav.js registers the whole /mcp catalog (webmcp.js), and
 * /lens adds its page tools on top (lens-webmcp.js). Nothing else registers.
 */
export function expectedCatalog(route: string, siteTools: readonly string[], lensTools: readonly string[]): string[] {
  const path = route.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  return [...new Set([...siteTools, ...(path === "/lens" ? lensTools : [])])].sort();
}

/** What the page should have registered and didn't, and what it registered unasked. */
export function diffCatalog(expected: readonly string[], live: readonly string[]): { missing: string[]; extra: string[] } {
  const want = new Set(expected);
  const got = new Set(live);
  return {
    missing: [...want].filter((n) => !got.has(n)).sort(),
    extra: [...got].filter((n) => !want.has(n)).sort(),
  };
}
