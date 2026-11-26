// Gotcha 120: fallback variants must not poison or fill a shared cache.
import { createHash } from "node:crypto";
import { assert, test } from "../../../../tools/tests/contract-shared.ts";
import { servePrecompressedShell, serveStaticPage } from "../assets.ts";

const known = createHash("sha256").update("known dictionary").digest();
const available = (digest: Uint8Array) => `:${Buffer.from(digest).toString("base64")}:`;
const tag = known.toString("hex");
const unknown = createHash("sha256").update("unknown dictionary").digest();
const samePrefix = Buffer.from(known);
samePrefix[31] ^= 1;
const shell = "/a/nav.12345678.js";
const page = "/garage/example";

function environment(brokenDelta?: "empty" | "zero-length" | "encoded") {
  const files = new Map([
    [shell, "shell identity"],
    [`${shell}.br`, "shell brotli"],
    [`/ad/nav.12345678.${tag}.dcz`, "shell delta"],
    ["/garage/example.html.br", "page brotli"],
    [`/pd/garage__example.${tag}.dcz`, "page delta"],
  ]);
  const asked: string[] = [];
  return {
    asked,
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (brokenDelta && path.endsWith(`.${tag}.dcz`)) {
          if (brokenDelta === "empty") return new Response(null);
          if (brokenDelta === "zero-length") return new Response("", { headers: { "content-length": "0" } });
          return new Response("compressed again", { headers: { "content-encoding": "br" } });
        }
        return files.has(path)
          ? new Response(files.get(path), { headers: { "cache-control": "public, max-age=3600", etag: '"asset"' } })
          : new Response("missing", { status: 404 });
      },
    },
  };
}

async function serve(path: string, dictionary?: string, brokenDelta?: "empty" | "zero-length" | "encoded") {
  const env = environment(brokenDelta);
  const request = new Request(`https://aadhar.sh${path}`, { headers: dictionary === undefined ? {} : { "available-dictionary": dictionary } });
  const response =
    path === shell ? await servePrecompressedShell(request, env, new URL(request.url)) : await serveStaticPage(request, env, new URL(request.url));
  return { response, body: await response.text(), asked: env.asked };
}

for (const [path, label] of [
  [shell, "shell"],
  [page, "page"],
] as const) {
  test(`${label} fallbacks vary on dictionary and do not store unknown hashes at the CDN`, async () => {
    const plain = await serve(path);
    assert.equal(plain.body, `${label} brotli`);
    assert.match(plain.response.headers.get("vary") || "", /available-dictionary/i, `${label} plain response must vary on the dictionary`);
    assert.notEqual(plain.response.headers.get("cdn-cache-control"), "no-store");
    for (const candidate of [available(unknown), available(samePrefix), "malformed"]) {
      const miss = await serve(path, candidate);
      assert.equal(miss.body, `${label} brotli`);
      assert.equal(miss.response.headers.get("content-encoding"), "br");
      assert.match(miss.response.headers.get("vary") || "", /available-dictionary/i);
      assert.equal(miss.response.headers.get("cdn-cache-control"), "no-store", `${label} unknown dictionary must not create a CDN cache variant`);
      assert.equal(miss.response.headers.get("cache-control"), "public, max-age=3600");
    }
    const hit = await serve(path, available(known));
    assert.equal(hit.body, `${label} delta`);
    assert.equal(hit.response.headers.get("content-encoding"), "dcz");
    assert.match(hit.response.headers.get("vary") || "", /available-dictionary/i);
    assert.notEqual(hit.response.headers.get("cdn-cache-control"), "no-store");
  });
  test(`${label} refuses an empty or already encoded delta`, async () => {
    for (const broken of ["empty", "zero-length", "encoded"] as const) {
      const { response, body } = await serve(path, available(known), broken);
      assert.equal(response.headers.get("content-encoding"), "br", `${label} ${broken} delta must fall back`);
      assert.equal(body, `${label} brotli`);
      assert.equal(response.headers.get("cdn-cache-control"), "no-store");
    }
  });
}

test("a page revalidation preserves the unknown-hash cache policy on its 304", async () => {
  const env = environment();
  const request = new Request(`https://aadhar.sh${page}`, {
    headers: { "available-dictionary": available(unknown), "if-none-match": 'W/"asset-br"' },
  });
  const response = await serveStaticPage(request, env, new URL(request.url));
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.match(response.headers.get("vary") || "", /available-dictionary/i);
});
