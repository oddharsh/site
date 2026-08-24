// The survey's word count is the number /garage/useragent publishes, so the
// thing that removes <script> and <style> before counting has to be right.
// CodeQL flagged the original regex twice, in successive runs, with a different
// end-tag shape each time: `</script >` and then `</script\t\n bar>`. HTML lets
// an end tag carry whitespace and junk before the bracket, and a missed close
// leaves the script body to be counted as prose.
//
// This tests BEHAVIOUR through a real import rather than reading the source for
// a pattern, because a source-text assertion would have passed on every broken
// version of this function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { words } from "./ua-survey.ts";

test("raw-text elements are stripped whatever shape their end tag takes", () => {
  /** @type {[string, string, number][]} */
  const cases = [
    ["plain close",            '<p>keep</p><script>LEAK one two</script>tail', 2],
    ["space before bracket",   '<p>keep</p><script>LEAK one two</script >tail', 2],
    ["whitespace then junk",   '<p>keep</p><script>LEAK one two</script\t\n bar>tail', 2],
    ["solidus close",          '<p>keep</p><script>LEAK one two</script/>tail', 2],
    ["attributes on the open", '<p>keep</p><script type="x" defer>LEAK one two</script>tail', 2],
    ["style as well",          '<p>keep</p><style>a{b:c} LEAK</style >tail', 2],
    ["two in a row",           '<p>keep</p><script>LEAK</script><script>LEAK2</script>tail', 2],
    // An unterminated raw-text element runs to end of document by the parser's
    // own rule, so everything after it is gone rather than counted.
    ["unterminated",           '<p>keep</p><script>LEAK runs to the end', 1],
  ];
  for (const [name, html, expected] of cases) {
    assert.equal(words(html), expected, name);
  }
});

test("a tag that merely starts with the name is not a close", () => {
  // `</scriptfoo>` closes an element called scriptfoo, so treating it as a
  // script close would swallow real prose and quietly shrink a word count.
  assert.equal(words('<p>keep</p><scriptfoo>two words</scriptfoo>tail'), 4);
});

test("the count is prose, so markup and attribute values never reach it", () => {
  assert.equal(words('<div class="a b c" data-x="one two">three four</div>'), 2);
});
