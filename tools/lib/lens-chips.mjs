// lens-chips.mjs — the seeded "Try:" URLs on /lens, read out of the page that
// renders them.
//
// Both warming scripts target this list, and it used to be pasted into each of
// them under a "keep in sync" comment. A comment is not a mechanism: the list
// that matters is the one a visitor can click, so this reads that list from the
// shell renderer and nobody has to remember a third copy.
//
// The FLOOR is the load-bearing part. A scanner whose pattern stops matching
// returns an empty array and every caller reports a clean run over nothing, so
// this throws instead. Same reasoning as the guard scanners in check-tools.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = join(ROOT, "src", "worker", "lens.ts");

// Below this, assume the markup moved rather than the chips.
const FLOOR = 5;

export function lensChips() {
  const src = readFileSync(SHELL, "utf8");
  const urls = [];
  // Quote-aware on purpose: the source is a JS template literal, so the
  // attributes are quoted here even though the SERVED bytes are not (minify-html
  // unquotes them). This reads the source, never the build output.
  for (const m of src.matchAll(/class="lx-chip"\s+data-url="([^"]+)"/g)) urls.push(m[1]);
  if (urls.length < FLOOR) {
    throw new Error(`lens-chips: found ${urls.length} chip URL(s) in ${SHELL}, expected at least ${FLOOR}. The markup probably moved.`);
  }
  return urls;
}

// The vs chips carry a pair in one attribute. A head-to-head demo scans both
// sides, so a warm that skips them leaves half the comparison cold.
export function lensVsChips() {
  const src = readFileSync(SHELL, "utf8");
  const pairs = [];
  for (const m of src.matchAll(/data-vs-pair="([^"]+)"/g)) {
    const [a, b] = m[1].split("|");
    if (a && b) pairs.push([a, b]);
  }
  return pairs;
}

// Every distinct URL a chip can put in the address bar, deduped.
export function lensChipTargets() {
  const all = [...lensChips(), ...lensVsChips().flat()];
  return [...new Set(all)];
}
