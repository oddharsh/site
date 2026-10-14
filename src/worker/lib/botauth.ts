// workerd now ships ML-DSA in WebCrypto behind the `webcrypto_modern_algorithms`
// compatibility flag, on BoringSSL. Measured 2026-10-01 on the pinned workerd:
// 0.12ms per signature, 72x the JS figure, and 0.03ms to turn the seed into a
// key. So the same fan-out now spends ~3.4ms where it spent ~240ms.
import { fetchFollowingPublicRedirects, readResponseCapped, validateLensTarget } from "./public-fetch.ts";
import { lensParseRobots, lensRobotsVerdict } from "./robots.ts";
import { isSubrequestLimit } from "./budget.ts";
import type { Env } from "./env.ts";

const ENCODER = new TextEncoder();

export const BOT_NAME    = "AadharshBot";

const BOT_VERSION = "1.0";

export const BOT_UA      = `${BOT_NAME}/${BOT_VERSION} (+https://aadhar.sh/bot)`;

export const SIG_AGENT   = "https://aadhar.sh/";

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

// `alg` is "ed25519" for sig1 and "ml-dsa-44" for sig2. The second is this
// site's spelling, since the IANA HTTP Signature Algorithms registry has no
// post-quantum entry yet; it follows the registry's lowercase-hyphen convention
// so a real registration is a no-op if it lands on the same token.
function signatureParams(components: string, keyId: string, tag: string, alg = "ed25519") {
  const created = Math.floor(Date.now() / 1000);
  const nonce = crypto.getRandomValues(new Uint8Array(32)).toBase64();
  return `(${components});created=${created};expires=${created + 60};nonce="${nonce}";keyid="${keyId}";alg="${alg}";tag="${tag}"`;
}

export type BotRequestOptions = {
  headers?: HeadersInit;
  sign?: boolean;
  method?: string;
  redirect?: "follow" | "error" | "manual";
  signal?: AbortSignal;
  cf?: RequestInitCfProperties;
  robots?: "respect" | "spotify-embed";
  postQuantum?: boolean;
};

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
  // RFC 9421: one covered component per line, then the signed parameters. Each
  // label signs its OWN base, because the base ends in that label's parameters.
  const signed = await signLabels(await activeSigners(env, opts.postQuantum !== false), '"@authority" "signature-agent"', "web-bot-auth", (params) => [
    `"@authority": ${host}`,
    `"signature-agent": "${SIG_AGENT}"`,
    `"@signature-params": ${params}`,
  ].join("\n"));
  headers.set("Signature-Agent", `"${SIG_AGENT}"`);
  headers.set("Signature-Input", signed.input);
  headers.set("Signature", signed.signature);
  return headers;
}

type Signer = { keyId: string; alg: string; sign: (base: Uint8Array) => Promise<ArrayBuffer> };
type SigningEnv = Pick<Env, "RN_SIGNING_KEY_JWK"> & Partial<Pick<Env, "RN_SIGNING_KEY_MLDSA_JWK">>;

async function activeSigners(env: SigningEnv, postQuantum = true): Promise<Signer[]> {
  const [ed, pq] = await Promise.all([
    signingMaterial(env.RN_SIGNING_KEY_JWK),
    postQuantum && env.RN_SIGNING_KEY_MLDSA_JWK ? pqSigningMaterial(env.RN_SIGNING_KEY_MLDSA_JWK) : null,
  ]);
  const signers: Signer[] = [{ keyId: ed.keyId, alg: "ed25519", sign: (base) => crypto.subtle.sign("Ed25519", ed.key, base) }];
  if (pq) signers.push({ keyId: pq.keyId, alg: "ml-dsa-44", sign: (base) => crypto.subtle.sign({ name: "ML-DSA-44" }, pq.key, base) });
  return signers;
}

