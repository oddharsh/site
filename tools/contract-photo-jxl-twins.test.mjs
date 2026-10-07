// ── an original's lossless JPEG XL twin ─────────────────────────────
// Each full-resolution original is a JPEG in R2, and tools/photos/jxl-originals.ts
// (or add-photos.sh, for a new photo) puts a lossless JPEG XL transcode beside
// it. The index names a twin only after it rebuilt the JPEG byte for byte and
// uploaded. These pin the rest of the path: the twin's key, the links that
// carry it, the script that follows it only where JPEG XL decodes, and the
// route that serves it.
import vm from "node:vm";
import { assert, derivePhotoPool, readFile, renderPhotoSlots, ROOT, test } from "./contract-shared.ts";
import { JXL_SWAP } from "../src/worker/lib/photo-jxl.ts";
import { servePhotoFromR2 } from "../src/worker/photos.ts";
import { CAP, HEIF_RATIO, TWIN_RATIO, UNINDEXED, indexFloor, parseSize } from "./photos/r2-budget.ts";

// ── the R2 budget ───────────────────────────────────────────────────
// The bucket must stay inside R2's free tier, and Cloudflare's own size lags
// uploads by many minutes, so the guard also trusts a floor computed from the
// index. These pin the arithmetic both upload paths rely on.
test("the R2 budget reads wrangler's sizes and floors the bucket from the index", () => {
  assert.equal(parseSize("10.2 GB"), 10.2e9);
  assert.equal(parseSize("512 MB"), 512e6);
  assert.equal(parseSize("0 B"), 0);
  assert.throws(() => parseSize("about ten gigs"), /unreadable/);
  const floor = indexFloor({
    A: { full: "A.jpg", size: 100 },
    B: { full: "B.jpg", size: 100, jxl: "B.jxl" },
    C: { full: "C.jpg", size: 100, jxl: "C.jxl", heif: "C.HIF" },
  });
  assert.equal(floor, UNINDEXED + 300 + 200 * TWIN_RATIO + 100 * HEIF_RATIO);
  // Control: the cap sits under the free tier, and the twin ratio over every
  // measured twin (worst 0.943), so the floor can only overstate.
  assert.ok(CAP < 10e9 && TWIN_RATIO > 0.943);
});

const row = (extra = {}) => ({
  full: "X1.jpg", stem: "X1", size: 10, uploaded: null,
  thumb_avif: "/i/X1.aaaaaaaa.avif", thumb_jpg: "/i/X1.bbbbbbbb.jpg", thumb_small: "/i/X1-400.cccccccc.avif", thumb_xs: null,
  ...extra,
});

test("a twin is the original's own key with a .jxl extension, and only a JPEG has one", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  for (const [stem, entry] of Object.entries(index)) {
    if (!entry.jxl) continue;
    assert.match(entry.full, /\.jpe?g$/i, `${stem}: only a JPEG transcodes losslessly to JPEG XL`);
    assert.equal(entry.jxl, entry.full.replace(/\.[^.]+$/, ".jxl"), `${stem}: the twin sits beside its original`);
  }
});

test("a tile links the JPEG and carries the twin in data-jxl, on both grids", async () => {
  const hashes = { X1: { a: "aaaaaaaa", j: "bbbbbbbb", s: "cccccccc" } };
  const [withTwin] = derivePhotoPool({ X1: { full: "X1.jpg", size: 10, jxl: "X1.jxl" } }, hashes);
  const [without] = derivePhotoPool({ X1: { full: "X1.jpg", size: 10 } }, hashes);
  assert.equal(withTwin.jxl, "X1.jxl");
  assert.equal(without.jxl, null);
  for (const deferred of [true, false]) {
    const html = renderPhotoSlots([withTwin], {}, { deferred }).html;
    assert.match(html, /href="\/images\/full\/X1\.jpg"/, "the href stays the JPEG for crawlers and no-JS visitors");
    assert.match(html, /data-jxl="\/images\/full\/X1\.jxl"/);
    // Control: a photo without a twin must not point anywhere new.
    assert.doesNotMatch(renderPhotoSlots([without], {}, { deferred }).html, /data-jxl/);
  }
  assert.ok(renderPhotoSlots([row({ jxl: "X1.jxl" })], {}).html.includes("data-jxl"));
});

