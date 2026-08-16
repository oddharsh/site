// @ts-nocheck — declared in config/ts-migration.json, which may only SHRINK.
// This module carried type errors when the Worker moved from JavaScript to
// TypeScript on 2026-08-16. The code is unchanged and runs identically; what
// changed is that tsc stopped being lenient. In a .js file TypeScript treats
// every parameter as optional and infers loosely, so none of this was visible.
// Remove this line, fix what tsc then reports, and delete the entry from
// config/ts-migration.json. A contract test fails if the two disagree.
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
// "sign on the request path". Do not re-add it to signRequestForWebBotAuth
// without one, and read the CPU note above first.
export const BOT_NAME    = "AadharshBot";

const BOT_VERSION = "1.0";   // module-private: only BOT_UA below consumes it

export const BOT_UA      = `${BOT_NAME}/${BOT_VERSION} (+https://aadhar.sh/bot)`;

export const SIG_AGENT   = "https://aadhar.sh/";

// Build the headers for an identified outbound request. AadharshBot's public
// identity promise is meaningful only when the signature is present, so this
// fails closed when the key is missing or malformed. Callers that genuinely do
// not need bot identity should use plain fetch with their own explicit policy.
export async function botHeaders(targetUrl, env, opts = {}) {
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
  const sigs = await signRequestForWebBotAuth(targetUrl, env);
  headers.set("Signature-Agent", `"${SIG_AGENT}"`);
  // both fields are structured-fields Dictionaries, so a second label appends
  // rather than replaces. a verifier that only knows ed25519 reads sig1 and
  // ignores sig2, which is the whole reason this can ship before the registry.
  headers.set("Signature-Input", sigs.map((s) => `${s.label}=${s.params}`).join(", "));
  headers.set("Signature", sigs.map((s) => `${s.label}=:${s.b64}:`).join(", "));
  return headers;
}

export async function signedFetch(targetUrl, env, opts = {}) {
  const headers = await botHeaders(targetUrl, env, { ...opts, sign: true });

  return fetch(targetUrl, {
    method: opts.method || "GET",
    headers,
    redirect: opts.redirect || "follow",
    signal: opts.signal,  // optional caller-supplied deadline (AbortSignal)
    cf: opts.cf || { cacheTtl: 0 },  // caller may set its own edge-cache policy; default is app-layer only
  });
}

function bytesToB64(bytes) {
  // structured-fields binary content: base64 with padding, wrapped in colons by the caller
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// RFC 9421 signature base: one covered component per line, then the parameters
// of the label being signed.
function signatureBase(host, params) {
  return new TextEncoder().encode([
    `"@authority": ${host}`,
    `"signature-agent": "${SIG_AGENT}"`,
    `"@signature-params": ${params}`,
  ].join("\n"));
}

function paramsFor(created, keyId, alg) {
  return `("@authority" "signature-agent");created=${created};keyid="${keyId}";alg="${alg}";tag="web-bot-auth"`;
}

// build + sign the Web Bot Auth signature over (@authority, signature-agent).
// One entry, kept as a list because the wire format is a structured-fields
// Dictionary and the callers join it: a second label would slot in here, and
// the header-building code above never has to learn how many there are.
export async function signRequestForWebBotAuth(targetUrl, env) {
  const host = new URL(targetUrl).host;
  const created = Math.floor(Date.now() / 1000);

  const jwk = JSON.parse(env.RN_SIGNING_KEY_JWK);
  const edParams = paramsFor(created, jwk.kid || "rn", "ed25519");
  // Ed25519 is native in workerd's WebCrypto, so this costs microseconds. The
  // retired sig2 was pure JS at ~8.5ms, which is the whole reason it is gone.
  const edKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return [{
    label: "sig1",
    params: edParams,
    b64: bytesToB64(new Uint8Array(await crypto.subtle.sign(
      "Ed25519", edKey, signatureBase(host, edParams)
    ))),
  }];
}
