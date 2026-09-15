// Web Bot Auth binds a signature's keyid to the key's RFC 7638 thumbprint
// (draft-meunier-web-bot-auth-architecture-04): a verifier fetches the
// directory, thumbprints every key, and looks keyid up by that value. Until
// 2026-09-03 the directory's kid was the label "rn-2026-06-30" and the signer
// copied that label into keyid, so the two agreed with each other and with no
// verifier. Every earlier check asserted the directory EXISTED and carried a
// well-formed key, and all of them passed. Found from outside, by a probe that
// computes the thumbprint (oddharsh/doors, agent-identity). This pins the
// property the verifier keys on, in every place it has to hold.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { botHeaders, handleSignatureDirectory, jwkThumbprint } from "../src/worker/lib/botauth.ts";
import { HOMEPAGE_DISCOVERY_LINK, withSecurityHeaders } from "../src/worker/lib/security.ts";
import { parseJsonc } from "./lib/jsonc.ts";

const MEDIA_TYPE = "application/http-message-signatures-directory+json";

test("jwkThumbprint reproduces RFC 8037's Ed25519 vector, and reads x", async () => {
  // RFC 8037 appendix A.3, the one published OKP thumbprint vector.
  const vector = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
  assert.equal(await jwkThumbprint(vector), "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  // Control: the function must depend on the public key bytes, not on kty and crv alone.
  const perturbed = { ...vector, x: vector.x.slice(0, -1) + (vector.x.endsWith("o") ? "p" : "o") };
  assert.notEqual(await jwkThumbprint(perturbed), await jwkThumbprint(vector));
  // And it must ignore members that are not part of the thumbprint input.
  assert.equal(await jwkThumbprint({ ...vector, kid: "anything", alg: "EdDSA", use: "sig" }), await jwkThumbprint(vector));
});

test("every published key's kid is its thumbprint", async () => {
  const dir = JSON.parse(await readFile(new URL("public/.well-known/http-message-signatures-directory", ROOT), "utf8"));
  assert.ok(Array.isArray(dir.keys) && dir.keys.length >= 1, "the directory must publish at least one key");
  for (const key of dir.keys) assert.equal(key.kid, await jwkThumbprint(key), `kid of the ${key.kty}/${key.crv} key is not its RFC 7638 thumbprint`);
});

test("the signer derives keyid from the key rather than reading a label", async () => {
  // Public test key and expected thumbprint from RFC 8037 A.1/A.3:
  // https://www.rfc-editor.org/rfc/rfc8037.txt
  const jwk = {
    kty: "OKP", crv: "Ed25519",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  };
  for (const kid of [undefined, "not-the-thumbprint"]) {
    const headers = await botHeaders("https://example.com/", {
      RN_SIGNING_KEY_JWK: JSON.stringify({ ...jwk, kid }),
    });
    assert.match(headers.get("signature-input") || "",
      /;keyid="kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";alg="ed25519";/);
  }
});

test("the directory is served as the draft's media type, and advertised as such", async () => {
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/.well-known/http-message-signatures-directory"));
  assert.ok(block, "_headers must carry a rule for the directory path (it has no extension, so nothing infers a type)");
  assert.match(block, new RegExp(`Content-Type: ${MEDIA_TYPE.replace("+", "\\+")}`));
  assert.match(headers, new RegExp(`rel="http-message-signatures-directory"; type="${MEDIA_TYPE.replace("+", "\\+")}"`), "the Link advertising the directory must name the same type");
  assert.ok(HOMEPAGE_DISCOVERY_LINK.includes(`rel="http-message-signatures-directory"; type="${MEDIA_TYPE}"`), "Worker discovery must advertise the same media type");
});

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

async function signingFixture() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const body = JSON.stringify({ keys: [{ ...publicJwk, kid: await jwkThumbprint(publicJwk) }] });
  const env = {
    RN_SIGNING_KEY_JWK: JSON.stringify(privateJwk),
    ASSETS: { fetch: async () => new Response(body) },
  };
  return { env, body, publicKey: pair.publicKey };
}

function freshness(headers, before) {
  const params = headers.get("signature-input");
  assert.ok(params);
  const created = Number(params.match(/;created=(\d+)/)?.[1]);
  const expires = Number(params.match(/;expires=(\d+)/)?.[1]);
  const nonce = params.match(/;nonce="([^"]+)"/)?.[1];
  assert.ok(created >= before && created <= Math.floor(Date.now() / 1000));
  assert.equal(expires - created, 60, "a signature has a one-minute lifetime");
  assert.ok(nonce);
  assert.equal(Buffer.from(nonce, "base64").length, 32);
  assert.equal(Buffer.from(nonce, "base64").toString("base64"), nonce, "nonce is canonical base64");
  return nonce;
}

test("outbound signatures have a fresh 256-bit nonce and a bounded expiry on every call", async () => {
  const { env } = await signingFixture();
  const before = Math.floor(Date.now() / 1000);
  const headers = await Promise.all(Array.from({ length: 16 }, () => botHeaders("https://example.com/", env)));
  assert.equal(new Set(headers.map((h) => freshness(h, before))).size, headers.length);
});

