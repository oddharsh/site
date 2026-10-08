// ── the HTML minifier keeps what the page means ─────────────────────────────
// tools/lib/html-minify.ts replaced @minify-html/node. The parity proof was a
// whole-build byte diff (68 of 69 pages identical); these pin the two calls
// where the replacement deliberately or narrowly differs, plus the rules the
// rest of the build reads its output by (unquoted attributes, raw blocks).
import { readFileSync } from "node:fs";
import {
  assert,
  ROOT,
  test,
} from "./contract-shared.ts";

const { minifyHtml } = await import("./lib/html-minify.ts");

test("a boolean attribute keeps a value that names another state", () => {
  // minify-html wrote bare `hidden` here, which a find-in-page search cannot
  // reveal: the /garage/horizon until-found demo shipped broken.
  assert.equal(
    minifyHtml('<p hidden="until-found" id="t">x</p>'),
    "<p hidden=until-found id=t>x",
  );
  assert.equal(minifyHtml('<p hidden="hidden">x</p>'), "<p hidden>x", "a self-named value goes");
  assert.equal(minifyHtml('<p hidden="">x</p>'), "<p hidden>x", "an empty value goes");
  assert.equal(minifyHtml('<input disabled="disabled">'), "<input disabled>");
});

test("a start tag that closes the open <p> trims it as a written </p> would", () => {
  // `<p>a <p>b` is two paragraphs. The first one's end tag is implied, so its
  // trailing space is the edge of a block and goes; minify-html did the same,
  // and the twin-based parity test missed it on horizon until the whole-build
  // diff caught it.
  assert.equal(minifyHtml("<div><p>a <p>b</div>"), "<div><p>a<p>b</div>");
  assert.equal(minifyHtml("<ul><li>a <li>b</ul>"), "<ul><li>a<li>b</ul>");
  assert.equal(minifyHtml("<p>a</p><p>b</p>"), "<p>a<p>b", "both end tags are inferable");
  assert.equal(minifyHtml("<p>a</p><span>b</span>"), "<p>a</p><span>b</span>", "an inline sibling needs the </p>");
});

test("raw and whitespace-sensitive content keeps its bytes", () => {
  assert.equal(minifyHtml("<pre>  a\n  b </pre>"), "<pre>  a\n  b </pre>");
  assert.equal(minifyHtml("<script>if (a < b) x()</script>"), "<script>if (a < b) x()</script>");
  assert.equal(minifyHtml("<p>a   b\n c</p>"), "<p>a b c", "flow whitespace collapses to one space");
  assert.equal(minifyHtml("<p>a<!-- gone --><!--#keep-->b</p>"), "<p>a<!--#keep-->b", "SSI markers survive, comments go");
});

test("attributes come out in the order and quoting the build's readers expect", () => {
  // csp-scan, link-integrity and client-assets all read unquoted values; this
  // is the shape they are tested against.
  assert.equal(
    minifyHtml('<a title="two words" href="/x" class="  a  b ">y</a>'),
    '<a class="a b" title="two words" href=/x>y</a>',
  );
  assert.equal(minifyHtml('<img src="/i/a.avif" alt="" loading="eager">'), "<img alt src=/i/a.avif>", "a default value goes");
  assert.equal(minifyHtml("<p title='say \"hi\"'>x</p>"), "<p title='say \"hi\"'>x");
});

test("the built horizon page still carries its until-found target", () => {
  const src = readFileSync(new URL("src/pages/garage/horizon.html", ROOT), "utf8");
  assert.ok(src.includes('<p hidden="until-found" id="huf-target"'), "the source still authors the demo");
  // the source is buildless: run it through the minifier the build uses
  assert.match(minifyHtml(src), /<p class=huf hidden=until-found id=huf-target>/);
});
