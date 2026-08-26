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
// ── what this scanner can and cannot see ─────────────────────────────────────
// It reads JS, TS and Python, where a write is a named call and detection is
// exact. It does NOT read shell, because a shell script writes with redirects,
// `cp`, `mv`, `tee` and heredocs, and a scanner that matched those loosely would
// spend its life on false positives while still missing `sed -i`. The two shell
// generators here are declared through `regenerate` anyway, and
// contract-committed-shell-scripts-fail-loudly.test.mjs already keeps a census of
// every committed shell script, so a twelfth one is not invisible.
//
// That limit is written down rather than left implied, because an inventory that
// silently covers three languages of four is exactly the overclaim the tiers in
// config/derivations.json exist to avoid.

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

/** Is this file named by any derivation's regenerate command? */
export const declaredBy = (file: string, regenerates: string[]): boolean =>
  regenerates.some((cmd) => cmd.includes(file));
