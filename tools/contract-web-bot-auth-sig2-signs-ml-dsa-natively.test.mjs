// ── Web Bot Auth: sig2, the post-quantum second label, signed natively ──
//
// sig2 shipped 2026-07-27 in pure JS, came out 2026-08-15 because ~8.5ms of
// signing per request did not fit Workers Free's CPU clamp, and came back once
// workerd shipped ML-DSA in WebCrypto behind `webcrypto_modern_algorithms`
// (0.12ms a signature, measured 2026-10-01). lib/botauth.ts has the history.
//
// What this file pins is the failure POLICY, because that is what makes a
// second label safe to carry: sig2 is optional, sig1 never changes because of
// it, and the directory never publishes a key the Worker is not signing with.
// Every assertion that something works has a control beside it that must fail.
//
// The keys here are FULL JWKs (pub and priv), because bun and node refuse a
// priv-only AKP JWK while workerd accepts one. The production secret's bare-
// seed shape is exercised in workerd itself, in the harness test at the end.
import {
  assert,
  botHeaders,
  configText,
  labels,
  ROOT,
  readFile,
  test,
} from "./contract-shared.ts";
import { handleSignatureDirectory, jwkThumbprint } from "../src/worker/lib/botauth.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { underNode } from "./lib/harness-dispatch.ts";

const MLDSA = { name: "ML-DSA-44" };
const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const encode = (s) => new TextEncoder().encode(s);

// The DOM lib this program types against predates ML-DSA, so generateKey reads
// as CryptoKey | CryptoKeyPair and JsonWebKey has no AKP members. These name
// what the runtime actually returns.
/** @typedef {JsonWebKey & { pub?: string, priv?: string, kid?: string }} Jwk */
/** @typedef {{ pair: CryptoKeyPair, priv: Jwk, pub: Jwk }} TestKey */

/** @returns {Promise<TestKey>} */
async function edKey() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]));
  const priv = /** @type {Jwk} */ (await crypto.subtle.exportKey("jwk", pair.privateKey));
  const pub = /** @type {Jwk} */ (await crypto.subtle.exportKey("jwk", pair.publicKey));
  return { pair, priv, pub: { ...pub, kid: await jwkThumbprint(pub) } };
}

/** @returns {Promise<TestKey>} */
async function pqKey() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(MLDSA, true, ["sign", "verify"]));
  const priv = /** @type {Jwk} */ (await crypto.subtle.exportKey("jwk", pair.privateKey));
  const pub = /** @type {Jwk} */ (await crypto.subtle.exportKey("jwk", pair.publicKey));
  return { pair, priv, pub: { ...pub, kid: await jwkThumbprint(pub) } };
}

// Split one Dictionary header into { label: value }. Signature-Input values
// carry quoted strings but never ", sig", so splitting on that is exact here.
function members(header) {
  return Object.fromEntries(header.split(/, (?=sig\d+=)/).map((m) => {
    const i = m.indexOf("=");
    return [m.slice(0, i), m.slice(i + 1)];
  }));
}

function requestBase(host, params) {
  return encode([`"@authority": ${host}`, `"signature-agent": "https://aadhar.sh/"`, `"@signature-params": ${params}`].join("\n"));
}

const sigBytes = (value) => Uint8Array.fromBase64(value.match(/^:([^:]+):$/)[1]);

test("with an ML-DSA key, every request carries sig1 then sig2, and each verifies over its own base", async () => {
  const ed = await edKey(), pq = await pqKey();
  const headers = await botHeaders("https://example.com/robots.txt", {
    RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv),
    RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(pq.priv),
  });
  assert.deepEqual(labels(headers), ["sig1", "sig2"]);
  const input = members(headers.get("signature-input"));
  const sig = members(headers.get("signature"));
  assert.match(input.sig1, new RegExp(`;keyid="${ed.pub.kid}";alg="ed25519";tag="web-bot-auth"$`));
  assert.match(input.sig2, new RegExp(`;keyid="${pq.pub.kid}";alg="ml-dsa-44";tag="web-bot-auth"$`));
  assert.ok(input.sig2.startsWith('("@authority" "signature-agent");'), "sig2 covers the same components as sig1");
  assert.equal(sigBytes(sig.sig2).length, 2420, "an ML-DSA-44 signature is 2,420 bytes (FIPS 204)");
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), requestBase("example.com", input.sig2)), true);
  assert.equal(await crypto.subtle.verify("Ed25519", ed.pair.publicKey, sigBytes(sig.sig1), requestBase("example.com", input.sig1)), true);
  // Controls: each signature is bound to its own parameters and authority.
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), requestBase("example.com", input.sig1)), false,
    "sig2 must sign a base ending in sig2's own parameters");
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), requestBase("mirror.example", input.sig2)), false,
    "sig2 must not verify for another authority");
  // Two independent nonces, so the labels are two signatures and not one reused.
  assert.notEqual(input.sig1.match(/nonce="([^"]+)"/)[1], input.sig2.match(/nonce="([^"]+)"/)[1]);
});

