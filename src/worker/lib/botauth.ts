// lib/botauth.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// ── AadharshBot ─────────────────────────────────────────────────────
// branded crawler. uses our own UA + signs every outbound request per
// RFC 9421 (HTTP Message Signatures), profile per the Web Bot Auth IETF
// draft. signatures cover @authority + signature-agent; receiving sites
// can fetch the JWKS at https://aadhar.sh/.well-known/http-message-signatures-directory
// and verify against the published public keys.
//
// Every request carries ONE signature: sig1, ed25519, the one verifiers check.
//
// It used to carry a second, sig2, an ML-DSA-44 post-quantum label riding
// alongside. That shipped 2026-07-27 as a live example (the numbers are still
// at /garage/pqc) and came back out on 2026-08-15, because the thing that made
// it "additive" was never true of its CPU.
//
// workerd has no ML-DSA in WebCrypto, so signing was pure JS at ~8.5ms per
// request. This account is on Workers Free, which allows 10ms of CPU per
// invocation, so ONE signature spent most of a request's entire budget and any
// fan-out spent several budgets. Two surfaces were dark because of it:
//
//   - rn's Spotify scrape signs once per track. 21 tracks = ~180ms of signing,
//     so tier 2 never completed and every album cover came back null.
//   - /lens signs every foreign fetch, and discovery fans out to 28 probes.
//     Measured 2026-08-15 in production: 31 of 51 sampled requests died
//     `exceededCpu`, nearly all of them /lens/fetch and /lens/tools.
//
// Nothing on the internet verified sig2, so removing it costs no verifier
// anything and buys back the CPU both surfaces needed. The key is also gone
// from the published JWKS: advertising a key we no longer sign with is the
// dangling-pointer problem the DNS-AID note refuses for `_a2a`.
//
// Reviving it needs a runtime with native ML-DSA, or a plan that is not
// "sign on the request path". Do not re-add it to botHeaders
// without one, and read the CPU note above first.
import { fetchFollowingPublicRedirects, validateLensTarget } from "./public-fetch.ts";

const ENCODER = new TextEncoder();

export const BOT_NAME    = "AadharshBot";

const BOT_VERSION = "1.0";   // module-private: only BOT_UA below consumes it

export const BOT_UA      = `${BOT_NAME}/${BOT_VERSION} (+https://aadhar.sh/bot)`;

export const SIG_AGENT   = "https://aadhar.sh/";

export type BotRequestOptions = {
  headers?: HeadersInit;
  sign?: boolean;
  method?: string;
  redirect?: "follow" | "error" | "manual";
  signal?: AbortSignal;
  cf?: RequestInitCfProperties;
};

// Build the headers for an identified outbound request. AadharshBot's public
// identity promise is meaningful only when the signature is present, so this
// fails closed when the key is missing or malformed. Callers that genuinely do
// not need bot identity should use plain fetch with their own explicit policy.
export async function botHeaders(targetUrl, env, opts: BotRequestOptions = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("user-agent", BOT_UA);
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.9");
  }

  if (opts.sign === false) return headers;
  if (!env || !env.RN_SIGNING_KEY_JWK) {
    throw new Error("AadharshBot signing key is unavailable");
  }
  const host = new URL(targetUrl).host;
  const created = Math.floor(Date.now() / 1000);
  const { keyId, key } = await signingMaterial(env.RN_SIGNING_KEY_JWK);
  const params = `("@authority" "signature-agent");created=${created};keyid="${keyId}";alg="ed25519";tag="web-bot-auth"`;
  // RFC 9421: one covered component per line, then the signed parameters.
  const base = ENCODER.encode([
    `"@authority": ${host}`,
    `"signature-agent": "${SIG_AGENT}"`,
    `"@signature-params": ${params}`,
  ].join("\n"));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, base)).toBase64();
  headers.set("Signature-Agent", `"${SIG_AGENT}"`);
  headers.set("Signature-Input", `sig1=${params}`);
  headers.set("Signature", `sig1=:${signature}:`);
  return headers;
}

