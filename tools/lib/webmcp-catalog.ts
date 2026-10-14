// The pure half of tools/webmcp-catalog.ts: what a page SHOULD register into
// the browser's WebMCP catalog, and how that differs from what it did.

export function lensPageToolNames(src: string): string[] {
  const start = src.indexOf("const defs = [");
  if (start < 0) throw new Error("lens-webmcp.js no longer declares its page tools as `const defs = [`; update lensPageToolNames()");
  const end = src.indexOf("\n  ];", start);
  if (end < start) throw new Error("could not find the end of lens-webmcp.js's page-tool array");
  return [...src.slice(start, end).matchAll(/^\s+name:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

export function expectedCatalog(route: string, siteTools: readonly string[], lensTools: readonly string[]): string[] {
  const path = route.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  return [...new Set([...siteTools, ...(path === "/lens" ? lensTools : [])])].sort();
}

export function diffCatalog(expected: readonly string[], live: readonly string[]): { missing: string[]; extra: string[] } {
  const want = new Set(expected);
  const got = new Set(live);
  return {
    missing: [...want].filter((n) => !got.has(n)).sort(),
    extra: [...got].filter((n) => !want.has(n)).sort(),
  };
}
