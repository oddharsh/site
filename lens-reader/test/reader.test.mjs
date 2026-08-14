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
import { countControls, countWords, scoreExtraction, shape, toMarkdown } from "../src/reader.js";

test("markdown conversion runs at all, which is the part node can prove", () => {
  // The trap is that turndown ships two builds: node falls back to domino and
  // takes an HTML string, the browser build needs document.implementation, and
  // wrangler resolves the BROWSER one. So this test CANNOT reproduce the Worker
  // failure — under node the broken form works too. The call shape is pinned in
  // the root suite; what this settles is that the node path produces the right
  // markdown, so a turndown bump that changes output fails here.
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

test("content recovery is four transparent checks over Readability output", () => {
  const score = scoreExtraction({
    source: { words: 300 }, kept: { words: 180 },
    controls: { total: 8, kept: 1 }, title: "A readable article", markdown: "# A readable article\n\nBody",
  });
  assert.equal(score.overall, 100);
  assert.equal(score.counted, 4);
  assert.equal(score.passed, 4);
  assert.deepEqual(score.checks.map((check) => check.key), ["body", "title", "controls", "markdown"]);
  assert.match(score.scoringNote, /Readability itself does not publish this score/);
});

test("control leakage and an empty title reduce recovery without inventing partial credit", () => {
  const score = scoreExtraction({
    source: { words: 120 }, kept: { words: 80 },
    controls: { total: 4, kept: 3 }, title: "", markdown: "Body",
  });
  assert.equal(score.overall, 50);
  assert.deepEqual(score.checks.map((check) => check.pass), [true, false, false, true]);
});

test("only messages written for the visitor are publishable", async () => {
  const { ReaderError } = await import("../src/reader.js");
  const entry = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8"));
  // CodeQL flagged the old blanket `String(error.message)` return as information
  // exposure through a stack trace. The fix is a marker class, so the guard is
  // that the entrypoint gates on it and never falls back to raw message text.
  assert.ok(new ReaderError("x").visitorFacing, "ReaderError must mark itself visitor-facing");
  assert.match(entry, /error instanceof ReaderError/,
    "the entrypoint must gate published messages on ReaderError");
  assert.doesNotMatch(entry, /String\(\(?error(\s*&&\s*error)?\.message/,
    "the entrypoint must never publish a raw error message again");
});

test("the extractor actually extracts, which no other test here proved", async () => {
  // Every test above this line exercises a helper in isolation, so the whole
  // suite stayed green through an extractor swap that could have been totally
  // broken. That is the same "a check that can only agree with itself is
  // decoration" failure CLAUDE.md records twice. This one runs the real engine
  // over a fixture and asserts it found the article and dropped the chrome.
  //
  // It is deliberately OFFLINE: `read()` fetches, and a test that needs the
  // network is a test that fails for reasons that are not about this code.
  const { Readability } = await import("@mozilla/readability");
  const { parseHTML } = await import("linkedom");
  const html = `<!doctype html><html><head><title>The Real Article</title></head><body>
    <nav><a href="/x">Home</a><a href="/y">About</a></nav>
    <article><h1>The Real Article</h1>
      ${"<p>This is a sentence of genuine body prose that the extractor should keep.</p>".repeat(12)}
    </article>
    <aside><button>Subscribe now</button><p>Advert copy nobody wants.</p></aside>
  </body></html>`;

  const result = new Readability(parseHTML(html).document, { charThreshold: 500 }).parse();
  assert.ok(result, "extractor returned nothing at all");
  // Readability takes the title from <title>, not <h1>, so the fixture agrees
  // on both rather than pinning which source wins.
  assert.match(result.title, /The Real Article/);
  assert.match(result.content, /genuine body prose/);
  assert.doesNotMatch(result.content, /Advert copy/, "the aside survived extraction");
  assert.doesNotMatch(result.content, /Subscribe now/, "a control label survived as prose");
});

test("the control census reads an untouched parse, not the extractor's leftovers", async () => {
  // Readability REWRITES the document it is handed, in place. read() therefore
  // parses twice on purpose. Fold those back into one parse to save a few ms
  // and countControls runs over the post-extraction corpse, reporting every
  // page as leaking zero controls, which reads as a clean bill of health.
  //
  // Measured on the real /garage/horizon 2026-08-14: body 217,022 -> 2,473
  // bytes and 29 <button> elements -> 0. The fixture below is sized to
  // reproduce that stripping; a handful of paragraphs will not, which is how
  // an earlier version of this test passed while asserting the opposite.
  const { Readability } = await import("@mozilla/readability");
  const { parseHTML } = await import("linkedom");
  const html = `<!doctype html><html><body><article><h1>Real Article</h1>
      ${"<p>Body prose long enough to clear the character threshold and win the scoring pass.</p>".repeat(40)}
    </article><aside><button>Buy the thing</button>
      ${"<p>Sidebar filler that should lose.</p>".repeat(10)}
    </aside></body></html>`;

  const { document: census } = parseHTML(html);
  const { document: working } = parseHTML(html);
  const beforeBytes = working.body.innerHTML.length;
  new Readability(working, { charThreshold: 500 }).parse();

  assert.equal(census.querySelectorAll("button").length, 1, "the untouched parse lost its button");
  assert.ok(working.body.innerHTML.length < beforeBytes / 2,
    "Readability left the working document intact, so read()'s two parses are now pointless");
});
