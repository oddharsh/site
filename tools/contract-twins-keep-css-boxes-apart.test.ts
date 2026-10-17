// ── a twin keeps apart what the page's CSS lays out apart ───────────────────
// tools/lib/html-to-md.ts writes the Markdown twins agents read, llms-full.txt and
// the search text. A grid or flex container makes each child a box of its own
// without the child saying so, and the converter ran those children together:
// /lwe's buddy rows read "**eFuses**a bit that goes 0 to 1 once and never comes
// backchat", and since `.buddy` is a block-level <a>, the row lost its link too.
// These pin the fix on the real page and on each layout rule it reads.
import { readFileSync } from "node:fs";
import { readDocument } from "./lib/html-to-md.ts";
import { assert, ROOT, test } from "./contract-shared.ts";

const page = (style, body) =>
  `<html><head><title>T</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
const md = (style, body) => readDocument(page(style, body), { origin: "https://aadhar.sh" }).body;

test("the /lwe buddy list keeps its words apart and its links", () => {
  const html = readFileSync(new URL("src/pages/lwe/index.html", ROOT), "utf8");
  const { body } = readDocument(html, { origin: "https://aadhar.sh" });
  assert.doesNotMatch(body, /comes backchat|\*\*eFuses\*\*a/, "the name, tagline and status chip ran together");
  assert.match(body, /\[\*\*eFuses\*\* · a bit that goes 0 to 1 once and never comes back · chat\]\(https:\/\/aadhar\.sh\/lwe\/fuse\)/);
  const text = readDocument(html, { origin: "https://aadhar.sh", format: "text" }).body;
  assert.doesNotMatch(text, /comes backchat/, "the search text welds them too");
});

test("a grid's children are boxes, and a card link keeps its href", () => {
  const body = md(".buddy{display:grid;grid-template-columns:30px 1fr auto}.pm{display:block}",
    '<ul><li><a class="buddy" href="/x"><span class="pic"></span><span class="nm"><b>Name</b><span class="pm">the tagline</span></span><span class="st">chat</span></a></li></ul>');
  assert.match(body, /^- \[\*\*Name\*\* · the tagline · chat\]\(https:\/\/aadhar\.sh\/x\)$/m);
});

test("a flex row is one line unless it wraps", () => {
  assert.match(md(".row{display:flex}", '<div class="row"><span><a href="/a">Title</a></span><span>watching</span></div>'),
    /^\[Title\]\(https:\/\/aadhar\.sh\/a\) · watching$/m);
  const wrapped = md(".g{display:flex;flex-wrap:wrap}", '<div class="g"><span>first card</span><span>second card</span></div>');
  assert.doesNotMatch(wrapped, /first card · second card/, "a wrapping row is a gallery, one card per line");
  assert.match(wrapped, /first card\n\nsecond card/);
});

test("a grid reads row by row, with columns from a contextual rule", () => {
  // /garage/av2's shape: the grid is declared on the row, its columns by context
  const body = md(".r{display:grid}.t .r{grid-template-columns:2fr repeat(2,1fr)}@media(max-width:620px){.t .r{grid-template-columns:1fr 1fr}}",
    '<div class="t"><div class="r"><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span></div></div>');
  assert.match(body, /^a · b · c\n\nd · e · f$/m);
  assert.match(md(".r{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr))}", '<div class="r"><span>a</span><span>b</span></div>'),
    /^a\n\nb$/m, "an auto-fill grid has no column count to read, so a line per child");
});

test("a box holding structure keeps its own lines", () => {
  // joining blindly fused /garage/blueprint's code fence onto one line
  const body = md(".row{display:flex}", '<div class="row"><span>as built</span><pre>line one\nline two</pre></div>');
  assert.match(body, /^```\nline one\nline two\n```$/m);
  assert.doesNotMatch(body, /as built · /);
});

test("the search text keeps a grid's cells apart", () => {
  const text = readDocument(page(".r{display:grid;grid-template-columns:1fr 1fr}", '<div class="r"><span>alpha</span><span>beta</span></div>'),
    { origin: "https://aadhar.sh", format: "text" }).body;
  assert.doesNotMatch(text, /alphabeta/);
  assert.match(text, /alpha beta/);
});

test("an inline-flex box stays inside its sentence", () => {
  assert.match(md(".chip{display:inline-flex}", '<p>one <span class="chip">two</span> three</p>'), /^one two three$/m);
});
