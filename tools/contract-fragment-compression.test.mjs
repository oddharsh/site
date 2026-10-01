import { assert, test, configText, ROOT } from "./contract-shared.ts";
import { brotliDecompressSync } from "node:zlib";
import { compressFragment, FRAGMENT_COMPRESSION_LIMIT } from "../src/worker/lib/fragment-compression.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { underNode } from "./lib/harness-dispatch.ts";

const request = (offer = "br, gzip") => new Request("https://aadhar.sh/fragment", {headers: {"accept-encoding": offer}});
const text = "<li>A fragment row with a title and metadata</li>".repeat(100);
/** @param {BodyInit} [body] */
const fragment = (body = text, extra = {}) => new Response(body, {headers: {"content-type": "text/html", "x-island": "1", "cache-control": "public, max-age=300", "etag": 'W/"logical"', ...extra}});

test("HTML islands and JSON compress without changing decoded bytes or cache metadata", async () => {
  for (const response of [fragment(), new Response(JSON.stringify({rows: Array(100).fill({title: "A repeated row", description: text.slice(0, 80)})}), {headers: {"content-type": "application/json", "etag": '"logical"'}})]) {
    const original = await response.clone().arrayBuffer();
    const cacheControl = response.headers.get("cache-control");
    const out = await compressFragment(request(), response);
    const bytes = Buffer.from(await out.arrayBuffer());
    assert.equal(out.headers.get("content-encoding"), "br");
    assert.deepEqual(brotliDecompressSync(bytes), Buffer.from(original));
    assert.ok(bytes.length < original.byteLength);
    assert.equal(out.headers.get("content-length"), String(bytes.length));
    assert.equal(out.headers.get("etag"), 'W/"logical"');
    assert.equal(out.headers.get("cache-control"), cacheControl);
    assert.match(out.headers.get("vary") ?? "", /accept-encoding/);
  }
});

test("full documents, refused Brotli, no-transform, errors and existing encodings stay untouched", async () => {
  /** @type {[Request, Response][]} */
  const cases = [
    [request(), new Response(text, {headers: {"content-type": "text/html"}})],
    [request("gzip, br;q=0"), fragment()],
    [request("identity"), fragment()],
    [request(), fragment(text, {"cache-control": "public, no-transform"})],
    [request(), new Response(text, {status: 503, headers: {"x-island": "1"}})],
    [request(), fragment(text, {"content-encoding": "br"})],
    [request(), fragment("tiny")],
  ];
  for (const [req, response] of cases) {
    assert.equal(await compressFragment(req, response), response);
    await response.body?.cancel();
  }
});

test("the size bound preserves oversized bodies, including ones with no length header", async () => {
  const bytes = new Uint8Array(FRAGMENT_COMPRESSION_LIMIT + 1).fill(65);
  for (const headers of [{}, {"content-length": String(bytes.length)}]) {
    const response = fragment(bytes, headers);
    const out = await compressFragment(request(), response);
    assert.equal(out, response);
    assert.equal(out.headers.get("content-encoding"), null);
    assert.deepEqual(new Uint8Array(await out.arrayBuffer()), bytes);
  }
});

test("304s stay bodiless and HEAD drops the length that would describe plain GET bytes", async () => {
  const fresh = new Response(null, {status: 304, headers: {"content-type": "application/json", "etag": 'W/"logical"'}});
  assert.equal(await compressFragment(request(), fresh), fresh);
  assert.equal(await fresh.text(), "");
  const req = new Request("https://aadhar.sh/fragment", {method: "HEAD", headers: {"accept-encoding": "br"}});
  const head = new Response(null, {headers: {"content-type": "application/json", "content-length": "4000"}});
  assert.equal((await compressFragment(req, head)).headers.get("content-length"), null);
});

const RUNTIME = "native fragment Brotli survives security headers in the pinned workerd";
test(RUNTIME, underNode(import.meta.url, RUNTIME, async () => {
  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fragment-compression-")));
  const path = (name) => JSON.stringify(fileURLToPath(new URL(`src/worker/lib/${name}.ts`, ROOT)));
  writeFileSync(join(dir, "worker.js"), `
    import {compressFragment} from ${path("fragment-compression")};
    import {encodeClientResponse} from ${path("encoding")};
    import {withSecurityHeaders} from ${path("security")};
    export default {async fetch(request) {
      const out = encodeClientResponse(request, await compressFragment(request, new Response(${JSON.stringify(text)}, {headers: {"content-type": "text/html", "x-island": "1", "etag": 'W/"logical"'}})));
      out.headers.set("x-selected-encoding", out.headers.get("content-encoding") || "identity");
      return withSecurityHeaders(out, "/");
    }};
  `);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({name: "fragment-compression-probe", main: "worker.js", compatibility_date: site.compatibility_date, compatibility_flags: site.compatibility_flags}));
  const server = createTestHarness({workers: [{configPath: join(dir, "wrangler.jsonc")}]});
  try {
    await server.listen();
    for (const [offer, selected] of [["br", "br"], ["gzip, br;q=0", "gzip"], ["identity", "identity"]]) {
      const response = await server.getWorker().fetch("http://fragment.test/", {headers: {"accept-encoding": offer}});
      assert.equal(response.headers.get("x-selected-encoding"), selected);
      assert.equal(await response.text(), text, "the harness decodes exactly one transport layer");
      assert.equal(response.headers.get("etag"), 'W/"logical"');
    }
  } finally {await server.close(); rmSync(dir, {recursive: true, force: true});}
}));
