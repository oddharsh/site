// lens-chips.mjs — the seeded "Try:" URLs on /lens, read out of the page that
// renders them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHELL = join(ROOT, "src", "worker", "lens.ts");

const FLOOR = 5;

export function lensChips() {
  const src = readFileSync(SHELL, "utf8");
  const urls = [];
  for (const m of src.matchAll(/class="lx-chip"\s+data-url="([^"]+)"/g)) urls.push(m[1]);
  if (urls.length < FLOOR) {
    throw new Error(`lens-chips: found ${urls.length} chip URL(s) in ${SHELL}, expected at least ${FLOOR}. The markup probably moved.`);
  }
  return urls;
}

export function lensVsChips() {
  const src = readFileSync(SHELL, "utf8");
  const pairs = [];
  for (const m of src.matchAll(/data-vs-pair="([^"]+)"/g)) {
    const [a, b] = m[1].split("|");
    if (a && b) pairs.push([a, b]);
  }
  return pairs;
}

export function lensChipTargets() {
  const all = [...lensChips(), ...lensVsChips().flat()];
  return [...new Set(all)];
}