test("directory GET and HEAD prove possession for the requesting authority with fresh signatures", async () => {
  const { env, body, publicKey } = await signingFixture();
  const nonces = new Set();
  for (const host of ["aadhar.sh", "preview.example:8787"]) {
    for (const method of ["GET", "HEAD"]) {
      const before = Math.floor(Date.now() / 1000);
      const request = new Request(`https://${host}${DIRECTORY_PATH}?ignored=1`, {
        method, headers: { "if-none-match": '"old"', range: "bytes=0-1" },
      });
      let reads = 0;
      const response = withSecurityHeaders(await handleSignatureDirectory(request, {
        ...env, ASSETS: { fetch: async (assetRequest) => {
          reads++;
          assert.equal(assetRequest.method, "GET");
          assert.equal(assetRequest.url, `https://${host}${DIRECTORY_PATH}`);
          assert.equal([...assetRequest.headers].length, 0, "client conditionals never reach the asset fetch");
          return new Response(body, { headers: { etag: '"old"', "cache-control": "public, max-age=2592000" } });
        } },
      }));
      assert.equal(reads, 1);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), MEDIA_TYPE);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.has("etag"), false);
      assert.equal(await response.text(), method === "GET" ? body : "");
      nonces.add(freshness(response.headers, before));
      const params = response.headers.get("signature-input").replace(/^sig1=/, "");
      assert.ok(params.startsWith('("@authority";req);'));
      assert.ok(params.endsWith(';tag="http-message-signatures-directory"'));
      const signature = response.headers.get("signature").match(/^sig1=:([^:]+):$/)?.[1];
      assert.ok(signature);
      const bytes = Uint8Array.fromBase64(signature);
      const base = (authority, parameters = params) => new TextEncoder().encode(`"@authority";req: ${authority}\n"@signature-params": ${parameters}`);
      assert.equal(await crypto.subtle.verify("Ed25519", publicKey, bytes, base(host)), true);
      assert.equal(await crypto.subtle.verify("Ed25519", publicKey, bytes, base("mirror.example")), false, "a mirror cannot reuse the proof");
      assert.equal(await crypto.subtle.verify("Ed25519", publicKey, bytes, base(host, params.replace(/;expires=\d+/, ";expires=9999999999"))), false, "expiry is signed");
      assert.equal(await crypto.subtle.verify("Ed25519", publicKey, bytes, base(host, params.replace(/;nonce="[^"]+"/, ';nonce="changed"'))), false, "nonce is signed");
    }
  }
  assert.equal(nonces.size, 4);
});

test("directory failures never fall back to an unsigned or mismatched success", async () => {
  const { env, body } = await signingFixture();
  const other = await signingFixture();
  for (const broken of [
    { ...env, RN_SIGNING_KEY_JWK: "" },
    { ...env, RN_SIGNING_KEY_JWK: "invalid JSON" },
    { ...env, RN_SIGNING_KEY_JWK: other.env.RN_SIGNING_KEY_JWK },
    { ...env, ASSETS: { fetch: async () => new Response(body, { status: 404 }) } },
    ...["invalid JSON", '{"keys":[]}', JSON.stringify({ keys: [...JSON.parse(body).keys, ...JSON.parse(other.body).keys] })]
      .map((payload) => ({ ...env, ASSETS: { fetch: async () => new Response(payload) } })),
    { ...env, ASSETS: { fetch: async () => { throw new Error("asset failure"); } } },
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await handleSignatureDirectory(new Request(`https://aadhar.sh${DIRECTORY_PATH}`, { method }), broken);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.has("signature"), false);
      assert.equal(await response.text(), method === "HEAD" ? "" : "Signing directory unavailable");
    }
  }
  const response = await handleSignatureDirectory(new Request(`https://aadhar.sh${DIRECTORY_PATH}`, { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.has("signature"), false);
});

test("both asset routers send the directory to the Worker within the platform's rule limit", async () => {
  for (const name of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
    const config = parseJsonc(await readFile(new URL(name, ROOT), "utf8"));
    assert.ok(config.assets.run_worker_first.includes(DIRECTORY_PATH), name);
    assert.ok(config.assets.run_worker_first.length <= 100, name);
  }
});

test("the /garage/pqc worked example quotes the published kid, so the page cannot teach the label shape", async () => {
  const dir = JSON.parse(await readFile(new URL("public/.well-known/http-message-signatures-directory", ROOT), "utf8"));
  const kid = dir.keys.find((k) => k.kty === "OKP").kid;
  const spec = await readFile(new URL("pipelines/garage/specs/pqc.json", ROOT), "utf8");
  const page = await readFile(new URL("src/pages/garage/pqc.html", ROOT), "utf8");
  assert.ok(spec.includes(`keyid=\\"${kid}\\"`), "the spec's Signature-Input example must carry the published kid");
  assert.ok(page.includes(`keyid="${kid}"`) || page.includes(`keyid=&quot;${kid}&quot;`), "the generated page must carry it too (regenerate with `node pipelines/garage/generate.mjs page pqc`)");
  assert.equal(spec.includes("rn-2026-06-30"), false, "the retired label must not survive as an example");
});
