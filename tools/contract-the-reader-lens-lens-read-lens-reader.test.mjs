// ── the Reader lens (/lens/read, lens-reader/) ───────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  brotliCompressSync,
  readFileSync,
  test,
  zlibConstants,
} from "./contract-shared.ts";
import { asRecord } from "../src/worker/lib/parse.ts";
import { hashOrder, minifiedScripts } from "./lib/client-assets.ts";

// EVERY assertion below reads SOURCE TEXT and imports nothing from lens-reader/.
// That is a hard constraint, not a style: this suite runs under plain node with
// the ROOT workspace's dependencies, and lens-reader/src/reader.ts imports
// readability and linkedom, which live only in that sub-project. Importing
// it here fails with ERR_MODULE_NOT_FOUND in CI while passing on any workstation
// that happens to have run `pnpm install` in lens-reader/ — which is exactly how
// this was caught (PR #299, first run). Same family as gotcha 16: what this file
// imports has to resolve under bare node, forever.

test("the reader's rate-limit message quotes the ceiling wrangler declares", async () => {
  const src = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const constant = src.match(/export const READER_LIMIT_PER_MIN = (\d+)/);
  assert.ok(constant, "reader.js no longer exports READER_LIMIT_PER_MIN");
  const READER_LIMIT_PER_MIN = Number(constant[1]);
  const config = (await import("../lens-reader/cloudflare.config.ts")).default;
  const declared = config.worker.env.READER_RL;
  assert.equal(declared?.type, "rate-limit", "lens-reader/cloudflare.config.ts declares no READER_RL rate limit");
  assert.equal(READER_LIMIT_PER_MIN, declared.simple.limit,
    "the reader's 429 message would quote a limit the binding does not enforce");
});

test("the reader minifies its dependency-heavy deploy without losing source locations", async () => {
  // The TOOLING half of the new config: wrangler.config.ts, beside the Worker.
  // asRecord because defineWranglerConfig types its return as a union with the
  // function form; this file exports the object form.
  const tooling = asRecord((await import("../lens-reader/wrangler.config.ts")).default) ?? {};
  assert.equal(tooling.minify, true,
    "the Reader Worker should minify its dependency-heavy production bundle");
  assert.equal(tooling.uploadSourceMaps, true,
    "Reader minification must retain original source locations in Workers Logs");
});

test("the reader Worker shares the site's SSRF guard rather than copying it", async () => {
  const reader = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const entry = readFileSync("./lens-reader/src/index.ts", "utf8");
  for (const [name, src] of [["reader.ts", reader], ["index.ts", entry]]) {
    assert.match(src, /from "\.\.\/\.\.\/src\/worker\/lib\/public-fetch\.(js|ts)"/,
      `lens-reader/src/${name} must import the shared guard, not reimplement it`);
    assert.doesNotMatch(src, /function\s+validateLensTarget|function\s+privateHostBlocked/,
      `lens-reader/src/${name} redefines a guard it is supposed to be importing`);
  }
  const crawl = await import("../src/worker/lib/public-fetch.ts");
  const lens = await import("../src/worker/lens.ts");
  assert.equal(lens.validateLensTarget, crawl.validateLensTarget,
    "lens.js and lib/public-fetch.ts must expose the same function object, not two copies");
});

test("the reader owns one focused Markdown walk over Readability's node", async () => {
  const src = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const manifest = JSON.parse(readFileSync("./lens-reader/package.json", "utf8"));
  assert.equal(manifest.dependencies.turndown, undefined,
    "a general HTML-to-Markdown dependency would restore a second traversal and tree clone");
  assert.doesNotMatch(src, /from "turndown"|TurndownService/,
    "the Reader Worker must not carry the removed converter in its bundle");
  assert.match(src, /return tidyMarkdown\(markdownChildren\(root\)\)\.trim\(\)/,
    "toMarkdown must walk Readability's finished node directly");
  assert.match(src, /const MD_DROP = new Set\(\["script", "style"\]\)/,
    "only non-prose script and style bodies may be discarded by the serializer");
  assert.match(src, /default: return inner\(\)/,
    "unknown semantic wrappers must retain their prose");
});

