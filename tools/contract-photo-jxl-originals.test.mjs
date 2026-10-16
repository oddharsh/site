// ── originals in R2 are JPEG XL ─────────────────────────────────────
// Every full-resolution original is a lossless JPEG XL transcode of the JPEG it
// replaced (tools/photos/migrate-originals.ts, add-photos.sh for new photos),
// and R2 keeps only the .jxl. These pin the parts a visitor depends on: the
// index's shape, the 301 that keeps every old .jpg link working, and the
// route's content type.
import { assert, readFile, ROOT, test } from "./contract-shared.ts";
import { servePhotoFromR2 } from "../src/worker/photos.ts";

const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));

test("an original is its stem's JPEG or JPEG XL, and only a migrated one names a retired JPEG", () => {
  // 165 entries on 2026-10-14, every one migrated. An emptied index, or a writer
  // that stopped recording `jpeg`, would otherwise run the checks below on
  // nothing and drop the redirects they guard without a word.
  const entries = Object.values(index);
  assert.ok(entries.length >= 150, `only ${entries.length} photos in photo-index.json`);
  assert.ok(entries.some((entry) => entry.jpeg !== undefined), "no entry names a retired JPEG, so the migrated half below checks nothing");
  for (const [stem, entry] of Object.entries(index)) {
    assert.match(entry.full, /\.(jpe?g|jxl)$/i, `${stem}: an original is a JPEG or its lossless JPEG XL`);
    assert.equal(entry.full.replace(/\.[^.]+$/, ""), stem, `${stem}: the key is the stem's`);
    if (entry.jpeg === undefined) continue;
    assert.match(entry.full, /\.jxl$/, `${stem}: only a JPEG XL original replaced a JPEG`);
    assert.match(entry.jpeg, /\.jpe?g$/i, `${stem}: the retired key is a JPEG`);
    assert.equal(entry.jpeg.replace(/\.[^.]+$/, ""), stem, `${stem}: the retired key is the stem's`);
  }
});

// Node has no Cache API; the route only needs a cache that always misses.
/** @param {string} path @param {{ get?: (key: string, opts?: any) => Promise<object | null>, head?: (key: string) => Promise<object | null> }} [r2] @param {Record<string, string>} [headers] */
async function serve(path, { get = async () => null, head = async () => null } = {}, headers = {}) {
  const g = /** @type {any} */ (globalThis);
  const had = g.caches;
  g.caches ??= { default: { match: async () => undefined, put: async () => {} } };
  const asked = [];
  const env = { PHOTOS_R2: {
    get: async (key, opts) => { asked.push(["get", key]); return get(key, opts); },
    head: async (key) => { asked.push(["head", key]); return head(key); },
  } };
  try {
    const res = await servePhotoFromR2(new Request(`https://aadhar.sh/images/full/${path}`, { headers }), env, { waitUntil() {} });
    return { res, asked };
  } finally {
    if (had === undefined) delete g.caches;
  }
}
const object = (body) => ({ body, size: body.length, httpEtag: '"e"', httpMetadata: {}, writeHttpMetadata() {} });

test("a migrated photo's old JPEG URL answers 301 to its JPEG XL from the index, without asking R2", async () => {
  const moved = Object.values(index).filter((e) => e.jpeg);
  assert.ok(moved.length > 0, "the index records at least one migrated original");
  const { full, jpeg } = moved[0];
  const { res, asked } = await serve(jpeg);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `https://aadhar.sh/images/full/${full}`);
  assert.deepEqual(asked, [], "the index answers from module memory");
  const direct = await serve(full, { get: async () => object("jxl") });
  assert.equal(direct.res.status, 200);
});

test("a JPEG deleted before its move deploys falls back to the .jxl beside it", async () => {
  const { res, asked } = await serve("X9.JPG", { head: async (key) => (key === "X9.jxl" ? {} : null) });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://aadhar.sh/images/full/X9.jxl");
  assert.deepEqual(asked, [["get", "X9.JPG"], ["head", "X9.jxl"]]);
  assert.equal((await serve("X9.JPG")).res.status, 404);
  const present = await serve("X9.jpg", { get: async () => object("jpeg") });
  assert.equal(present.res.status, 200);
  assert.equal(present.res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual((await serve("X9.png")).asked, [["get", "X9.png"]]);
});

test("the original's route serves a .jxl key as image/jxl", async () => {
  const { res, asked } = await serve("X1.jxl", { get: async () => object("jxl") });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jxl", "an upload without a type still names its format");
  assert.deepEqual(asked, [["get", "X1.jxl"]]);
  const refused = await serve("X1.jxlz");
  assert.equal(refused.res.status, 404);
  assert.deepEqual(refused.asked, []);
});

test("a matching If-None-Match answers 304 from the body-less object R2 returns", async () => {
  // R2 answers a failed precondition with the object's metadata and no body,
  // and keeps null for a missing key. Reading null as "matched" served a 200
  // with zero bytes, marked immutable for a year.
  const r2 = {
    get: async (_key, opts) => {
      const { body, ...meta } = object("jxl");
      return opts?.onlyIf?.etagDoesNotMatch === "e" ? meta : { body, ...meta };
    },
  };
  for (const tag of ['"e"', 'W/"e"']) {
    const { res, asked } = await serve("X1.jxl", r2, { "if-none-match": tag });
    assert.equal(res.status, 304, `${tag} matches the stored etag`);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("etag"), '"e"');
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", "the 304 repeats the 200's freshness");
    assert.deepEqual(asked, [["get", "X1.jxl"]], "get's own answer settles it, with no head()");
  }
  const stale = await serve("X1.jxl", r2, { "if-none-match": '"old"' });
  assert.equal(stale.res.status, 200);
  assert.equal(await stale.res.text(), "jxl");
  assert.equal(stale.res.headers.get("content-length"), "3");
  assert.equal((await serve("X2.jxl", {}, { "if-none-match": '"e"' })).res.status, 404);
});
