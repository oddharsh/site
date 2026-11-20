// warm-crypto.ts: build node's WebCrypto tables in this isolate before a CPU
// sample charges a route for them.
//
// workerd's crypto.subtle is native (BoringSSL) and does no setup on first use.
// node's is JavaScript, and its first call per operation per isolate builds the
// algorithm tables it validates against. Measured 2026-11-20 under node
// 26.13.1, the first call in a fresh process, three runs each:
//
//   digest, cold                          9.63-13.88 ms
//   digest, warmed in a worker isolate    5.23-5.60 ms
//   digest, warmed in this isolate        0.15-0.18 ms
//   HMAC import+sign+verify, cold         8.62-9.38 ms
//   HMAC, after a digest warm-up only     1.13-1.28 ms
//   HMAC, after warming both              0.39-0.48 ms
//
// So unlike ICU (tools/lib/warm-icu.ts), a throwaway isolate can't do this: half
// the cost is per isolate. It runs here, in the sample's own isolate, and what a
// route pays to hash its own bytes is still charged to it. Before this, POST
// /mcp tools/list read about 4 ms over its real cost (#1761).
//
// It warms what the Worker reaches with outbound fetch refused: digest (crawl
// receipts, weak ETags) and HMAC (lib/sign.ts). Ed25519 and ML-DSA sign only
// AadharshBot's outbound requests, which the sweep refuses.
export async function warmCrypto(): Promise<void> {
  const bytes = new Uint8Array(1);
  await crypto.subtle.digest("SHA-256", bytes);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  await crypto.subtle.verify("HMAC", key, sig, bytes);
}
