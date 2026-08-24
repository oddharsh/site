// The BEHAVIOURAL half of the Reader lens's tests. It lives here rather than in
// the root contract-tests.mjs because it imports ../src/reader.ts, which imports
// readability and linkedom — dependencies of THIS project alone. The root
// suite runs under plain node with the root workspace's deps, so importing this
// module there fails with ERR_MODULE_NOT_FOUND in CI while passing on a
// workstation that happened to install them (caught on PR #299's first run).
//
// The split by capability:
//   root contract-tests.mjs — everything provable from SOURCE TEXT: the rate
//     limit against wrangler.toml, the shared SSRF guard, the dependency floor,
//     the dropped tally, the tab labels.
//   here — everything that has to actually RUN.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseHTML as parseLinkedom } from "linkedom";
import { parseHTML } from "../src/dom.ts";
import { collectControlLabels, countControls, countWords, read, scoreExtraction, tally, toMarkdown } from "../src/reader.ts";

// The override's REASON changed on 2026-08-23 and the assertion outlived it, so
// this now says what it is for today. The Worker no longer bundles linkedom, so
// the override buys no shipped bytes at all. What it buys is that the parity
// oracle in dom-differential.test.mjs resolves the SAME parser the Worker
// bundles, and a gate whose reference parses differently proves nothing.
test("the oracle and the Worker resolve one parser generation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const parser = JSON.parse(readFileSync(new URL("../node_modules/htmlparser2/package.json", import.meta.url), "utf8"));

  assert.equal(manifest.dependencies?.htmlparser2, "11.0.0",
    "src/dom.ts parses with htmlparser2 directly, so it must be a declared dependency rather than linkedom's transitive");
  assert.equal(manifest.devDependencies?.linkedom, "0.18.13",
    "linkedom is the parity oracle; deleting it deletes the only proof src/dom.ts is faithful");
  assert.equal(manifest.overrides?.htmlparser2, "11.0.0",
    "without the override the oracle resolves a different parser than the Worker bundles");
  assert.equal(parser.version, "11.0.0", "the installed parser must honor the measured override");
  assert.equal(
    existsSync(new URL("../node_modules/htmlparser2/node_modules/domutils/package.json", import.meta.url)),
    false,
    "htmlparser2 should share one domutils generation rather than carrying another tree",
  );
});

// Was asserted against linkedom, which is no longer what ships. It runs on the
// fitted DOM now and checks the oracle agrees, so the property is pinned on the
// product first and the reference second.
test("the aligned parser preserves self-closing script serialization", () => {
  const source = '<html><script src="./main.js" type="module"/></html>';
  const expected = '<script src="./main.js" type="module"></script>';
  const shipped = parseHTML(source).document.documentElement.firstElementChild;
  assert.equal(shipped?.outerHTML, expected,
    "htmlparser2 v12's raw-text parsing leaves the document close inside the script");
  assert.equal(parseLinkedom(source).document.documentElement.firstElementChild?.toString(), expected,
    "the oracle must agree, or the parity gate is measuring against a different parser");
});