test("sig2's keyid is the RFC 9964 thumbprint of the key that signed, whatever the secret's kid says", async () => {
  const ed = await edKey(), pq = await pqKey();
  for (const kid of [undefined, "rn-mldsa-2026-07-27"]) {
    const headers = await botHeaders("https://example.com/", {
      RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv),
      RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify({ ...pq.priv, kid }),
    });
    assert.match(members(headers.get("signature-input")).sig2, new RegExp(`;keyid="${pq.pub.kid}";`));
  }
});

test("jwkThumbprint reads an AKP key's alg, kty and pub, and nothing else", async () => {
  const pq = await pqKey();
  const bare = { kty: "AKP", alg: "ML-DSA-44", pub: pq.pub.pub };
  assert.equal(await jwkThumbprint({ ...bare, kid: "x", use: "sig", priv: "ignored" }), await jwkThumbprint(bare));
  // Controls: the public key bytes and the algorithm are both in the input.
  assert.notEqual(await jwkThumbprint({ ...bare, pub: (await pqKey()).pub.pub }), await jwkThumbprint(bare));
  assert.notEqual(await jwkThumbprint({ ...bare, alg: "ML-DSA-65" }), await jwkThumbprint(bare));
  // And the canonical form is the RFC 7638 one: lexicographic, no whitespace.
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", encode(`{"alg":"ML-DSA-44","kty":"AKP","pub":"${bare.pub}"}`)))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  assert.equal(await jwkThumbprint(bare), expected);
});

test("without an ML-DSA key, sig1 ships alone and unchanged", async () => {
  const ed = await edKey();
  const headers = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv) });
  assert.deepEqual(labels(headers), ["sig1"]);
  const input = headers.get("signature-input") ?? "";
  assert.match(input, new RegExp(`^sig1=\\("@authority" "signature-agent"\\);created=\\d+;expires=\\d+;nonce="[A-Za-z0-9+/]+=*";keyid="${ed.pub.kid}";alg="ed25519";tag="web-bot-auth"$`));
  assert.doesNotMatch(headers.get("signature") ?? "", /sig2/);
});

test("an unusable ML-DSA key drops sig2, never fails the request, and never logs the secret", async () => {
  const ed = await edKey();
  const secretish = "SEEDSEEDSEEDSEEDSEEDSEEDSEEDSEED";
  const broken = [
    `{"kty":"AKP","alg":"ML-DSA-44","priv":"${secretish}"`, // truncated JSON: JSON.parse quotes its input
    JSON.stringify({ kty: "AKP", alg: "ML-DSA-44", priv: secretish }), // not a 32-byte seed
    JSON.stringify(ed.priv), // an ed25519 key in the ML-DSA slot
  ];
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    for (const secret of broken) {
      const before = logged.length;
      for (let i = 0; i < 3; i++) {
        const headers = await botHeaders("https://example.com/", { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: secret });
        assert.deepEqual(labels(headers), ["sig1"], `secret ${broken.indexOf(secret)} must cost sig2 and nothing else`);
      }
      assert.equal(logged.length - before, 1, "an unusable key logs once per isolate, not once per signature");
    }
  } finally {
    console.error = original;
  }
  for (const line of logged) {
    assert.match(line, /sig2 disabled/);
    assert.ok(!line.includes(secretish), `a log line carried secret material: ${line}`);
  }
  // Control: the ed25519 half still fails closed, since without it there is no identity.
  await assert.rejects(botHeaders("https://example.com/", { RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify((await pqKey()).priv) }));
});

// ── the directory ──────────────────────────────────────────────────────

function directoryEnv(keys, secrets) {
  const body = JSON.stringify({ keys });
  return { body, env: { ...secrets, ASSETS: { fetch: async () => new Response(body) } } };
}

const getDirectory = (env) => handleSignatureDirectory(new Request(`https://aadhar.sh${DIRECTORY_PATH}`), env);

test("with sig2 active, the directory publishes both keys and proves possession of each", async () => {
  const ed = await edKey(), pq = await pqKey();
  const { body, env } = directoryEnv([ed.pub, pq.pub], {
    RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(pq.priv),
  });
  const response = await getDirectory(env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body, "an active key set serves the committed bytes untouched");
  const input = members(response.headers.get("signature-input"));
  const sig = members(response.headers.get("signature"));
  assert.deepEqual(Object.keys(input), ["sig1", "sig2"]);
  const base = (params) => encode(`"@authority";req: aadhar.sh\n"@signature-params": ${params}`);
  assert.match(input.sig2, new RegExp(`;keyid="${pq.pub.kid}";alg="ml-dsa-44";tag="http-message-signatures-directory"$`));
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), base(input.sig2)), true);
  assert.equal(await crypto.subtle.verify("Ed25519", ed.pair.publicKey, sigBytes(sig.sig1), base(input.sig1)), true);
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), encode(`"@authority";req: mirror.example\n"@signature-params": ${input.sig2}`)), false,
    "a mirror cannot reuse the ML-DSA proof either");
});

