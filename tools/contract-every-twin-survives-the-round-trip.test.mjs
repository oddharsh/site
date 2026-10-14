// Every Markdown twin survives the round trip: HTML to Markdown (html-to-md.ts),
// back to HTML (src/client/garage/md-to-html.js, the /garage/round-trip parser),
// and down again must hand back the same twin, byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDocument } from "./lib/html-to-md.ts";
import { mdToHtml } from "../src/client/garage/md-to-html.js";
import { lintAuthorText } from "../pipelines/content/page-contract.mjs";

const down = (html) => readDocument(`<!doctype html><html><body><main>${html}</main></body></html>`).body;

const pages = [];
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
  const failed = [];
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
  for (const file of pages) {
    const twin = readDocument(readFileSync(file, "utf8")).body;
    assert.equal(down(mdToHtml(twin, { origin: "https://aadhar.sh" })), twin, file);
  }
});

test("a page rebuilt from its twin writes terms, intros and links byte for byte as the hand-written page", () => {
  const TERM = /<a class="term"[^>]*>[\s\S]*?<\/a>/g;
  const INTRO = /<p class="garage-intro">/g;
  const LOCAL = /<a href="\/[^"]*">[\s\S]*?<\/a>/g;
  const KINDS = [{ kind: "term", re: TERM }, { kind: "intro", re: INTRO }, { kind: "local", re: LOCAL }];
  /** @type {Record<string, number>} */
  const totals = { term: 0, intro: 0, local: 0 };
  for (const f of readdirSync("pipelines/garage/specs").filter((x) => x.endsWith(".json") && x !== "round-trip.json")) {
    const id = f.replace(/\.json$/, "");
    const authored = JSON.parse(readFileSync(join("pipelines/garage/specs", f), "utf8")).bodyHtml;
    const twin = readDocument(readFileSync(`src/pages/garage/${id}.html`, "utf8")).body;
    const rebuilt = mdToHtml(twin, { origin: "https://aadhar.sh" });
    for (const { kind, re } of KINDS) {
      const want = [...(authored.match(re) || [])].sort();
      const got = [...(rebuilt.match(re) || [])].sort();
      for (const tag of want) assert.ok(got.includes(tag), `${id}: ${kind} lost or changed on the trip: ${tag.slice(0, 140)}`);
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
  assert.equal(mdToHtml("[sRGB][nowhere]"), "<p>[sRGB][nowhere]</p>");
});

test("every hand twin settles after one trip", () => {
  const dir = "src/content/md";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const once = down(mdToHtml(readFileSync(join(dir, f), "utf8").trim()));
    assert.equal(down(mdToHtml(once)), once, f);
  }
});

const RENDERS_FROM_MARKDOWN = "src/content/garage/round-trip.md";

test("a page that renders from its Markdown is that Markdown's fixed point, byte for byte", () => {
  const src = readFileSync(RENDERS_FROM_MARKDOWN, "utf8");
  const body = src.replace(/^---\n[\s\S]*?\n---\n\n/, "").trimEnd();
  assert.notEqual(body, src.trimEnd(), "the source should carry front matter for agents");
  assert.equal(down(mdToHtml(src)), body);
  assert.match(body, /^## Take a page on the trip$/m);
});

test("the Markdown a page renders from is held to the house voice", () => {
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