async function signLabels(signers: Signer[], components: string, tag: string, base: (params: string) => string) {
  const parts = await Promise.all(signers.map(async (signer, i) => {
    const label = `sig${i + 1}`;
    const params = signatureParams(components, signer.keyId, tag, signer.alg);
    const signature = new Uint8Array(await signer.sign(ENCODER.encode(base(params)))).toBase64();
    return { input: `${label}=${params}`, signature: `${label}=:${signature}:` };
  }));
  return {
    input: parts.map((p) => p.input).join(", "),
    signature: parts.map((p) => p.signature).join(", "),
  };
}

// The committed JWK Set stays the public-key source of truth. Its response is
// Worker-owned so it can prove possession of each key for the requesting host
// (Cloudflare's directory-03 profile; directory-05 recommends one signature per
// key, so sig2 signs the directory too). Never serve an unsigned success, or
// sign a directory that drifted from the configured secrets: the ed25519 key
// must be published, and so must the ML-DSA key whenever sig2 is active. A
// rotation must update the public directory and the secret together.
//
// One asymmetry, on purpose. An AKP entry whose secret is unset or unusable is
// FILTERED out of the served copy instead of failing the request, because a
// 503 here also blinds every verifier of sig1, and sig2 must never cost sig1
// anything. Only real drift, a usable key that is not the published one, 503s.
export async function handleSignatureDirectory(request: Request, env: Pick<Env, "ASSETS"> & SigningEnv) {
  const headers = new Headers({ "cache-control": "no-store" });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    return new Response("Method not allowed", { status: 405, headers });
  }
  try {
    if (!env.RN_SIGNING_KEY_JWK) throw new Error("Signing key unavailable");
    const signers = await activeSigners(env);
    const asset = await env.ASSETS.fetch(new Request(new URL(DIRECTORY_PATH, request.url)));
    if (asset.status !== 200) throw new Error("Directory unavailable");
    let body = await asset.text();
    const directory = JSON.parse(body);
    if (!Array.isArray(directory.keys)) throw new Error("Directory has no keys");
    const ed = directory.keys.filter((k) => k.kty !== "AKP");
    const akp = directory.keys.filter((k) => k.kty === "AKP");
    if (ed.length !== 1 || await jwkThumbprint(ed[0]) !== signers[0].keyId || akp.length > 1) {
      throw new Error("Directory does not match signing key");
    }
    const pq = signers[1];
    if (pq && (akp.length !== 1 || await jwkThumbprint(akp[0]) !== pq.keyId)) {
      throw new Error("Directory does not publish the ML-DSA key sig2 signs with");
    }
    if (!pq && akp.length) body = JSON.stringify({ ...directory, keys: ed });
    const signed = await signLabels(signers, '"@authority";req', "http-message-signatures-directory",
      (params) => `"@authority";req: ${new URL(request.url).host}\n"@signature-params": ${params}`);
    headers.set("content-type", DIRECTORY_TYPE);
    headers.set("signature-input", signed.input);
    headers.set("signature", signed.signature);
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return new Response(request.method === "HEAD" ? null : "Signing directory unavailable", { status: 503, headers });
  }
}

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

// The same memo for sig2, with the opposite failure policy: it resolves to null
// instead of rejecting, so a bad ML-DSA key costs the label and never the
// request. The null is cached like any answer, for the reason above, which also
// means the console.error fires once per isolate rather than once per signature
// (an error log is an Issues occurrence and an observability event, and 28 a
// /lens scan would be noise). Only the error's NAME is logged: V8's JSON.parse
// messages quote the start of their input, which here is the secret.
//
// keyid comes from the public key getPublicKey derives, never from a `pub` the
// secret may or may not carry. workerd imports a bare seed JWK, and when `pub`
// IS present it refuses one that does not match `priv`, so the derived key is
// the only value that is right in every shape the secret can take.
let pqSigningKey: { jwkText: string; material: Promise<{ keyId: string; key: CryptoKey } | null> } | null = null;

