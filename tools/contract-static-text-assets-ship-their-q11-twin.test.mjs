// ── static text assets ship their q11 twin ───────────────────────────────────
// Shared imports live in contract-shared.mjs.
import {
  configText, ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { existsSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { servePrecompressedText } from "../src/worker/lib/assets.ts";
import { claimedByWorker } from "../src/worker/routes.ts";

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

async function textTwins() {
  const all = await readdir(BUILT, { recursive: true });
  return all.filter((f) => f.endsWith(".br") && !f.startsWith("a/") && !f.endsWith(".html.br"));
}

test("every text twin decodes to the bytes beside it, and is smaller", { skip: needsBuild }, async () => {
  const twins = await textTwins();
  assert.ok(twins.length >= 200, `expected 200+ text twins (241 on 2026-08-31), found ${twins.length}`);
  for (const rel of twins) {
    const twin = await readFile(new URL(rel, BUILT));
    const plain = await readFile(new URL(rel.slice(0, -3), BUILT));
    assert.ok(brotliDecompressSync(twin).equals(plain), `${rel} does not decode to ${rel.slice(0, -3)}`);
    assert.ok(twin.length < plain.length, `${rel} is not smaller than the file it compresses`);
  }
});

const jsoncStringArray = (src, key) => {
  const block = (src.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`)) || [, ""])[1];
  return [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

test("every text twin sits on a path the Worker claims", { skip: needsBuild }, async () => {
  const twins = (await textTwins()).map((rel) => `/${rel.slice(0, -3)}`);
  const config = "cloudflare.config.ts";
  const allow = jsoncStringArray(await configText(config), "run_worker_first");
  assert.ok(allow.length >= 60, `${config}: scanned only ${allow.length} run_worker_first entries; the reader has lost the allowlist`);
  const covered = claimedByWorker(allow);
  const dead = twins.filter((p) => !covered(p));
  assert.deepEqual(dead, [], `${config}: ${dead.length} twin(s) on paths the asset layer answers directly, so they are uploaded and never served: ${dead.slice(0, 5).join(", ")}`);
  for (const unroutable of ["bimi.svg", "robots.txt"]) {
    assert.ok(existsSync(new URL(unroutable, BUILT)), `${unroutable} should be staged; the control needs a real file`);
    assert.ok(!existsSync(new URL(`${unroutable}.br`, BUILT)), `${unroutable} has a twin but no run_worker_first rule reaches it`);
  }
});

const PLAIN = Buffer.from("<rss><channel><title>garage</title></channel></rss>");
const TWIN = brotliCompressSync(PLAIN);
function fakeEnv(overrides = {}) {
  return {
    ...overrides,
    ASSETS: {
      async fetch(input) {
        const req = input instanceof Request ? input : new Request(input);
        const path = new URL(req.url).pathname;
        if (path === "/garage/feed.xml") {
          return new Response(PLAIN, { headers: {
            "content-type": "application/rss+xml; charset=utf-8",
            "cache-control": "public, max-age=2592000, s-maxage=2592000",
            "content-length": String(PLAIN.length),
            "etag": '"feed-v3"',
          } });
        }
        if (path === "/garage/feed.xml.br" && !overrides.noTwin) {
          const headers = {
            "content-type": "application/octet-stream",
            "content-length": String(TWIN.length),
            "etag": '"feed-v3-br-file"',
          };
          if (overrides.twinEncoded) headers["content-encoding"] = "br";
          return new Response(TWIN, { headers });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}
const get = (headers = {}, method = "GET") => new Request("https://aadhar.sh/garage/feed.xml", { method, headers });

test("headers come from the plain asset and the body from the twin", async () => {
  const res = await servePrecompressedText(get(), fakeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/rss+xml; charset=utf-8", "_headers' type on the plain path must survive");
  assert.equal(res.headers.get("cache-control"), "public, max-age=2592000, s-maxage=2592000", "_headers' cache rule on the plain path must survive");
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(res.headers.get("content-length"), String(TWIN.length), "length must describe the twin, not the plain body");
  assert.match(res.headers.get("vary") || "", /accept-encoding/);
  assert.equal(res.headers.get("etag"), 'W/"feed-v3-br"', "the plain asset's strong tag is weakened and marked, never the .br file's own");
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(TWIN), "the body must be the twin's bytes, untouched");
});

test("a twin-marked validator revalidates to 304", async () => {
  const res = await servePrecompressedText(get({ "if-none-match": 'W/"feed-v3-br"' }), fakeEnv());
  assert.equal(res.status, 304);
});

test("caller headers win, the way routeImagesMetadata relies on", async () => {
  const res = await servePrecompressedText(get(), fakeEnv(), { headers: { "cache-control": "public, max-age=60" } });
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  assert.equal(res.headers.get("content-encoding"), "br");
});

test("every failure path lands on the plain asset, untouched", async () => {
  const cases = [
    ["twin missing", get(), fakeEnv({ noTwin: true })],
    ["twin already encoded by the layer", get(), fakeEnv({ twinEncoded: true })],
    ["in-process caller (IDENTITY_BODY)", get(), fakeEnv({ IDENTITY_BODY: true })],
    ["not a GET", get({}, "POST"), fakeEnv()],
  ];
  for (const [label, req, env] of cases) {
    const res = await servePrecompressedText(req, env);
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get("content-encoding"), null, `${label}: must not claim an encoding it did not apply`);
    assert.equal(res.headers.get("content-type"), "application/rss+xml; charset=utf-8", label);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PLAIN), `${label}: body must be the plain bytes`);
  }
});

test("a type the build does not twin never takes the path", async () => {
  const env = fakeEnv();
  let twinAsked = false;
  const inner = env.ASSETS.fetch;
  env.ASSETS.fetch = async (input) => { if (String(input instanceof Request ? input.url : input).endsWith(".br")) twinAsked = true; return inner(input); };
  await servePrecompressedText(new Request("https://aadhar.sh/garage/photo.avif"), env);
  assert.equal(twinAsked, false, "an .avif must go straight to the asset layer without a twin lookup");
});
