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
import { jwkThumbprint } from "../src/worker/lib/botauth.ts";

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
  const src = await readFile(new URL("src/worker/lib/botauth.ts", ROOT), "utf8");
  assert.match(src, /paramsFor\(created, await jwkThumbprint\(jwk\), "ed25519"\)/, "keyid must be derived by jwkThumbprint at signing time");
  assert.doesNotMatch(src, /jwk\.kid\s*\|\|/, "a typed kid must never be the fallback for keyid again");
});

test("the directory is served as the draft's media type, and advertised as such", async () => {
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/.well-known/http-message-signatures-directory"));
  assert.ok(block, "_headers must carry a rule for the directory path (it has no extension, so nothing infers a type)");
  assert.match(block, new RegExp(`Content-Type: ${MEDIA_TYPE.replace("+", "\\+")}`));
  assert.match(headers, new RegExp(`rel="http-message-signatures-directory"; type="${MEDIA_TYPE.replace("+", "\\+")}"`), "the Link advertising the directory must name the same type");
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
