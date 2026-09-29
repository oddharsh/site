// ── /images/manifest.json is build output ────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { existsSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { servePrecompressedText } from "../src/worker/lib/assets.ts";
import { IMAGES_MANIFEST_HEADERS, PHOTO_POOL, handleImagesManifest, imagesManifestJson } from "../src/worker/photos.ts";

// The manifest was rendered per request until 2026-09-26, so the edge compressed
// it on the fly: 13,082 B on the wire against 9,803 at q11. Its only input is the
// bundled pool, so build.ts step 1e stages it, the text-twin step compresses it,
// and the route serves the twin with the old handler as a 404 fallback. Three
// things can quietly undo that, and each has a test: the staged bytes drifting
// from what the fallback renders, the twin going missing (the route then serves
// plain bytes and every other check still passes), and `_headers`' one-year
// immutable rule on /images/* reaching a file that changes on every photo add.

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

test("the staged manifest is byte-identical to what the fallback renders", { skip: needsBuild }, async () => {
  const staged = await readFile(new URL("images/manifest.json", BUILT));
  const rendered = Buffer.from(await handleImagesManifest().arrayBuffer());
  assert.ok(staged.equals(rendered), "build.ts and the Worker's fallback disagree about the manifest's bytes, so which one a visitor gets depends on whether the deploy staged it");
  // A floor, because an empty pool serializes to valid JSON and would pass the
  // equality above on both sides.
  const { count, photos } = JSON.parse(staged.toString("utf8"));
  assert.ok(count >= 100 && photos.length === count, `manifest carries ${count} photos; expected 100+ (165 on 2026-09-26)`);
});

test("the staged manifest ships a q11 twin that decodes to it", { skip: needsBuild }, async () => {
  const plain = await readFile(new URL("images/manifest.json", BUILT));
  const twin = await readFile(new URL("images/manifest.json.br", BUILT));
  assert.ok(brotliDecompressSync(twin).equals(plain), "the twin does not decode to the staged manifest");
  assert.ok(twin.length < plain.length / 4, `twin is ${twin.length} B for ${plain.length} B of JSON; q11 has held this under a quarter`);
});

// The asset layer answers a file under /images/ with _headers' rule attached, so
// the fake does too. The body is the real serializer's output.
const IMMUTABLE = "public, max-age=31536000, immutable";
const PLAIN = Buffer.from(imagesManifestJson(PHOTO_POOL));
const TWIN = Buffer.from("fake-brotli-bytes");
function fakeEnv({ noTwin = false } = {}) {
  return {
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const headers = { "content-type": "application/json", "cache-control": IMMUTABLE, etag: '"m1"' };
        if (path === "/images/manifest.json") return new Response(PLAIN, { headers });
        if (path === "/images/manifest.json.br" && !noTwin) return new Response(TWIN, { headers });
        return new Response("not found", { status: 404 });
      },
    },
  };
}
const get = (method = "GET") => new Request("https://aadhar.sh/images/manifest.json", { method });

test("the route's headers replace the immutable cache /images/* would hand it", async () => {
  // THE CONTROL: without the override the inherited rule reaches the client,
  // which is the hazard this whole test exists for. If this stops leaking, the
  // fake no longer resembles the asset layer and the assertions below prove nothing.
  const bare = await servePrecompressedText(get(), fakeEnv());
  assert.equal(bare.headers.get("cache-control"), IMMUTABLE, "control: the fake asset layer should leak _headers' immutable rule");

  const cases = [
    { label: "twin served", req: get(), env: fakeEnv(), encoding: "br" },
    { label: "twin missing", req: get(), env: fakeEnv({ noTwin: true }), encoding: null },
    { label: "HEAD", req: get("HEAD"), env: fakeEnv(), encoding: null },
  ];
  for (const { label, req, env, encoding } of cases) {
    const res = await servePrecompressedText(req, env, { headers: IMAGES_MANIFEST_HEADERS });
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get("cache-control"), IMAGES_MANIFEST_HEADERS["cache-control"], `${label}: the manifest must not inherit a one-year immutable cache`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", `${label}: the manifest was always public to other origins`);
    assert.equal(res.headers.get("content-encoding"), encoding, label);
  }
});

test("the fallback carries the same headers the static path sends", () => {
  const res = handleImagesManifest();
  for (const [name, value] of Object.entries(IMAGES_MANIFEST_HEADERS)) {
    assert.equal(res.headers.get(name), value, `fallback ${name}`);
  }
});

// index.ts imports cloudflare:workers and cannot load outside workerd (gotcha
// 16), so the wiring is asserted on the source.
test("the route serves the twin and falls back to the handler", async () => {
  const src = await readFile(new URL("src/worker/index.ts", ROOT), "utf8");
  assert.match(src, /\["\/images\/manifest\.json", routeImagesManifest\]/, "the ROUTES row must name the twin-serving route, not the per-request handler");
  const body = (src.match(/async function routeImagesManifest\([^)]*\) \{([\s\S]*?)\n\}/) || [])[1];
  assert.ok(body, "routeImagesManifest is gone");
  assert.match(body, /servePrecompressedText\(request, env, \{ headers: IMAGES_MANIFEST_HEADERS \}\)/);
  assert.match(body, /status !== 404/);
  assert.match(body, /return handleImagesManifest\(\)/);
});
