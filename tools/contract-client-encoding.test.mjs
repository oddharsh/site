import { assert, test } from "./contract-shared.ts";
import { gunzipSync } from "node:zlib";
import { clientEncodingRequest, encodeClientResponse, preferredEncoding } from "../src/worker/lib/encoding.ts";
import { serveAssetWith404Clamp, servePrecompressedShell, servePrecompressedText, serveStaticPage } from "../src/worker/lib/assets.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { underNode } from "./lib/harness-dispatch.ts";
import { configText, ROOT } from "./contract-shared.ts";

const request = (offer, path = "/") => new Request(`https://aadhar.sh${path}`, { headers: { "accept-encoding": offer } });

test("client encoding honors explicit refusals, wildcard and quality ordering", () => {
  /** @type {[string, string | null][]} */
  const offers = [
    ["gzip, br;q=0", "gzip"], ["br;q=0.5, gzip;q=1", "gzip"],
    ["identity", "identity"], ["", "identity"], ["br, gzip", "br"],
    ["*;q=1, br;q=0", "gzip"], ["*;q=0", null],
    ["br;q=garbage, gzip", "gzip"], ["br;q=0, br", "identity"],
  ];
  for (const [offer, expected] of offers) assert.equal(preferredEncoding(request(offer), ["br", "gzip", "identity"]), expected, offer);
  assert.equal(preferredEncoding(new Request("https://aadhar.sh/"), ["br", "identity"]), "br");
});

test("the original Cloudflare offer is restored before cache admission", () => {
  const req = request("br, gzip");
  Object.defineProperty(req, "cf", { value: { clientAcceptEncoding: "gzip, br;q=0" } });
  assert.equal(preferredEncoding(req, ["br", "gzip", "identity"]), "gzip");
  const restored = clientEncodingRequest(req);
  assert.equal(restored.headers.get("accept-encoding"), "gzip, br;q=0");
  assert.equal(req.headers.get("accept-encoding"), "br, gzip", "does not mutate the platform request");
  const absent = request("br, gzip");
  Object.defineProperty(absent, "cf", {value: {clientAcceptEncoding: null}});
  assert.equal(clientEncodingRequest(absent), absent, "null means the platform did not retain a different offer");
  const empty = request("br, gzip");
  Object.defineProperty(empty, "cf", {value: {clientAcceptEncoding: ""}});
  assert.equal(clientEncodingRequest(empty).headers.get("accept-encoding"), "", "an explicitly empty offer accepts only identity");
});

test("shell, text and page twins never answer a refused encoding", async () => {
  for (const serve of [servePrecompressedShell, servePrecompressedText, serveStaticPage]) {
    for (const offer of ["gzip, br;q=0, dcz;q=0", "identity", "gzip, br;q=0.5"]) {
      const seen = [];
      const env = { ASSETS: { fetch: async (req) => {
        seen.push(new URL(req.url).pathname);
        return new Response("plain", { headers: { "content-type": "text/plain" } });
      } } };
      const path = serve === serveStaticPage ? "/garage/encoding" : "/a/nav.1234abcd.js";
      const req = request(offer, path);
      req.headers.set("available-dictionary", `:${Buffer.alloc(32).toString("base64")}:`);
      const res = await serve(req, env);
      assert.equal(res.headers.get("content-encoding"), null);
      assert.equal(await res.text(), "plain");
      assert.ok(seen.every((p) => !/\.(?:br|dcz)$/.test(p)), `${serve.name}: ${seen}`);
    }
  }
});

test("gzip fallback decodes exactly and keeps cache policy and a weak logical validator", async () => {
  const text = "<p>Some bytes</p>".repeat(100);
  const out = encodeClientResponse(request("gzip, br;q=0"), new Response(text, {
    headers: { "content-type": "text/html", "etag": '"same"', "cache-control": "public, max-age=300", "content-length": String(text.length) },
  }));
  assert.equal(out.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await out.arrayBuffer())).toString(), text);
  assert.equal(out.headers.get("etag"), 'W/"same"');
  assert.equal(out.headers.get("content-length"), null);
  assert.match(out.headers.get("cache-control") ?? "", /max-age=300.*no-transform/);
  assert.match(out.headers.get("vary") ?? "", /accept-encoding/);
});

