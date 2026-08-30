// ── D1 exec() is handed one-line statements only ─────────────────────────────
// Split-file suite; shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// D1's exec() SPLITS ITS INPUT ON NEWLINES and runs each line as its own
// statement, so a multi-line statement cannot survive it. around.ts handed it a
// multi-line CREATE TABLE plus two CREATE INDEXes and the whole thing died on
// line 1 with `incomplete input`, so `around_crawl_history` was never created in
// production. persistAroundHistory catches everything, so what shipped was ten
// days of daily crawls writing zero history rows while /around/changes.json
// said "change history starts with the next scheduled crawl".
//
// THE SAME WORKER CARRIES THE CONTROL, which is what makes this rule worth
// pinning rather than a one-off repair: census.ts's ensureCensusTable() passes
// exec() a SINGLE-LINE CREATE TABLE, and `lens_census` exists in production.
// Two calls to one API in one Worker, differing only in newlines, one working
// and one not.
//
// WHY THIS IS ASSERTED ON THE SOURCE. The behavioural version cannot see the
// bug: contract-shared's fakeD1 normalises whitespace (`sql.replace(/\s+/g,
// " ")`) and answers any `^CREATE` with a success, so the broken DDL passes
// against it. A check that can only agree with itself is decoration, and this
// is the shape that has teeth from a suite running outside workerd.

/** Worker source this repository owns, from `git ls-files` rather than a walk,
 *  so a vendored tree cannot wander into scope. */
function workerSources() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "src/worker/*", "cal/src/*", "serendipity/*"],
    { cwd: new URL(".", ROOT), encoding: "utf8" },
  );
  return out
    .split("\0")
    .filter((rel) => /\.(ts|js|mjs)$/.test(rel))
    .map((rel) => ({ rel, url: new URL(rel, new URL(".", ROOT)) }));
}

/** The string or template literal starting at `i`, or null if what starts there
 *  is not a literal (an identifier, a call, a variable — all of which this check
 *  has nothing to say about, and which is also how `RegExp.prototype.exec(line)`
 *  stays out of scope without a receiver heuristic). */
function literalAt(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") { j++; continue; }
    if (source[j] === quote) return source.slice(i, j + 1);
  }
  return null;
}

/** Every `.exec(` call site whose FIRST argument is a literal, as
 *  `{ index, literal }`. The argument is read past leading whitespace, so the
 *  newlines a formatter puts between `exec(` and its argument are not mistaken
 *  for newlines inside the statement. */
function execLiteralArgs(source) {
  const found = [];
  for (const m of source.matchAll(/\.exec\(/g)) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i])) i++;
    const literal = literalAt(source, i);
    if (literal) found.push({ index: m.index, literal });
  }
  return found;
}

test("D1 exec() call sites pass a single-line statement", async () => {
  const files = workerSources();

  // FLOOR. A scanner that matches nothing reports a pass, which is the failure
  // this repository has shipped more than once.
  assert.ok(files.length >= 80, `found only ${files.length} worker sources; the enumerator is broken`);

  const offenders = [];
  let literals = 0;
  for (const { rel, url } of files) {
    for (const { literal } of execLiteralArgs(await readFile(url, "utf8"))) {
      literals++;
      if (literal.includes("\n")) offenders.push(`${rel}: ${literal.split("\n")[0].trim()} …`);
    }
  }

  // SECOND FLOOR, on what the scanner actually reached. The file count above
  // proves the enumerator works and says nothing about the matcher; census.ts's
  // single-line ensureCensusTable() is the live call site that must keep being
  // seen, so a matcher that stops finding argument literals fails here instead
  // of reporting a clean pass over zero of them.
  assert.ok(literals >= 1, "the matcher found no exec() literal arguments at all; it is broken");

  assert.deepEqual(
    offenders,
    [],
    `D1 exec() splits on newlines, so these statements cannot run; use prepare().run() or batch():\n  ${offenders.join("\n  ")}`,
  );
});

test("the multi-line matcher fails the shape that shipped", () => {
  // The control, because a check that has never gone red is decoration. This is
  // the DDL string around.ts passed to exec(), reduced; the matcher must call it
  // out, and must leave the single-line form alone.
  const broken = 'await env.RESTORE_DB.exec(\n  `CREATE TABLE IF NOT EXISTS t (\n    a TEXT\n  )`\n);';
  const fixed = 'await env.RESTORE_DB.exec("CREATE TABLE IF NOT EXISTS t (a TEXT)");';
  const byName = 'const m = /^(a)$/.exec(line);';

  assert.equal(execLiteralArgs(broken).length, 1, "the broken form is one literal argument");
  assert.ok(execLiteralArgs(broken)[0].literal.includes("\n"), "and it must be flagged");
  assert.equal(execLiteralArgs(fixed).length, 1, "the fixed form is one literal argument");
  assert.ok(!execLiteralArgs(fixed)[0].literal.includes("\n"), "and it must pass");
  assert.equal(execLiteralArgs(byName).length, 0, "RegExp.exec(identifier) carries no literal and is out of scope");
});

test("the around history DDL is a list of complete statements", async () => {
  // The repair itself, pinned from the other direction: exec() is the API that
  // cannot take these, and the reason they are safe now is that each element is
  // a whole statement rather than a fragment of one. A future edit that merges
  // them back into a single string fails here as well as above.
  const src = await readFile(new URL("../src/worker/around.ts", import.meta.url), "utf8");

  assert.ok(
    /await db\.batch\(/.test(src),
    "persistAroundHistory must reach D1 through batch(), not exec()",
  );

  const block = /const AROUND_HISTORY_DDL = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, "AROUND_HISTORY_DDL must be a literal array the check can read");

  const statements = [...block[1].matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  assert.equal(statements.length, 3, "one CREATE TABLE and two CREATE INDEXes");

  for (const sql of statements) {
    const open = (sql.match(/\(/g) || []).length;
    const close = (sql.match(/\)/g) || []).length;
    assert.equal(open, close, `unbalanced parentheses, so this is a fragment rather than a statement:\n${sql}`);
    assert.ok(/^\s*CREATE (TABLE|INDEX) IF NOT EXISTS /.test(sql), `not an idempotent CREATE:\n${sql}`);
    assert.ok(!sql.includes(";"), `statements are separated by the array, never by a semicolon:\n${sql}`);
  }
});