// The key material a signature needs, derived once per secret rather than once
// per call. `JSON.parse`, the RFC 7638 thumbprint (a SHA-256 over members that
// never change) and `importKey` are pure functions of the secret, and measured
// in workerd at this repo's compatibility date they were 17us of botHeaders'
// 29.5us. What is left, 12.5us, is the Ed25519 signature itself, which covers a
// per-request authority and a per-request `created` and so cannot be reused.
//
// The saving is per SIGNATURE, and the signature count is what makes it worth
// doing: /around walks 20 neighbours at two signed fetches each, /lens
// discovery fans out to 26 probes, and since #746 every redirect hop signs for
// its own authority. This account is on Workers Free, where sustained requests
// clamp near 10ms of CPU, and the ML-DSA note at the top of this file is what
// that clamp costs when per-request crypto meets a fan-out.
//
// Keyed on the JWK TEXT rather than computed once, because "the secret cannot
// change" is true of an isolate and not of a process: the contract suite signs
// with fixture keys, and a rotation that reused retired material would sign
// with a key the directory no longer publishes. Comparing the string makes the
// memo correct without anyone having to know which of those is happening.
//
// A PROMISE is cached rather than its result, since the fan-out above starts
// dozens of signatures at once and caching the value would let every one of
// them begin the same derivation before the first finished.
//
// A REJECTION is cached like any other answer, and that is deliberate rather
// than overlooked. Every input to the derivation is the secret, so a key that
// cannot be parsed or imported fails the same way however many times it is
// retried, and a different secret is a different memo entry. Dropping the entry
// on rejection was written first and then measured against the tests here: it
// changes nothing any caller can observe, so it went back out rather than stay
// as a line nothing can fail on.
let signingKey: { jwkText: string; material: Promise<{ keyId: string; key: CryptoKey }> } | null = null;

function signingMaterial(jwkText: string) {
  const cached = signingKey;
  if (cached && cached.jwkText === jwkText) return cached.material;
  const material = (async () => {
    const jwk = JSON.parse(jwkText);
    // keyid MUST be the key's RFC 7638 thumbprint (draft-meunier-web-bot-auth-
    // architecture-04): a verifier fetches the directory, thumbprints each key,
    // and looks the signature's keyid up by that value. It read `jwk.kid` here
    // until 2026-09-03, which was the label "rn-2026-06-30", so the signature and
    // the directory agreed with each other and with no verifier. Deriving it from
    // the public members means the two cannot disagree again.
    const [keyId, key] = await Promise.all([
      jwkThumbprint(jwk),
      crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]),
    ]);
    return { keyId, key };
  })();
  signingKey = { jwkText, material };
  return material;
}

export async function signedFetch(targetUrl, env, opts: BotRequestOptions = {}) {
  const init = async (url) => ({
    method: opts.method || "GET",
    headers: await botHeaders(url, env, { ...opts, sign: true }),
    signal: opts.signal,  // optional caller-supplied deadline (AbortSignal)
    cf: opts.cf || { cacheTtl: 0 },  // caller may set its own edge-cache policy; default is app-layer only
  });
  if (opts.redirect && opts.redirect !== "follow") {
    const verdict = validateLensTarget(targetUrl);
    if (!verdict.ok) throw new TypeError(verdict.error);
    return fetch(targetUrl, { ...await init(targetUrl), redirect: opts.redirect });
  }
  const followed = await fetchFollowingPublicRedirects(targetUrl, init, validateLensTarget, 20);
  if (!followed.ok) throw new TypeError(followed.error);
  return followed.response;
}

// RFC 7638: SHA-256 over the JSON of the REQUIRED members alone, in lexicographic
// order, with no whitespace, base64url without padding. For an OKP key those are
// crv, kty, x. Exported so the contract suite can pin it to RFC 8037's vector.
export async function jwkThumbprint(jwk) {
  const required = { OKP: ["crv", "kty", "x"], EC: ["crv", "kty", "x", "y"], RSA: ["e", "kty", "n"] }[jwk.kty];
  if (!required) throw new Error(`jwkThumbprint: unsupported kty ${jwk.kty}`);
  const canonical = "{" + required.map((k) => `${JSON.stringify(k)}:${JSON.stringify(jwk[k])}`).join(",") + "}";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(canonical)));
  return digest.toBase64({ alphabet: "base64url", omitPadding: true });
}
