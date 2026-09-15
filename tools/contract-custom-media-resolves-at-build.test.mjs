// ── @custom-media resolves at build, for every stylesheet, and fails by name ─
// Split-file convention: shared imports live in contract-shared.ts.
import { readFileSync } from "node:fs";
import {
  assert,
  ROOT,
  test,
} from "./contract-shared.ts";
import { parseCss } from "./lib/css-parse.ts";

// No browser implements @custom-media (cssdb 8.11: zero engines), so the
// definitions in src/styles/custom-media.css exist only if tools/lib/css-parse.ts
// expands them. That module is the ONE parser every served stylesheet goes
// through (luna.css, the four first-interaction sheets, every inline <style>,
// the Worker's /*min*/ literals, and check-page-contracts' scaffold check), so
// proving it here proves it for all of them. Three claims, each with the
// failure it is written against:
//
//   1. every declared name expands to its query, in the minified AND the
//      unminified path, because a name that survived to the wire is a media
//      query no engine will ever match and the rule behind it is dead;
//   2. an unused definition ships NOTHING, which is what lets the file ride on
//      every stylesheet for free;
//   3. a name nothing defines FAILS, by name, rather than passing through.

const DEFS_PATH = new URL("src/styles/custom-media.css", ROOT);
const defs = readFileSync(DEFS_PATH, "utf8");
const declared = [...defs.matchAll(/^@custom-media\s+(--[a-z0-9-]+)\s+([^;]+);/gm)].map((m) => [m[1], m[2].trim()]);

test("the definitions file declares at least the names the tree repeats, once each", () => {
  const names = declared.map(([n]) => n);
  assert.ok(names.length >= 5, `only ${names.length} @custom-media definitions; the file was emptied or the matcher stopped matching`);
  assert.deepEqual(names, [...new Set(names)], "a name declared twice is ambiguous (last one wins, silently)");
  for (const n of ["--p3", "--reduced-motion", "--coarse", "--forced-colors"]) {
    assert.ok(names.includes(n), `${n} is the alias this test's fixtures use; renaming it means renaming them`);
  }
});

test("every declared name expands to its query, minified or not", () => {
  for (const [name, query] of declared) {
    for (const minify of [true, false]) {
      const out = parseCss("fixture.css", `@media (${name}) { .a { color: red } }`, { minify });
      assert.ok(!out.includes(name), `${name} survived to the output (minify=${minify}): ${out}`);
      assert.ok(!out.includes("@custom-media"), `the definition itself shipped (minify=${minify}): ${out}`);
      // Lightning normalises the query on the way through (`(max-width: 520px)`
      // becomes `(width<=520px)` under minify), so the assertion is on the
      // feature NAME the query carries, which survives either spelling.
      const m = /\(\s*([a-z-]+)/.exec(query);
      assert.ok(m, `${name}'s query ${query} names no media feature`);
      const feature = m[1].replace(/^(min|max)-/, "");
      assert.ok(out.includes(feature), `${name} did not expand to a query naming ${feature}: ${out}`);
    }
  }
});

test("a custom media query composes with a plain one and with `not`", () => {
  const out = parseCss("fixture.css", `@media (--coarse) and (--p3) { .a { color: red } } @media not (--reduced-motion) { .b { color: blue } }`, { minify: true });
  assert.match(out, /@media \(hover:none\) and \(color-gamut:p3\)\{\.a\{color:red\}\}/, out);
  assert.match(out, /@media not \(prefers-reduced-motion:reduce\)\{\.b\{color:#00f\}\}/, out);
});

test("a stylesheet that uses no custom media ships not one byte of the definitions", () => {
  const out = parseCss("fixture.css", `.a { color: red }`, { minify: true });
  assert.equal(out, ".a{color:red}");
});

test("a name nothing defines fails the parse by name, rather than shipping a query no engine matches", () => {
  assert.throws(
    () => parseCss("fixture.css", `@media (--definitely-not-defined) { .a { color: red } }`, { minify: true }),
    /--definitely-not-defined/,
  );
});

test("the append leaves the caller's line numbers alone", () => {
  // A parse error on line 3 of the caller's CSS must report line 3, which is
  // why the definitions are appended rather than prepended. A prepend would
  // shift every reported line by the length of the definitions file.
  let err;
  try { parseCss("fixture.css", `.a { color: red }\n.b { color: blue }\n}\n.c { d: 1 }`, { minify: true }); } catch (e) { err = e; }
  assert.ok(err, "a stray close brace must throw");
  assert.equal(err.loc?.line, 3, `expected the error on the caller's line 3, got ${JSON.stringify(err.loc)}`);
});

test("a block left open at end-of-input is reported as that, not as five unknown at-rules", () => {
  // Lightning recovers an unclosed block by closing it at EOF, which used to
  // parse clean. With the definitions appended, EOF is now inside the caller's
  // block and every definition reads as a nested unknown at-rule. The append
  // turns a silent authoring bug into a failure, and parseCss names the bug
  // rather than the symptom.
  assert.throws(
    () => parseCss("fixture.css", `.a { color: red }\n.c { d: 1 `, { minify: true }),
    /never closed/,
  );
});
