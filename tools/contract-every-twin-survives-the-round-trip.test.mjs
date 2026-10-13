// Every Markdown twin survives the round trip: HTML to Markdown (html-to-md.ts),
// back to HTML (src/client/garage/md-to-html.js, the /garage/round-trip parser),
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
import { mdToHtml } from "../src/client/garage/md-to-html.js";

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

test("every hand twin settles after one trip", () => {
  const dir = "src/content/md";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const once = down(mdToHtml(readFileSync(join(dir, f), "utf8").trim()));
    assert.equal(down(mdToHtml(once)), once, f);
  }
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
