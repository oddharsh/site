// A Markdown twin keeps every word the page shows, in order, with nothing added.
//
// Five ways it did not, each live in production twins until 2026-10-13, and
// each found by rebuilding HTML from every twin and converting it back (the
// sketch for /garage/round-trip). Every one read like ordinary text, which is
// why reading the twins never caught them:
//
//   1. A list marker escaped mid-line. The escape ran per TEXT NODE, so a node
//      that began `16. ` was treated as a line start: /garage/octane's twin read
//      `Next.js \16.`, and a backslash before a digit is no escape in CommonMark.
//   2. A space between two inline siblings dropped: /garage/iroh read
//      `QUIChole-punching`, and the same bug fused words on 19 other pages.
//   3. A <caption> never rendered: /garage/wire lost 197 words.
//   4. A <br> in a table cell became spaces, which Markdown reads as one.
//   5. A heading part its CSS sets apart as a block ran into the text before
//      it: /lwe read `**Learning With Errors**explaining hard things`.
//
// Each case below carries its control: the escape must still fire where a
// marker really starts a line, or the twin grows a list nobody wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDocument } from "./lib/html-to-md.ts";

const twin = (html) => readDocument(`<html><body><div class="content">${html}</div></body></html>`).body;

test("a list marker is escaped where it starts a line, and nowhere else", () => {
  assert.equal(
    twin('<p>less than <a href="https://example.com/">Next.js</a> 16. That is real.</p>'),
    "less than [Next.js](https://example.com/) 16. That is real.",
  );
  assert.equal(twin("<p>a <code>x</code> + b</p>"), "a `x` + b", "mid-line plus after a code span");
  // controls: the same markers at a real line start still need their escape
  assert.equal(twin("<p>16. That is real.</p>"), "16\\. That is real.", "ordered marker escapes its period");
  assert.equal(twin("<p>- not a list</p>"), "\\- not a list");
  assert.equal(twin("<p># not a heading</p>"), "\\# not a heading");
  assert.equal(twin("<p>one<br>+ two</p>"), "one  \n\\+ two", "a hard break starts a line too");
});

test("a space between inline siblings survives, and indentation does not", () => {
  assert.equal(
    twin('<p><a href="https://a.example/">QUIC</a> <a href="https://b.example/">hole-punching</a></p>'),
    "[QUIC](https://a.example/) [hole-punching](https://b.example/)",
  );
  assert.equal(twin("<p><strong>write-only</strong> <em>init</em></p>"), "**write-only** *init*");
  // controls: whitespace that only indents the source adds nothing, and two
  // runs of it meeting across a comment still collapse to one space
  assert.equal(twin("<p>\n    <strong>lead</strong>\n</p>"), "**lead**");
  assert.equal(twin("<p><time>June 7</time>\n  <!-- note -->\n  &middot; visitor</p>"), "June 7 · visitor");
});

test("a heading keeps the parts its CSS sets apart", () => {
  const page = (h) => readDocument(`<html><head><style>.who .tag{display:block}</style></head><body><div class="content">${h}</div></body></html>`).body;
  assert.equal(
    page('<h1 class="who"><b>Learning With Errors</b><span class="tag">explaining hard things</span></h1>'),
    "# **Learning With Errors** · explaining hard things",
  );
  // control: a heading with no promoted part renders on the inline path as before
  assert.equal(page("<h2><b>Plain</b> <span>heading</span></h2>"), "## **Plain** heading");
});

test("a glossary term becomes a reference link, and its definition closes the twin", () => {
  const term = (key, title, text) => `<a class="term" data-t="${key}" href="https://en.wikipedia.org/wiki/${text}" title="${title}" rel="external">${text}</a>`;
  const md = twin(`<p>${term("srgb", "A colour space.", "sRGB")} and ${term("brotli", "Says &quot;hi&quot; with a \\ in it.", "Brotli")}, then ${term("srgb", "A colour space.", "sRGB")} again.</p>`);
  assert.equal(md, [
    "[sRGB][srgb] and [Brotli][brotli], then [sRGB][srgb] again.",
    "",
    '[srgb]: https://en.wikipedia.org/wiki/sRGB "A colour space."',
    '[brotli]: https://en.wikipedia.org/wiki/Brotli "Says \\"hi\\" with a \\\\ in it."',
  ].join("\n"));
  // controls: a titled link that is no term stays an inline link, and a page
  // with no terms has no glossary
  assert.equal(twin('<p><a href="https://a.example/" title="hover text">plain</a></p>'), "[plain](https://a.example/)");
});

test("a table keeps its caption", () => {
  const md = twin("<table><caption>The old project is parked as a rollback.</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>");
  assert.equal(md, "The old project is parked as a rollback.\n\n| a |\n| --- |\n| 1 |");
  // control: a table with no caption renders exactly as before
  assert.equal(twin("<table><tr><th>a</th></tr><tr><td>1</td></tr></table>"), "| a |\n| --- |\n| 1 |");
});

test("a line break in a table cell stays a line break, in one row", () => {
  const md = twin("<table><tr><th>a</th><th>b</th></tr><tr><td>128KB raw<br>64KB brotli</td><td>x</td></tr></table>");
  assert.equal(md.split("\n").at(-1), "| 128KB raw<br>64KB brotli | x |");
  assert.equal(md.split("\n").length, 3, "the break must not split the row");
});
