// Shorten every CSS custom property name the site defines, in the STAGED tree.
//
// The palette is authored for people (`--surface-window`, `--blue-inactive`),
// and 106 of those names are unique strings, which is exactly what brotli
// cannot discount: a repeated string costs one backreference, a distinct one
// costs its length. Measured 2026-09-08 over the five stylesheets, shortening
// them is -272 B brotli (-2.24%), and 93% of that is luna.css.
//
// This is safe to do mechanically ONLY because nothing builds a property name
// at runtime. Every setProperty/getPropertyValue/removeProperty call in the
// tree passes a literal, and the five names they pass are RESERVED below. A
// single dynamic `setProperty("--" + kind)` anywhere would defeat the whole
// pass silently, which is what `assertNoDynamicPropertyNames` exists to catch.
//
// The readable `.src.css` / `.src.html` / `.src.js` twins are deliberately NOT
// mangled. They are the View Source copy, the same way they are the unminified
// copy, so `--surface-window` still means something to anyone reading them.

/** Names a DOM call passes as a literal, so the rename may not touch them. */
export const RESERVED = new Set(["--x", "--y", "--lx", "--ly", "--tail"]);

/** Any custom-property-shaped token. CLI flags match too and simply miss the map. */
const TOKEN = /--[a-z0-9][a-z0-9-]*/g;
const DEFINITION = /(--[a-z0-9][a-z0-9-]*)\s*:/g;
const REFERENCE = /var\(\s*(--[a-z0-9][a-z0-9-]*)/g;

/** A first argument to those APIs that is NOT a literal, which would be unsafe. */
const PROPERTY_API_DYNAMIC =
  /(?:setProperty|getPropertyValue|removeProperty|getPropertyPriority)\(\s*(?![`"'])[^)]/g;

const matchAll = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]);

export const definitionsIn = (text: string): string[] => matchAll(DEFINITION, text);
export const referencesIn = (text: string): string[] => matchAll(REFERENCE, text);

/**
 * Throw if any file hands a property-name API something other than a literal.
 * The rename is a whole-tree find-and-replace, so a name assembled at runtime
 * is the one input it cannot follow.
 */
export function assertNoDynamicPropertyNames(files: Map<string, string>): void {
  const offenders: string[] = [];
  for (const [name, text] of files) {
    for (const m of text.matchAll(PROPERTY_API_DYNAMIC)) {
      offenders.push(`${name}: ${text.slice(m.index, m.index + 60).replace(/\s+/g, " ")}`);
    }
  }
  if (offenders.length) {
    throw new Error(
      `mangle: a custom property name is built at runtime, so it cannot be renamed safely:\n  ${offenders.join("\n  ")}`,
    );
  }
}

/** Short names, shortest for the most-referenced, skipping anything reserved. */
export function planNames(files: Map<string, string>): Map<string, string> {
  const defined = new Set<string>();
  const uses = new Map<string, number>();
  for (const text of files.values()) {
    for (const n of definitionsIn(text)) defined.add(n);
    for (const n of referencesIn(text)) uses.set(n, (uses.get(n) ?? 0) + 1);
  }
  for (const n of RESERVED) defined.delete(n);

  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // Seed with every custom-property-shaped token ALREADY in the tree, not just
  // the reserved ones. A generated `--l` that happens to collide with a name
  // something references and nothing defines would silently start resolving.
  // The integrity check caught exactly that on this pass's first run.
  const taken = new Set(RESERVED);
  for (const text of files.values()) for (const t of text.match(TOKEN) ?? []) taken.add(t);
  const short = (i: number): string => {
    let s = "";
    for (let n = i; ; n = Math.floor(n / alphabet.length) - 1) {
      s = alphabet[n % alphabet.length] + s;
      if (n < alphabet.length) break;
    }
    return `--${s}`;
  };

  // Most-used first, so the shortest names land where they repeat most.
  const ordered = [...defined].sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || (a < b ? -1 : 1));
  const map = new Map<string, string>();
  let i = 0;
  for (const name of ordered) {
    let candidate = short(i++);
    while (taken.has(candidate)) candidate = short(i++);
    taken.add(candidate);
    if (candidate.length < name.length) map.set(name, candidate);
  }
  return map;
}

/** Rewrite one file. Whole-token lookup, so `--blue-9` cannot match `--blue-95`. */
export const applyMangle = (text: string, map: Map<string, string>): string =>
  text.replace(TOKEN, (token) => map.get(token) ?? token);

/** Referenced somewhere and defined nowhere. Must not grow across the rename. */
export function unresolved(files: Map<string, string>): Set<string> {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  for (const text of files.values()) {
    for (const n of definitionsIn(text)) defined.add(n);
    for (const n of referencesIn(text)) referenced.add(n);
  }
  for (const n of defined) referenced.delete(n);
  return referenced;
}

/**
 * The integrity assertion, and the reason this pass is allowed to exist.
 *
 * A missed file is silent: its `var(--surface-window)` keeps the old name,
 * nothing defines it any more, and the colour falls back to nothing three
 * commits later. So the invariant is not "the output looks right", it is that
 * the set of DANGLING references is exactly what it was, name for name, with
 * the rename applied to it. A file the walk forgot shows up here immediately.
 */
export function assertIntegrity(
  before: Map<string, string>,
  after: Map<string, string>,
  map: Map<string, string>,
  floor: number,
): void {
  if (map.size < floor) {
    throw new Error(`mangle: only ${map.size} custom properties renamed, expected at least ${floor} — did the collector stop seeing the styles?`);
  }
  const expected = new Set([...unresolved(before)].map((n) => map.get(n) ?? n));
  const actual = unresolved(after);
  const appeared = [...actual].filter((n) => !expected.has(n));
  const vanished = [...expected].filter((n) => !actual.has(n));
  if (appeared.length || vanished.length) {
    throw new Error(
      "mangle: the set of dangling var() references changed, so a file was missed or rewritten twice.\n" +
        (appeared.length ? `  newly dangling: ${appeared.join(", ")}\n` : "") +
        (vanished.length ? `  no longer dangling: ${vanished.join(", ")}\n` : ""),
    );
  }
}
