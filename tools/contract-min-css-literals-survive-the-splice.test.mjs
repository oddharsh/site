// ── a /*min*/ CSS literal means at runtime what Lightning CSS wrote ─────────
// Split-file convention: shared imports live in contract-shared.ts.
import { readdir, readFile } from "node:fs/promises";
import {
  assert,
  ROOT,
  test,
} from "./contract-shared.ts";
import { parseCss } from "./lib/css-parse.ts";
import { cookTemplate, MIN_LITERAL, spliceMinLiterals, toTemplateRaw } from "./lib/css-literal.ts";

// build.ts step 5 lifts each /*min*/ template literal out of a Worker module,
// minifies it, and splices it back. A template literal is JS source, so a
// backslash in it means one thing to the engine and another to Lightning CSS.
// The pass lost escapes at both ends until 2026-10-09 (tools/lib/css-literal.ts
// has the two failures), and the Worker shipped `n.tool-out` for `.tool-out`.
//
// The claim: evaluating the spliced literal yields Lightning's output byte for
// byte, and Lightning saw the literal's runtime value. Each case below is one
// a naive splice gets wrong, and the controls prove this test can tell.

const minify = (css) => parseCss("fixture.css", css, { minify: true });
// The engine's own reading of a template literal, independent of the module's.
const evaluate = (literal) => new Function(`return ${literal};`)();

// Module source as the pass reads it off disk. String.raw keeps every JS
// escape as written: `\n` is a JS newline, `\\2014` is the CSS escape \2014,
// `\\:` is CSS's escaped colon, and \` and $\{ cook to a backtick and "${".
const FIXTURE = String.raw`export const css = ` + "`" + String.raw`/*min*/\n.tool-out { margin: 0 }
form[action="/run"] { color: red }
.a\\:b { color: blue }
p::before { content: "\\2014" }
q::after { content: "\`$\{" }` + "`;\n";

test("the cooker reads every escape class the way the engine does", () => {
  // css-literal.ts cooks by hand (lint refuses implied eval in .ts); the engine
  // is the oracle. One raw string per escape class, then all of them at once.
  const cases = [
    String.raw`\n\t\b\v\f\r`, String.raw`\0 and \0a`, String.raw`\x41é\u{1F600}😀`,
    String.raw`\\ \` \$ \{ \/ \: \q`, "line\\\ncontinued", "crlf\r\nand bare\rcr", "ls\\\u2028ps\\\u2029",
    String.raw`content:"\\2014" .a\\:b`,
  ];
  for (const raw of [...cases, cases.join("")]) {
    assert.equal(cookTemplate(raw), evaluate("`" + raw + "`"), `cooked ${JSON.stringify(raw)} differently`);
    assert.equal(cookTemplate(toTemplateRaw(evaluate("`" + raw + "`"))), evaluate("`" + raw + "`"), "toTemplateRaw does not invert the cooker");
  }
  for (const bad of [String.raw`\1`, String.raw`\07`, String.raw`\xZ`, String.raw`\u12`]) {
    assert.throws(() => evaluate("`" + bad + "`"), SyntaxError, `the engine accepted ${bad}; this case is stale`);
    assert.throws(() => cookTemplate(bad), /cannot hold/, `the cooker accepted ${bad}`);
  }
});

test("a spliced literal evaluates to exactly what Lightning CSS wrote", () => {
  const { out, literals } = spliceMinLiterals("fixture.ts", FIXTURE, minify);
  assert.equal(literals.length, 1, `the fixture literal was not matched: ${FIXTURE}`);
  const [{ source, cooked, min, spliced }] = literals;
  assert.equal(cooked, evaluate(source), "the pass misread the literal's runtime value");
  assert.equal(min, minify(cooked), "the pass did not minify the literal's runtime value");
  assert.equal(evaluate(spliced), min, `the splice changed the CSS: ${spliced}`);
  assert.ok(out.includes(spliced), "the spliced literal is not what the module now carries");

  // Each fixture line exercises one escape; pin that Lightning still emits it,
  // or a future Lightning that stops writing \/ would let this test go blind.
  assert.ok(min.startsWith(".tool-out{"), `a JS \\n became a CSS escape: ${min}`);
  for (const piece of ["form[action=\\/run]", ".a\\:b", '"—"', '"`${"']) {
    assert.ok(min.includes(piece), `Lightning no longer writes ${piece}, so this case tests nothing: ${min}`);
  }
});

test("control: the old splice, raw in and unescaped out, fails both ways", () => {
  const raw = MIN_LITERAL.exec(FIXTURE)?.[1];
  MIN_LITERAL.lastIndex = 0;
  assert.ok(raw, "fixture literal not matched");
  const [{ min }] = spliceMinLiterals("fixture.ts", FIXTURE, minify).literals;
  assert.notEqual(minify(raw), min, "minifying raw source text should differ; the input case is not exercised");
  let naive;
  try { naive = evaluate("`" + min + "`"); } catch { naive = undefined; }
  assert.notEqual(naive, min, "an unescaped splice round-tripped; the output case is not exercised");
  // The reported failure on its own: \/ cooks to "/", leaving invalid CSS.
  assert.equal(evaluate("`" + "form[action=\\/run]{color:red}" + "`"), "form[action=/run]{color:red}");
  assert.throws(() => minify("form[action=/run]{color:red}"), /attribute selector/);
});

test("every /*min*/ literal in the Worker trees survives the splice", async () => {
  // The three trees build.ts step 5 walks.
  const roots = ["src/worker", "cal/src", "serendipity"];
  let count = 0;
  const changedByCooking = [];
  for (const dir of roots) {
    for (const rel of await readdir(new URL(dir, ROOT), { recursive: true })) {
      if (!rel.endsWith(".ts") && !rel.endsWith(".js")) continue;
      const path = `${dir}/${rel}`;
      const src = await readFile(new URL(path, ROOT), "utf8");
      for (const l of spliceMinLiterals(path, src, minify).literals) {
        count++;
        assert.equal(l.cooked, evaluate(l.source), `${path}: the pass misread the literal`);
        assert.equal(evaluate(l.spliced), l.min, `${path}: the splice changed the CSS`);
        if (l.source.slice(1, -1) !== l.cooked) changedByCooking.push(path);
      }
    }
  }
  // build.ts floors these at 19 + 3 + 1; a matcher that went blind passes vacuously.
  assert.ok(count >= 23, `only ${count} /*min*/ literals found; did the sentinel or the walk change?`);
  // terminal.ts's literal opens with a JS \n, the one tree literal whose value
  // differs from its text today. If this list moves, read the new entry.
  assert.deepEqual(changedByCooking, ["src/worker/terminal.ts"]);
});
