import { assert, test, testGlobals } from "./contract-shared.ts";
import { signedFetch } from "../src/worker/lib/botauth.ts";
import { lensFetch, lensFetchAsBot } from "../src/worker/lens.ts";
import { probeRevalidation } from "../src/worker/cache-lint.ts";
import { foreignMcpTools, foreignNlwebAsk } from "../src/worker/lib/doors.ts";

const origin = "https://example.com";
const readers = [
  { name: "signedFetch", run: (env) => signedFetch(origin + "/page", env) },
  { name: "Lens", run: (env) => lensFetch(origin + "/page", env) },
  { name: "cache probe", run: (env) => probeRevalidation(origin + "/page", env) },
  { name: "MCP catalogue", run: (env) => foreignMcpTools(origin, env) },
  { name: "NLWeb", run: (env) => foreignNlwebAsk(origin, env) },
];

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { publicKey: pair.publicKey, env: { RN_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) } };
}

async function withFetch(respond, run) {
  const original = globalThis.fetch;
  const seen = [];
  testGlobals.fetch = async (input, init = {}) => {
    let url = String(input);
    for (let hop = 0; hop <= 20; hop++) {
      const record = { url, ...init, headers: new Headers(init.headers) };
      seen.push(record);
      const response = respond(record);
      const location = response.headers.get("location");
      if (init.redirect === "follow" && location) {
        url = new URL(location, url).href;
        await response.body?.cancel();
        continue;
      }
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new TypeError("too many redirects");
  };
  try { return await run(seen); }
  finally { testGlobals.fetch = original; }
}

async function verifies({ url, headers }, publicKey) {
  const params = headers.get("signature-input")?.match(/^sig1=(.+)$/)?.[1];
  const encoded = headers.get("signature")?.match(/^sig1=:([^:]+):$/)?.[1];
  assert.ok(params && encoded, "every external request has its bot signature");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const base = new TextEncoder().encode(`"@authority": ${new URL(url).host}\n"signature-agent": "https://aadhar.sh/"\n"@signature-params": ${params}`);
  return crypto.subtle.verify("Ed25519", publicKey, bytes, base);
}

for (const reader of readers) test(`${reader.name} signs each redirect authority and refuses blocked hops`, async () => {
  const { env, publicKey } = await keyPair();
  for (const destination of ["https://other.example", "http://169.254.169.254"]) {
    await withFetch(({ url }) => new URL(url).origin === origin
      ? new Response(null, { status: 307, headers: { location: destination + new URL(url).pathname } })
      : Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] }, results: [] }), async (seen) => {
      try { await reader.run(env); } catch (error) {
        if (!destination.startsWith("http:")) throw error;
      }
      assert.ok(seen.length > 0);
      if (destination.startsWith("http:")) assert.ok(seen.every(({ url }) => new URL(url).origin === origin), "refusal precedes the disallowed request");
      else assert.ok(seen.some(({ url }) => new URL(url).origin === destination), "the allowed redirect succeeds");
      for (const record of seen) assert.equal(await verifies(record, publicKey), true, `signature must verify for ${record.url}`);
    });
  }
});

test("signedFetch retains explicit redirect modes, headers, method, deadline and cache policy", async () => {
  const { env } = await keyPair();
  const signal = new AbortController().signal;
  const cf = { cacheTtl: 86400, cacheEverything: true };
  for (const redirect of /** @type {const} */ (["manual", "error"])) await withFetch(() => new Response(null, { status: 302, headers: { location: "/next" } }), async (seen) => {
    await signedFetch(origin, env, { method: "HEAD", headers: { accept: "application/json" }, signal, cf, redirect });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, redirect);
    assert.equal(seen[0].method, "HEAD");
    assert.equal(seen[0].headers.get("accept"), "application/json");
    assert.equal(seen[0].signal, signal);
    assert.deepEqual(seen[0].cf, cf);
  });
  await withFetch(() => { throw new Error("unexpected fetch"); }, async (seen) => {
    await assert.rejects(signedFetch(origin, {}, { sign: false }), /signing key/);
    assert.equal(seen.length, 0, "sign:false cannot bypass the signed fetch contract");
  });
});

test("self-dispatch stays unsigned and a failed local binding never falls through to the network", async () => {
  const self = "https://aadhar.sh/page";
  for (const run of [
    (env) => lensFetch(self, env),
    (env) => lensFetchAsBot(self, env, undefined, "fixture-agent"),
    (env) => probeRevalidation(self, env),
  ]) await withFetch(() => new Response("unexpected network"), async (seen) => {
    for (const binding of ["SELF_FETCH", "ASSETS"]) {
      let requests = 0;
      const fetch = async (request) => {
        requests++;
        assert.equal(request.headers.has("signature"), false);
        return new Response("fixture", { headers: { "content-type": "text/plain" } });
      };
      await run(binding === "SELF_FETCH" ? { SELF_FETCH: fetch } : { ASSETS: { fetch } });
      assert.ok(requests > 0);
      const broken = async () => { throw new Error("fixture local failure"); };
      try { await run(binding === "SELF_FETCH" ? { SELF_FETCH: broken } : { ASSETS: { fetch: broken } }); } catch {}
      assert.equal(seen.length, 0, "a binding failure is not authorization for an unsigned external fallback");
    }
  });
});