test("the reader reports what it dropped, never only what it kept", async () => {
  const reader = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const client = readFileSync("./src/client/lens-reader.js", "utf8");
  assert.match(reader, /dropped:\s*\{/, "the payload must carry a dropped tally");
  assert.match(reader, /source[\s\S]{0,200}kept/, "the payload must carry both counts");
  assert.match(client, /What the extractor threw away/, "the pane must lead with the gap");
  const note = reader.match(/export const READER_NOTE =([\s\S]*?);\n/);
  assert.ok(note, "reader.js no longer exports READER_NOTE");
  assert.match(note[1], /OPINION/, "the note must name the output as an opinion");
  assert.match(note[1], /never what the server sent/);
});

test("every machine lens tab has a label, and the reader is one of them", async () => {
  const { LENS_TAB_ORDER } = await import("../src/worker/lens.ts");
  const server = readFileSync("./src/worker/lens.ts", "utf8");
  const client = readFileSync("./src/client/lens.js", "utf8");
  assert.ok(LENS_TAB_ORDER.includes("reader"), "the reader tab must be in the tab order");
  const labels = server.match(/const LENS_TAB_LABELS = \{([\s\S]*?)\};/)[1];
  for (const key of LENS_TAB_ORDER) {
    assert.match(labels, new RegExp(`\\b${key}:`), `LENS_TAB_LABELS has no entry for "${key}"`);
    assert.match(client, new RegExp(`\\b${key}: "`), `the client LENS_LABEL map has no entry for "${key}"`);
    assert.match(client, new RegExp(`LENS_FN\\.${key} =`), `the client has no render function for "${key}"`);
  }
});

test("a ?lens= deep link works for every tab in the strip", async () => {
  const { LENS_TAB_ORDER } = await import("../src/worker/lens.ts");
  const client = readFileSync("./src/client/lens.js", "utf8");
  assert.match(client, /var lenses = Object\.keys\(LENS_LABEL\);/,
    "the deep-link allowlist must be derived from LENS_LABEL, never re-listed");
  const labels = client.match(/var LENS_LABEL = \{([\s\S]*?)\};/)[1];
  for (const key of LENS_TAB_ORDER) {
    assert.match(labels, new RegExp(`\\b${key}: "`), `LENS_LABEL has no entry for "${key}", so ?lens=${key} cannot resolve`);
  }
});

test("the idle Lens shell defers its full client without losing the first action", () => {
  const server = readFileSync("./src/worker/lens.ts", "utf8");
  const boot = readFileSync("./src/client/lens-boot.js", "utf8");

  assert.match(server, /scripts: (?:unsafeHtml\()?`<script src="\/lens-boot\.js" defer><\/script>`/,
    "the server-rendered idle shell must load only the bootstrap");
  assert.doesNotMatch(server, /scripts: (?:unsafeHtml\()?`<script src="\/lens\.js"/,
    "the full Lens application must not sit on the passive render path");
  assert.match(boot, /import\("\/lens\.js\?v=1"\)/,
    "the bootstrap must load the full application through the build's hashable specifier");
  assert.match(boot, /root\.addEventListener\("click", click, true\)/,
    "a cold button click must be captured before the unloaded application can miss it");
  assert.match(boot, /root\.addEventListener\("submit", submit, true\)/,
    "a cold form submission must be captured before the unloaded application can miss it");
  assert.match(boot, /form\.requestSubmit\(submitter \|\| undefined\)/,
    "the first form action must be replayed with its original submitter");

  assert.doesNotMatch(boot, /document\.addEventListener\(/,
    "the bootstrap must bind inside the Lens UI, never on the document the desktop shell shares");
  assert.match(boot, /form\.closest\("\.content"\)/,
    "the Lens content root is the scope, so shell chrome outside it stays instant");

  const client = readFileSync("./src/client/lens.js", "utf8");
  const holders = new Set(
    [...client.matchAll(/(\w+)\s*=\s*new URLSearchParams\(location\.search\)\s*;/g)].map((m) => m[1]),
  );
  const read = new Set();
  for (const m of client.matchAll(/new URLSearchParams\(location\.search\)\.(?:get|has)\("([\w-]+)"\)/g)) read.add(m[1]);
  for (const name of holders) {
    for (const m of client.matchAll(new RegExp(`\\b${name}\\.(?:get|has)\\("([\\w-]+)"\\)`, "g"))) read.add(m[1]);
  }
  assert.ok(read.size >= 5, `lens.js URL-parameter scan found ${read.size} reads, so the pattern stopped matching`);
  const hydrated = new Set(
    (boot.match(/\[(?:\s*"[\w-]+",?)+\s*\]/) || [""])[0].match(/"([\w-]+)"/g)?.map((q) => q.slice(1, -1)) || [],
  );
  for (const key of read) {
    assert.ok(hydrated.has(key), `lens.js reads ?${key}= but lens-boot.js will not eagerly hydrate for it`);
  }

  assert.deepEqual(minifiedScripts().find((row) => row.file === "lens-boot.js"),
    { file: "lens-boot.js", twin: "/lens-boot.src.js", marker: "requestSubmit", module: false },
    "the bootstrap must be minified with a readable source twin");
  const order = hashOrder().map((asset) => asset.file);
  const at = (file) => {
    assert.ok(order.includes(file), `${file} must be content-hashed`);
    return order.indexOf(file);
  };
  for (const feature of ["lens-browser.js", "lens-reader.js", "lens-wire.js", "lens-tools.js", "lens-nlweb.js", "lens-markdown.js"]) {
    assert.ok(at(feature) < at("lens.js"), `${feature} must be hashed before the application that loads it`);
  }
  assert.ok(at("lens.js") < at("lens-boot.js") && at("lens-webmcp.js") < at("lens-boot.js"),
    "the bootstrap must be hashed last, so the shell receives a URL covering the whole lazy chain");
});

test("the reader never renders an unmeasurable phase as 0 ms", () => {
  const client = readFileSync("./src/client/lens-reader.js", "utf8");
  // A Worker's clock advances across I/O and never during synchronous execution,
  // so `parse`, `extract` and `markdown` come back 0 from production while
  // `fetch` carries real time. Measured through the live route 2026-08-10:
  // stripe.com answered {fetch: 104, parse: 0, extract: 0, markdown: 0} where the
  // same run under wrangler dev had reported 30 / 347 / 10.
  assert.match(client, /return value > 0 \? value \+ " ms" : "not measurable/,
    "a zero-valued timing phase must render as unmeasurable, never as 0 ms");
  assert.match(client, /never during synchronous execution/,
    "the panel must explain WHY those phases read zero");
  assert.doesNotMatch(client, /ms\.extract \+/,
    "the headline total must not sum phases the clock cannot see");
});

test("the cracker's scorer matches the quadgram table it ships", () => {
  const table = readFileSync("./public/lwe/quadgrams.txt", "utf8");
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");

  assert.match(table, /^[A-Z]+$/, "the table must be bare A-Z with no counts, separators or trailing newline");
  assert.equal(table.length % 4, 0, "the table must be whole quadgrams");
  const grams = table.length / 4;
  assert.equal(grams, 4000, `the page's prose and gauge thresholds were measured at 4,000 grams, got ${grams}`);

  const seen = new Set();
  for (let i = 0; i < table.length; i += 4) seen.add(table.slice(i, i + 4));
  assert.equal(seen.size, grams, "a duplicated quadgram would give one gram two ranks");
  assert.equal(table.slice(0, 4), "THAT", "the table must stay in frequency order; TOP is calibrated to the first entry");

  const top = Number(page.match(/var TOP = (-[\d.]+)/)[1]);
  const floor = Number(page.match(/FLOOR = (-[\d.]+)/)[1]);
  assert.ok(top > floor, "an observed quadgram must outscore an unseen one");
  assert.ok(top > -3 && top < -2, `TOP looks recalibrated (${top}); rerun gen-quadgram-table.mjs and update the page`);
  assert.ok(floor > -10 && floor < -8, `FLOOR looks recalibrated (${floor})`);

  const wire = brotliCompressSync(Buffer.from(table), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  const claimed = Number(page.match(/<b>([\d.]+) KB<\/b> over the wire/)[1]);
  assert.ok(Math.abs(wire / 1024 - claimed) < 0.15,
    `the page claims ${claimed} KB over the wire, the table brotlis to ${(wire / 1024).toFixed(1)} KB`);
});

test("the cracker reports a verdict rather than always answering", () => {
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");
  assert.match(page, /<b>failed\.<\/b>/, "a run that did not solve must say so");
  // The scorer and its shrinkage, since both words also appear in comments and
  // in PERIOD_PSEUDO, which is a different estimate.
  assert.match(page, /function confidence\(L\)/, "the verdict must carry a confidence");
  assert.match(page, /\+ PSEUDO \* FLOOR\) \/ \(w \+ PSEUDO\)/, "confidence must be shrunk toward random on short text");
  assert.match(page, /margin over runner-up/, "the verdict must report the margin to the next candidate");
  assert.match(page, /letters per column/, "the gauge must be per column, not per message");
  assert.match(page, /per >= 20/, "the measured comfortable threshold is 20 letters per column");
});

test("the reader's 429 carries the site limiter's Retry-After and RateLimit fields", async () => {
  const index = readFileSync("lens-reader/src/index.ts", "utf8");
  assert.match(index, /import \{[^}]*\brateLimitedHeaders\b[^}]*\} from "\.\.\/\.\.\/src\/worker\/lib\/ratelimit\.ts"/);
  const refusal = index.slice(index.indexOf("overBudget(READER_BUDGET"), index.indexOf("try {", index.indexOf("overBudget(READER_BUDGET")));
  assert.match(refusal, /429, rateLimitedHeaders\("reader", READER_LIMIT_PER_MIN\)\)/, "the 429 names the reader policy and its real quota");
  assert.match(index, /json\(await read\(target\.url\), 200, \{ "ratelimit-policy": rateLimitPolicy\("reader", READER_LIMIT_PER_MIN\) \}\)/, "a served read names the policy too");
});
