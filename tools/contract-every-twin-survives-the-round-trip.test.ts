// Every Markdown twin survives the round trip: HTML to Markdown (html-to-md.ts),
// back to HTML (src/client/garage/md-to-html.ts, the /garage/round-trip parser),
// and down again must hand back the same twin, byte for byte.
//
// The parser reads only the language html-to-md writes, so this is a fixed
// point, and either converter can fail it. The first run on 2026-10-13 failed
// on 4 of 47 twins and every failure was a converter bug agents were reading
// (#1309): a stray `\16.` on /garage/octane, a table-cell <br> flattened to
// spaces on /garage/wire, and a needless `\+` on two more. A failure here is a
// bug in one of the two directions; which one is the first thing to find out.
//
// The hand twins in src/content/md/ are written by a person, who soft-wraps
// lines and uses autolinks the converter never writes. They get the weaker
// check: one trip puts them in canonical form, and a second changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDocument } from "./lib/html-to-md.ts";
import { mdToHtml } from "../src/client/garage/md-to-html.ts";
import { lintAuthorText } from "../pipelines/content/page-contract.ts";

const down = (html) => readDocument(`<!doctype html><html><body><main>${html}</main></body></html>`).body;

const pages: any[] = [];
const walk = (dir) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (p.endsWith(".html")) pages.push(p);
  }
};
walk("src/pages");

test("every generated twin comes back byte for byte", () => {
  assert.ok(pages.length >= 40, `found ${pages.length} pages; the walk lost src/pages`);
  const failed: any[] = [];
  for (const file of pages) {
    const twin = readDocument(readFileSync(file, "utf8")).body;
    const back = down(mdToHtml(twin));
    if (back !== twin) {
      const a = twin.split("\n"), b = back.split("\n");
      const k = a.findIndex((l, i) => l !== b[i]);
      failed.push(`${file} line ${k + 1}\n  twin: ${JSON.stringify(a[k])}\n  back: ${JSON.stringify(b[k])}`);
    }
  }
  assert.deepEqual(failed, [], `\n${failed.join("\n")}`);
});

test("the round trip also closes when the parser writes the page a Garage page would be", () => {
  // `origin` turns this site's links into paths and marks the intro; html-to-md
  // makes the links absolute again and reads no class, so the twin still closes.
  for (const file of pages) {
    const twin = readDocument(readFileSync(file, "utf8")).body;
    assert.equal(down(mdToHtml(twin, { origin: "https://aadhar.sh" })), twin, file);
  }
});

// The page /garage/round-trip renders must be markup a hand-written Garage page
// would carry, byte for byte. Each authored spec is the reference: rebuild the
// page from its twin and every term, every intro and every plain link to this
// site must be the exact bytes the spec wrote. What a twin cannot carry is a
// class a demo puts on its own markup (/garage/dictionary's table rows), and
// that stays out of the comparison by construction: only bare tags are counted.
test("a page rebuilt from its twin writes terms, intros and links byte for byte as the hand-written page", () => {
  const TERM = /<a class="term"[^>]*>[\s\S]*?<\/a>/g;
  const INTRO = /<p class="garage-intro">/g;
  const LOCAL = /<a href="\/[^"]*">[\s\S]*?<\/a>/g;
  const KINDS = [{ kind: "term", re: TERM }, { kind: "intro", re: INTRO }, { kind: "local", re: LOCAL }];

  const totals: Record<string, number> = { term: 0, intro: 0, local: 0 };
  for (const f of readdirSync("pipelines/garage/specs").filter((x) => x.endsWith(".json") && x !== "round-trip.json")) {
    const id = f.replace(/\.json$/, "");
    const authored = JSON.parse(readFileSync(join("pipelines/garage/specs", f), "utf8")).bodyHtml;
    const twin = readDocument(readFileSync(`src/pages/garage/${id}.html`, "utf8")).body;
    const rebuilt = mdToHtml(twin, { origin: "https://aadhar.sh" });
    for (const { kind, re } of KINDS) {
      const want = [...(authored.match(re) || [])].sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
      const got = [...(rebuilt.match(re) || [])].sort();
      // every one the hand-written page has comes back, byte for byte
      for (const tag of want) assert.ok(got.includes(tag), `${id}: ${kind} lost or changed on the trip: ${tag.slice(0, 140)}`);
      // and terms and intros come back once each, with nothing invented
      if (kind !== "local") assert.deepEqual(got, want, `${id}: ${kind}s differ`);
      totals[kind] += want.length;
    }
  }
  assert.ok(totals.term >= 100 && totals.intro >= 8 && totals.local >= 15, `compared only ${JSON.stringify(totals)}; the specs are not being read`);
});

