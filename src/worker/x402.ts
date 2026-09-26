// x402.js — the /llms-full.txt bot paywall. The llms.txt MAP is free next
// door; the FULL machine-readable corpus (map + every writing post + every Garage
// and LWE explainer, inlined)
// costs one cent, payable by machine, per the x402 protocol (x402.org):
// no X-PAYMENT header → HTTP 402 with a machine-readable invoice (the
// "accepts" envelope); a signed USDC payment in X-PAYMENT → verify + settle
// through a facilitator → 200 + X-PAYMENT-RESPONSE receipt. A working demo
// of "content on the site's terms — open, gated behind payment, or anywhere
// in between", self-inspectable at /lens?url=https://aadhar.sh/llms-full.txt.
//
// Config (all optional — ungated until the wallet is set):
//   X402_PAY_TO       the receiving EVM address (var or secret). Absent →
//                     the file serves FREE with an honest x-payment-note,
//                     same degrade-when-unconfigured rule as /lens/shot.
//   X402_NETWORK      "base" (default) or "base-sepolia" for testing.
//   X402_FACILITATOR  verify/settle service; defaults to x402.org's hosted
//                     one (base-sepolia only — mainnet needs e.g. Coinbase's).
import type { Env, SiteRequest } from "./lib/env.ts";
import { servePrecompressedText } from "./lib/assets.ts";
import { jsonResponse } from "./lib/http.ts";
import { renderLlmsFull, WRITING_HEADING, type LlmsFullDoc } from "./lib/llms-full.ts";

const X402_VERSION = 1;
const PRICE_ATOMIC = "10000"; // USDC has 6 decimals → $0.01
const PRICE_HUMAN = "$0.01";
// USDC per network: the token contract + its EIP-712 domain (what the payer's
// wallet signs against — mainnet USDC self-describes as "USD Coin", Circle's
// Sepolia test token as "USDC").
const USDC = {
  "base":         { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", eip712: { name: "USD Coin", version: "2" } },
  "base-sepolia": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", eip712: { name: "USDC", version: "2" } },
};
const FACILITATOR_DEFAULT = "https://x402.org/facilitator";

export async function handleLlmsFull(request: SiteRequest, env: Env, _ctx: ExecutionContext) {
  const url = new URL(request.url);

  // gate off = serve free, and say so. never a broken paywall.
  if (!env.X402_PAY_TO) {
    return llmsFullResponse(request, env, { "x-payment-note": "x402 gate not configured; served free" });
  }

  const requirements = paymentRequirements(env, url);
  const paymentHeader = request.headers.get("x-payment");
  if (!paymentHeader) {
    return deny(requirements, "X-PAYMENT header is required. This resource costs " + PRICE_HUMAN +
      " in USDC (" + requirements.network + "). The llms.txt map next door is free.");
  }

  // JSON is UTF-8, and atob's Latin-1 string turned any non-ASCII byte in it to mojibake
  let payload = null;
  try { payload = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(paymentHeader))); } catch (_e) {
    return deny(requirements, "X-PAYMENT did not decode as base64 JSON.");
  }

  // verify, then settle, through the facilitator. Older facilitators read
  // paymentHeader (the b64 string), newer ones paymentPayload (the decoded
  // object) — send both; unknown fields are ignored.
  const fac = (env.X402_FACILITATOR || FACILITATOR_DEFAULT).replace(/\/$/, "");
  const body = JSON.stringify({ x402Version: X402_VERSION, paymentHeader, paymentPayload: payload, paymentRequirements: requirements });

  let verify;
  try { verify = await facilitatorPost(fac + "/verify", body); }
  catch (_e) { return deny(requirements, "The payment facilitator is unreachable; try again shortly."); }
  const isValid = verify.json && (verify.json.isValid === true || verify.json.valid === true);
  if (!verify.ok || !isValid) {
    return deny(requirements, "Payment did not verify" +
      (verify.json && (verify.json.invalidReason || verify.json.error) ? ": " + (verify.json.invalidReason || verify.json.error) : "."));
  }

  let settle;
  try { settle = await facilitatorPost(fac + "/settle", body); }
  catch (_e) { return deny(requirements, "Payment verified but settlement failed (facilitator unreachable); nothing was charged."); }
  const settled = settle.ok && settle.json && (settle.json.success === true || (settle.json.success === undefined && (settle.json.txHash || settle.json.transaction)));
  if (!settled) {
    return deny(requirements, "Payment verified but did not settle" +
      (settle.json && settle.json.error ? ": " + settle.json.error : "."));
  }

  // UTF-8 before base64. btoa threw on anything above U+00FF, and this line runs after
  // the payment settled, so one curly quote from the facilitator charged the payer for
  // an error. Identical bytes to btoa for every ASCII receipt.
  return llmsFullResponse(request, env, {
    "x-payment-response": new TextEncoder().encode(JSON.stringify(settle.json)).toBase64(),
  });
}

