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
// A definition is `--name:` at the head of a declaration. A style container
// query, `@container style(--name: true)` (and `if(style(--name: 1): …)` from
// CSS Values 5), has the same `--name:` shape and is a READ: the flag's value
// is compared, never set. Counting it as a definition hid two things, measured
// 2026-09-15 on a fixture. A query on a flag nothing defines never reached the
// dangling set, so the one assertion this pass rests on could not see it, and
// the flag was still planned a short name as if the tree defined it. The
// lookbehind excludes the `style(` form here and REFERENCE collects it below,
// so a shell flag that only a `setProperty` call ever sets is dangling by
// construction, which is exactly what makes a missed file visible.
const DEFINITION = /(?<!style\(\s*)(--[a-z0-9][a-z0-9-]*)\s*:/g;
const REFERENCE = /(?:var|style)\(\s*(--[a-z0-9][a-z0-9-]*)/g;

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

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The i-th short name: `--a` .. `--9`, then `--aa` .. `--99`, then three characters. */
const short = (i: number): string => {
  let s = "";
  for (let n = i; ; n = Math.floor(n / ALPHABET.length) - 1) {
    s = ALPHABET[n % ALPHABET.length] + s;
    if (n < ALPHABET.length) break;
  }
  return `--${s}`;
};

/** Where the two-character names start in `short`'s sequence, and how many there are. */
const TWO_CHAR_FIRST = ALPHABET.length;
const TWO_CHAR_COUNT = ALPHABET.length * ALPHABET.length;

/** FNV-1a, 32-bit. Stable across runtimes, which is the only property wanted from it. */
const fnv1a = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/**
 * Short names in two tiers, and the split is what keeps a page edit from
 * re-minting the shell.
 *
 * `shellFiles` names the staged files that step 6 content-hashes into `/a/`
 * (luna.css, lwe-base.css, nav.js and the rest). A short name inside one of
 * them is part of that file's bytes, so it is part of its URL, and every page
 * and page dictionary that names the URL moves with it (gotcha 35). Until
 * 2026-09-24 one site-wide ranking decided every name, so one more
 * `var(--sh)` in /pixel-peeper made a page-local `--sh` outrank luna.css's
 * `--blue-65`, the two swapped letters inside luna.css, and 311 staged files
 * changed for a one-line edit to one page.
 *
 * TIER 1, the SHELL: every name a shell file DEFINES, ranked by its uses
 * inside the shell files alone, and handed `--a`, `--b`, ... in that order.
 * Nothing outside the shell is read, so no page can move a shell name. The
 * ranking is also the right one for bytes, since luna.css is where the
 * savings are and it is luna.css's own repetition that is being counted.
 *
 * TIER 2, everything else the tree defines (page-local names, and a name the
 * shell only reads): placed by a HASH OF THE NAME into the two-character
 * space, probing past anything taken. No use count reaches it, so a count edit
 * moves nothing, and a new name can displace an existing one only by hashing
 * onto the same free slot and sorting before it. Page CSS is compressed per
 * document, so a two-character name where a count ranking would have given
 * one costs a byte or two per page.
 *
 * Per-document ranking would be tighter still, and was declined: two pages
 * could then share a short name for different properties, which is harmless
 * in the browser and breaks the one tree-wide map `assertIntegrity` checks
 * the dangling set against. A missed file is the failure that check exists
 * to catch, and it is worth more than the byte.
 *
 * Without `shellFiles` every file is shell, which is the old single ranking.
 */
export function planNames(files: Map<string, string>, shellFiles?: ReadonlySet<string>): Map<string, string> {
  const inShell = (name: string): boolean => !shellFiles || shellFiles.has(name);
  const defined = new Set<string>();
  const shellDefined = new Set<string>();
  const shellUses = new Map<string, number>();
  for (const [file, text] of files) {
    const shell = inShell(file);
    for (const n of definitionsIn(text)) {
      defined.add(n);
      if (shell) shellDefined.add(n);
    }
    if (shell) for (const n of referencesIn(text)) shellUses.set(n, (shellUses.get(n) ?? 0) + 1);
  }
  for (const n of RESERVED) defined.delete(n);

  // Seed with every custom-property-shaped token ALREADY in the tree, not just
  // the reserved ones. A generated `--l` that happens to collide with a name
  // something references and nothing defines would silently start resolving.
  // The integrity check caught exactly that on this pass's first run. This is
  // the one way a page can still move a shell name, and it takes a LITERAL
  // short token (an authored `--q`), which no count edit produces.
  const taken = new Set(RESERVED);
  for (const text of files.values()) for (const t of text.match(TOKEN) ?? []) taken.add(t);

  const map = new Map<string, string>();
  const claim = (name: string, candidate: string): void => {
    taken.add(candidate);
    if (candidate.length < name.length) map.set(name, candidate);
  };

  // Tier 1. Most-used first, so the shortest names land where they repeat most.
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const tier1 = [...defined].filter((n) => shellDefined.has(n));
  tier1.sort((a, b) => (shellUses.get(b) ?? 0) - (shellUses.get(a) ?? 0) || byName(a, b));
  let i = 0;
  for (const name of tier1) {
    let candidate = short(i++);
    while (taken.has(candidate)) candidate = short(i++);
    claim(name, candidate);
  }

  // Tier 2. Sorted by name so the probe order, and so any collision, is a
  // function of the set of names and never of the order files were read in.
  const tier2 = [...defined].filter((n) => !shellDefined.has(n)).sort(byName);
  let overflow = TWO_CHAR_FIRST + TWO_CHAR_COUNT;
  for (const name of tier2) {
    const home = fnv1a(name) % TWO_CHAR_COUNT;
    let candidate: string | undefined;
    for (let k = 0; k < TWO_CHAR_COUNT && !candidate; k++) {
      const c = short(TWO_CHAR_FIRST + ((home + k) % TWO_CHAR_COUNT));
      if (!taken.has(c)) candidate = c;
    }
    // All 1296 two-character names taken: carry on into three characters.
    while (!candidate || taken.has(candidate)) candidate = short(overflow++);
    claim(name, candidate);
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
