// Which files in this repository WRITE one, so the graph can refuse a generator
// nobody declared.
//
// config/derivations.json answers "is this artifact stale". It cannot answer the
// question underneath it, which is whether an artifact has a declaration at all,
// and that is the gap gotcha 46 fell through: histograms.json had no declaration,
// so there was nothing for a check to be wrong about. A graph is only as complete
// as its census of producers.
//
// This tier was added after the exact scan shipped with shell listed as a known
// hole. The hole was real: `add-car-photo.sh`, `reencode-thumbnails.sh` and the
// two encoding-grid scripts all write committed bytes and none was classified,
// and reencode-thumbnails.sh is the very script whose standalone use caused
// gotcha 46.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".build", ".wrangler", ".claude", "target", ".venv", "dist", ".dev-assets"]);

/**
 * Vendored third-party trees, skipped by PATH rather than by basename.
 *
 * tools/photos/libavif/build.sh clones libavif and builds aom, libwebp and libyuv
 * underneath it. Both directories are gitignored, because that is a vendored BUILD
 * rather than source this repository owns. The census walks the filesystem, so the
 * first person to follow build.sh got seven of those projects' own scripts reported
 * as undeclared generators and a red derive:check on a tree with no local edits.
 *
 * The shell tier fires hardest, and by construction: it matches any mention of
 * `src/`, and every C project on earth has one of those.
 *
 * By path because the basenames are `src` and `build`, which are the two names
 * least safe to add to SKIP.
 *
 * The AV2 build was the same shape and worse (CMake fetches AVM, TensorFlow
 * Lite, XNNPACK and abseil, whose Python read as undeclared generators by the
 * dozen). It moved to github.com/oddharsh/av2-tone and builds inside
 * node_modules, which the census never walks.
 */
const VENDORED = new Set([
  "tools/photos/libavif/src", "tools/photos/libavif/build",
]);

const SCANNED = [".ts", ".mjs", ".js", ".py"];

const WRITES = [
  /\bwriteFile(?:Sync)?\s*\(/,
  /\bappendFile(?:Sync)?\s*\(/,
  /\bBun\.write\s*\(/,
  /\bopen\s*\([^)]*["']w[b+]?["']\s*\)/,
  /\bcreateWriteStream\s*\(/,
];

export const WRITER_FLOOR = 15;

export async function findWriters(root: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!VENDORED.has(child)) await walk(child);
        continue;
      }
      if (entry.name.includes(".test.")) continue;
      if (!SCANNED.includes(path.extname(entry.name))) continue;
      const src = await readFile(path.join(root, child), "utf8");
      if (WRITES.some((re) => re.test(src))) out.push(child);
    }
  };
  for (const r of roots) await walk(r);
  return out.sort();
}

const COMMITTED = /(^|[^\w])(public|src)\//;

const stripComments = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

export const SHELL_FLOOR = 5;

export async function findShellTouchers(root: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!VENDORED.has(child)) await walk(child);
        continue;
      }
      if (path.extname(entry.name) !== ".sh") continue;
      const src = stripComments(await readFile(path.join(root, child), "utf8"));
      if (COMMITTED.test(src)) out.push(child);
    }
  };
  for (const r of roots) await walk(r);
  return out.sort();
}

export const declaredBy = (file: string, regenerates: string[]): boolean =>
  regenerates.some((cmd) => cmd.includes(file));