test("the homepage carries JXL_SWAP byte for byte, since a static page can't import it", async () => {
  const page = await readFile(new URL("src/pages/index.html", ROOT), "utf8");
  assert.ok(page.includes(JXL_SWAP.html), "src/pages/index.html must hold the exact JXL_SWAP script");
  const worker = await readFile(new URL("src/worker/photos.ts", ROOT), "utf8");
  assert.equal(worker.match(/\$\{JXL_SWAP(\.html)?\}/g)?.length, 2, "the contact sheet and every album page run it too");
});

// Run the real script against a fake page: a 1px probe that did or didn't
// decode, and one link being pressed.
function runSwap(naturalWidth) {
  const listeners = [];
  class Element {
    constructor(attrs) { this.attrs = { ...attrs }; this.dataset = { jxl: attrs["data-jxl"] }; this.href = attrs.href; }
    closest(sel) { return sel === "a[data-jxl]" && this.attrs["data-jxl"] !== undefined ? this : null; }
    removeAttribute(name) { delete this.attrs[name]; }
  }
  let probe;
  class Image { constructor() { probe = this; this.naturalWidth = 0; } }
  const ctx = { Element, Image, addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  // JXL_SWAP is one static literal, so its tags are exact strings to slice off
  // rather than HTML to filter.
  const open = "<script>", close = "</script>";
  assert.ok(JXL_SWAP.html.startsWith(open) && JXL_SWAP.html.endsWith(close), "JXL_SWAP is exactly one inline script");
  vm.runInNewContext(JXL_SWAP.html.slice(open.length, -close.length), ctx);
  assert.match(probe.src, /^data:image\/jxl;base64,/);
  probe.naturalWidth = naturalWidth;
  probe.onload();
  const link = new Element({ href: "/images/full/X1.jpg", "data-jxl": "/images/full/X1.jxl" });
  for (const l of listeners.filter((l) => l.type === "pointerdown")) l.fn({ target: link });
  return { listeners, link };
}

test("the swap follows the twin only after a JPEG XL image actually decoded", () => {
  const yes = runSwap(1);
  assert.deepEqual(yes.listeners.map((l) => [l.type, l.capture]), [["pointerdown", true], ["focusin", true], ["click", true]]);
  assert.equal(yes.link.href, "/images/full/X1.jxl");
  // Control: a browser whose load event fired on a broken image (width 0)
  // keeps every link on the JPEG and registers nothing.
  const no = runSwap(0);
  assert.equal(no.listeners.length, 0);
  assert.equal(no.link.href, "/images/full/X1.jpg");
});

test("the original's route serves a .jxl key as image/jxl", async () => {
  // Node has no Cache API; the route only needs a cache that always misses.
  const g = /** @type {any} */ (globalThis);
  const had = g.caches;
  g.caches ??= { default: { match: async () => undefined, put: async () => {} } };
  try {
    const got = [];
    const env = { PHOTOS_R2: { get: async (key) => (got.push(key), {
      body: "jxl", size: 3, httpEtag: '"e"', httpMetadata: {}, writeHttpMetadata() {},
    }) } };
    const ctx = { waitUntil() {} };
    const res = await servePhotoFromR2(new Request("https://aadhar.sh/images/full/X1.jxl"), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jxl", "a twin uploaded without a type still names its format");
    assert.deepEqual(got, ["X1.jxl"]);
    // Control: the JPEG's fallback type is unchanged, and an unknown extension
    // is still refused before R2 is asked.
    assert.equal((await servePhotoFromR2(new Request("https://aadhar.sh/images/full/X1.jpg"), env, ctx)).headers.get("content-type"), "image/jpeg");
    assert.equal((await servePhotoFromR2(new Request("https://aadhar.sh/images/full/X1.jxlz"), env, ctx)).status, 404);
  } finally {
    if (had === undefined) delete g.caches;
  }
});
