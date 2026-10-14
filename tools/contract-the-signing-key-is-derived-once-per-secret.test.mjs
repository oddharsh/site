// botHeaders signs every outbound AadharshBot request, and three quarters of
// what it used to do per call was rederiving a constant: JSON.parse over the
// secret, the RFC 7638 thumbprint, and importKey. Those are memoized now.
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
  assert.notEqual(keyidOf(first), keyidOf(second));
  assert.equal(keyidOf(third), keyidOf(first), "rotating back must not leave the second key's material in place");
});

test("the memoized key is the key that signs, so the signature still verifies under the published thumbprint", async () => {
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify(RFC8037) };
  const { d: _private, ...pub } = RFC8037;
  const verifier = await crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, { name: "Ed25519" }, false, ["verify"]);

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
  await assert.rejects(() => botHeaders("https://example.com/", bad));
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
