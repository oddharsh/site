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
/** @param {string} path @param {{ get?: (key: string) => Promise<object | null>, head?: (key: string) => Promise<object | null> }} [r2] */
async function serve(path, { get = async () => null, head = async () => null } = {}) {
  const g = /** @type {any} */ (globalThis);
  const had = g.caches;
  g.caches ??= { default: { match: async () => undefined, put: async () => {} } };
  const asked = [];
  const env = { PHOTOS_R2: {
    get: async (key) => { asked.push(["get", key]); return get(key); },
    head: async (key) => { asked.push(["head", key]); return head(key); },
  } };
  try {
    const res = await servePhotoFromR2(new Request(`https://aadhar.sh/images/full/${path}`), env, { waitUntil() {} });
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
  // Control: the .jxl itself is served, not redirected again.
  const direct = await serve(full, { get: async () => object("jxl") });
  assert.equal(direct.res.status, 200);
});

test("a JPEG deleted before its move deploys falls back to the .jxl beside it", async () => {
  // Between migrate-originals.ts --delete and the deploy that records the
  // move, production's index still names the JPEG, so R2 misses.
  const { res, asked } = await serve("X9.JPG", { head: async (key) => (key === "X9.jxl" ? {} : null) });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://aadhar.sh/images/full/X9.jxl");
  assert.deepEqual(asked, [["get", "X9.JPG"], ["head", "X9.jxl"]]);
  // Controls: no .jxl either is a plain 404, and a JPEG still in R2 is served.
  assert.equal((await serve("X9.JPG")).res.status, 404);
  const present = await serve("X9.jpg", { get: async () => object("jpeg") });
  assert.equal(present.res.status, 200);
  assert.equal(present.res.headers.get("content-type"), "image/jpeg");
  // A miss on a non-JPEG key asks for no fallback.
  assert.deepEqual((await serve("X9.png")).asked, [["get", "X9.png"]]);
});

test("the original's route serves a .jxl key as image/jxl", async () => {
  const { res, asked } = await serve("X1.jxl", { get: async () => object("jxl") });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jxl", "an upload without a type still names its format");
  assert.deepEqual(asked, [["get", "X1.jxl"]]);
  // Control: an unknown extension is refused before R2 is asked.
  const refused = await serve("X1.jxlz");
  assert.equal(refused.res.status, 404);
  assert.deepEqual(refused.asked, []);
});