test("with sig2 unavailable, the directory drops its AKP entry and still proves sig1", async () => {
  const ed = await edKey(), pq = await pqKey();
  for (const secrets of [
    { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv) }, // unset: local dev, any preview without the secret
    { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: "not json" }, // unusable
  ]) {
    const original = console.error;
    console.error = () => {};
    try {
      const { env } = directoryEnv([ed.pub, pq.pub], secrets);
      const response = await getDirectory(env);
      assert.equal(response.status, 200, "sig2 being unavailable must never take sig1's directory down");
      assert.deepEqual(JSON.parse(await response.text()).keys, [ed.pub], "nothing may advertise a key the Worker is not signing with");
      assert.deepEqual(Object.keys(members(response.headers.get("signature-input"))), ["sig1"]);
    } finally {
      console.error = original;
    }
  }
});

test("the directory refuses real drift: an active sig2 key that is missing, or not the published one", async () => {
  const ed = await edKey(), pq = await pqKey(), other = await pqKey();
  const secrets = { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(pq.priv) };
  for (const keys of [
    [ed.pub], // sig2 signs with a key nobody can look up
    [ed.pub, other.pub], // a rotation that updated one side
    [ed.pub, pq.pub, other.pub], // two AKP entries
  ]) {
    const response = await getDirectory(directoryEnv(keys, secrets).env);
    assert.equal(response.status, 503, `keys [${keys.map((k) => k.kty).join(", ")}] must not serve`);
    assert.equal(response.headers.has("signature"), false);
  }
});

// ── what ships ─────────────────────────────────────────────────────────

test("the committed directory publishes a real ML-DSA-44 public key beside the ed25519 one", async () => {
  const dir = JSON.parse(await readFile(new URL("public/.well-known/http-message-signatures-directory", ROOT), "utf8"));
  const akp = dir.keys.filter((k) => k.kty === "AKP");
  assert.equal(akp.length, 1, "exactly one AKP key");
  assert.equal(akp[0].alg, "ML-DSA-44");
  assert.equal(akp[0].kid, await jwkThumbprint(akp[0]), "its kid is its RFC 9964 thumbprint");
  assert.equal(Uint8Array.fromBase64(akp[0].pub, { alphabet: "base64url" }).length, 1312, "an ML-DSA-44 public key is 1,312 bytes");
  await crypto.subtle.importKey("jwk", /** @type {JsonWebKey} */ ({ kty: "AKP", alg: "ML-DSA-44", pub: akp[0].pub }), MLDSA, false, ["verify"]);
  assert.equal("priv" in akp[0], false, "the public directory must never carry the seed");
});

test("production carries webcrypto_modern_algorithms, without which sig2 silently disappears", async () => {
  // build.ts already fails when dev and production flags differ. What it cannot
  // see is both losing the flag together: sig2 would degrade to nothing, by
  // design, and every other check would stay green.
  for (const name of ["cloudflare.config.ts", "wrangler.dev.jsonc"]) {
    const flags = parseJsonc(await configText(name)).compatibility_flags;
    assert.ok(flags.includes("webcrypto_modern_algorithms"), `${name} must enable native ML-DSA`);
  }
});

