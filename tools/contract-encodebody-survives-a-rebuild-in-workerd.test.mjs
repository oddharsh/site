// ── encodeBody, measured in the runtime that implements it ────────────────────
// gotcha 13. The rebuild walker in contract-the-speculation-ledger.test.mjs
// holds every `new Response(<other>.body, init)` to a shape it calls safe, and
// those shapes are claims about workerd rather than about JavaScript:
//
//   new Response(r.body, r)                        keeps encodeBody
//   new Response(r.body, { status, headers })      drops it, body encoded twice
//   the same, with init.encodeBody set again       keeps it (security.ts's carry)
//
// undici implements no encodeBody, so neither runner in this suite could check
// any of them, and the walker says so: the SOURCE was the only place the
// invariant could be held "without booting a Worker". wrangler's own test
// harness boots one in-process on the PINNED workerd, so this file checks the
// claims themselves, and a wrangler pin that moves the asymmetry fails here
// instead of shipping as a double-encoded body. The walker still owns coverage
// of every call site; this owns the rules it applies.
//
// Measured 2026-09-22 on node 26.9.0 before a line of this was written, against
// a 17,600-byte payload: the untouched and response-init rows came back as the
// plain payload, the object-init row came back as 13 bytes of STILL-BROTLI, and
// the same held through the harness's listening socket as well as in-process.
// That control row is what makes the other rows mean anything: it proves the
// instrument can see a second layer when there is one.
//
// The Worker is written into a temp directory rather than committed under
// tools/fixtures, because that directory is exempt from typecheck coverage on
// the grounds that it holds frozen DATA (check-ts-coverage.ts), and a fixture
// Worker is code. It imports the real lib/security.ts, so the two rows that
// matter most run production's withSecurityHeaders inside workerd.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { ROOT, assert, readFileSync, test } from "./contract-shared.ts";

// Every shape the walker has an opinion about, plus production's own wrapper
// down each of its three exits.
//
// THE FLAG IS READ ONCE, AT SERIALIZATION, which is why the wrapper needs two
// noindex rows. Measured while writing this: deleting the carry on the noindex
// rebuild (security.ts's first `init.encodeBody`) left an HTML row GREEN,
// because the main rebuild after it sets the flag again, and an intermediate
// Response that dropped it hands its body stream on untouched. So that first
// carry is load-bearing only when the main rebuild never runs, which is the
// image and redirect bails. The svg row takes the image bail and is the one row
// that fails without it; the html row covers two rebuilds in a row.
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

test("encodeBody survives every rebuild shape the walker allows, measured in the pinned workerd", async () => {
  const PAGE = Buffer.from("<p>encodeBody, carried or lost</p>\n".repeat(500));
  const BROTLI = brotliCompressSync(PAGE);

  // Production's flags rather than a default: compatibility_flags carries
  // new_module_registry, and a runtime behaviour measured under different
  // flags would be a measurement of a different runtime.
  const site = parseJsonc(readFileSync(new URL("wrangler.jsonc", ROOT), "utf8"));
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

    // THE CONTROL, first, because every row after it reads as a pass for a
    // broken instrument too. An object init must leave one brotli layer behind
    // after the client's decode, and exactly one: decoding it again yields the
    // page. If this row ever reads as the plain page, workerd changed the
    // asymmetry and the walker's RECORDED entries need re-reading, not this row.
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

    // Production's wrapper. The header assertions are what stop these rows
    // passing vacuously: a withSecurityHeaders that bailed before its rebuild
    // would hand the body through untouched and read exactly like a carry.
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

    // The early rebuild ALONE. x-robots-tag says the noindex rebuild ran and a
    // missing CSP says the image bail returned before the main one could set the
    // flag again, so this row has exactly one carry to lean on.
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
});
