// The gate that lets linkedom be deleted.
//
// src/dom.ts is a DOM fitted to this Worker's workload. "Fitted" is only ever a
// claim until something holds it to the general implementation it replaces, so
// this runs the REAL pipeline twice over one corpus, once on each DOM, and
// compares the five payload fields a visitor sees. linkedom is the oracle, not
// the browser: see the note at the top of src/dom.ts for why img.src stays raw.
//
// Parity is asserted BYTE-FOR-BYTE on content and markdown. A word-count or
// length comparison would pass on two documents that differ in every attribute,
// which is the failure mode this file exists to catch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML as parseLinkedom } from "linkedom";
import { parseHTML as parseFitted } from "../src/dom.ts";
import { toMarkdown, collectControlLabels } from "../src/reader.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Captured pages are stored Brotli'd, the same trade `src/dict/p-dict` already
 *  makes in this repository: 3.13 MiB of real-world HTML is 384 KiB compressed,
 *  and node:zlib decompresses it with no dependency. Authored repo documents are
 *  read as-is. */
const readDoc = (file) => file.endsWith(".br")
  ? brotliDecompressSync(readFileSync(file)).toString("utf8")
  : readFileSync(file, "utf8");
const CORPUS = [join(here, "..", "..", "src", "pages"), join(here, "corpus")];

function htmlFiles(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(htmlFiles(p));
    else if (name.endsWith(".html") || name.endsWith(".html.br")) out.push(p);
  }
  return out;
}

/** The pipeline read() runs, minus the network. Both DOMs go through this
 *  identical path so a difference can only come from the DOM.
 *
 *  parseHTML is called with ONE argument because that is what reader.ts does.
 *  Handing it a base URL makes Readability absolutize every href, which is
 *  arguably the better payload and is definitely a different one. Changing it
 *  is a product decision and belongs in its own commit, not smuggled in under a
 *  DOM swap, so the gate holds the fitted DOM to the behaviour in production. */
function extract(parseHTML, html) {
  const { document } = parseHTML(html);
  const controls = collectControlLabels(document);
  let node;
  const article = new Readability(document, {
    charThreshold: 500,
    serializer(el) { node = el; return el.innerHTML; },
  }).parse() || /** @type {Partial<NonNullable<ReturnType<Readability["parse"]>>>} */ ({});
  return {
    title: String(article.title || ""),
    byline: String(article.byline || ""),
    content: String(article.content || ""),
    markdown: toMarkdown(node || String(article.content || "")),
    controls: controls === null ? null : [...controls].sort(),
  };
}

const FIELDS = ["title", "byline", "content", "markdown", "controls"];

test("fitted DOM matches linkedom across the corpus", () => {
  const files = CORPUS.flatMap(htmlFiles).sort();
  assert.ok(files.length >= 30, `corpus collapsed to ${files.length} documents`);

  const mismatches = [];
  let threw = 0;
  for (const file of files) {
    const html = readDoc(file);
    let a, b;
    try { a = extract(parseLinkedom, html); } catch (e) { threw++; mismatches.push({ file, field: "linkedom threw", detail: e.message }); continue; }
    try { b = extract(parseFitted, html); } catch (e) { threw++; mismatches.push({ file, field: "fitted threw", detail: e.message }); continue; }
    for (const field of FIELDS) {
      const x = JSON.stringify(a[field]), y = JSON.stringify(b[field]);
      if (x !== y) mismatches.push({ file, field, detail: firstDiff(x, y) });
    }
  }

  if (mismatches.length) {
    const byField = {};
    for (const m of mismatches) byField[m.field] = (byField[m.field] || 0) + 1;
    console.error(`\n${files.length} documents, ${mismatches.length} mismatches, ${threw} threw`);
    console.error(byField);
    for (const m of mismatches.slice(0, 12)) {
      console.error(`  ${m.file.split("/").slice(-2).join("/")}  [${m.field}]  ${m.detail}`);
    }
  }
  assert.equal(mismatches.length, 0, `${mismatches.length} field mismatches across ${files.length} documents`);
});

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length && i === a.length) return "equal";
  return `@${i} len ${a.length}/${b.length}\n      linkedom: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))}\n      fitted:   ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`;
}

// A STRONGER gate than the payload one above, and cheap. Payload parity can
// hold while the two trees differ, because Readability discards most of a page;
// serialized-tree parity cannot. Repo documents are excluded: they are one
// author's HTML and agree trivially. The real-world captures are the test.
test("fitted DOM parses real-world pages into an identical tree", () => {
  const files = htmlFiles(join(here, "corpus"));
  assert.ok(files.length >= 5, `real-world corpus collapsed to ${files.length} pages`);
  for (const file of files) {
    const html = readDoc(file);
    // Asserted rather than optional-chained. A capture that parses to no
    // documentElement is a broken fixture, and reading it as "" would compare
    // two empty strings and pass.
    const rootA = parseLinkedom(html).document.documentElement;
    const rootB = parseFitted(html).document.documentElement;
    assert.ok(rootA, `linkedom parsed no documentElement from ${file}`);
    assert.ok(rootB, `the fitted DOM parsed no documentElement from ${file}`);
    const a = rootA.outerHTML, b = rootB.outerHTML;
    assert.equal(b, a, `tree differs for ${file}\n${firstDiff(a, b)}`);
  }
});

