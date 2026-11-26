// Every key in AadharshBot's Web Bot Auth directory carries a validity window,
// nbf and exp in JWT NumericDate seconds, as the directory draft's examples do
// (draft-meunier-http-message-signatures-directory-04). The draft rotates by
// that window: publish the next key before its nbf, keep the old one until its
// exp, then drop it. An orank scan on 2026-11-24 docked the directory for
// carrying neither. Cloudflare's reference verifier (cloudflare/web-bot-auth at
// 6f5d2e5, 2026-11-25) does not read either member yet, so exp is a promise the
// site makes, and this test is what keeps it: it fails on every PR from 60 days
// before the soonest exp, which leaves two months to rotate (or knowingly
// extend) and deploy. It reads the clock on purpose, like
// contract-security-txt-expires-60-days-out.
import { ROOT, assert, readFile, test } from "../../../../tools/tests/contract-shared.ts";
import { handleSignatureDirectory, jwkThumbprint } from "../botauth.ts";

const FILE = "public/.well-known/http-message-signatures-directory";
const DAY_S = 86_400;
const LEAD_DAYS = 60;
// The owner's horizon (2026-11-24): a key's exp sits at most a year out, so a
// far-future date cannot stand in for the rotation review this test forces.
const HORIZON_DAYS = 366;

const directory = JSON.parse(await readFile(new URL(FILE, ROOT), "utf8"));

test(`${FILE} publishes exactly these members on each key`, () => {
  // Sorted member names per key type. A new member is a deliberate change to
  // what verifiers read, so it should have to touch this line.
  assert.deepEqual(
    directory.keys.map((key) => [key.kty, Object.keys(key).sort()]),
    [
      ["OKP", ["alg", "crv", "exp", "kid", "kty", "nbf", "use", "x"]],
      ["AKP", ["alg", "exp", "kid", "kty", "nbf", "pub", "use"]],
    ],
  );
  assert.deepEqual(Object.keys(directory), ["keys"]);
});

test(`${FILE} key windows are seconds, already open, and close ${LEAD_DAYS} to ${HORIZON_DAYS} days out`, () => {
  const now = Math.floor(Date.now() / 1000);
  for (const key of directory.keys) {
    const label = `${key.kty} key ${key.kid}`;
    assert.ok(Number.isSafeInteger(key.nbf) && Number.isSafeInteger(key.exp), `${label}: nbf and exp must be integers`);
    // Milliseconds would put exp in the year 50,000 and still pass a "future"
    // check. Cloudflare's verification-workers example writes nbf with
    // Date.getTime(), which is this mistake.
    assert.ok(key.exp < 10_000_000_000, `${label}: exp ${key.exp} looks like milliseconds; NumericDate is seconds`);
    assert.ok(key.nbf <= now, `${label}: nbf ${key.nbf} is in the future, so a verifier honoring it rejects sig1 today`);
    assert.ok(key.nbf < key.exp, `${label}: nbf must precede exp`);
    const days = (key.exp - now) / DAY_S;
    assert.ok(
      days >= LEAD_DAYS,
      `${label} expires ${new Date(key.exp * 1000).toISOString()}, ${Math.floor(days)} day(s) from now. Rotate it (docs/MAINTENANCE.md) or extend exp, keeping it under a year out, and deploy`,
    );
    assert.ok(days <= HORIZON_DAYS, `${label} expires ${new Date(key.exp * 1000).toISOString()}, more than a year out`);
  }
});

test("nbf and exp leave the thumbprint alone, so keyid still matches kid", async () => {
  for (const key of directory.keys) {
    const { nbf: _nbf, exp: _exp, ...bare } = key;
    assert.equal(await jwkThumbprint(key), await jwkThumbprint(bare));
    assert.equal(await jwkThumbprint(key), key.kid);
  }
});

test("the served directory keeps nbf and exp when it drops an unusable ML-DSA key", async () => {
  // With no ML-DSA secret the handler re-serializes the directory without its
  // AKP entry. That rewrite is the one place the window could fall off.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const ed = { ...publicJwk, kid: await jwkThumbprint(publicJwk), use: "sig", nbf: 1782878939, exp: 1827187200 };
  const akp = directory.keys.find((key) => key.kty === "AKP");
  const body = JSON.stringify({ keys: [ed, akp] });
  const response = await handleSignatureDirectory(new Request("https://aadhar.sh/.well-known/http-message-signatures-directory"), {
    RN_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    ASSETS: { fetch: async () => new Response(body) },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { keys: [ed] });
});