function pqSigningMaterial(jwkText: string) {
  const cached = pqSigningKey;
  if (cached && cached.jwkText === jwkText) return cached.material;
  const material = (async () => {
    try {
      const key = await crypto.subtle.importKey("jwk", JSON.parse(jwkText), { name: "ML-DSA-44" }, false, ["sign"]);
      const publicJwk = await crypto.subtle.exportKey("jwk", await crypto.subtle.getPublicKey(key, ["verify"]));
      return { keyId: await jwkThumbprint(publicJwk), key };
    } catch (error) {
      console.error(`AadharshBot: sig2 disabled, the ML-DSA-44 key is unusable (${error?.name || "Error"})`);
      return null;
    }
  })();
  pqSigningKey = { jwkText, material };
  return material;
}

type BotPolicy = { ok: true } | { ok: false; kind: "disallow"; rule: string } | { ok: false; kind: "undetermined"; reason: string };

export class BotPolicyError extends Error {
  readonly policy: Exclude<BotPolicy, { ok: true }>;
  constructor(policy: Exclude<BotPolicy, { ok: true }>) {
    super(`AadharshBot: ${policy.kind === "disallow" ? policy.rule : policy.reason}, not fetched`);
    this.name = "BotPolicyError";
    this.policy = policy;
  }
}

export async function botRobotsPolicy(targetUrl: string, env: Pick<Env, "RN_KV" | "RN_SIGNING_KEY_JWK" | "BOT_ROBOTS_CACHE" | "OUTBOUND_TRANSPORT">, signal?: AbortSignal): Promise<BotPolicy> {
  const target = validateLensTarget(targetUrl);
  if (!target.ok) return { ok: false, kind: "undetermined", reason: target.error || "invalid target" };
  const url = new URL(target.url);
  if (url.pathname === "/robots.txt" && !url.search) return { ok: true };
  const cache = env.BOT_ROBOTS_CACHE;
  let pending = cache?.get(url.origin);
  if (!pending) {
    pending = readBotRobots(url.origin, env);
    cache?.set(url.origin, pending);
  }
  const read = await pending;
  if (!read.ok) return read;
  const parsed = read.parsed;
  signal?.throwIfAborted();
  const verdict = lensRobotsVerdict(parsed, BOT_NAME, url.pathname + url.search);
  if (verdict.verdict === "block") return { ok: false, kind: "disallow", rule: verdict.rule || "Disallow" };
  if (verdict.crawlDelay > 0) return { ok: false, kind: "disallow", rule: `Crawl-delay: ${verdict.crawlDelay} (origin skipped)` };
  return { ok: true };
}

// Only the parsed policy is shared inside one invocation, including in-flight
// reads. No Worker-global I/O promises can leak into another request context.
export type BotRobotsRead = { ok: true; parsed: ReturnType<typeof lensParseRobots> } | Extract<BotPolicy, { kind: "undetermined" }>;

export function withBotPolicyCache<T>(env: T) {
  return { ...env, BOT_ROBOTS_CACHE: new Map<string, Promise<BotRobotsRead>>() };
}

