// Step 5e: shorten CSS class names across the staged tree, through
// spokeshave's cross-language class census (spokeshave/src/classes.ts has the
// rules for what is renameable and why).
//
// What this file owns is the NAMING, in the same two tiers as the custom
// property mangler (lib/mangle-custom-properties.ts, planNames) and for the
// same reason: a short name inside a hashed shell file is part of that file's
// URL, so a page edit must never move one (gotcha 35).
//
// TIER 1, the SHELL: every class name a shell file holds a position of,
// ranked by its positions inside the shell files alone. Rank r gets the r-th
// short name. A name that isn't renameable keeps its rank and leaves the slot
// empty, so a prose edit that reserves one name can't shift the names below
// it. A slot whose short name is taken (a reserved word, an existing class)
// sends that one name to a hashed three-character slot instead of probing
// forward, which would move every later name.
//
// TIER 2, everything else: placed by a hash of the name into the
// two-character space, probing past anything taken.
import { applyClassNames, assertClassIntegrity, censusClasses, nameIsFree } from "spokeshave/classes";
import type { ClassCensus } from "spokeshave/classes";

const FIRST = "abcdefghijklmnopqrstuvwxyz";
const REST = "abcdefghijklmnopqrstuvwxyz0123456789";
const ONE = FIRST.length;
const TWO = FIRST.length * REST.length;
const THREE = FIRST.length * REST.length * REST.length;

/** The i-th short class name: a..z, then two characters, then three. */
export function shortClassName(i: number): string {
  if (i < ONE) return FIRST[i];
  if (i < ONE + TWO) {
    const k = i - ONE;
    return FIRST[Math.floor(k / REST.length)] + REST[k % REST.length];
  }
  const k = i - ONE - TWO;
  if (k >= THREE) throw new Error(`class names: index ${i} is past the three-character space`);
  return FIRST[Math.floor(k / (REST.length * REST.length))] + REST[Math.floor(k / REST.length) % REST.length] + REST[k % REST.length];
}

/** FNV-1a, 32-bit, the same hash the custom property tiers place by. */
const fnv1a = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

// Classes the build's own later steps and perf tools look for in finished
// pages, by their authored names. The census reads only what ships, so it
// can't see these readers; they keep their names.
//   fold                 critical-css.ts (the first fold holds first paint), parser-pause.ts
//   window np-window max check-agent.ts (finds the window and its maximize button)
//   content              lib/browser-readings.ts (measures the content box's overflow)
// A reader inside build.ts itself looks the served name up instead (servedClass).
export const TOOLING_RESERVED: ReadonlySet<string> = new Set(["fold", "window", "np-window", "max", "content"]);

export function planClassNames(census: ClassCensus, shellFiles: ReadonlySet<string>): Map<string, string> {
  const shellUses = new Map<string, number>();
  for (const p of census.positions) if (shellFiles.has(p.file)) shellUses.set(p.name, (shellUses.get(p.name) ?? 0) + 1);

  const taken = new Set<string>();
  const free = (name: string) => !taken.has(name) && nameIsFree(census, name);
  const map = new Map<string, string>();
  const claim = (name: string, short: string) => {
    taken.add(short);
    if (short.length < name.length) map.set(name, short);
  };
  // A hashed slot among `size` names starting at index `first`, probing past taken ones.
  const hashed = (name: string, first: number, size: number): string => {
    const home = fnv1a(name) % size;
    for (let k = 0; k < size; k++) {
      const c = shortClassName(first + ((home + k) % size));
      if (free(c)) return c;
    }
    throw new Error(`class names: no free name left for ${name}`);
  };

  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const tier1 = [...shellUses.keys()].sort((a, b) => shellUses.get(b)! - shellUses.get(a)! || byName(a, b));
  const overflow: string[] = [];
  const renames = (name: string) => census.renameable.has(name) && !TOOLING_RESERVED.has(name);
  tier1.forEach((name, rank) => {
    if (!renames(name)) return;
    const c = rank < ONE + TWO ? shortClassName(rank) : undefined;
    if (c && free(c)) claim(name, c);
    else overflow.push(name);
  });
  for (const name of overflow) claim(name, hashed(name, ONE + TWO, THREE));
  const tier2 = [...census.renameable].filter((n) => renames(n) && !shellUses.has(n)).sort(byName);
  // Two characters while they last (reserved words take many), then three.
  const twoLeft = () => Array.from({ length: TWO }, (_, k) => shortClassName(ONE + k)).some(free);
  for (const name of tier2) claim(name, twoLeft() ? hashed(name, ONE, TWO) : hashed(name, ONE + TWO, THREE));
  return map;
}

/** The files the census reads: markup, stylesheets, scripts, Worker source and JSON, never a readable twin. */
export const censusFile = (rel: string): boolean =>
  /\.(css|html|svg|js|mjs|ts|json)$/.test(rel) &&
  !/\.src\.(css|html|js)$/.test(rel) &&
  !rel.startsWith("src/dict/") &&
  !rel.endsWith(".d.ts") &&
  !/(^|\/)tests?\//.test(rel);

/**
 * Census, plan, rewrite and prove, over the staged files. Returns the census,
 * the map and every file after the rewrite. `floor` is the fewest renamed
 * names that counts as a working census.
 */
export function renameClasses(staged: ReadonlyMap<string, string>, shellFiles: ReadonlySet<string>, floor: number) {
  const planned = planRename(staged, shellFiles);
  assertClassIntegrity(planned.before, censusClasses(planned.after, { publicDir: "public" }), planned.map, floor);
  return planned;
}

/** The first census, the plan and the rewrite, without the proof. */
export function planRename(staged: ReadonlyMap<string, string>, shellFiles: ReadonlySet<string>) {
  const before = censusClasses(staged, { publicDir: "public" });
  const map = planClassNames(before, shellFiles);
  const after = applyClassNames(staged, before, map);
  return { before, map, after };
}

/**
 * The proof, on a worker thread: the census of the rewritten tree against the
 * first one. It is the step's second census and half its time, and no later
 * step needs its answer, so the build starts it here and waits on it only
 * before it reports a staged tree. Rejects with the integrity error when the rename
 * changed more than names.
 */
export function proveRename(planned: ReturnType<typeof planRename>, floor: number, timeoutMs = 60_000): Promise<void> {
  const worker = new Worker(new URL("./class-names-proof.ts", import.meta.url));
  return new Promise<void>((resolve, reject) => {
    // A worker that never answers fails the proof: an unanswered one is how a
    // dropped job looked (class-names-proof.ts), and the proof is the only
    // thing standing between a census blind spot and a page whose CSS misses.
    const timer = setTimeout(() => settle(new Error(`class names: the proof worker gave no answer in ${timeoutMs} ms`)), timeoutMs);
    const settle = (error: Error | null) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    worker.onmessage = (event: MessageEvent<{ error: string | null }>) => settle(event.data.error === null ? null : new Error(event.data.error));
    worker.onerror = (event) => settle(new Error(`class names: the proof worker failed: ${event.message}`));
    worker.postMessage({ before: planned.before, after: planned.after, map: planned.map, floor });
  });
}
