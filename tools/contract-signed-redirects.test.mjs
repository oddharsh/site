import { assert, test, testGlobals } from "./contract-shared.ts";
import { signedFetch, withBotPolicyCache } from "../src/worker/lib/botauth.ts";
import { lensFetch, lensFetchAsBot } from "../src/worker/lens.ts";
import { probeRevalidation } from "../src/worker/cache-lint.ts";
import { foreignMcpTools, foreignNlwebAsk } from "../src/worker/lib/doors.ts";
import { scrapeSpotifyEmbed } from "../src/worker/rn.ts";

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

async function withFetch(respond, run, robots = (_record) => new Response(null, { status: 404 })) {
  const original = globalThis.fetch;
  const seen = [];
  testGlobals.fetch = async (input, init = {}) => {
    let url = String(input);
    for (let hop = 0; hop <= 20; hop++) {
      const record = { url, ...init, headers: new Headers(init.headers) };
      seen.push(record);
      const response = new URL(url).pathname === "/robots.txt" ? robots(record) : respond(record);
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
    assert.equal(seen.length, 2, "one policy read and one content request");
    assert.equal(seen[0].url, origin + "/robots.txt");
    assert.equal(seen[1].redirect, redirect);
    assert.equal(seen[1].method, "HEAD");
    assert.equal(seen[1].headers.get("accept"), "application/json");
    assert.equal(seen[1].signal, signal);
    assert.deepEqual(seen[1].cf, cf);
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

for (const reader of readers) test(`${reader.name} honors AadharshBot opt-outs before reading content`, async () => {
  const { env } = await keyPair();
  await withFetch(() => { throw new Error("disallowed content fetched"); }, async (seen) => {
    try { await reader.run(env); } catch (error) { assert.match(error.message, /Disallow/); }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, origin + "/robots.txt");
  }, () => new Response("User-agent: AadharshBot\nDisallow: /"));
});

test("redirect destinations are checked against their own policy", async () => {
  const { env } = await keyPair();
  await withFetch(() => new Response(null, { status: 302, headers: { location: "https://other.example/private" } }), async (seen) => {
    await assert.rejects(signedFetch(origin + "/page", env), /Disallow: \/private/);
    assert.deepEqual(seen.map((r) => r.url), [origin + "/robots.txt", origin + "/page", "https://other.example/robots.txt"]);
  }, ({ url }) => new Response(new URL(url).origin === origin ? "" : "User-agent: *\nDisallow: /private"));
});

test("unknown, oversized, rate-limited and crawl-delayed policies stop the content request", async () => {
  const { env } = await keyPair();
  for (const policy of [
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 429 }),
    () => { throw new Error("offline"); },
    () => new Response("#".repeat(512 * 1024 + 1)),
    () => new Response("User-agent: *\nCrawl-delay: 0.5"),
    () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/robots.txt" } }),
  ]) await withFetch(() => { throw new Error("content fetched without permission"); }, async (seen) => {
    await assert.rejects(signedFetch(origin + "/page", env), /not fetched/);
    assert.deepEqual(seen.map((r) => r.url), [origin + "/robots.txt"]);
  }, policy);
});

test("named groups, query paths and percent-encoded paths keep the same opt-out", async () => {
  const { env } = await keyPair();
  const policy = "User-agent: *\nDisallow: /\nCrawl-delay: 5\nUser-agent: AadharshBot\nDisallow: /private\nDisallow: /*?secret=\nAllow: /private/public";
  for (const [path, allowed] of [["/page", true], ["/private/public", true], ["/pr%69vate", false], ["/page?secret=yes", false]]) {
    await withFetch(() => new Response("content"), async (seen) => {
      if (allowed) assert.equal((await signedFetch(origin + path, env)).status, 200);
      else await assert.rejects(signedFetch(origin + path, env), /Disallow/);
      assert.equal(seen.length, allowed ? 2 : 1);
    }, () => new Response(policy));
  }
});

test("a policy is fetched once per invocation and cached in KV for twelve hours", async () => {
  const { env } = await keyPair();
  const entries = new Map();
  let reads = 0, writes = 0;
  const bindings = { ...env, RN_KV: {
    async get(key) { reads++; return entries.get(key) || null; },
    async put(key, value, opts) { writes++; assert.equal(opts.expirationTtl, 43200); entries.set(key, JSON.parse(value)); },
  } };
  await withFetch(() => new Response("content"), async (seen) => {
    const scoped = withBotPolicyCache(bindings);
    await Promise.all(Array.from({ length: 28 }, (_, i) => signedFetch(origin + "/p" + i, scoped)));
    assert.equal(seen.filter((r) => r.url.endsWith("/robots.txt")).length, 1);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    await signedFetch(origin + "/another", withBotPolicyCache(bindings));
    assert.equal(reads, 2, "the next invocation reads its own policy, not an old I/O promise");
    assert.equal(writes, 1);
  });
});

test("Lens UA diagnostics cannot bypass AadharshBot's robots opt-out", async () => {
  const { env } = await keyPair();
  await withFetch(() => { throw new Error("diagnostic content fetched"); }, async (seen) => {
    await assert.rejects(lensFetchAsBot(origin + "/page", env, undefined, "GPTBot/1.0"), /Disallow/);
    assert.equal(seen.length, 1);
  }, () => new Response("User-agent: AadharshBot\nDisallow: /"));
});

