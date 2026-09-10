// ── every "gotcha N" reference names exactly one entry ───────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// CLAUDE.md carried TWO entries numbered 41 from 2026-08-24 (#538 added the
// cf-garage TypeScript-config entry on top of #535's histogram entry, which had
// landed the day before) until 2026-09-10. Twenty-four references pointed at
// that number across twelve files (CLAUDE.md, ci.yml, two config declarations, a
// contract test, two derive modules and five photo-pipeline files), and every one
// of them was ambiguous: three meant cf-garage and twenty-one meant the
// histograms.
//
// Nothing caught it because nothing had ever read these numbers. The build stays
// green throughout, and what a collision costs is the cross-reference itself:
// "gotcha 41 as a standing risk" is unresolvable until you read both entries and
// decide which one the sentence is about, which is exactly the work a number
// exists to save. That is the same shape as the repository-layout note's
// warning about stale paths, one layer up: a reference nobody re-reads rots
// silently.
//
// UNIQUENESS ONLY, NEVER MONOTONICITY. The repair renumbered the second 41 to 46
// rather than shifting 42-45 up by one, because the shift would have rewritten
// every cross-reference in a 6000-line file to fix a collision between two of
// them. So the list deliberately ends 40, 41, 42, 43, 44, 45, 46-where-41-was.
// It was already out of order anyway: 22 has sat above 21 since 2026-08-06.
// Asserting order here would fail on that history and invite renumbering the
// file to satisfy a test, which is the change this check exists to make
// unnecessary.

/** The gotcha headings, which are the column-0 numbered items AFTER the section
 *  header. The anchor is load-bearing: this file opens with several ordinary
 *  numbered lists at column 0 (the two homepage fragments, the converter's two
 *  rules, the three MCP deviations), and a scan of the whole document reads
 *  those as gotchas 1, 2 and 3 and reports duplicates that are not there.
 */
async function gotchaNumbers() {
  const md = await readFile(new URL("CLAUDE.md", ROOT), "utf8");
  const start = md.indexOf("\n## Conventions + gotchas");
  assert.ok(start > 0, "CLAUDE.md no longer carries the gotchas section header");
  return [...md.slice(start).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
}

test("every gotcha number names exactly one entry", async () => {
  const nums = await gotchaNumbers();

  // A floor, on the a-dict precedent: a scanner that has quietly stopped
  // matching reports a clean pass over zero headings, and an empty list is
  // trivially unique. 46 today.
  assert.ok(nums.length >= 40, `only ${nums.length} gotcha headings found; the scan has stopped matching`);

  const seen = new Map();
  const dupes = [];
  for (const n of nums) {
    if (seen.has(n)) dupes.push(n);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  assert.deepEqual(dupes, [], `gotcha numbers used more than once: ${dupes.join(", ")}`);
});

// The other half of the same claim, and the one that catches a DELETED entry
// rather than a duplicated one. A reference to a number nothing defines is the
// quieter failure: it reads as a pointer right up until somebody follows it.
test("every gotcha reference in the repository resolves to an entry", async () => {
  const defined = new Set(await gotchaNumbers());

  // git grep rather than a directory walk, for the reason the shell-script
  // census gives: it answers for the files this repository OWNS and stays right
  // over the next vendored tree with no edit here.
  const hits = execFileSync("git", ["grep", "-hoIEi", "gotchas? +#?[0-9]+"], {
    cwd: new URL(".", ROOT),
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });

  const referenced = [...new Set(hits.split("\n").flatMap((h) => {
    const m = h.match(/(\d+)/);
    return m ? [Number(m[1])] : [];
  }))];
  assert.ok(referenced.length >= 20, `only ${referenced.length} distinct references found; the scan has stopped matching`);

  const dangling = referenced.filter((n) => !defined.has(n)).sort((a, b) => a - b);
  assert.deepEqual(dangling, [], `references to gotchas that do not exist: ${dangling.join(", ")}`);
});
