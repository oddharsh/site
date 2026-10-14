export const TWIN_PATHS = []; // build:twins

const TWINS = new Set(TWIN_PATHS);

export function twinFor(path) {
  if (!path) return null;
  const canonical = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!TWINS.has(canonical)) return null;
  return canonical === "/" ? "/index.md" : `${canonical}.md`;
}
