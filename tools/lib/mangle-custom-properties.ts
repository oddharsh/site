// Shorten every CSS custom property name the site defines, in the STAGED tree.

export const RESERVED = new Set(["--x", "--y", "--lx", "--ly", "--tail"]);

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

const PROPERTY_API_DYNAMIC =
  /(?:setProperty|getPropertyValue|removeProperty|getPropertyPriority)\(\s*(?![`"'])[^)]/g;

const matchAll = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]);

export const definitionsIn = (text: string): string[] => matchAll(DEFINITION, text);
export const referencesIn = (text: string): string[] => matchAll(REFERENCE, text);

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

const short = (i: number): string => {
  let s = "";
  for (let n = i; ; n = Math.floor(n / ALPHABET.length) - 1) {
    s = ALPHABET[n % ALPHABET.length] + s;
    if (n < ALPHABET.length) break;
  }
  return `--${s}`;
};

const TWO_CHAR_FIRST = ALPHABET.length;
const TWO_CHAR_COUNT = ALPHABET.length * ALPHABET.length;

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

  const taken = new Set(RESERVED);
  for (const text of files.values()) for (const t of text.match(TOKEN) ?? []) taken.add(t);

  const map = new Map<string, string>();
  const claim = (name: string, candidate: string): void => {
    taken.add(candidate);
    if (candidate.length < name.length) map.set(name, candidate);
  };

  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const tier1 = [...defined].filter((n) => shellDefined.has(n));
  tier1.sort((a, b) => (shellUses.get(b) ?? 0) - (shellUses.get(a) ?? 0) || byName(a, b));
  let i = 0;
  for (const name of tier1) {
    let candidate = short(i++);
    while (taken.has(candidate)) candidate = short(i++);
    claim(name, candidate);
  }

  const tier2 = [...defined].filter((n) => !shellDefined.has(n)).sort(byName);
  let overflow = TWO_CHAR_FIRST + TWO_CHAR_COUNT;
  for (const name of tier2) {
    const home = fnv1a(name) % TWO_CHAR_COUNT;
    let candidate: string | undefined;
    for (let k = 0; k < TWO_CHAR_COUNT && !candidate; k++) {
      const c = short(TWO_CHAR_FIRST + ((home + k) % TWO_CHAR_COUNT));
      if (!taken.has(c)) candidate = c;
    }
    while (!candidate || taken.has(candidate)) candidate = short(overflow++);
    claim(name, candidate);
  }
  return map;
}

export function pruneUnread(files: Map<string, string>, isStylesheet: (rel: string) => boolean): { files: Map<string, string>; dropped: string[] } {
  const current = new Map(files);
  const dropped: string[] = [];
  for (;;) {
    const tokens = new Map<string, number>(), definitions = new Map<string, number>(), inStylesheet = new Set<string>();
    for (const [rel, text] of current) {
      for (const t of text.match(TOKEN) ?? []) tokens.set(t, (tokens.get(t) ?? 0) + 1);
      for (const n of definitionsIn(text)) {
        definitions.set(n, (definitions.get(n) ?? 0) + 1);
        if (isStylesheet(rel)) inStylesheet.add(n);
      }
    }
    const unread = [...inStylesheet].filter((n) => !RESERVED.has(n) && (tokens.get(n) ?? 0) <= (definitions.get(n) ?? 0));
    if (!unread.length) break;
    const names = new Set(unread), removed = new Set<string>();
    for (const [rel, text] of current) {
      if (!isStylesheet(rel)) continue;
      const next = text.replace(/(?<![a-z0-9-])(?<!style\(\s*)(--[a-z0-9][a-z0-9-]*)\s*:[^;}]*;?/g, (decl, name) => {
        if (!names.has(name)) return decl;
        removed.add(name);
        return "";
      }).replace(/;}/g, "}");
      if (next !== text) current.set(rel, next);
    }
    if (!removed.size) break;
    dropped.push(...removed);
  }
  return { files: current, dropped: dropped.sort() };
}

export const applyMangle = (text: string, map: Map<string, string>): string =>
  text.replace(TOKEN, (token) => map.get(token) ?? token);

type Scan = { defined: string[]; referenced: string[] };
const scanOf = (text: string): Scan => ({ defined: definitionsIn(text), referenced: referencesIn(text) });

function danglingFrom(files: Map<string, string>, reuse?: { text: Map<string, string>; scans: Map<string, Scan> }): {
  dangling: Set<string>;
  scans: Map<string, Scan>;
} {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  const scans = new Map<string, Scan>();
  for (const [rel, text] of files) {
    const prior = reuse && reuse.text.get(rel) === text ? reuse.scans.get(rel) : undefined;
    const scan = prior ?? scanOf(text);
    scans.set(rel, scan);
    for (const n of scan.defined) defined.add(n);
    for (const n of scan.referenced) referenced.add(n);
  }
  for (const n of defined) referenced.delete(n);
  return { dangling: referenced, scans };
}

export function unresolved(files: Map<string, string>): Set<string> {
  return danglingFrom(files).dangling;
}

export function assertIntegrity(
  before: Map<string, string>,
  after: Map<string, string>,
  map: Map<string, string>,
  floor: number,
): void {
  if (map.size < floor) {
    throw new Error(`mangle: only ${map.size} custom properties renamed, expected at least ${floor} — did the collector stop seeing the styles?`);
  }
  const first = danglingFrom(before);
  const expected = new Set([...first.dangling].map((n) => map.get(n) ?? n));
  const actual = danglingFrom(after, { text: before, scans: first.scans }).dangling;
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