function paymentRequirements(env: Env, url: URL) {
  const network = String(env.X402_NETWORK || "base").toLowerCase();
  const usdc = USDC[network] || USDC["base"];
  return {
    scheme: "exact",
    network: USDC[network] ? network : "base",
    maxAmountRequired: PRICE_ATOMIC,
    resource: url.origin + "/llms-full.txt",
    description: "llms-full.txt for aadhar.sh: the llms.txt map plus the full text of every writing post and every Garage and LWE explainer, one cent, payable by machine. The map alone is free at /llms.txt.",
    mimeType: "text/plain",
    payTo: env.X402_PAY_TO,
    maxTimeoutSeconds: 60,
    asset: usdc.asset,
    extra: usdc.eip712,
  };
}

// the 402: an x402 envelope for protocol speakers, plus a pay-per-crawl-style
// price header so every 402 reader sees a price no matter which spec it knows.
function deny(requirements, error) {
  return jsonResponse({ x402Version: X402_VERSION, error, accepts: [requirements] }, 402, {
    "crawler-price": PRICE_HUMAN + " USD",
    "x-robots-tag": "noindex",
  });
}

async function facilitatorPost(url, body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl.signal });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } finally { clearTimeout(to); }
}

// The corpus is BUILT (tools/build.ts step 1g3, lib/llms-full.ts): the map, every
// writing post, and the Markdown twin of every Garage and LWE page, staged at the
// asset path this route shadows. /llms-full.txt is run_worker_first, so the file is
// reachable only through this handler and the paywall stays in front of it.
// It goes out through the q11 twin, which is why this is no longer a `.text()`
// read. The corpus is 516 KB and this route is `no-store`, so every agent fetch
// re-paid the edge's on-the-fly compression at about q4: measured 2026-09-26
// against production, 188,404 B on the wire where q11 is 156,709, a flat
// 31,695 B (16.8%) off the largest text artifact this site serves. The gap was
// worth about 1 KB when the twin allowlist was written (2026-09-01, #692, which
// names llms.txt and not this file), and #903 took the corpus from 20.5 KB to
// 516 KB three days before anyone looked. Nothing joins "a file grew" to "a
// file has no twin", which is why no check caught it.
//
// The comment here used to say to read `.text()` rather than hand the asset's
// body on, so as not to rebuild another response (gotcha 13). That reasoning is
// intact and now lives one layer down: servePrecompressedText owns the
// `encodeBody: "manual"` rebuild that 430 other twins already ship through, and
// it falls back to the plain asset when no twin was built.
//
// With no staged file at all (`bun run dev` stages nothing derived) that helper
// 404s, and the writing half is assembled live through the same renderer.
//
// no-store: the paid response carries a per-payment receipt header, so it must
// never be shared from a cache.
async function llmsFullResponse(request: SiteRequest, env: Env, extraHeaders) {
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };
  const served = await servePrecompressedText(request, env, { headers });
  if (served.status !== 404) return served;

  const base = new URL(request.url);
  const grab = async (path) => {
    const r = await env.ASSETS.fetch(new Request(new URL(path, base)));
    return r.ok ? await r.text() : null;
  };
  return new Response(await assembleWritingOnly(grab), { headers });
}

async function assembleWritingOnly(grab: (path: string) => Promise<string | null>) {
  const [llms, postsRaw] = await Promise.all([grab("/llms.txt"), grab("/writing/posts.json")]);
  // Annotated because `let posts = []` infers `never[]`, which makes `p` below
  // `never` and every field read on it an error. The shape is the registry's,
  // src/content/writing/posts.json.
  let posts: Array<{ slug: string; title: string; date: string }> = [];
  try { posts = JSON.parse(postsRaw || "[]"); } catch (_e) {}
  const docs = (await Promise.all(posts.map(async (p): Promise<LlmsFullDoc | null> => {
    const path = "/writing/" + p.slug + ".txt";
    const body = await grab(path);
    return body == null ? null : { title: p.title, date: p.date, path, body };
  }))).filter((d): d is LlmsFullDoc => d !== null);
  return renderLlmsFull(llms || "# aadhar.sh", [{ heading: WRITING_HEADING, docs }]);
}
