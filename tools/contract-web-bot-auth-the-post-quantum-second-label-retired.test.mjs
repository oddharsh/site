// ── Web Bot Auth: the post-quantum second label, retired ─────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  botHeaders,
  labels,
  test,
} from "./contract-shared.ts";

// ── Web Bot Auth: the post-quantum second label, retired ─────────────
// sig2 shipped 2026-07-27 and came out 2026-08-15 because ~8.5ms of pure-JS
// ML-DSA per request does not fit a 10ms CPU budget (see lib/botauth.js).
//
// The FIRST test below is the load-bearing one. `RN_SIGNING_KEY_MLDSA_JWK` is
// still set as a production secret and deleting a secret is its own release, so
// the code has to ignore a key that is present. A regression here would be
// silent: sig2 would simply reappear and every fan-out would start dying on CPU
// again, which is the exact failure that took the covers and /lens down.

async function edEnv() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  jwk.kid = "test-ed";
  return { RN_SIGNING_KEY_JWK: JSON.stringify(jwk) };
}


test("a configured ML-DSA key is ignored: sig2 stays retired", async () => {
  // a well-formed AKP JWK, the shape the live secret still carries
  const env = {
    ...(await edEnv()),
    RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify({
      kty: "AKP", alg: "ML-DSA-44", kid: "test-mldsa", use: "sig",
      priv: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    }),
  };
  const headers = await botHeaders("https://example.com/", env);
  assert.deepEqual(labels(headers), ["sig1"]);
  assert.doesNotMatch(headers.get("signature-input"), /ml-dsa/i);
  assert.doesNotMatch(headers.get("signature"), /sig2/);
});

test("the ed25519 signature is unchanged by the removal", async () => {
  const headers = await botHeaders("https://example.com/", await edEnv());
  assert.deepEqual(labels(headers), ["sig1"]);
  assert.match(
    headers.get("signature-input"),
    /sig1=\("@authority" "signature-agent"\);created=\d+;keyid="test-ed";alg="ed25519";tag="web-bot-auth"/
  );
  // one label, so exactly one `created`
  assert.equal([...headers.get("signature-input").matchAll(/created=(\d+)/g)].length, 1);
});

test("sig1 verifies against the ed25519 key the JWKS publishes", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  jwk.kid = "test-ed";
  const headers = await botHeaders("https://example.com/robots.txt", { RN_SIGNING_KEY_JWK: JSON.stringify(jwk) });

  const params = headers.get("signature-input").match(/sig1=(.+)$/)[1];
  const base = new TextEncoder().encode([
    `"@authority": example.com`,
    `"signature-agent": "https://aadhar.sh/"`,
    `"@signature-params": ${params}`,
  ].join("\n"));
  const sig = Uint8Array.from(atob(headers.get("signature").match(/sig1=:([^:]+):/)[1]), (c) => c.charCodeAt(0));

  assert.equal(sig.length, 64);
  assert.equal(await crypto.subtle.verify("Ed25519", pair.publicKey, sig, base), true);
  // and it must not verify a base it did not sign
  base[13] ^= 1;
  assert.equal(await crypto.subtle.verify("Ed25519", pair.publicKey, sig, base), false);
});
