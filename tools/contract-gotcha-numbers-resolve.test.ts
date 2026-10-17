// ── every "gotcha N" reference names exactly one entry ───────────────────────
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// The gotchas live in docs/GOTCHAS.md and code cites them by number. A number
// that names two entries, or none, makes every citation of it ambiguous, and
// nothing else would notice. Uniqueness only, never order: numbers are
// permanent, so retired entries leave gaps.

/** The text after the `## Gotchas` header. */
async function gotchaSection() {
  const md = await readFile(new URL("docs/GOTCHAS.md", ROOT), "utf8");
  const start = md.indexOf("\n## Gotchas");
  assert.ok(start > 0, "docs/GOTCHAS.md no longer carries the gotchas section header");
  return md.slice(start);
}

/** Column-0 numbered items after the `## Gotchas` header. */
async function gotchaNumbers() {
  return [...(await gotchaSection()).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
}

test("every gotcha number names exactly one entry", async () => {
  const nums = await gotchaNumbers();

  // A floor, on the a-dict precedent: a scanner that has quietly stopped
  // matching reports a clean pass over zero headings, and an empty list is
  // trivially unique. 63 on 2026-10-16.
  assert.ok(nums.length >= 30, `only ${nums.length} gotcha headings found; the scan has stopped matching`);

  const seen = new Map();
  const dupes: any[] = [];
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

// A gotcha is a mistake somebody already paid for, and prose alone stops
// nothing: an agent that never opens this file repeats it. So every entry says
// what fails when the mistake comes back, and each file it names cites the
// gotcha by number. That second half is what keeps the line honest: delete or
// rename the check and this fails, where a bare path would go on pointing at a
// file that no longer checks anything.
const NOTHING = /^nothing \((judgment|fails loudly|how to measure)\)\.$/;
const CHECKS = /^`[^`]+`(, `[^`]+`)*\.$/;

/** Every entry's `Checked by:` value, or the problem with it. */
export function checkedBy(section) {
  return section.split(/\n(?=\d+\. \*\*)/).flatMap((entry) => {
    const n = entry.match(/^(\d+)\. \*\*/)?.[1];
    if (!n) return [];
    const lines = [...entry.matchAll(/^ +Checked by: (.*)$/gm)].map((m) => m[1]);
    if (lines.length !== 1) return [{ n, problem: `${lines.length} Checked by lines` }];
    const [value] = lines;
    if (NOTHING.test(value)) return [{ n, files: [] }];
    if (!CHECKS.test(value)) return [{ n, problem: `unreadable Checked by: ${value}` }];
    return [{ n, files: [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]) }];
  });
}

test("the Checked by reader takes both forms and refuses everything else", () => {
  const read = (body) => checkedBy(`\n## Gotchas\n\n${body}`);
  assert.deepEqual(read("7. **A.** text\n   Checked by: `tools/a.ts`, `tools/b.mjs`.\n"), [{ n: "7", files: ["tools/a.ts", "tools/b.mjs"] }]);
  assert.deepEqual(read("7. **A.** text\n   Checked by: nothing (judgment).\n"), [{ n: "7", files: [] }]);
  assert.deepEqual(read("7. **A.** text, no line\n"), [{ n: "7", problem: "0 Checked by lines" }]);
  assert.deepEqual(read("7. **A.** text\n   Checked by: nothing.\n"), [{ n: "7", problem: "unreadable Checked by: nothing." }]);
  assert.deepEqual(read("7. **A.** text\n   Checked by: tools/a.ts.\n"), [{ n: "7", problem: "unreadable Checked by: tools/a.ts." }]);
});

test("every gotcha says what checks it, and every named check cites it back", async () => {
  const entries = checkedBy(await gotchaSection());
  // Same floor as above: a reader that stopped matching reads as all clear.
  assert.ok(entries.length >= 30, `only ${entries.length} entries read`);
  const named = entries.filter((e) => e.files?.length);
  // 26 on 2026-10-14. Fewer means entries were relabelled `nothing`.
  assert.ok(named.length >= 20, `only ${named.length} gotchas name a check`);

  const tracked = new Set(execFileSync("git", ["ls-files"], {
    cwd: new URL(".", ROOT), encoding: "utf8", maxBuffer: 1 << 24,
  }).split("\n"));
  const problems = entries.filter((e) => e.problem).map((e) => `gotcha ${e.n}: ${e.problem}`);
  for (const { n, files = [] } of entries) {
    for (const file of files) {
      if (!tracked.has(file)) { problems.push(`gotcha ${n}: ${file} is not a tracked file`); continue; }
      const text = await readFile(new URL(file, ROOT), "utf8");
      if (!new RegExp(`gotchas? +#?${n}\\b`, "i").test(text)) problems.push(`gotcha ${n}: ${file} never says "gotcha ${n}"`);
    }
  }
  assert.deepEqual(problems, []);
});
