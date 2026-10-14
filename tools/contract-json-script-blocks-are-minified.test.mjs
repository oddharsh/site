// The JSON arm of the inline transform (tools/lib/json-script.ts) strips the
// whitespace out of every data `<script>` on the site, and the one way it can be
// WRONG is inside a script element rather than inside JSON: the round trip
// unescapes `\/` and `<`, and a string that comes back holding `</script`
// ends the element early. Behaviour through a real import, with the guard
// exercised on the shape that would truncate a page, plus one source assertion
// that build.ts still routes the JSON types through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isJsonScriptType, minifyJsonScript } from "./lib/json-script.ts";

test("every JSON script type the tree ships is recognised, and JavaScript is not", () => {
  for (const t of ["application/json", "application/ld+json", "speculationrules", "importmap", "Application/LD+JSON"]) {
    assert.ok(isJsonScriptType(t), t);
  }
  for (const t of ["", "module", "text/javascript", "application/javascript", "text/plain"]) {
    assert.ok(!isJsonScriptType(t), t || "(bare)");
  }
});

test("whitespace outside strings goes, whitespace inside strings stays, values survive", () => {
  const body = '\n  {\n    "why": "two  spaces\\tand a tab",\n    "ok": [ 1, 2.50, true, null ],\n    "n": { "a": "b" }\n  }\n';
  const out = minifyJsonScript("probe", body);
  assert.equal(out, '{"why":"two  spaces\\tand a tab","ok":[1,2.50,true,null],"n":{"a":"b"}}');
  assert.deepEqual(JSON.parse(out), JSON.parse(body));
});

test("a number reaches the output exactly as it was authored", () => {
  const body = '{"id": 9007199254740993, "wei": 1000000000000000000001, "t": 1.7000000000000002e9, "z": -0}';
  const out = minifyJsonScript("probe", body);
  for (const literal of ["9007199254740993", "1000000000000000000001", "1.7000000000000002e9", "-0"]) {
    assert.ok(out.includes(literal), `${literal} survived: ${out}`);
  }
  const precision = '{"id": 9007199254740993}';
  const naive = JSON.stringify(JSON.parse(precision));
  assert.ok(!naive.includes("9007199254740993"), `control: naive round trip renumbers it (${naive})`);
  assert.deepEqual(JSON.parse(naive), JSON.parse(precision), "control: the value comparison cannot see the loss");
});

test("a string that would end the script element is re-escaped, and the value is unchanged", () => {
  const body = '{"html": "<\\/script><script>alert(1)<\\/script>", "c": "<!-- x -->"}';
  const out = minifyJsonScript("probe", body);
  assert.ok(!/<\/script/i.test(out), "no live close tag: " + out);
  assert.ok(!out.includes("<!--"), "no comment opener: " + out);
  assert.deepEqual(JSON.parse(out), JSON.parse(body), "the escape is invisible to the consumer");
  assert.ok(JSON.stringify(JSON.parse(body)).includes("</script>"), "control: naive round trip un-escapes the close tag");
});

test("a body that is not JSON fails the build by label rather than shipping as-is", () => {
  assert.throws(() => minifyJsonScript("src/pages/x.html inline <script type=application/json>", '{"a": 1,}'), /src\/pages\/x\.html.*does not parse/);
});

test("build.ts routes the JSON script types through the shared module", async () => {
  const build = await readFile(new URL("./build.ts", import.meta.url), "utf8");
  assert.match(build, /import \{ isJsonScriptType, minifyJsonScript \} from "\.\/lib\/json-script\.ts"/);
  assert.match(build, /isJsonScriptType\(scriptType\(token\)\)/, "the inline transform asks the module which types are JSON");
  assert.match(build, /minifyJsonScript\(`\$\{label\} inline <script type=\$\{scriptType\(token\)\}>`, body\)/);
  assert.match(build, /<script type="application\/ld\+json">\{"x":1\}<\/script>/);
});
