// ── The Worker's byte decoders are ES2026 built-ins ──────────────────────────
// #738 moved every Worker ENCODER onto Uint8Array#toBase64 and #toHex and left
// each decoder beside it on atob plus a charCodeAt loop. The decoders are
// Uint8Array.fromBase64 and .fromHex now, and these pin what that kept and what
// it changed. Every oracle here is node's Buffer or node:crypto, never the
// built-in under test.
//
// Three of them fail on the code this replaced, on purpose: x402 (the payment
// read as Latin-1, and the receipt throwing on a curly quote after settlement),
// the cover proxy accepting a signature re-spelled in the standard alphabet, and
// an HTTPS record written in two-byte words reading as no ECH. The other two pin
// behaviour the swap had to keep. cal/test/sign.test.js carries the fourth.
import { createHash, createHmac } from "node:crypto";
import { assert, context, test, testGlobals } from "./contract-shared.ts";
import { serveStaticPage } from "../src/worker/lib/assets.ts";
import { imageInspect } from "../src/worker/image-tools.ts";
import { svcbHasEch } from "../src/worker/lens.ts";
import { handleLlmsFull } from "../src/worker/x402.ts";
import { handleSerendipity } from "../serendipity/serendipity.ts";

test("Available-Dictionary selects the delta named by the digest's first 8 bytes, in hex", async () => {
  // 0x07 needs its leading zero and 0xb8 is past 0x7f: the two places a hand-rolled
  // hex encoder goes wrong. An all-0x01 digest, which the older negotiation test
  // uses, hexes the same under either mistake.
  const digest = Uint8Array.from({ length: 32 }, (_, i) => (i * 0x3b + 0x07) & 0xff);
  const tag = Buffer.from(digest).subarray(0, 8).toString("hex");
  const requested = [];
  const env = { ASSETS: { async fetch(input) {
    const path = new URL(typeof input === "string" ? input : input.url).pathname;
    requested.push(path);
    if (path === "/lwe/drivers.html.br") return new Response("brotli bytes", { headers: { etag: '"page"', "cache-control": "public, max-age=0, s-maxage=86400" } });
    if (path === `/pd/lwe__drivers.${tag}.dcz`) return new Response("delta bytes");
    return new Response("not found", { status: 404 });
  } } };
  const offer = (bytes) => serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "available-dictionary": `:${Buffer.from(bytes).toString("base64")}:` },
  }), env);

  const hit = await offer(digest);
  assert.equal(hit.headers.get("content-encoding"), "dcz");
  assert.ok(requested.includes(`/pd/lwe__drivers.${tag}.dcz`), requested.join(" "));

  // 31 bytes is no SHA-256, so no delta path is even asked for
  requested.length = 0;
  await offer(digest.subarray(0, 31));
  assert.equal(requested.some((p) => p.startsWith("/pd/")), false, requested.join(" "));
});