test("the focused Markdown walk covers the article vocabulary", () => {
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

test("the focused walk preserves links, code, nested lists, and unknown wrappers", () => {
  const md = toMarkdown(`<article data-new-wrapper><h2>Title</h2>
    <p>Body <em>voice</em>, <a href="/notes" title="Notes">a link</a>, and <code>a\`b</code>.</p>
    <ul><li>One</li><li>Two<ol start="3"><li>Three</li></ol></li></ul>
    <blockquote><p>Quoted.</p></blockquote>
    <pre><code class="language-js">const answer = 42;</code></pre>
    <img src="/x.jpg" alt="Example"><future-article-element>Future prose.</future-article-element></article>`);
  assert.match(md, /^## Title/m);
  assert.match(md, /Body \*voice\*, \[a link\]\(\/notes "Notes"\), and `` a`b ``\./);
  assert.match(md, /^- Two\n\s+3\. Three/m, "the nested ordered list must stay nested");
  assert.match(md, /^> Quoted\.$/m);
  assert.match(md, /```js\nconst answer = 42;\n```/);
  assert.match(md, /!\[Example\]\(\/x\.jpg\)/);
  assert.match(md, /Future prose\./, "an unknown semantic wrapper must keep its prose");
});

test("the extracted article node preserves the string path byte for byte", () => {
  const html = `<article><h2>Title</h2><p>Body <strong>text</strong> and
    <a href="/notes">a link</a>.</p><ul><li>One</li><li>Two</li></ul>
    <pre><code>const answer = 42;</code></pre></article>`;
  const { document } = parseHTML(html);
  const node = document.querySelector("article");
  assert.equal(toMarkdown(node), toMarkdown(node.outerHTML));
});

test("read publishes Markdown from Readability's finished article node", async () => {
  const originalFetch = globalThis.fetch;
  const html = `<!doctype html><html><head><title>Direct Article</title></head><body>
    <nav>Navigation that should lose.</nav><article><h1>Direct Article</h1>
    ${"<p>Article prose with <strong>structure</strong> that the extractor should retain.</p>".repeat(12)}
    </article></body></html>`;
  try {
    // The cast is the stub's honesty note. node's `fetch` carries a `preconnect`
    // property this one does not, and `read()` never calls it, so the two do not
    // overlap enough for a direct assertion and the hop through `unknown` is what
    // TypeScript asks for. Widening the stub to satisfy the type would be adding
    // a method to a test double for the compiler's benefit.
    globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (
      async () => new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));
    const result = await read("https://example.com/article");
    const baseline = new (await import("@mozilla/readability")).Readability(
      parseHTML(html).document,
      { charThreshold: 500 },
    ).parse();
    assert.equal(result.title, "Direct Article");
    assert.equal(result.markdown, toMarkdown(baseline.content));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("both word counts come from one function, so the gap is extraction", () => {
  // The load-bearing property of the whole lens. If `source` and `kept` were
  // counted differently the reported drop would be two definitions of "word"
  // disagreeing, which is the failure gotcha 24 names: a number that cannot be
  // wrong because nothing independent produced it.
  const html = "<html><body><p>one two three four five</p></body></html>";
  assert.equal(tally(html).words, 5);
  assert.equal(countWords("one two three four five"), 5);
  // and the body extractor must not count markup as words
  assert.equal(tally("<html><body><p><b>a</b> <i>b</i></p></body></html>").words, 2);
});

test("control counting is an upper bound and never a silent overcount", () => {
  const { document } = parseHTML('<html><body><button>Run all three</button><button>Close</button></body></html>');
  // "Close" also appears as ordinary prose, which is precisely why the payload
  // labels this an upper bound instead of reporting it as fact.
  const counted = countControls(collectControlLabels(document), "<p>Run all three now. Then close the window.</p>");
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
  const { ReaderError } = await import("../src/reader.ts");
  const entry = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
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

test("the control census survives Readability mutation without a second DOM", async () => {
  // Readability REWRITES the document it is handed, in place. Snapshotting the
  // labels before extraction must preserve the census after the source nodes
  // disappear, without retaining a second complete hostile-HTML tree.
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

  const { document } = parseHTML(html);
  const labels = collectControlLabels(document);
  const beforeBytes = document.body.innerHTML.length;
  const result = new Readability(document, { charThreshold: 500 }).parse();

  assert.ok(document.body.innerHTML.length < beforeBytes / 2,
    "Readability left the document intact, so the mutation boundary is no longer exercised");
  assert.equal(document.querySelectorAll("button").length, 0, "the fixture did not lose its source control");
  const counted = countControls(labels, result.content);
  assert.equal(counted.total, 1, "the pre-extraction label snapshot lost the source control");
  assert.equal(counted.kept, 0, "the removed control was reported as surviving extraction");
});

test("a link destination cannot be closed early by its own backslash", () => {
  // CodeQL js/incomplete-sanitization on the image half: the anchor escaped
  // backslash before `)` and the image escaped only `)`, so an input backslash
  // paired with the escape and left the paren bare, closing the link early and
  // spilling the rest of the URL into the prose. One escaper now serves both,
  // and the assertion is that they agree for the same input.
  const url = String.raw`https://x.test/a\)b`;
  const escaped = String.raw`https://x.test/a\\\)b`;
  const { document } = parseHTML(`<div><a href="${url}">label</a><img src="${url}" alt="shot"></div>`);
  const md = toMarkdown(document.querySelector("div"));

  assert.ok(md.includes(`[label](${escaped})`), `anchor destination not fully escaped: ${md}`);
  assert.ok(md.includes(`![shot](${escaped})`), `image destination not fully escaped: ${md}`);
});
