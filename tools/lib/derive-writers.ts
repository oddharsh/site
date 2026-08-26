// Which files in this repository WRITE one, so the graph can refuse a generator
// nobody declared.
//
// config/derivations.json answers "is this artifact stale". It cannot answer the
// question underneath it, which is whether an artifact has a declaration at all,
// and that is the gap gotcha 41 fell through: histograms.json had no declaration,
// so there was nothing for a check to be wrong about. A graph is only as complete
// as its census of producers.
//
// So every file that writes is classified exactly once: it either appears as some
// derivation's `regenerate` command, or it is listed under `writers.exempt` with a
// reason. A new generator is covered by EXISTING rather than by somebody
// remembering to add it, which is the property tools.json's declaration tier has
// and the reason it is worth copying.
//
// ── two scanners, because shell cannot be read the same way ──────────────────
// JS, TS and Python get an EXACT scan: a write is a named call, so the question
// "does this file write" has a yes or no answer in the source text.
//
// Shell has no such answer. A shell script writes with redirects, `cp`, `mv`,
// `tee`, `sed -i` and heredocs, and it also writes through the tools it drives:
// `avifenc -o`, `zenc square`, `exif-sooc --merge-into`. A scanner matching those
// loosely spends its life on false positives and still misses some. So the shell
// tier asks a DELIBERATELY WEAKER AND WIDER question: does this script mention a
// path under a committed tree at all? That over-approximates on purpose, because
// over-approximating fails CLOSED. A script that only reads from public/ still
// has to be classified, and its exemption says it only reads.
//
// This tier was added after the exact scan shipped with shell listed as a known
// hole. The hole was real: `add-car-photo.sh`, `reencode-thumbnails.sh` and the
// two encoding-grid scripts all write committed bytes and none was classified,
// and reencode-thumbnails.sh is the very script whose standalone use caused
// gotcha 41.
//
// Full-line comments are stripped first. A path in a comment is not a write, and
// leaving them in would have made most of the classifications read "mentions it
// in a comment", which is the kind of entry that teaches people the list is
// noise.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Directories with no first-party generators in them. */
const SKIP = new Set(["node_modules", ".git", ".build", ".wrangler", ".claude", "target", ".venv", "dist", ".dev-assets"]);

const SCANNED = [".ts", ".mjs", ".js", ".py"];

/** A write, per language. Exact calls, never a loose path match. */
const WRITES = [
  /\bwriteFile(?:Sync)?\s*\(/,          // node
  /\bBun\.write\s*\(/,                  // bun
  /\bopen\s*\([^)]*["']w[b+]?["']\s*\)/, // python
  /\bcreateWriteStream\s*\(/,
];

/**
 * Below this the scanner has stopped matching and every caller reports a clean
 * run over nothing, which is the failure every floor in this repo refuses.
 */
export const WRITER_FLOOR = 15;

export async function findWriters(root: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      // A test that writes a fixture is not a generator of anything committed.
      if (entry.name.includes(".test.")) continue;
      if (!SCANNED.includes(path.extname(entry.name))) continue;
      const src = await readFile(path.join(root, child), "utf8");
      if (WRITES.some((re) => re.test(src))) out.push(child);
    }
  };
  for (const r of roots) await walk(r);
  return out.sort();
}

/** Committed trees whose bytes a browser or the Worker can reach. */
const COMMITTED = /(^|[^\w])(public|src)\//;

const stripComments = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * Shell scripts that mention a committed tree. Wider than "writes" on purpose;
 * see the header. Below the floor the matcher has broken rather than the
 * repository having gone quiet.
 */
export const SHELL_FLOOR = 5;

export async function findShellTouchers(root: string, roots: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
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

/** Is this file named by any derivation's regenerate command? */
export const declaredBy = (file: string, regenerates: string[]): boolean =>
  regenerates.some((cmd) => cmd.includes(file));
