// ── /llms-full.txt ships through its q11 twin ────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { existsSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { handleLlmsFull } from "../src/worker/x402.ts";

// The corpus is the largest text artifact this site serves and the route is
// no-store, so every agent fetch pays its full encoding. It had no twin until
// 2026-09-26: production sent 188,404 B where q11 is 156,709. The allowlist in
// build.ts named llms.txt and not this file, which cost about 1 KB when it was
// written and 31,695 B (16.8%) after #903 took the corpus from 20.5 KB to 516 KB.
//
// THE ROUTE ORACLE CANNOT SEE THIS, which is why the assertions live here.
// Measured the same day by booting the harness with the twin unserved: it still
// answered `content-encoding: br`, because miniflare re-encodes compressible
// types and the production edge does the same. A fake asset layer is what makes
// "served the twin" and "served identity bytes the edge then compressed"
// distinguishable at all.

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

test("the build writes a twin that decodes to the staged corpus", { skip: needsBuild }, async () => {
  const plain = await readFile(new URL("llms-full.txt", BUILT));
  const twin = await readFile(new URL("llms-full.txt.br", BUILT));
  assert.ok(brotliDecompressSync(twin).equals(plain), "the twin does not decode to the staged corpus");
  // A floor rather than an exact size, since the corpus grows with every page.
  // q11 has held this near a third; the edge's on-the-fly pass gives ~36%.
  assert.ok(twin.length < plain.length * 0.35, `twin is ${twin.length} B for ${plain.length} B, which is not the q11 ratio this route is here for`);
  assert.ok(plain.length > 100_000, `staged corpus is ${plain.length} B; expected 100 KB+ (516 KB on 2026-09-26)`);
});

// The asset layer hands back the file's own bytes, so the fake does too.
const PLAIN = Buffer.from("# aadhar.sh\n\nthe corpus, in full.\n");
const TWIN = Buffer.from("fake-brotli-bytes");
const MAP = Buffer.from("# aadhar.sh\n\nthe map.\n");
// `any` because the route's Env declares 57 bindings and this fake owes the
// two asset paths it reads; the same shape contract-native-byte-decoders uses.
function fakeEnv({ noTwin = false, nothingStaged = false } = {}) {
  return /** @type {any} */ ({
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const headers = { "content-type": "text/plain; charset=utf-8", etag: '"c1"' };
        if (!nothingStaged && path === "/llms-full.txt") return new Response(PLAIN, { headers });
        if (!nothingStaged && !noTwin && path === "/llms-full.txt.br") return new Response(TWIN, { headers });
        if (path === "/llms.txt") return new Response(MAP, { headers });
        if (path === "/writing/posts.json") return new Response("[]", { headers: { "content-type": "application/json" } });
        return new Response("not found", { status: 404 });
      },
    },
  });
}
const get = () => new Request("https://aadhar.sh/llms-full.txt");

test("the twin is what goes on the wire, and its absence is the control", async () => {
  const served = await handleLlmsFull(get(), fakeEnv(), {});
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-encoding"), "br", "the twin was built and the route did not serve it");
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(TWIN), "the body is not the twin's bytes");

  // THE CONTROL: with no twin the same call must fall back to identity bytes.
  // Without it, a `br` above would prove nothing, since every other assertion
  // here passes on the plain body too.
  const bare = await handleLlmsFull(get(), fakeEnv({ noTwin: true }), {});
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get("content-encoding"), null, "control: no twin should mean no content-encoding");
  assert.ok(Buffer.from(await bare.arrayBuffer()).equals(PLAIN), "control: the plain staged bytes should be served");
});

test("the paywall's own headers survive both paths, and dev still assembles", async () => {
  // The gate is unconfigured here (no X402_PAY_TO), which is the free path and
  // the one production runs today. Its note is set by the handler rather than
  // passed in, so this doubles as the check that the route's own headers are
  // not lost to the twin's: servePrecompressedText copies the ASSET's headers
  // first and applies the route's over them.
  for (const [label, env] of [["twin", fakeEnv()], ["no twin", fakeEnv({ noTwin: true })]]) {
    const res = await handleLlmsFull(get(), env, {});
    assert.equal(res.headers.get("cache-control"), "no-store", `${label}: a per-payment receipt must never be cached`);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", `${label}: content-type`);
    assert.equal(res.headers.get("x-payment-note"), "x402 gate not configured; served free", `${label}: the route's own headers must reach the client`);
  }
  // `bun run dev` stages nothing derived, so neither file exists and the
  // handler assembles the writing half live rather than 404ing.
  const dev = await handleLlmsFull(get(), fakeEnv({ nothingStaged: true }), {});
  assert.equal(dev.status, 200, "with nothing staged the route must still answer");
  assert.equal(dev.headers.get("content-encoding"), null);
  assert.match(await dev.text(), /aadhar\.sh/, "the assembled fallback should carry the map");
});

test("build.ts twins this path, so the route has something to serve", async () => {
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(build, /llms-full\\\.txt/, "build.ts's TWINNED list no longer names llms-full.txt, so the twin stops being written and the route silently serves plain bytes");
});