test("image_data decodes to the same bytes however its base64 is wrapped", async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff);
  const b64 = Buffer.from(bytes).toString("base64");
  assert.match(b64, /[+/]/, "the fixture needs a character base64url spells differently");
  // the receipt's sha256 is the Worker hashing what it decoded; node hashes the original
  const want = createHash("sha256").update(bytes).digest("hex");
  const env = { IMAGES: { async info() { return { format: "png", width: 1, height: 1 }; } } };

  for (const [label, image_data] of [
    ["plain", b64],
    ["data URL", `data:image/png;base64,${b64}`],
    ["CRLF every 76", b64.replace(/(.{76})(?!$)/g, "$1\r\n")],
    // \s admits more than the ASCII whitespace fromBase64 skips, which is why
    // decodeBase64 still strips before it decodes
    ["NBSP inside", `${b64.slice(0, 40)}\u00a0${b64.slice(40)}`],
  ]) {
    const receipt = await imageInspect({ image_data }, env);
    assert.ok("input" in receipt, `${label}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.input.sha256, want, label);
    assert.equal(receipt.input.bytes, bytes.length, label);
  }
  for (const [label, image_data] of [
    ["base64url alphabet", b64.replace(/\+/g, "-").replace(/\//g, "_")],
    ["padding mid-string", `${b64.slice(0, 8)}=${b64.slice(8)}`],
  ]) {
    const refused = await imageInspect({ image_data }, env);
    assert.ok("_error" in refused, label);
    assert.match(refused._error, /valid base64/, label);
  }
});

test("x402 reads the payment as UTF-8 and writes a receipt btoa could not", async () => {
  const realFetch = globalThis.fetch;
  const payment = { x402Version: 1, scheme: "exact", network: "base", payload: { memo: "caf\u00e9" } };
  const env = /** @type {any} */ ({
    X402_PAY_TO: `0x${"12".repeat(20)}`,
    X402_FACILITATOR: "https://facilitator.test",
    // 404 on the q11 twin, so this test stays about the UTF-8 receipt. An asset
    // layer answering every path would hand back plain text as the "twin" and
    // the handler would label it br.
    ASSETS: { fetch: async (req) => new URL(req.url).pathname.endsWith(".br")
      ? new Response("not found", { status: 404 })
      : new Response("the full corpus") },
  });
  const pay = async (settled) => {
    const posts = [];
    testGlobals.fetch = async (input, init) => {
      const url = String(input?.url ?? input);
      posts.push({ url, body: JSON.parse(init.body) });
      return Response.json(url.endsWith("/verify") ? { isValid: true } : settled);
    };
    const res = await handleLlmsFull(new Request("https://aadhar.sh/llms-full.txt", {
      headers: { "x-payment": Buffer.from(JSON.stringify(payment), "utf8").toString("base64") },
    }), env, context());
    return { res, posts };
  };
  try {
    const receipt = { success: true, transaction: `0x${"ab".repeat(32)}`, network: "base", note: "settled \u2713 \u201cthanks\u201d" };
    const { res, posts } = await pay(receipt);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "the full corpus");
    // atob handed JSON.parse Latin-1, so the facilitator was sent "cafÃ©"
    assert.deepEqual(posts.map((p) => p.body.paymentPayload), [payment, payment]);
    // btoa threw on the check mark and the curly quotes, after /settle had moved the money
    assert.equal(Buffer.from(res.headers.get("x-payment-response") ?? "", "base64").toString("utf8"), JSON.stringify(receipt));

    // an ASCII receipt, which is every receipt that worked before, keeps btoa's exact bytes
    const ascii = { success: true, transaction: `0x${"cd".repeat(32)}`, network: "base" };
    const plain = await pay(ascii);
    assert.equal(plain.res.headers.get("x-payment-response"), btoa(JSON.stringify(ascii)));
  } finally { testGlobals.fetch = realFetch; }
});

test("the cover proxy refuses a signature re-spelled in the standard alphabet", async () => {
  const secret = "cover-secret-for-the-contract-suite";
  const env = { SERENDIPITY_DB: {}, COVER_SECRET: secret };
  const sign = (raw) => createHmac("sha256", secret).update(raw).digest("base64url");
  // a signature needs a "-" or "_" before it has a standard-alphabet spelling at all
  let raw = "", sig = "";
  for (let i = 0; !/[-_]/.test(sig); i++) { raw = `https://images.lumacdn.com/event-covers/${i}.jpg`; sig = sign(raw); }
  const cover = (s) => handleSerendipity(new Request(
    `https://aadhar.sh/serendipity/cover?u=${encodeURIComponent(raw)}&s=${encodeURIComponent(s)}`), env, context());

  const hadCaches = "caches" in globalThis;
  const realCaches = testGlobals.caches;
  try {
    // the cache lookup is the first step past the signature check, so a hit proves it passed
    testGlobals.caches = { default: { match: async () => new Response("past the signature check") } };
    assert.equal(await (await cover(sig)).text(), "past the signature check");
    // the decoder this replaced mapped "-" to "+" and "_" to "/", so both spellings were one key
    const respelled = await cover(sig.replace(/-/g, "+").replace(/_/g, "/"));
    assert.equal(respelled.status, 403);
  } finally {
    if (hadCaches) testGlobals.caches = realCaches; else delete testGlobals.caches;
  }
});

test("an RFC 3597 HTTPS record reads the same in any word grouping", () => {
  // SvcPriority 1, TargetName ".", alpn="h2", then key 5 (ech) carrying two bytes
  const withEch = "0001" + "00" + "0001" + "0003" + "026832" + "0005" + "0002" + "abcd";
  const withoutEch = withEch.slice(0, -12);
  const record = (hex, width) => `\\# ${hex.length / 2} ${hex.match(new RegExp(`.{1,${width}}`, "g")).join(" ")}`;

  // 2 digits per word is the only form Cloudflare's resolver emits; RFC 3597 allows
  // any even count, and the per-word parseInt read 4 as one out-of-range "byte"
  for (const width of [2, 4, withEch.length]) {
    assert.deepEqual(svcbHasEch(record(withEch, width)), { ech: true, parsed: true }, `words of ${width}`);
    assert.deepEqual(svcbHasEch(record(withoutEch, width)), { ech: false, parsed: true }, `words of ${width}`);
  }
  // an odd digit count is no byte string, so it reports unparsed rather than "no ECH"
  assert.deepEqual(svcbHasEch("\\# 1 0"), { ech: false, parsed: false });
  // the presentation-form fallback never reaches the decoder
  assert.deepEqual(svcbHasEch('1 . alpn="h2" ech="AEX+/w=="'), { ech: true, parsed: true });
});
