// ── encodeBody, measured in the runtime that implements it ────────────────────
// gotcha 13. The rebuild walker in contract-the-speculation-ledger.test.mjs
// holds every `new Response(<other>.body, init)` to a shape it calls safe, and
// those shapes are claims about workerd rather than about JavaScript:
//
//   new Response(r.body, r)                        keeps encodeBody
//   new Response(r.body, { status, headers })      drops it, body encoded twice
//   the same, with init.encodeBody set again       keeps it (security.ts's carry)
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { underNode } from "./lib/harness-dispatch.ts";
import {
  configText, ROOT, assert, test } from "./contract-shared.ts";

const workerSource = (security) => `
import { withSecurityHeaders } from ${JSON.stringify(security)};

const encoded = (bytes, type) => new Response(bytes, {
  encodeBody: "manual",
  headers: { "content-encoding": "br", "content-type": type },
});

const HTML = "text/html; charset=utf-8";
const SHAPES = {
  "/untouched": [HTML, (r) => r],
  "/response-init": [HTML, (r) => new Response(r.body, r)],
  "/object-init": [HTML, (r) => new Response(r.body, { status: r.status, headers: r.headers })],
  "/security-headers": [HTML, (r) => withSecurityHeaders(r, "/")],
  "/security-headers-noindex": [HTML, (r) => withSecurityHeaders(r, "/", { noindex: true })],
  "/security-headers-noindex-image": ["image/svg+xml", (r) => withSecurityHeaders(r, "/", { noindex: true })],
};

export default {
  async fetch(request) {
    const row = SHAPES[new URL(request.url).pathname];
    if (!row) return new Response("unknown shape", { status: 404 });
    const [type, shape] = row;
    return shape(encoded(await request.arrayBuffer(), type));
  },
};
`;

// What a client holds after honouring content-encoding exactly once. The
// in-process door decodes by itself and drops the header (measured, node 26);
// a runtime that hands the header back instead gets the one decode it asks for.
// Either way the result is what a browser would render.
async function decodedOnce(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  return response.headers.get("content-encoding") === "br" ? brotliDecompressSync(bytes) : bytes;
}

const DISPATCH = "encodeBody survives every rebuild shape the walker allows, measured in the pinned workerd";
test(DISPATCH, underNode(import.meta.url, DISPATCH, async () => {
  const PAGE = Buffer.from("<p>encodeBody, carried or lost</p>\n".repeat(500));
  const BROTLI = brotliCompressSync(PAGE);

  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "encodebody-")));
  writeFileSync(join(dir, "worker.js"),
    workerSource(fileURLToPath(new URL("src/worker/lib/security.ts", ROOT))));
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "encodebody-probe",
    main: "worker.js",
    compatibility_date: site.compatibility_date,
    compatibility_flags: site.compatibility_flags,
  }));

  const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const send = (path) => worker.fetch(`http://encodebody.test${path}`, {
      method: "POST",
      body: BROTLI,
      headers: { "accept-encoding": "br" },
    });

    const lost = await decodedOnce(await send("/object-init"));
    assert.notDeepEqual(lost, PAGE,
      "an object-init rebuild came back clean, so either workerd now preserves encodeBody "
    + "through a plain init (re-read gotcha 13 and the walker's rules) or this probe stopped "
    + "seeing the second layer");
    assert.deepEqual(brotliDecompressSync(lost), PAGE,
      "the object-init body should be the page wrapped in exactly one extra brotli layer");

    for (const path of ["/untouched", "/response-init"]) {
      assert.deepEqual(await decodedOnce(await send(path)), PAGE,
        `${path}: a client decoding once did not get the page back`);
    }

    const secured = await send("/security-headers");
    assert.ok(secured.headers.get("content-security-policy"),
      "withSecurityHeaders did not reach its rebuild, so this row proves nothing");
    assert.deepEqual(await decodedOnce(secured), PAGE,
      "withSecurityHeaders double-encoded a precompressed body: its init must carry encodeBody");

    const noindex = await send("/security-headers-noindex");
    assert.ok(noindex.headers.get("x-robots-tag"),
      "the noindex rebuild did not run, so this row proves nothing");
    assert.deepEqual(await decodedOnce(noindex), PAGE,
      "the noindex path double-encoded a precompressed body across its two rebuilds");

    const image = await send("/security-headers-noindex-image");
    assert.ok(image.headers.get("x-robots-tag"),
      "the noindex rebuild did not run on the image row, so it proves nothing");
    assert.equal(image.headers.get("content-security-policy"), null,
      "the image row reached the main rebuild, so it no longer isolates the noindex carry");
    assert.deepEqual(await decodedOnce(image), PAGE,
      "the noindex rebuild double-encoded a body that then took the image bail: "
    + "its init must carry encodeBody, since no later rebuild sets it again");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}));
