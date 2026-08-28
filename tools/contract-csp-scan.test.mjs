// ── the CSP hash scanner ────────────────────────────────────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import {
  assert,
  test,
} from "./contract-shared.ts";

// build.ts step 7c reads documents with HTMLRewriter, a bun global. The suite
// runs under bun, so this is a guard for `bun run test:node` rather than a real
// skip, matching contract-link-integrity.test.mjs.
const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };
const scan = async (html) => (await import("./lib/csp-scan.ts")).scanDocument(html, "fixture.html");

// sha256-base64 of the empty string, which is what an empty executable block
// hashes to. Spelled out rather than computed, so a scanner that returned the
// hash of something else could not agree with a helper that made the same
// mistake.
const EMPTY_SHA = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

test("only the scripts a browser would EXECUTE are hashed", needsParser, async () => {
  const { hashes } = await scan(`<!doctype html><html><body>
    <script>console.log(1)</script>
    <script type="module">export default 1</script>
    <script type="speculationrules">{"prerender":[]}</script>
    <script type="application/json" id="luq-data">{"answer":"b"}</script>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
    <script src="/nav.js" defer></script>
  </body></html>`);

  // Three executable blocks: bare, module, speculationrules. The two data blocks
  // are parsed as data and never reach script-src, and 31 of this site's inline
  // blocks are data, so a scanner that is wrong here is wrong 31 times. The
  // external one is covered by 'self'.
  assert.equal(hashes.length, 3, `expected 3 executable blocks, got ${hashes.length}`);
  assert.ok(hashes.every((h) => /^[A-Za-z0-9+/]+=*$/.test(h)), "hashes are base64");
  assert.equal(new Set(hashes).size, 3, "three different bodies hash three different ways");
});

test("an empty inline script still gets the hash of the empty string", needsParser, async () => {
  // It has no text node at all, which is why the capture closes on the END TAG
  // rather than on the last text chunk. Dropping it would leave the page needing
  // a hash the header does not carry, and the block silently blocked.
  const { hashes } = await scan(`<script></script>`);
  assert.deepEqual(hashes, [EMPTY_SHA]);
});

test("an empty script does not swallow the text that follows it", needsParser, async () => {
  // The reason the text handler is scoped to `script` rather than to `*`. An
  // empty script emits NO text chunk, so a `*` handler hands it the next text
  // the stream produces, which is whatever follows the close tag. Measured with
  // a `*` handler on this exact fixture: the body comes back as "following
  // text", so the page ships a hash for a script that does not exist and the
  // real empty block stays blocked.
  const { hashes } = await scan(`<script></script><p>following text</p>`);
  const [empty] = (await scan(`<script></script>`)).hashes;
  assert.deepEqual(hashes, [empty], "the empty script must hash the empty string, not its neighbour");
});

test("a script body is hashed as its SOURCE bytes, undecoded", needsParser, async () => {
  // Raw-text content arrives in chunks split on `<` and is not entity-decoded,
  // which is what the browser hashes too. If HTMLRewriter ever started decoding,
  // every hash on a page containing `&amp;` in a script would silently move.
  const [withEntity] = (await scan(`<script>a &amp; b</script>`)).hashes;
  const [literal] = (await scan(`<script>a &amp; b</script>`)).hashes;
  const [decoded] = (await scan(`<script>a & b</script>`)).hashes;
  assert.equal(withEntity, literal);
  assert.notEqual(withEntity, decoded, "the entity must NOT be decoded before hashing");
});

test("an inline event handler is reported, and demo TEXT that looks like one is not", needsParser, async () => {
  // THE CONTROL THAT COST THE OLD SCANNER THREE PATCHES. /garage/horizon ships
  // an XSS demo whose default payload is an attribute VALUE, and a naive
  // /\son\w+=/ over the raw tag reads it as a live handler and sends you
  // refactoring a string literal. A parser cannot make that mistake.
  const { handlers } = await scan(`<!doctype html><html><body>
    <input value="&lt;img src=x onerror=alert(1)&gt;">
    <textarea>&lt;div onclick=boom()&gt;</textarea>
    <button onclick="boom()">go</button>
  </body></html>`);

  assert.equal(handlers.length, 1, `expected exactly the real handler, got ${handlers.length}: ${handlers.join(", ")}`);
  assert.match(handlers[0], /<button onclick=/);

  // The trap, asserted rather than described, so it cannot quietly stop being
  // true of this fixture: the naive scanner finds THREE handlers in the same
  // bytes, and two of them are content.
  const naive = `<input value="&lt;img src=x onerror=alert(1)&gt;">
    <textarea>&lt;div onclick=boom()&gt;</textarea>
    <button onclick="boom()">go</button>`.match(/\son\w+=/g) || [];
  assert.equal(naive.length, 3, "the naive regex is supposed to be wrong here; if it is not, this fixture stopped testing anything");
});

test("a srcdoc document's scripts are hashed against the EMBEDDING page", needsParser, async () => {
  // A srcdoc document INHERITS the parent's CSP, so its scripts are checked
  // against this page's script-src. The old walker stepped over the whole
  // attribute, which is what kept the inner `<script>` from reading as a real
  // one, so the hashes were silently short by exactly the scripts nobody can
  // see. /garage/horizon's #mb-frame uptime counter is the live instance:
  // enforcing without this froze it at 0 with nothing logged.
  const plain = await scan(`<script>tick()</script>`);
  const framed = await scan(`<iframe srcdoc="&lt;script&gt;tick()&lt;/script&gt;"></iframe>`);
  assert.deepEqual(framed.hashes, plain.hashes,
    "the srcdoc script must hash exactly as the same script would in the parent");
});

test("hashes come back in DOCUMENT ORDER", needsParser, async () => {
  // The map is serialised into lib/csp-hashes.ts, so a reordering is a changed
  // Worker bundle for nothing.
  const one = (await scan(`<script>1</script>`)).hashes[0];
  const two = (await scan(`<script>2</script>`)).hashes[0];
  assert.deepEqual((await scan(`<script>1</script><script>2</script>`)).hashes, [one, two]);
  assert.deepEqual((await scan(`<script>2</script><script>1</script>`)).hashes, [two, one]);
});

test("an unterminated script hashes the body a browser would run", needsParser, async () => {
  // The old hand-rolled walker THREW here, because it went looking for a close
  // tag and found none. That was a property of the walker rather than a real
  // invariant: a browser runs an unterminated script to end of document, and
  // lol-html agrees, closing the text node at EOF. Probed rather than assumed.
  // So the parser's answer is the browser's answer, and hashing it is right;
  // throwing would refuse to cover a block that really does execute.
  const [open] = (await scan(`<script>never closed`)).hashes;
  const [closed] = (await scan(`<script>never closed</script>`)).hashes;
  assert.equal(open, closed, "an unterminated script hashes as if it closed at EOF");
});

test("the parser requirement is stated by name", async () => {
  // Under node the global is absent and the build would otherwise die on an
  // undefined symbol somewhere inside a stream transform.
  const { PARSER_MISSING, requireParser } = await import("./lib/csp-scan.ts");
  assert.match(PARSER_MISSING, /HTMLRewriter/);
  assert.match(PARSER_MISSING, /bun run build/);
  if (typeof HTMLRewriter === "undefined") assert.throws(requireParser, /HTMLRewriter/);
  else assert.doesNotThrow(requireParser);
});
