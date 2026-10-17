// ── the Explorer chrome escapes a page's heading exactly once ────────────────
// Build step 1g2 reads each page's name out of its h1 and hands it to
// addressBar() and taskPane(), whose `html` template escapes it. Until
// 2026-10-17 the name kept every character reference but `&nbsp;`, so the
// template escaped the `&` a second time: /garage/gpt56 printed
// `5.6 Sol&apos;s performance pass` as literal text in its address bar and its
// Details box, and /garage/safari27, /garage/chunks and /lwe/vigenere did the
// same with `&apos;`, `&amp;` and `&egrave;`. Nothing failed, because a
// double-escaped name is still valid HTML.
import { existsSync } from "node:fs";
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { addressBar, taskPane } from "../src/worker/lib/explorer.ts";
import { objectNameOf } from "./lib/object-name.ts";

// `&amp;` followed by what would have been a reference: a name or a number,
// then `;`. "R&amp;D" is a single escape and stays legal.
const TWICE = /&amp;(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
// From the address bar to the end of the pane, quoted or minified.
const CHROME = /class="?axp-address"?[\s\S]*?class="?axp-pane"?[\s\S]*?<\/aside>/;

const chromeFor = (path, source) => {
  const options = { path, name: objectNameOf(source) };
  return String(addressBar(options)) + String(taskPane(options));
};

test("the name is the heading's text, with each reference decoded once", () => {
  // The four headings that shipped double-escaped, as their sources spell them.
  assert.equal(objectNameOf("<h1>5.6 Sol&apos;s performance pass</h1>"), "5.6 Sol's performance pass");
  assert.equal(objectNameOf("<h1>Safari 27, through this site&apos;s lens</h1>"), "Safari 27, through this site's lens");
  assert.equal(objectNameOf("<h1>Chunking &amp; content-addressing</h1>"), "Chunking & content-addressing");
  assert.equal(objectNameOf("<h1>Vigen&egrave;re Online</h1>"), "Vigenère Online");
  assert.equal(objectNameOf("<h1>It&#39;s &#x2014; Latin&nbsp;1</h1>"), "It's \u2014 Latin 1");
  // Decoding comes after the tags go, so an escaped tag is text, not markup.
  assert.equal(objectNameOf("<h1>The &lt;h1&gt; tag</h1>"), "The <h1> tag");
  // The pill is state, not name. The garage spells it `badge`; until
  // 2026-10-17 only `status` was stripped, so four pages printed their pill.
  assert.equal(objectNameOf('<h1>Thumbnail encoding study <span class="status">shipped</span></h1>'), "Thumbnail encoding study");
  assert.equal(objectNameOf('<h1>Thumbnail encoding study <span class="badge shipped">shipped</span></h1>'), "Thumbnail encoding study");
  assert.equal(objectNameOf('<h1>Chunking &amp; content-addressing <span class="badge review">in review</span></h1>'), "Chunking & content-addressing");
});

test("the address bar and the task pane escape the name once, and still escape it", () => {
  const chrome = chromeFor("/garage/gpt56", "<h1>5.6 Sol&apos;s performance pass</h1>");
  assert.doesNotMatch(chrome, TWICE);
  assert.match(chrome, /class="axp-here" aria-current="page">5\.6 Sol&#39;s performance pass</);
  assert.match(chrome, /<dt>Name<\/dt><dd>5\.6 Sol&#39;s performance pass<\/dd>/);
  // A decoded `<` goes back out as `&lt;`: decoding must not become injection.
  const tag = chromeFor("/garage/x", "<h1>The &lt;h1&gt; tag</h1>");
  assert.doesNotMatch(tag, TWICE);
  assert.match(tag, /The &lt;h1&gt; tag/);
  assert.doesNotMatch(tag, /The <h1>/);
});

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

test("no staged page's Explorer chrome carries a double escape", { skip: needsBuild }, async () => {
  const pages = (await readdir(BUILT, { recursive: true }))
    .filter((f) => f.endsWith(".html") && !f.endsWith(".src.html"));
  let checked = 0;
  const offenders: any[] = [];
  for (const rel of pages) {
    const chrome = CHROME.exec(await readFile(new URL(rel, BUILT), "utf8"));
    if (!chrome) continue;
    checked++;
    const hit = TWICE.exec(chrome[0]);
    if (hit) offenders.push(`${rel}: ${chrome[0].slice(Math.max(0, hit.index - 40), hit.index + hit[0].length)}`);
  }
  // 1g2 dresses 30+ pages or the build stops, so fewer here means CHROME has
  // stopped matching the staged markup and this test is checking nothing.
  assert.ok(checked >= 30, `found the Explorer chrome on ${checked} staged pages; expected 30+`);
  assert.deepEqual(offenders, []);
});

test("no staged page's address bar carries its heading's pill", { skip: needsBuild }, async () => {
  const pages = (await readdir(BUILT, { recursive: true }))
    .filter((f) => f.endsWith(".html") && !f.endsWith(".src.html"));
  let pilled = 0;
  const offenders: any[] = [];
  for (const rel of pages) {
    const page = await readFile(new URL(rel, BUILT), "utf8");
    const here = /class="?axp-here"?[^>]*>([^<]*)</.exec(page);
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(page);
    if (!here || !h1) continue;
    for (const pill of h1[1].matchAll(/<span\b[^>]*\bclass="?[^">]*\b(?:badge|status)\b[^>]*>([^<]*)<\/span>/gi)) {
      pilled++;
      if (here[1].trim().endsWith(pill[1].trim())) offenders.push(`${rel}: ${here[1]}`);
    }
  }
  // Four garage pages carried a pill on 2026-10-17; none means the pill regex
  // stopped matching the staged markup.
  assert.ok(pilled >= 4, `found ${pilled} heading pills on dressed pages; expected 4+`);
  assert.deepEqual(offenders, []);
});
