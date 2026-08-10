// The BEHAVIOURAL half of the Reader lens's tests. It lives here rather than in
// the root contract-tests.mjs because it imports ../src/reader.js, which imports
// defuddle, linkedom and turndown — dependencies of THIS project alone. The root
// suite runs under plain node with the root workspace's deps, so importing this
// module there fails with ERR_MODULE_NOT_FOUND in CI while passing on a
// workstation that happened to install them (caught on PR #299's first run).
//
// The split by capability:
//   root contract-tests.mjs — everything provable from SOURCE TEXT: the rate
//     limit against wrangler.toml, the shared SSRF guard, the turndown call
//     shape, the dropped tally, the tab labels.
//   here — everything that has to actually RUN.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { countControls, countWords, shape, toMarkdown } from "../src/reader.js";

test("markdown conversion runs at all, which is the part node can prove", () => {
  // The trap is that turndown ships two builds: node falls back to domino and
  // takes an HTML string, the browser build needs document.implementation, and
  // wrangler resolves the BROWSER one. So this test CANNOT reproduce the Worker
  // failure — under node the broken form works too. The call shape is pinned in
  // the root suite; what this settles is that the node path produces the right
  // markdown, so a defuddle or turndown bump that changes output fails here.
  const md = toMarkdown("<h2>Title</h2><p>Body <strong>text</strong>.</p>");
  assert.match(md, /^## Title/m);
  assert.match(md, /\*\*text\*\*/);
});

test("script and style bodies never reach the markdown", () => {
  // Same rule the Markdown twins enforce: a converter that walks into script
  // bodies publishes things that are not prose. Here it is a third party's
  // script rather than our own answer key, which is no better.
  const md = toMarkdown('<p>Real prose.</p><script>alert("bad")</script><style>.x{color:red}</style>');
  assert.match(md, /Real prose/);
  assert.doesNotMatch(md, /alert/);
  assert.doesNotMatch(md, /color:red/);
});

test("both word counts come from one function, so the gap is extraction", () => {
  // The load-bearing property of the whole lens. If `source` and `kept` were
  // counted differently the reported drop would be two definitions of "word"
  // disagreeing, which is the failure gotcha 24 names: a number that cannot be
  // wrong because nothing independent produced it.
  const html = "<html><body><p>one two three four five</p></body></html>";
  assert.equal(shape(html).words, 5);
  assert.equal(countWords("one two three four five"), 5);
  // and the body extractor must not count markup as words
  assert.equal(shape("<html><body><p><b>a</b> <i>b</i></p></body></html>").words, 2);
});

test("control counting is an upper bound and never a silent overcount", () => {
  const { document } = parseHTML('<html><body><button>Run all three</button><button>Close</button></body></html>');
  // "Close" also appears as ordinary prose, which is precisely why the payload
  // labels this an upper bound instead of reporting it as fact.
  const counted = countControls(document, "<p>Run all three now. Then close the window.</p>");
  assert.equal(counted.total, 2);
  assert.ok(counted.kept >= 1);
  assert.match(counted.note, /upper bound/);
});
