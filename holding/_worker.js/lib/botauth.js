// lib/botauth.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// ── AadharshBot ─────────────────────────────────────────────────────
// branded crawler. uses our own UA + signs every outbound request per
// RFC 9421 (HTTP Message Signatures), profile per the Web Bot Auth IETF
// draft. signatures cover @authority + signature-agent; receiving sites
// can fetch the JWKS at https://aadhar.sh/.well-known/http-message-signatures-directory
// and verify against the published Ed25519 public key.
export const BOT_NAME    = "AadharshBot";

const BOT_VERSION = "1.0";   // module-private: only BOT_UA below consumes it

export const BOT_UA      = `${BOT_NAME}/${BOT_VERSION} (+https://aadhar.sh/bot)`;

export const SIG_AGENT   = "https://aadhar.sh/";

// signed outbound fetch. always sets our UA. signs when the private key is
// available; falls back to UA-only fetch if signing fails (better to crawl
// unsigned than to silently break).
export async function signedFetch(targetUrl, env, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("user-agent", BOT_UA);
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.9");
  }

  if (env.RN_SIGNING_KEY_JWK) {
    try {
      const sig = await signRequestForWebBotAuth(targetUrl, env);
      headers.set("Signature-Agent", `"${SIG_AGENT}"`);
      headers.set("Signature-Input", `sig1=${sig.params}`);
      headers.set("Signature", `sig1=:${sig.b64}:`);
    } catch (_e) {
      // keep going; recipient just won't be able to verify
    }
  }

  return fetch(targetUrl, {
    method: opts.method || "GET",
    headers,
    redirect: opts.redirect || "follow",
    signal: opts.signal,  // optional caller-supplied deadline (AbortSignal)
    cf: opts.cf || { cacheTtl: 0 },  // caller may set its own edge-cache policy; default is app-layer only
  });
}

// build + sign a Web Bot Auth signature over (@authority, signature-agent).
export async function signRequestForWebBotAuth(targetUrl, env) {
  const u = new URL(targetUrl);
  const jwk = JSON.parse(env.RN_SIGNING_KEY_JWK);
  const keyId = jwk.kid || "rn";
  const cryptoKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "Ed25519" }, false, ["sign"]
  );

  const created = Math.floor(Date.now() / 1000);
  const params  = `("@authority" "signature-agent");created=${created};keyid="${keyId}";alg="ed25519";tag="web-bot-auth"`;

  // RFC 9421 signature base: one component per line, then @signature-params.
  const base = [
    `"@authority": ${u.host}`,
    `"signature-agent": "${SIG_AGENT}"`,
    `"@signature-params": ${params}`,
  ].join("\n");

  const sigBytes = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", cryptoKey, new TextEncoder().encode(base)
  ));
  // structured-fields binary content: base64 (with padding), wrapped in colons by caller
  let bin = "";
  for (let i = 0; i < sigBytes.length; i++) bin += String.fromCharCode(sigBytes[i]);
  const b64 = btoa(bin);

  return { params, b64 };
}