// Dispatches through the harness, so it runs under node: tools/lib/harness-dispatch.ts.
const WORKERD = "workerd signs sig2 from a bare-seed secret under production's flags, and refuses ML-DSA without the flag";
test(WORKERD, underNode(import.meta.url, WORKERD, async () => {
  const ed = await edKey(), pq = await pqKey();
  // The production secret is a bare 32-byte seed with no `pub`. bun and node
  // refuse that shape, workerd accepts it, and this is the only place the
  // shape that actually ships is signed with.
  const seedOnly = { kty: "AKP", alg: "ML-DSA-44", kid: "seed-only", use: "sig", priv: pq.priv.priv };
  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const botauth = fileURLToPath(new URL("src/worker/lib/botauth.ts", ROOT));
  const run = async (flags) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sig2-")));
    writeFileSync(join(dir, "worker.js"), `
      import { botHeaders } from ${JSON.stringify(botauth)};
      export default { async fetch(_request, env) {
        const errors = [];
        const original = console.error;
        console.error = (...args) => errors.push(args.join(" "));
        try {
          const h = await botHeaders("https://example.com/", env);
          return Response.json({ input: h.get("signature-input"), signature: h.get("signature"), errors });
        } finally { console.error = original; }
      } };`);
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
      name: "sig2-probe", main: "worker.js",
      compatibility_date: site.compatibility_date, compatibility_flags: flags,
      // `alg: "EdDSA"`, the spelling production's key and directory carry. bun
      // exports "Ed25519" (RFC 9864's fully-specified name), and workerd refuses
      // that spelling with or without webcrypto_modern_algorithms (measured
      // 2026-10-01), so a fixture passed through unchanged fails on sig1.
      vars: { RN_SIGNING_KEY_JWK: JSON.stringify({ ...ed.priv, alg: "EdDSA" }), RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(seedOnly) },
    }));
    const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
    try {
      await server.listen();
      return /** @type {{ input: string, signature: string, errors: string[] }} */ (await (await server.getWorker().fetch("http://sig2.test/")).json());
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const live = await run(site.compatibility_flags);
  const input = members(live.input), sig = members(live.signature);
  assert.deepEqual(Object.keys(input), ["sig1", "sig2"], "production's flags must sign sig2 from the seed-only secret");
  assert.match(input.sig2, new RegExp(`;keyid="${pq.pub.kid}";alg="ml-dsa-44";`), "keyid comes from the DERIVED public key");
  assert.equal(await crypto.subtle.verify(MLDSA, pq.pair.publicKey, sigBytes(sig.sig2), requestBase("example.com", input.sig2)), true,
    "a signature workerd made must verify in another implementation");

  // Control: the same Worker without the flag. The runtime refuses ML-DSA by
  // name, sig2 drops, sig1 survives, and the refusal is logged once.
  const bare = await run(site.compatibility_flags.filter((f) => f !== "webcrypto_modern_algorithms"));
  assert.deepEqual(Object.keys(members(bare.input)), ["sig1"], "without the flag, sig2 must drop rather than fail the request");
  assert.equal(bare.errors.length, 1);
  assert.match(bare.errors[0], /sig2 disabled.*NotSupportedError/);
}));

// ── fan-out carries sig1 alone ─────────────────────────────────────────
//
// Measured in production on 2026-10-01 with sig2 on EVERY request: a /lens
// scan's CPU median went from 22ms to 32ms, ~0.33ms a signature, 3x the laptop
// figure. So the fan-out (discovery probes, the Markdown replay, the robots.txt
// bootstrap) passes `postQuantum: false`, and only primary fetches carry sig2.

test("postQuantum: false drops sig2 for that request and leaves sig1 untouched", async () => {
  const ed = await edKey(), pq = await pqKey();
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(pq.priv) };
  const scoped = await botHeaders("https://example.com/", env, { postQuantum: false });
  assert.deepEqual(labels(scoped), ["sig1"]);
  assert.match(scoped.get("signature-input") ?? "", new RegExp(`;keyid="${ed.pub.kid}";alg="ed25519";`));
  // Control: the same env without the option still signs both.
  assert.deepEqual(labels(await botHeaders("https://example.com/", env)), ["sig1", "sig2"]);
});

test("a /lens scan's primary fetch carries sig2; its discovery probes and robots read do not", async () => {
  const { lensFetch, lensProbe, lensProbeMcp } = await import("../src/worker/lens.ts");
  const ed = await edKey(), pq = await pqKey();
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify(ed.priv), RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify(pq.priv) };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === "string" ? undefined : input.headers));
    seen.push({ path: new URL(url).pathname, labels: headers.get("signature-input") ? labels(headers) : [] });
    return new Response(new URL(url).pathname === "/robots.txt" ? "" : "{}", { status: new URL(url).pathname === "/robots.txt" ? 404 : 200 });
  }, { preconnect: realFetch.preconnect });
  try {
    // A fresh origin per call, so the robots read is a real miss each time.
    await lensFetch("https://scan-target.example/", { ...env });
    await lensProbe("https://probe-target.example/llms.txt", { ...env });
    await lensProbeMcp("https://mcp-target.example", { ...env });
  } finally {
    globalThis.fetch = realFetch;
  }
  const by = (path) => seen.filter((s) => s.path === path).map((s) => s.labels);
  assert.deepEqual(by("/"), [["sig1", "sig2"]], "the page being scanned is the crawler's identity, so it carries both");
  assert.deepEqual(by("/llms.txt"), [["sig1"]], "a discovery probe is fan-out and carries sig1 alone");
  assert.deepEqual(by("/mcp"), [["sig1"]], "the MCP probe too");
  assert.equal(by("/robots.txt").length, 3, "each fresh origin's robots policy was read");
  for (const l of by("/robots.txt")) assert.deepEqual(l, ["sig1"], "the robots.txt bootstrap carries sig1 alone");
});
