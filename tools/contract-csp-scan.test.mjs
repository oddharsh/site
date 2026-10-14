// ── the CSP hash scanner ────────────────────────────────────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import {
  assert,
  test,
} from "./contract-shared.ts";

const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };
const scan = async (html) => (await import("./lib/csp-scan.ts")).scanDocument(html, "fixture.html");

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

  assert.equal(hashes.length, 3, `expected 3 executable blocks, got ${hashes.length}`);
  assert.ok(hashes.every((h) => /^[A-Za-z0-9+/]+=*$/.test(h)), "hashes are base64");
  assert.equal(new Set(hashes).size, 3, "three different bodies hash three different ways");
});

test("an empty inline script still gets the hash of the empty string", needsParser, async () => {
  const { hashes } = await scan(`<script></script>`);
  assert.deepEqual(hashes, [EMPTY_SHA]);
});

test("an empty script does not swallow the text that follows it", needsParser, async () => {
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
  const { handlers } = await scan(`<!doctype html><html><body>
    <input value="&lt;img src=x onerror=alert(1)&gt;">
    <textarea>&lt;div onclick=boom()&gt;</textarea>
    <button onclick="boom()">go</button>
  </body></html>`);

  assert.equal(handlers.length, 1, `expected exactly the real handler, got ${handlers.length}: ${handlers.join(", ")}`);
  assert.match(handlers[0], /<button onclick=/);

  const naive = `<input value="&lt;img src=x onerror=alert(1)&gt;">
    <textarea>&lt;div onclick=boom()&gt;</textarea>
    <button onclick="boom()">go</button>`.match(/\son\w+=/g) || [];
  assert.equal(naive.length, 3, "the naive regex is supposed to be wrong here; if it is not, this fixture stopped testing anything");
});

test("a srcdoc document's scripts are hashed against the EMBEDDING page", needsParser, async () => {
  const plain = await scan(`<script>tick()</script>`);
  const framed = await scan(`<iframe srcdoc="&lt;script&gt;tick()&lt;/script&gt;"></iframe>`);
  assert.deepEqual(framed.hashes, plain.hashes,
    "the srcdoc script must hash exactly as the same script would in the parent");
});

test("hashes come back in DOCUMENT ORDER", needsParser, async () => {
  const one = (await scan(`<script>1</script>`)).hashes[0];
  const two = (await scan(`<script>2</script>`)).hashes[0];
  assert.deepEqual((await scan(`<script>1</script><script>2</script>`)).hashes, [one, two]);
  assert.deepEqual((await scan(`<script>2</script><script>1</script>`)).hashes, [two, one]);
});

test("an unterminated script hashes the body a browser would run", needsParser, async () => {
  const [open] = (await scan(`<script>never closed`)).hashes;
  const [closed] = (await scan(`<script>never closed</script>`)).hashes;
  assert.equal(open, closed, "an unterminated script hashes as if it closed at EOF");
});

test("the parser requirement is stated by name", async () => {
  const { PARSER_MISSING, requireParser } = await import("./lib/csp-scan.ts");
  assert.match(PARSER_MISSING, /HTMLRewriter/);
  assert.match(PARSER_MISSING, /bun run build/);
  if (typeof HTMLRewriter === "undefined") assert.throws(requireParser, /HTMLRewriter/);
  else assert.doesNotThrow(requireParser);
});
