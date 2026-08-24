// ── the Reader lens (/lens/read, lens-reader/) ───────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  brotliCompressSync,
  readFileSync,
  test,
  zlibConstants,
} from "./contract-shared.ts";

// ── the Reader lens (/lens/read, lens-reader/) ───────────────────────────────
// The Reader lens is the one /lens surface that lives in a DIFFERENT Worker, so
// nothing about it is covered by the site Worker's own dry-run or route sweep.
// These tests stand in for that: they pin the numbers a message quotes, the
// single SSRF guard, and the two traps this feature actually hit.
//
// EVERY assertion below reads SOURCE TEXT and imports nothing from lens-reader/.
// That is a hard constraint, not a style: this suite runs under plain node with
// the ROOT workspace's dependencies, and lens-reader/src/reader.ts imports
// readability and linkedom, which live only in that sub-project. Importing
// it here fails with ERR_MODULE_NOT_FOUND in CI while passing on any workstation
// that happens to have run `pnpm install` in lens-reader/ — which is exactly how
// this was caught (PR #299, first run). Same family as gotcha 16: what this file
// imports has to resolve under bare node, forever.
//
// The behavioural half lives in lens-reader/test/reader.test.mjs, run by the CI
// step that installs those dependencies.

test("the reader's rate-limit message quotes the ceiling wrangler declares", async () => {
  const src = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const constant = src.match(/export const READER_LIMIT_PER_MIN = (\d+)/);
  assert.ok(constant, "reader.js no longer exports READER_LIMIT_PER_MIN");
  const READER_LIMIT_PER_MIN = Number(constant[1]);
  const toml = readFileSync("./lens-reader/wrangler.toml", "utf8");
  const declared = toml.match(/\[\[ratelimits\]\][\s\S]*?simple\s*=\s*\{[^}]*limit\s*=\s*(\d+)/);
  assert.ok(declared, "lens-reader/wrangler.toml declares no ratelimit");
  // Same discipline as LENS_BUDGETS on the site Worker: the constant is what the
  // 429 message quotes, the toml is what actually throttles, and a message that
  // outlives its limit is worse than no message at all.
  assert.equal(READER_LIMIT_PER_MIN, Number(declared[1]),
    "the reader's 429 message would quote a limit the binding does not enforce");
});

test("the reader minifies its dependency-heavy deploy without losing source locations", () => {
  const toml = readFileSync("./lens-reader/wrangler.toml", "utf8");
  assert.match(toml, /^minify\s*=\s*true$/m,
    "the Reader Worker should minify its dependency-heavy production bundle");
  assert.match(toml, /^upload_source_maps\s*=\s*true$/m,
    "Reader minification must retain original source locations in Workers Logs");
});