test("control: a term written by hand in another shape is caught", () => {
  const html = mdToHtml('[sRGB][srgb]\n\n[srgb]: https://en.wikipedia.org/wiki/SRGB "A colour space."');
  assert.equal(html, '<p><a class="term" data-t="srgb" href="https://en.wikipedia.org/wiki/SRGB" title="A colour space." rel="external">sRGB</a></p>');
  assert.notEqual(html, '<p><a class="term" href="https://en.wikipedia.org/wiki/SRGB" data-t="srgb" title="A colour space." rel="external">sRGB</a></p>');
  // a reference with no definition is text, and a definition renders nothing
  assert.equal(mdToHtml("[sRGB][nowhere]"), "<p>[sRGB][nowhere]</p>");
});

test("every hand twin settles after one trip", () => {
  const dir = "src/content/md";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const once = down(mdToHtml(readFileSync(join(dir, f), "utf8").trim()));
    assert.equal(down(mdToHtml(once)), once, f);
  }
});

// /garage/round-trip ships no prose in its HTML. Its Markdown in src/content is
// the source and the twin both, and the page renders it with mdToHtml when it
// opens. That only keeps the page and its twin from disagreeing if the source
// is a fixed point exactly: one byte the parser reads differently and the page
// a person sees is not the file an agent reads.
const RENDERS_FROM_MARKDOWN = "src/content/garage/round-trip.md";

test("a page that renders from its Markdown is that Markdown's fixed point, byte for byte", () => {
  const src = readFileSync(RENDERS_FROM_MARKDOWN, "utf8");
  const body = src.replace(/^---\n[\s\S]*?\n---\n\n/, "").trimEnd();
  assert.notEqual(body, src.trimEnd(), "the source should carry front matter for agents");
  assert.equal(down(mdToHtml(src)), body);
  // The demo mounts under this heading; without it the page renders the demo last.
  assert.match(body, /^## Take a page on the trip$/m);
});

test("the Markdown a page renders from is held to the house voice", () => {
  // pages:check lints a spec's bodyHtml. This page's words live in Markdown,
  // which that lint never reads.
  lintAuthorText(readFileSync(RENDERS_FROM_MARKDOWN, "utf8"), RENDERS_FROM_MARKDOWN);
  assert.throws(() => lintAuthorText("a test — with a dash", "control"), /em dashes/);
});

test("the page's HTML is a frame that points at its Markdown", () => {
  const html = readFileSync("src/pages/garage/round-trip.html", "utf8");
  assert.match(html, /<div id="rt-doc"/);
  assert.match(html, /href="\/garage\/round-trip\.md"/);
  assert.match(html, /fetch\("\/garage\/round-trip\.md"\)/);
});

test("control: the fixed point fails on Markdown the parser does not read", () => {
  // A setext heading is CommonMark, and html-to-md never writes one. If the
  // check passed this, it would pass anything.
  const md = "Title\n=====";
  assert.notEqual(down(mdToHtml(md)), md);
});

test("the parser escapes its input and refuses a link that runs", () => {
  assert.equal(mdToHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(mdToHtml("[x](javascript:alert(1))"), "<p>x</p>");
  assert.equal(mdToHtml("[x](\tJavaScript:alert(1))"), "<p>x</p>", "read the way a browser reads the scheme");
  assert.equal(mdToHtml("[x](data:text/html,hi)"), "<p>x</p>");
  assert.equal(mdToHtml('[x](https://a.example/"onmouseover=1)'), '<p><a href="https://a.example/&quot;onmouseover=1">x</a></p>');
  // an <img> never runs what it loads, so a data: image is a picture
  assert.equal(mdToHtml("![q](data:image/svg+xml,%3Csvg%3E)"), '<p><img src="data:image/svg+xml,%3Csvg%3E" alt="q"></p>');
  assert.equal(mdToHtml("![q](javascript:alert(1))"), "<p></p>");
});

test("a served twin's front matter stays out of the body", () => {
  const md = '---\ntitle: "x"\nsource: "https://aadhar.sh/x"\n---\n\n# Heading';
  assert.equal(mdToHtml(md), "<h1>Heading</h1>");
});
