export const PAGE_SCRIPT_HASHES = {}; // build:csp-hashes

export function canonicalPath(pathname) {
  if (!pathname) return "/";
  let p = pathname;
  if (p.endsWith(".html")) p = p.slice(0, -5);
  if (p.endsWith("/index")) p = p.slice(0, -6) || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

export function scriptHashesFor(pathname) {
  if (!pathname) return null;
  return PAGE_SCRIPT_HASHES[canonicalPath(pathname)] || null;
}
