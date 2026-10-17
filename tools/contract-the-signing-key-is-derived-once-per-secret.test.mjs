// botHeaders signs every outbound AadharshBot request, and three quarters of
// what it used to do per call was rederiving a constant: JSON.parse over the
// secret, the RFC 7638 thumbprint, and importKey. Those are memoized now.
//
// The saving is per signature and the signature count is large: /around signs
// twice per neighbour across 20 of them, /lens discovery fans out to 26 probes,
// and since #746 every redirect hop signs for its own authority. A memo on that
// path has two ways to be wrong that no existing check would see, because both
// produce a perfectly well-formed signature:
//
//   - keyed too loosely, so a ROTATED secret keeps signing with retired
//     material and the directory stops matching the keyid on the wire;
//   - cached on failure, so the first malformed env becomes the isolate's
//     permanent answer and a later good key never gets a chance.
//
// The existing keyid test signs twice in one process and cannot catch either:
// its two envs differ only in a `kid` member the thumbprint ignores, so both
// calls are entitled to the same answer.
import { assert, test } from "./contract-shared.ts";
import { botHeaders, jwkThumbprint } from "../src/worker/lib/botauth.ts";

// RFC 8037 A.1, plus a second Ed25519 pair so "rotated" is a real other key.
const RFC8037 = {
  kty: "OKP", crv: "Ed25519",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};

async function freshJwk() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

const keyidOf = (headers) => (headers.get("signature-input") || "").match(/;keyid="([^"]+)"/)?.[1];

test("a rotated secret derives fresh material instead of reusing the last one", async () => {
  const rotated = await freshJwk();
  const first = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(RFC8037) });
  const second = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(rotated) });
  const third = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(RFC8037) });

  assert.equal(keyidOf(first), await jwkThumbprint(RFC8037));
  assert.equal(keyidOf(second), await jwkThumbprint(rotated));
  // The control the memo exists to survive: two different keys in one process
  // must not answer with one keyid, in either order.
  assert.notEqual(keyidOf(first), keyidOf(second));
  assert.equal(keyidOf(third), keyidOf(first), "rotating back must not leave the second key's material in place");
});

test("the memoized key is the key that signs, so the signature still verifies under the published thumbprint", async () => {
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify(RFC8037) };
  const { d: _private, ...pub } = RFC8037;
  const verifier = await crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, { name: "Ed25519" }, false, ["verify"]);

  // Twice, because the second call is the one reading memoized material.
  for (const host of ["example.com", "example.org"]) {
    const headers = await botHeaders(`https://${host}/path`, env);
    const params = (headers.get("signature-input") || "").replace(/^sig1=/, "");
    const signature = (headers.get("signature") || "").match(/^sig1=:(.+):$/)?.[1];
    assert.ok(signature, "every signed request carries a sig1 label");
    const base = new TextEncoder().encode([
      `"@authority": ${host}`,
      `"signature-agent": "https://aadhar.sh/"`,
      `"@signature-params": ${params}`,
    ].join("\n"));
    assert.equal(
      await crypto.subtle.verify("Ed25519", verifier, Uint8Array.fromBase64(signature), base),
      true,
      `the signature for ${host} does not verify against the published public key`,
    );
    assert.equal(keyidOf(headers), await jwkThumbprint(RFC8037));
  }
});

test("a malformed secret fails closed on every call rather than poisoning the isolate", async () => {
  const bad = { RN_SIGNING_KEY_JWK: "{not json" };
  await assert.rejects(() => botHeaders("https://example.com/", bad));
  // The second call is the one a cached rejection would answer from.
  await assert.rejects(() => botHeaders("https://example.com/", bad));
  // And a good key after a bad one must still work.
  const headers = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(RFC8037) });
  assert.equal(keyidOf(headers), await jwkThumbprint(RFC8037));
});

test("one secret costs one importKey however many signatures it produces", async () => {
  const jwk = await freshJwk();
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify(jwk) };
  const real = crypto.subtle.importKey.bind(crypto.subtle);
  let imports = 0;
  crypto.subtle.importKey = (...args) => { imports++; return real(...args); };
  try {
    // Concurrent, because caching the RESULT rather than the promise lets every
    // caller in a fan-out start the same derivation before the first finishes.
    // This is the shape /lens discovery and the /around sweep actually produce.
    const headers = await Promise.all(
      Array.from({ length: 12 }, (_, i) => botHeaders(`https://h${i}.example.com/`, env)),
    );
    assert.equal(imports, 1, `12 concurrent signatures cost ${imports} importKey calls, expected 1`);
    assert.equal(new Set(headers.map(keyidOf)).size, 1, "every signature must name the same keyid");
    for (const h of headers) assert.match(h.get("signature") || "", /^sig1=:.+:$/);
  } finally {
    crypto.subtle.importKey = real;
  }
});