async function readBotRobots(origin: string, env: Pick<Env, "RN_KV" | "RN_SIGNING_KEY_JWK" | "OUTBOUND_TRANSPORT">): Promise<BotRobotsRead> {
  const cacheKey = `bot:robots:v1:${origin}`;
  let parsed: ReturnType<typeof lensParseRobots> | null = null;
  try { parsed = env.RN_KV ? await env.RN_KV.get(cacheKey, "json") : null; } catch (error) { if (isSubrequestLimit(error)) throw error; }
  if (!parsed) {
    const policySignal = AbortSignal.timeout(3000);
    try {
      const followed = await fetchFollowingPublicRedirects(origin + "/robots.txt", async (candidate) => ({
        headers: await botHeaders(candidate, env, { headers: { accept: "text/plain" }, postQuantum: false }),
        signal: policySignal,
        cf: { cacheTtl: 0 },
      }), validateLensTarget, 5, env.OUTBOUND_TRANSPORT);
      if (!followed.ok) return { ok: false, kind: "undetermined", reason: "robots.txt redirect refused" };
      const response = followed.response;
      if (response.ok) {
        // RFC 9309 requires at least 500 KiB. A truncated policy is unknown,
        // never allow-all: a later Disallow could be the part we did not read.
        const body = await readResponseCapped(response, 512 * 1024, policySignal);
        if (body.truncated) return { ok: false, kind: "undetermined", reason: "robots.txt exceeds 512 KiB" };
        parsed = lensParseRobots(body.text);
      } else {
        await response.body?.cancel();
        if (response.status < 400 || response.status >= 500 || response.status === 429) {
          return { ok: false, kind: "undetermined", reason: "robots.txt " + response.status };
        }
        parsed = lensParseRobots(""); // RFC 9309: unavailable 4xx means no rules.
      }
      if (env.RN_KV) {
        try { await env.RN_KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 43200 }); } catch (error) { if (isSubrequestLimit(error)) throw error; }
      }
    } catch (error) {
      if (isSubrequestLimit(error)) throw error;
      return { ok: false, kind: "undetermined", reason: "robots.txt unreachable" };
    }
  }
  return { ok: true, parsed };
}

const SPOTIFY_EMBED = /^https:\/\/open\.spotify\.com\/embed\/(?:playlist|track|artist)\/[A-Za-z0-9]{22}(?:\?_t=\d+)?$/;

export async function botRequestHeaders(targetUrl: string, env, opts: BotRequestOptions = {}) {
  const headers = await botHeaders(targetUrl, env, { ...opts, sign: true });
  if (opts.robots === "spotify-embed" && (opts.method || "GET") === "GET" && SPOTIFY_EMBED.test(targetUrl)) return headers;
  const policy = await botRobotsPolicy(targetUrl, env, opts.signal);
  if (!policy.ok) throw new BotPolicyError(policy);
  return headers;
}

export async function signedFetch(targetUrl, env, opts: BotRequestOptions = {}) {
  const init = async (url) => ({
    method: opts.method || "GET",
    headers: await botRequestHeaders(url, env, opts),
    signal: opts.signal,
    cf: opts.cf || { cacheTtl: 0 },
  });
  if (opts.redirect && opts.redirect !== "follow") {
    const verdict = validateLensTarget(targetUrl);
    if (!verdict.ok) throw new TypeError(verdict.error);
    const single = { ...await init(targetUrl), redirect: opts.redirect };
    return env?.OUTBOUND_TRANSPORT ? env.OUTBOUND_TRANSPORT(targetUrl, single) : fetch(targetUrl, single);
  }
  const followed = await fetchFollowingPublicRedirects(targetUrl, init, validateLensTarget, 20, env?.OUTBOUND_TRANSPORT);
  if (!followed.ok) throw new TypeError(followed.error);
  return followed.response;
}

// RFC 7638: SHA-256 over the JSON of the REQUIRED members alone, in lexicographic
// order, with no whitespace, base64url without padding. For an OKP key those are
// crv, kty, x; for an AKP (ML-DSA) key RFC 9964 section 6 makes them alg, kty,
// pub. Exported so the contract suite can pin it to RFC 8037's vector.
export async function jwkThumbprint(jwk) {
  const required = { OKP: ["crv", "kty", "x"], EC: ["crv", "kty", "x", "y"], RSA: ["e", "kty", "n"], AKP: ["alg", "kty", "pub"] }[jwk.kty];
  if (!required) throw new Error(`jwkThumbprint: unsupported kty ${jwk.kty}`);
  const canonical = "{" + required.map((k) => `${JSON.stringify(k)}:${JSON.stringify(jwk[k])}`).join(",") + "}";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(canonical)));
  return digest.toBase64({ alphabet: "base64url", omitPadding: true });
}