test("the reader Worker shares the site's SSRF guard rather than copying it", async () => {
  const reader = readFileSync("./lens-reader/src/reader.ts", "utf8");
  const entry = readFileSync("./lens-reader/src/index.ts", "utf8");
  // A second Worker aiming a visitor-supplied URL at the public internet is the
  // same SSRF surface /lens/fetch has. Two copies of an allowlist pass review on
  // the day they are written and diverge quietly afterwards, so this asserts the
  // import exists AND that no local redefinition shadows it.
  for (const [name, src] of [["reader.ts", reader], ["index.ts", entry]]) {
    assert.match(src, /from "\.\.\/\.\.\/src\/worker\/lib\/crawl\.(js|ts)"/,
      `lens-reader/src/${name} must import the shared guard, not reimplement it`);
    assert.doesNotMatch(src, /function\s+validateLensTarget|function\s+privateHostBlocked/,
      `lens-reader/src/${name} redefines a guard it is supposed to be importing`);
  }
  // And the site's export is still the shared one, so moving it did not leave
  // lens.js with a stale private copy that only IT uses.
  const crawl = await import("../src/worker/lib/crawl.ts");
  const lens = await import("../src/worker/lens.ts");
  assert.equal(lens.validateLensTarget, crawl.validateLensTarget,
    "lens.js and lib/crawl.js must expose the same function object, not two copies");
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
  // The whole point of this lens is the GAP. A payload that reported only the
  // extraction would read as "here is the page", which is the claim /lens exists
  // to complicate — an extractor is guessing, and on a landing page it guesses
  // badly (stripe.com, 2026-08-09: 55% of the words gone, hero headline first).
  assert.match(reader, /dropped:\s*\{/, "the payload must carry a dropped tally");
  assert.match(reader, /source[\s\S]{0,200}kept/, "the payload must carry both counts");
  assert.match(client, /What the extractor threw away/, "the pane must lead with the gap");
  // And it must never present itself as the served bytes.
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
  // The strip renders from LENS_TAB_ORDER, so a key with no label ships an empty
  // button rather than failing. The client keeps its own LENS_LABEL map (no
  // module graph on /lens), which is exactly the pair that can drift.
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
  // The client validates ?lens= against its OWN allowlist before honouring it.
  // That list was hand-written and stopped at six while the strip grew to eight,
  // so ?lens=reader and ?lens=wire fell back to Raw response — a deep link that
  // looks like it worked. Deriving it from LENS_LABEL is what makes the two
  // impossible to separate; this pins the derivation rather than the contents,
  // because pinning the contents is precisely what rotted.
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
  const build = readFileSync("./tools/build.ts", "utf8");

  assert.match(server, /scripts: `<script src="\/lens-boot\.js" defer><\/script>`/,
    "the server-rendered idle shell must load only the bootstrap");
  assert.doesNotMatch(server, /scripts: `<script src="\/lens\.js"/,
    "the full Lens application must not sit on the passive render path");
  assert.match(boot, /import\("\/lens\.js\?v=1"\)/,
    "the bootstrap must load the full application through the build's hashable specifier");
  assert.match(boot, /root\.addEventListener\("click", click, true\)/,
    "a cold button click must be captured before the unloaded application can miss it");
  assert.match(boot, /root\.addEventListener\("submit", submit, true\)/,
    "a cold form submission must be captured before the unloaded application can miss it");
  assert.match(boot, /form\.requestSubmit\(submitter \|\| undefined\)/,
    "the first form action must be replayed with its original submitter");

  // The capture click handler calls stopImmediatePropagation, so its ROOT decides
  // which buttons wait on a module they may not need. nav.js injects Back and
  // Forward into every window title bar, outside .content, so a document-level
  // binding made the shell's own chrome pay for the Lens client. Assert the
  // negative too: the four listeners moving back to `document` is the exact
  // regression, and only the positive match would still pass if both existed.
  assert.doesNotMatch(boot, /document\.addEventListener\(/,
    "the bootstrap must bind inside the Lens UI, never on the document the desktop shell shares");
  assert.match(boot, /form\.closest\("\.content"\)/,
    "the Lens content root is the scope, so shell chrome outside it stays instant");

  // The eager-hydrate list is a COPY of what the client reads off the URL, and a
  // copy pinned to a literal cannot notice the original growing: adding a sixth
  // parameter to lens.js would leave this green while that deep link rendered
  // the idle shell. Derive the expectation from the client instead. This is the
  // same failure the ?lens= tab list already had once, where a hand-written array
  // of six sat beside a strip of eight.
  const client = readFileSync("./src/client/lens.js", "utf8");
  const holders = new Set(
    [...client.matchAll(/(\w+)\s*=\s*new URLSearchParams\(location\.search\)\s*;/g)].map((m) => m[1]),
  );
  const read = new Set();
  for (const m of client.matchAll(/new URLSearchParams\(location\.search\)\.(?:get|has)\("([\w-]+)"\)/g)) read.add(m[1]);
  for (const name of holders) {
    for (const m of client.matchAll(new RegExp(`\\b${name}\\.(?:get|has)\\("([\\w-]+)"\\)`, "g"))) read.add(m[1]);
  }
  // A scanner that matches nothing reports a pass, which is how the twin-facts
  // check and the CSP attribute scan each shipped asserting zero. Floor it.
  assert.ok(read.size >= 5, `lens.js URL-parameter scan found ${read.size} reads, so the pattern stopped matching`);
  const hydrated = new Set(
    (boot.match(/\[(?:\s*"[\w-]+",?)+\s*\]/) || [""])[0].match(/"([\w-]+)"/g)?.map((q) => q.slice(1, -1)) || [],
  );
  for (const key of read) {
    assert.ok(hydrated.has(key), `lens.js reads ?${key}= but lens-boot.js will not eagerly hydrate for it`);
  }

  assert.match(build, /\["lens-boot\.js", "\/lens-boot\.src\.js", "requestSubmit"\]/,
    "the bootstrap must be minified with a readable source twin");
  assert.match(build, /\{ file: "\/lens\.js",\s+base: "lens"/,
    "the full client must be content-hashed as a string-loaded dependency");
  assert.match(build, /from: "\/lens-boot\.js",\s+base: "lens-boot"/,
    "the shell must receive the final content-hashed bootstrap");
  assert.ok(build.indexOf('{ file: "/lens-tools.js"') < build.indexOf('{ file: "/lens.js"'),
    "Lens feature modules must be hashed before the application that loads them");
  assert.ok(build.indexOf("for (const a of STRING_ASSETS)") < build.indexOf("for (const a of ASSETS)"),
    "string-loaded applications must be hashed before the shell assets that import them");
});

test("the reader never renders an unmeasurable phase as 0 ms", () => {
  const client = readFileSync("./src/client/lens-reader.js", "utf8");
  // A Worker's clock advances across I/O and never during synchronous execution,
  // so `parse`, `extract` and `markdown` come back 0 from production while
  // `fetch` carries real time. Measured through the live route 2026-08-10:
  // stripe.com answered {fetch: 104, parse: 0, extract: 0, markdown: 0} where the
  // same run under wrangler dev had reported 30 / 347 / 10.
  //
  // Rendering those zeros would tell a visitor that parsing a 645 KB page is
  // free, on the one panel whose job is saying what the read cost. This is the
  // same class of claim the rest of the lens is built to avoid, so it is pinned.
  assert.match(client, /not measurable/,
    "a zero-valued timing phase must render as unmeasurable, never as 0 ms");
  assert.match(client, /never during synchronous execution/,
    "the panel must explain WHY those phases read zero");
  assert.doesNotMatch(client, /ms\.extract \+/,
    "the headline total must not sum phases the clock cannot see");
});

test("the cracker's scorer matches the quadgram table it ships", () => {
  // The /lwe/vigenere cracker fetches public/lwe/quadgrams.txt and derives every
  // score from a gram's RANK in that file, so the file's SHAPE is part of the
  // scorer. Regenerating it at a different size, or with counts left in, changes
  // what the solver computes while both the page and the table still look fine.
  // Nothing else in the build reads this file, so this is the only thing that
  // would notice.
  const table = readFileSync("./public/lwe/quadgrams.txt", "utf8");
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");

  assert.match(table, /^[A-Z]+$/, "the table must be bare A-Z with no counts, separators or trailing newline");
  assert.equal(table.length % 4, 0, "the table must be whole quadgrams");
  const grams = table.length / 4;
  assert.equal(grams, 4000, `the page's prose and gauge thresholds were measured at 4,000 grams, got ${grams}`);

  const seen = new Set();
  for (let i = 0; i < table.length; i += 4) seen.add(table.substr(i, 4));
  assert.equal(seen.size, grams, "a duplicated quadgram would give one gram two ranks");
  assert.equal(table.slice(0, 4), "THAT", "the table must stay in frequency order; TOP is calibrated to the first entry");

  // TOP is log10 of the most common quadgram's corpus share and FLOOR is an
  // unseen one. gen-quadgram-table.mjs prints both; the page hardcodes them,
  // and a table rebuilt from a different corpus moves them.
  const top = Number(page.match(/var TOP = (-[\d.]+)/)[1]);
  const floor = Number(page.match(/FLOOR = (-[\d.]+)/)[1]);
  assert.ok(top > floor, "an observed quadgram must outscore an unseen one");
  assert.ok(top > -3 && top < -2, `TOP looks recalibrated (${top}); rerun gen-quadgram-table.mjs and update the page`);
  assert.ok(floor > -10 && floor < -8, `FLOOR looks recalibrated (${floor})`);

  // The page states the wire cost as a fact. It is a fact about these bytes.
  const wire = brotliCompressSync(Buffer.from(table), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  const claimed = Number(page.match(/<b>([\d.]+) KB<\/b> over the wire/)[1]);
  assert.ok(Math.abs(wire / 1024 - claimed) < 0.15,
    `the page claims ${claimed} KB over the wire, the table brotlis to ${(wire / 1024).toFixed(1)} KB`);
});

test("the cracker reports a verdict rather than always answering", () => {
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");
  // A solver that always returns its best guess is indistinguishable from one
  // that solved the cipher, which is the whole reason step 4 exists. The three
  // outcomes and the sample-size shrinkage are the load-bearing parts.
  assert.match(page, /<b>failed\.<\/b>/, "a run that did not solve must say so");
  assert.match(page, /confidence/, "the verdict must carry a confidence");
  assert.match(page, /PSEUDO/, "confidence must be shrunk toward random on short text");
  assert.match(page, /margin over runner-up/, "the verdict must report the margin to the next candidate");
  // The gauge predicts failure BEFORE the run, from letters per column, which is
  // the number that actually governs it. These thresholds were measured.
  assert.match(page, /letters per column/, "the gauge must be per column, not per message");
  assert.match(page, /per >= 20/, "the measured comfortable threshold is 20 letters per column");
});