test("a policy read preserves platform exhaustion for the census guard", async () => {
  const { env } = await keyPair();
  await withFetch(() => { throw new Error("content fetched after exhaustion"); }, async (seen) => {
    await assert.rejects(signedFetch(origin + "/page", env), /Too many subrequests/);
    assert.equal(seen.length, 1);
  }, () => { throw new Error("Too many subrequests by single Worker"); });
});

const spotify = "https://open.spotify.com";
const spotifyId = "5DIi2JWfQPTKffaVBlIYRn";
const spotifyRobots = () => new Response("User-agent: *\nDisallow: /embed/");
const embedResponse = (entity) => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({
  props: { pageProps: { state: { data: { entity } } } },
})}</script>`);

test("RN fetches all three Spotify embed tiers with its signed identity despite robots disallow", async () => {
  const { env, publicKey } = await keyPair();
  for (const kind of ["playlist", "track", "artist"]) {
    const entity = { name: kind, visualIdentity: { image: [{ url: "https://i.scdn.co/image/fixture" }] } };
    await withFetch(() => embedResponse(entity), async (seen) => {
      assert.deepEqual(await scrapeSpotifyEmbed(`${kind}/${spotifyId}`, env), entity);
      assert.equal(seen.length, 1, "RN fetches the embed without reading robots.txt");
      const request = seen[0];
      assert.equal(new URL(request.url).pathname, `/embed/${kind}/${spotifyId}`);
      assert.equal(request.headers.get("user-agent"), "AadharshBot/1.0 (+https://aadhar.sh/bot)");
      assert.equal(await verifies(request, publicKey), true);
      assert.deepEqual(request.cf, kind === "playlist"
        ? { cacheTtl: 0, cacheEverything: false }
        : { cacheTtl: 86400, cacheEverything: true });
    }, spotifyRobots);
  }
});

test("RN's fresh retry keeps the Spotify exception and signature", async () => {
  const { env, publicKey } = await keyPair();
  let attempts = 0;
  await withFetch(() => ++attempts === 1 ? embedResponse({}) : embedResponse({ name: "artist" }), async (seen) => {
    assert.deepEqual(await scrapeSpotifyEmbed(`artist/${spotifyId}`, env), { name: "artist" });
    assert.equal(seen.length, 2);
    assert.equal(new URL(seen[0].url).search, "");
    assert.match(new URL(seen[1].url).search, /^\?_t=\d+$/);
    assert.deepEqual(seen[1].cf, { cacheTtl: 0, cacheEverything: false });
    for (const record of seen) assert.equal(await verifies(record, publicKey), true);
  }, spotifyRobots);
});

test("normal signed readers still respect Spotify's robots disallow", async () => {
  const { env } = await keyPair();
  const url = `${spotify}/embed/artist/${spotifyId}`;
  for (const read of [signedFetch, lensFetch]) await withFetch(() => { throw new Error("disallowed embed fetched"); }, async (seen) => {
    await assert.rejects(read(url, env), /Disallow: \/embed\//);
    assert.deepEqual(seen.map((r) => r.url), [spotify + "/robots.txt"]);
  }, spotifyRobots);
});

test("the Spotify exception cannot bypass policy on unrelated URLs", async () => {
  const { env } = await keyPair();
  for (const url of [
    `${origin}/embed/artist/${spotifyId}`,
    `${spotify}/artist/${spotifyId}`,
    `${spotify}/embed/show/${spotifyId}`,
    `${spotify}/embed/artist/not-an-id`,
    `${spotify}/embed/artist/${spotifyId}?redirect=https://other.example`,
  ]) await withFetch(() => { throw new Error("unrelated content fetched"); }, async (seen) => {
    await assert.rejects(signedFetch(url, env, { robots: "spotify-embed" }), /Disallow/);
    assert.deepEqual(seen.map((r) => r.url), [new URL(url).origin + "/robots.txt"]);
  }, () => new Response("User-agent: *\nDisallow: /"));
});

test("RN redirects retain policy checks outside Spotify embeds and reject private destinations", async () => {
  const { env } = await keyPair();
  for (const destination of [
    `${origin}/embed/artist/${spotifyId}`,
    `${spotify}/private`,
    "http://169.254.169.254/private",
  ]) await withFetch(() => new Response(null, { status: 302, headers: { location: destination } }), async (seen) => {
    await assert.rejects(scrapeSpotifyEmbed(`artist/${spotifyId}`, env));
    assert.ok(seen.some((r) => new URL(r.url).pathname.startsWith("/embed/")), "the allowed initial request must run");
    assert.ok(seen.every((r) => r.url !== destination), "the redirect must be rejected before fetching content");
  }, () => new Response("User-agent: *\nDisallow: /"));
});

test("the Spotify exception still requires a signing key", async () => {
  await withFetch(() => { throw new Error("unsigned embed fetched"); }, async (seen) => {
    await assert.rejects(scrapeSpotifyEmbed(`artist/${spotifyId}`, {}), /signing key/);
    assert.equal(seen.length, 0);
  }, spotifyRobots);
});
