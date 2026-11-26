// ── title, meta and the Lens receipt are found in linear time ───────────────
// extractTitle and extractMeta read crawled pages and webmention sources, and
// lensFindReceipt reads what a Lens render returned: text the other origin
// wrote, up to 1 MB. Until 2026-11-20 each was one regex that rescanned to the
// end from every opener it could not match, and 256 KB of "<meta " took 6.5 s
// in Node 26. The fuzz pins each scan to the regex it replaced; the budget is
// about 50x what the scans take on 256 KB.
import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { lensFindReceipt } from "../lens-recipes.ts";
import { extractMeta, extractTitle } from "../lib/http.ts";

const BUDGET_MS = 50;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const metaRe = (name: string) =>
  new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']`, "i");
const RECEIPT_RE = /<script[^>]*\bid=["']?lens-recipe-receipt["']?[^>]*>([\s\S]*?)<\/script\s*>/i;

const TOKENS = [
  ...[" ", "x", ">", '"', "'", "\n", "=", "&lt;", "&amp;", "<", "/"],
  ...["<meta", "<META ", " name=", "NAME=", "property=", "content=", "Content=", "description", "DESCRIPTION", "og:image", "author"],
  ...["<title>", "<TITLE a>", "<title", "</title>", "</TITLE>", " t "],
  ...["<script", "<SCRIPT ", " id=", "aid=", "-id=", "lens-recipe-receipt", "LENS-RECIPE-RECEIPT", "</script>", "</script >", "</script"],
  // Whole attributes, so a 30-token draw assembles a match often enough to test it.
  ...["<meta ", ' name="description"', " property='og:image'", ' content="v"', " content='w > z'", ' content=""', ' content="'],
  ...["<script id=lens-recipe-receipt>", '<script id="lens-recipe-receipt"', "<title>t</title>"],
];

// mulberry32, seeded so a failure names an input that reproduces.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function* inputs(count: number) {
  const next = random(0x7a9);
  for (let n = 0; n < count; n++) {
    let html = "";
    for (let k = Math.floor(next() * 30); k > 0; k--) html += TOKENS[Math.floor(next() * TOKENS.length)];
    yield html;
  }
}

test("each scan finds what the regex it replaced found", () => {
  const found = { title: 0, meta: 0, receipt: 0 };
  for (const html of inputs(60000)) {
    // A capture holds no closer (title) and no quote (meta), so wrapping it in
    // the plainest match runs it through the same trim, decode and slice.
    const title = html.match(TITLE_RE);
    if (title) found.title++;
    assert.equal(extractTitle(html), title ? extractTitle(`<title>${title[1]}</title>`) : "", `title of ${JSON.stringify(html)}`);
    for (const name of ["description", "og:image"]) {
      const meta = html.match(metaRe(name));
      if (meta) found.meta++;
      assert.equal(extractMeta(html, name), meta ? extractMeta(`<meta name="${name}" content="${meta[1]}">`, name) : "", `${name} of ${JSON.stringify(html)}`);
    }
    const receipt = html.match(RECEIPT_RE);
    if (receipt) found.receipt++;
    const want = receipt ? { start: receipt.index, end: (receipt.index ?? 0) + receipt[0].length, json: receipt[1] } : null;
    assert.deepEqual(lensFindReceipt(html), want, `receipt in ${JSON.stringify(html)}`);
  }
  for (const [scan, n] of Object.entries(found)) assert.ok(n > 500, `only ${n} ${scan} matches, so the fuzz barely ran the matching path`);
  assert.equal(extractMeta(`<META x NAME='Description' a content="one" content='two > three'>`, "description"), "two > three");
  assert.equal(extractTitle("<title a>x</title><title>y</title>"), "x");
  assert.deepEqual(lensFindReceipt('<p><script id="lens-recipe-receipt" type=x>{"a":1}</script >'), { start: 3, end: 60, json: '{"a":1}' });
});

test("the scans stay inside the budget on 256 KB of openers that cannot match", () => {
  const fill = (unit: string) => unit.repeat(Math.floor((256 * 1024) / unit.length));
  const cases: [string, () => unknown, unknown][] = [
    ["<title>", () => extractTitle(fill("<title>")), ""],
    ["<title ", () => extractTitle(fill("<title ")), ""],
    ["<meta ", () => extractMeta(fill("<meta "), "description"), ""],
    ['name="description" in one tag', () => extractMeta(`<meta ${fill('name="description" ')}`, "description"), ""],
    ["meta tags with no content=", () => extractMeta(fill('<meta name="author" x>'), "author"), ""],
    ["meta then the real tag", () => extractMeta(`${fill("<meta ")}><meta name="author" content="Ada">`, "author"), "Ada"],
    ["<script ", () => lensFindReceipt(fill("<script ")), null],
    ["<script before one >", () => lensFindReceipt(`${fill("<script ")}>`), null],
    ["id=receipt in one tag", () => lensFindReceipt(`<script ${fill("id=lens-recipe-receipt ")}`), null],
    ["receipt openers, no closer", () => lensFindReceipt(fill("<script id=lens-recipe-receipt>")), null],
  ];
  for (const [label, run, want] of cases) {
    const start = performance.now();
    const got = run();
    const ms = performance.now() - start;
    assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms on 256 KB`);
    assert.deepEqual(got, want, label);
  }
});