// toMarkdown's OTHER entry point. read() normally hands it Readability's live
// article node, so this branch only runs when the serializer never fired, which
// makes it exactly the path a corpus sweep would miss. It leans on three things
// the article path never touches: a document with no <html>, getElementById
// against the root element itself, and the innerHTML setter.
test("fitted DOM supports toMarkdown's string fallback", () => {
  const fragment =
    '<p>Hello <b>world</b> &amp; <a href="/x">link</a></p>' +
    "<ul><li>a</li><li>b</li></ul><pre><code>x &lt; y</code></pre>" +
    '<blockquote><p>q</p></blockquote><img src="/i.png" alt="alt">';
  const root = (parseHTML) => {
    const { document } = parseHTML('<div id="lens-root"></div>');
    const el = document.getElementById("lens-root");
    assert.ok(el, "getElementById did not find the scratch root");
    el.innerHTML = fragment;
    return el;
  };
  const a = root(parseLinkedom), b = root(parseFitted);
  assert.equal(b.innerHTML, a.innerHTML, "innerHTML round-trip differs");
  assert.equal(toMarkdown(b), toMarkdown(a), "markdown differs");
  assert.equal(toMarkdown(fragment).length > 0, true, "string fallback produced nothing");
});

test("the cached element-child view invalidates on every mutation path", () => {
  const { document } = parseFitted("<main><a></a><b></b></main>");
  const main = document.querySelector("main");
  assert.ok(main);

  const cached = main.children;
  assert.equal(main.children, cached, "an unchanged node rebuilt its element-child view");

  const c = document.createElement("c");
  main.appendChild(c);
  assert.notEqual(main.children, cached, "appendChild kept a stale view");
  assert.deepEqual(main.children.map((node) => node.localName), ["a", "b", "c"]);

  const first = document.createElement("first");
  main.insertBefore(first, main.firstChild);
  assert.deepEqual(main.children.map((node) => node.localName), ["first", "a", "b", "c"]);

  main.removeChild(first);
  assert.deepEqual(main.children.map((node) => node.localName), ["a", "b", "c"]);

  const replacement = document.createElement("replacement");
  main.replaceChild(replacement, main.children[1]);
  assert.deepEqual(main.children.map((node) => node.localName), ["a", "replacement", "c"]);

  const other = document.createElement("aside");
  document.appendChild(other);
  void main.children;
  void other.children;
  other.appendChild(c);
  assert.deepEqual(main.children.map((node) => node.localName), ["a", "replacement"],
    "moving a child kept the old parent's cached view");
  assert.deepEqual(other.children.map((node) => node.localName), ["c"],
    "moving a child kept the new parent's cached view");

  main.textContent = "text";
  assert.equal(main.children.length, 0, "textContent kept the previous children");
  main.innerHTML = "<i></i><em></em>";
  assert.deepEqual(main.children.map((node) => node.localName), ["i", "em"],
    "innerHTML kept the textContent-era cache");
});

// SVG semantics the corpus CANNOT reach, pinned directly against the oracle.
//
// Two of the three below are invisible to every gate above, and finding that out
// is why this test exists. `tagName` is never serialized (serialization reads
// localName), and Readability only ever compares tagName against HTML names, so
// a wrong SVG tagName passes 48 documents and two byte-for-byte gates. It was
// wrong: the first version of src/dom.ts kept SVG tagName lowercase on the
// reasonable guess that SVG is case-sensitive. Reverting the fix still passes
// the corpus, which makes the corpus decoration for this property.
//
// Every expectation here is read from linkedom in the same run rather than
// written by hand, so this stays a parity assertion and cannot drift into a
// record of what someone once believed.
test("SVG semantics match the oracle where the corpus is blind", () => {
  const svgHtml =
    '<html><body><svg viewBox="0 0 1 1">' +
    '<path d="M0&amp;0" data-q="a&amp;b&lt;c" class=""></path>' +
    "<g></g><text>t</text></svg></body></html>";
  const pick = (parseHTML) => {
    const { document } = parseHTML(svgHtml);
    const svg = document.getElementsByTagName("svg")[0];
    const path = svg.getElementsByTagName("path")[0];
    return {
      svgTagName: svg.tagName,
      pathTagName: path.tagName,
      pathLocalName: path.localName,
      // Quote-only escaping, which is the branch a stale comment in dom.ts
      // called an untested gap. It is unreachable: linkedom selects the fuller
      // XML escape on ownerDocument[MIME].ignoreCase, and an HTML document
      // answers true for its SVG children too.
      attr: path.getAttribute("data-q"),
      serialized: svg.outerHTML,
    };
  };
  const oracle = pick(parseLinkedom);
  assert.deepEqual(pick(parseFitted), oracle);

  // Spelled out, so a future reader sees the shape rather than trusting deepEqual.
  assert.equal(oracle.pathTagName, "PATH", "SVG tagName is uppercased inside an HTML document");
  assert.equal(oracle.pathLocalName, "path", "localName keeps the parsed case");
  assert.equal(oracle.attr, "a&b<c", "attribute values decode, and re-serialize unescaped");
  assert.match(oracle.serialized, /<path d="M0&0" data-q="a&b<c" \/>/, "empty class dropped, childless SVG self-closes");
  assert.match(oracle.serialized, /<g \/><text>t<\/text>/, "childless self-closes, non-empty does not");
});