test("plain asset lookups prevent binding compression and preserve conditional and range headers", async () => {
  const req = request("gzip, br;q=0", "/llms.txt");
  req.headers.set("range", "bytes=0-3");
  req.headers.set("if-none-match", '"same"');
  const response = await serveAssetWith404Clamp(req, {ASSETS: {fetch: async (sub) => {
    assert.equal(sub.headers.get("accept-encoding"), "identity");
    assert.equal(sub.headers.get("range"), "bytes=0-3");
    assert.equal(sub.headers.get("if-none-match"), '"same"');
    return new Response("plain", {headers: {"content-type": "text/plain"}});
  }}});
  assert.equal(await response.text(), "plain");
  assert.equal(req.headers.get("accept-encoding"), "gzip, br;q=0");
});

test("identity stays unencoded and bodiless responses keep their contracts", async () => {
  const identity = encodeClientResponse(request("identity"), new Response("plain", { headers: { "content-type": "text/plain" } }));
  assert.equal(identity.headers.get("content-encoding"), null);
  assert.equal(await identity.text(), "plain");
  assert.match(identity.headers.get("cache-control") ?? "", /no-transform/);
  const fresh = encodeClientResponse(request("gzip, br;q=0"), new Response(null, { status: 304, headers: { "content-type": "text/html", "etag": 'W/"same"' } }));
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get("content-encoding"), null);
  assert.equal(await fresh.text(), "");
  const refused = encodeClientResponse(request("*;q=0"), new Response("plain", { headers: { "content-type": "text/plain" } }));
  assert.equal(refused.status, 406);
  const partial = encodeClientResponse(request("gzip, br;q=0"), new Response("part", { status: 206, headers: { "content-type": "text/plain", "content-range": "bytes 0-3/100" } }));
  assert.equal(partial.headers.get("content-encoding"), null, "partial bytes retain their range coordinates");
  assert.equal(await partial.text(), "part");
});

const RUNTIME = "client encodings survive normalized headers and security wrapping in workerd";
test(RUNTIME, underNode(import.meta.url, RUNTIME, async () => {
  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "client-encoding-")));
  const path = (name) => JSON.stringify(fileURLToPath(new URL(`src/worker/lib/${name}.ts`, ROOT)));
  writeFileSync(join(dir, "worker.js"), `
    import {clientEncodingRequest, encodeClientResponse} from ${path("encoding")};
    import {withSecurityHeaders} from ${path("security")};
    export default {fetch(input) {
      const request = clientEncodingRequest(new Request(input, {cf: {clientAcceptEncoding: input.headers.get("x-client-offer")}}));
      const response = encodeClientResponse(request, new Response("<p>decoded bytes</p>".repeat(100), {headers: {"content-type": "text/html", "etag": '"same"'}}));
      response.headers.set("x-selected-encoding", response.headers.get("content-encoding") || "identity");
      response.headers.set("x-restored-offer", request.headers.get("accept-encoding"));
      return withSecurityHeaders(response, "/");
    }};
  `);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "client-encoding-probe", main: "worker.js", compatibility_date: site.compatibility_date, compatibility_flags: site.compatibility_flags }));
  const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
  try {
    await server.listen();
    for (const offer of ["gzip, br;q=0", "identity"]) {
      const response = await server.getWorker().fetch("http://encoding.test/", {headers: {"accept-encoding": "br, gzip", "x-client-offer": offer}});
      assert.equal(response.headers.get("x-restored-offer"), offer);
      assert.equal(response.headers.get("x-selected-encoding"), offer.startsWith("gzip") ? "gzip" : "identity");
      const bytes = Buffer.from(await response.arrayBuffer());
      const decoded = response.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes).toString() : bytes.toString();
      assert.equal(decoded, "<p>decoded bytes</p>".repeat(100));
      assert.match(response.headers.get("cache-control") ?? "", /no-transform/);
    }
  } finally { await server.close(); rmSync(dir, {recursive: true, force: true}); }
}));
