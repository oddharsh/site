// lib/botauth.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// ── AadharshBot ─────────────────────────────────────────────────────
// branded crawler. uses our own UA + signs every outbound request per
// RFC 9421 (HTTP Message Signatures), profile per the Web Bot Auth IETF
// draft. signatures cover @authority + signature-agent; receiving sites
// can fetch the JWKS at https://aadhar.sh/.well-known/http-message-signatures-directory
// and verify against the published public keys.
//
// Every request carries TWO signatures over the same components:
//
//   sig1  ed25519     the one verifiers actually check today
//   sig2  ml-dsa-44   post-quantum, additive, nothing verifies it yet
//
// sig2 exists because the migration is cheap here and expensive later, and
// because a live example beats a writeup. Read /garage/pqc for the numbers.
// It is deliberately NOT load-bearing: see MLDSA_ALG on why it cannot be.
// The ML-DSA import is DYNAMIC, and that is a startup fix rather than a style
// choice. @noble/post-quantum builds its NTT lattice tables (getZettas,
// reverseBits) in module scope, so a static import made every cold isolate pay
// for them before serving a byte -- including the overwhelming majority of
// requests that never sign anything, since sig2 only rides AadharshBot's
// OUTBOUND crawls (rn's Spotify scrape, /around, census, webmention, /lens).
// `wrangler check startup` put the package at 45% of active startup; deferring
// it took the local profile from 3.9ms to 1.4ms median (25 runs each).
//
// esbuild keeps the module in this same bundle and wraps it in a lazy __esm
// initializer, so there is no extra network fetch at runtime and no
// find_additional_modules config -- the deferral is the wrapper, not a second
// module load. Verified under workerd, which permits a runtime import() inside
// a request handler.
//
// NB the ordering below: mldsaSigner checks for the KEY before it awaits this,
// so a deployment with no ML-DSA key configured never builds the tables at all.
let mlDsaPromise = null;
const getMlDsa44 = () => (mlDsaPromise ||= import("@noble/post-quantum/ml-dsa.js").then((m) => m.ml_dsa44));

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

// The IANA HTTP Signature Algorithms registry holds six entries and none of
// them are post-quantum, so this token is OURS, not a codepoint. It is spelled
// to match the registry's existing convention (ed25519, ecdsa-p256-sha256) so
// it slots straight in if a real registration ever lands. Until then nothing
// on the internet verifies sig2, and the site says so on /bot rather than
// implying a standard it does not have.
const MLDSA_ALG = "ml-dsa-44";

// ML-DSA-44 keygen expands a 32-byte seed into a 2560-byte secret key, which
// costs real milliseconds. Workers isolates outlive a request, so derive once
// and keep it. Keyed by the raw secret so rotating it inside a live isolate
// re-derives instead of signing with the retired key.
let mldsaCache = null;

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  // structured-fields binary content: base64 with padding, wrapped in colons by the caller
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// RFC 9964 AKP JWK (kty AKP, alg ML-DSA-44, priv = the 32-byte seed). Absent is
// fine and means "ed25519 only", because sig2 promises nothing yet and a crawl
// that still verifies beats a crawl that 500s. Malformed is NOT fine: the key
// directory advertises this key, so a broken one has to be loud.
async function mldsaSigner(env) {
  const raw = env && env.RN_SIGNING_KEY_MLDSA_JWK;
  if (!raw) return null;
  if (mldsaCache && mldsaCache.raw === raw) return mldsaCache;

  const jwk = JSON.parse(raw);
  if (jwk.kty !== "AKP" || jwk.alg !== "ML-DSA-44" || typeof jwk.priv !== "string") {
    throw new Error("AadharshBot ML-DSA key is malformed: expected an RFC 9964 AKP JWK with alg ML-DSA-44");
  }
  const seed = b64urlToBytes(jwk.priv);
  if (seed.length !== 32) {
    throw new Error(`AadharshBot ML-DSA seed is ${seed.length} bytes, expected 32`);
  }
  // shape checks first, tables second: a malformed key still fails loudly
  // without building 27KB of lattice constants to reject it.
  const ml_dsa44 = await getMlDsa44();
  mldsaCache = {
    raw,
    keyId: jwk.kid || "rn-mldsa",
    secretKey: ml_dsa44.keygen(seed).secretKey,
    sign: (msg, key) => ml_dsa44.sign(msg, key),
  };
  return mldsaCache;
}

// RFC 9421 signature base: one covered component per line, then the parameters
// of the label being signed. Each label signs its own params, so sig1 and sig2
// cover identical components but are never byte-identical inputs.
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

// build + sign the Web Bot Auth signatures over (@authority, signature-agent).
// returns one entry per label, in the order they go on the wire.
export async function signRequestForWebBotAuth(targetUrl, env) {
  const host = new URL(targetUrl).host;
  // one timestamp for both labels: they describe the same request, and a
  // verifier comparing created across labels should not see a skew we invented.
  const created = Math.floor(Date.now() / 1000);
  const out = [];

  const jwk = JSON.parse(env.RN_SIGNING_KEY_JWK);
  const edParams = paramsFor(created, jwk.kid || "rn", "ed25519");
  const edKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  out.push({
    label: "sig1",
    params: edParams,
    b64: bytesToB64(new Uint8Array(await crypto.subtle.sign(
      "Ed25519", edKey, signatureBase(host, edParams)
    ))),
  });

  // workerd's WebCrypto has no ML-DSA (it is still a WICG proposal), so this
  // one is pure JS. ~8.5ms and ~3.2KB of header, measured on /garage/pqc.
  const pq = await mldsaSigner(env);
  if (pq) {
    const pqParams = paramsFor(created, pq.keyId, MLDSA_ALG);
    out.push({
      label: "sig2",
      params: pqParams,
      b64: bytesToB64(pq.sign(signatureBase(host, pqParams), pq.secretKey)),
    });
  }

  return out;
}
