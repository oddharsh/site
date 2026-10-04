// ── every "gotcha N" reference names exactly one entry ───────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// The gotchas live in docs/GOTCHAS.md and code cites them by number. A number
// that names two entries, or none, makes every citation of it ambiguous, and
// nothing else would notice. Uniqueness only, never order: numbers are
// permanent, so retired entries leave gaps.

/** Column-0 numbered items after the `## Gotchas` header. */
async function gotchaNumbers() {
  const md = await readFile(new URL("docs/GOTCHAS.md", ROOT), "utf8");
  const start = md.indexOf("\n## Gotchas");
  assert.ok(start > 0, "docs/GOTCHAS.md no longer carries the gotchas section header");
  return [...md.slice(start).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
}

test("every gotcha number names exactly one entry", async () => {
  const nums = await gotchaNumbers();

  // A floor, on the a-dict precedent: a scanner that has quietly stopped
  // matching reports a clean pass over zero headings, and an empty list is
  // trivially unique. 46 today.
  assert.ok(nums.length >= 30, `only ${nums.length} gotcha headings found; the scan has stopped matching`);

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
