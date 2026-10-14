// ── D1 exec() is handed one-line statements only ─────────────────────────────
// Split-file suite; shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

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

function literalAt(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") { j++; continue; }
    if (source[j] === quote) return source.slice(i, j + 1);
  }
  return null;
}

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

  assert.ok(files.length >= 80, `found only ${files.length} worker sources; the enumerator is broken`);

  const offenders = [];
  let literals = 0;
  for (const { rel, url } of files) {
    for (const { literal } of execLiteralArgs(await readFile(url, "utf8"))) {
      literals++;
      if (literal.includes("\n")) offenders.push(`${rel}: ${literal.split("\n")[0].trim()} …`);
    }
  }

  assert.ok(literals >= 1, "the matcher found no exec() literal arguments at all; it is broken");

  assert.deepEqual(
    offenders,
    [],
    `D1 exec() splits on newlines, so these statements cannot run; use prepare().run() or batch():\n  ${offenders.join("\n  ")}`,
  );
});

test("the multi-line matcher fails the shape that shipped", () => {
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
