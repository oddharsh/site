// ── the outbound reader, against a fake transport ────────────────────────
//
// lib/outbound.ts decides self-dispatch or network, validates every hop before
// requesting it, applies the identity's gate (signature plus robots, or robots
// alone), and returns a refusal as a value. These tests reach it by INJECTION:
// env.OUTBOUND_TRANSPORT is the network adapter, so nothing here replaces the
// global fetch. The suite's no-network preload stays armed underneath, which
// means a read that slipped past the injected adapter fails the whole run.
//
// Each test carries its control: the same fixture with the guard taken away,
// showing the fake network CAN see the request the guard prevents.
import { assert, test } from "./contract-shared.ts";
import { dispatchesToSelf, outboundRead, selfAdapter } from "../src/worker/lib/outbound.ts";
import { fetchFollowingPublicRedirects } from "../src/worker/lib/public-fetch.ts";
import { lensFetch, lensFetchAsBot } from "../src/worker/lens.ts";
import { probeRevalidation } from "../src/worker/cache-lint.ts";
import { foreignMcpTools, foreignNlwebAsk } from "../src/worker/lib/doors.ts";

const origin = "https://example.com";
const metadata = "http://169.254.169.254/latest/meta-data/";
const answer = () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] }, results: [] });
const noRobots = () => new Response(null, { status: 404 });

async function signingEnv() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { RN_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
}

// The third adapter. It records what reached "the network" and answers from
// the fixture; robots.txt is answered separately so a test states its policy.
/**
 * @param {(record: any) => Response} respond
 * @param {(record: any) => Response} [robots]
 */
function fakeNetwork(respond, robots = noRobots) {
  const seen = [];
  const transport = async (url, init) => {
    const record = { url, method: init.method, redirect: init.redirect, cf: init.cf, body: init.body, headers: new Headers(init.headers) };
    seen.push(record);
    return new URL(url).pathname === "/robots.txt" ? robots(record) : respond(record);
  };
  return { seen, transport, content: () => seen.filter((r) => new URL(r.url).pathname !== "/robots.txt") };
}

const BOT = { as: "aadharshbot" };
const PROBE = { as: "unsigned-probe" };
/** @returns {import("../src/worker/lib/outbound.ts").OutboundRequest} */
const get = (identity, maxHops = 4) => ({ method: "GET", headers: { accept: "text/plain", "user-agent": "fixture-agent/1.0" }, identity, maxHops });

test("a redirect to a private address is refused at the hop, as a value, before the request", async () => {
  const key = await signingEnv();
  for (const identity of [BOT, PROBE]) {
    const net = fakeNetwork(() => new Response(null, { status: 302, headers: { location: metadata } }));
    const read = await outboundRead(origin + "/start", { ...key, OUTBOUND_TRANSPORT: net.transport }, get(identity));
    assert.equal(read.ok, false);
    assert.equal(read.reason, "url-policy");
    assert.equal(read.hop, 1, "hop 0 was the public URL; hop 1 is the private one");
    assert.equal(read.url, metadata);
    assert.match(read.error, /no-fetch list/);
    assert.deepEqual(net.content().map((r) => r.url), [origin + "/start"], "the private address is never requested");
    assert.ok(net.seen.every((r) => r.redirect === "manual"), "every hop is requested with redirect: manual");
  }

  // CONTROL: the same fake network under a check that allows everything DOES
  // request the metadata address, so the assertion above can fail.
  const net = fakeNetwork(({ url }) => url === metadata ? new Response("secret") : new Response(null, { status: 302, headers: { location: metadata } }));
  const walked = await fetchFollowingPublicRedirects(origin + "/start", () => ({}), () => ({ ok: true }), 4, net.transport);
  assert.equal(walked.ok, true);
  assert.deepEqual(net.seen.map((r) => r.url), [origin + "/start", metadata]);
});

test("the URL as given is checked too, and an unparseable one is refused rather than thrown", async () => {
  const net = fakeNetwork(answer);
  for (const url of [metadata, "https://user:secret@example.org/", "https://example.org:8443/", "http://["]) {
    const read = await outboundRead(url, { OUTBOUND_TRANSPORT: net.transport }, get(PROBE));
    assert.equal(read.ok, false, url);
    assert.equal(read.reason, "url-policy");
    assert.equal(read.hop, 0);
  }
  assert.equal(net.seen.length, 0, "nothing is requested, robots.txt included");
});

test("the robots gate stops a disallowed read for both identities, as a value", async () => {
  const key = await signingEnv();
  const disallow = () => new Response("User-agent: AadharshBot\nDisallow: /private");
  for (const identity of [BOT, PROBE]) {
    const net = fakeNetwork(() => new Response("content"), disallow);
    const read = await outboundRead(origin + "/private/page", { ...key, OUTBOUND_TRANSPORT: net.transport }, get(identity));
    assert.equal(read.ok, false);
    assert.equal(read.reason, "robots");
    assert.match(read.error, /Disallow: \/private/);
    assert.equal(read.cause.name, "BotPolicyError");
    assert.deepEqual(net.seen.map((r) => r.url), [origin + "/robots.txt"], "only the policy was read");

    // CONTROL: a path the same policy allows IS fetched through the same fake.
    const allowed = fakeNetwork(() => new Response("content"), disallow);
    const ok = await outboundRead(origin + "/public", { ...key, OUTBOUND_TRANSPORT: allowed.transport }, get(identity));
    assert.equal(ok.ok, true);
    assert.equal(ok.via, "network");
    assert.deepEqual(allowed.content().map((r) => r.url), [origin + "/public"]);
  }
});

test("a redirect destination answers to its own robots.txt", async () => {
  const key = await signingEnv();
  const net = fakeNetwork(
    () => new Response(null, { status: 302, headers: { location: "https://other.example/private" } }),
    ({ url }) => new Response(new URL(url).origin === origin ? "" : "User-agent: *\nDisallow: /private"),
  );
  const read = await outboundRead(origin + "/page", { ...key, OUTBOUND_TRANSPORT: net.transport }, get(BOT));
  assert.equal(read.ok, false);
  assert.equal(read.reason, "robots");
  assert.deepEqual(net.seen.map((r) => r.url), [origin + "/robots.txt", origin + "/page", "https://other.example/robots.txt"]);
});

test("this origin goes to self-dispatch, unsigned, and never to the network", async () => {
  const key = await signingEnv();
  const self = "https://aadhar.sh/page";
  for (const binding of ["SELF_FETCH", "ASSETS"]) for (const identity of [BOT, PROBE]) {
    const net = fakeNetwork(() => new Response("unexpected network"));
    const requests = [];
    const dispatch = async (request) => { requests.push(request); return new Response("in-process"); };
    const env = { ...key, OUTBOUND_TRANSPORT: net.transport, ...(binding === "SELF_FETCH" ? { SELF_FETCH: dispatch } : { ASSETS: { fetch: dispatch } }) };
    const read = await outboundRead(self, env, get(identity));
    assert.equal(read.ok, true);
    assert.equal(read.via, "self");
    assert.equal(await read.response.text(), "in-process");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.has("signature"), false, "self-dispatch carries no wire signature");
    assert.equal(requests[0].headers.get("user-agent"), identity === BOT ? "AadharshBot/1.0 (+https://aadhar.sh/bot)" : "fixture-agent/1.0");
    assert.equal(net.seen.length, 0, "no network request and no robots read");

    // A dead binding is a FAULT: it throws, and it is not permission to go out.
    const broken = async () => { throw new Error("fixture local failure"); };
    await assert.rejects(outboundRead(self, { ...env, SELF_FETCH: binding === "SELF_FETCH" ? broken : undefined, ASSETS: binding === "ASSETS" ? { fetch: broken } : undefined }, get(identity)), /fixture local failure/);
    assert.equal(net.seen.length, 0, "a binding failure never falls through to the network");
  }

  // SELF_FETCH wins over ASSETS when both are present.
  const both = await outboundRead(self, { SELF_FETCH: async () => new Response("route"), ASSETS: { fetch: async () => new Response("static") } }, get(PROBE));
  assert.ok(both.ok);
  assert.equal(await both.response.text(), "route");

  // CONTROL: the same URL with no binding to dispatch through DOES reach the
  // fake network, so "never the network" above is something the fake can see.
  const net = fakeNetwork(() => new Response("over the wire"));
  const read = await outboundRead(self, { ...key, OUTBOUND_TRANSPORT: net.transport }, get(BOT));
  assert.ok(read.ok);
  assert.equal(read.via, "network");
  assert.deepEqual(net.content().map((r) => r.url), [self]);
  assert.ok(net.content()[0].headers.has("signature"), "and on the network it is signed");
});

test("the self predicate and the self adapter agree with the reader", () => {
  const dispatch = async () => new Response("x");
  assert.equal(dispatchesToSelf("aadhar.sh", { SELF_FETCH: dispatch }), true);
  assert.equal(dispatchesToSelf("AADHAR.SH", { ASSETS: { fetch: dispatch } }), true);
  assert.equal(dispatchesToSelf("aadhar.sh", {}), false, "no binding, no self-dispatch");
  assert.equal(dispatchesToSelf("aadhar.sh", { SELF_FETCH: null }), false, "the inner env's null SELF_FETCH is not a dispatcher");
  assert.equal(dispatchesToSelf("example.com", { SELF_FETCH: dispatch }), false);
  assert.equal(dispatchesToSelf("aadhar.sh.example.com", { SELF_FETCH: dispatch }), false);
  assert.equal(selfAdapter({}), null);
  assert.equal(selfAdapter(undefined), null);
  assert.equal(typeof selfAdapter({ ASSETS: { fetch: dispatch } }), "function");
});

test("the two identities differ exactly where they are meant to", async () => {
  const key = await signingEnv();
  const bot = fakeNetwork(answer);
  await outboundRead(origin + "/page", { ...key, OUTBOUND_TRANSPORT: bot.transport }, get(BOT));
  const signed = bot.content()[0];
  assert.equal(signed.headers.get("user-agent"), "AadharshBot/1.0 (+https://aadhar.sh/bot)", "aadharshbot overrides the caller's UA");
  assert.match(signed.headers.get("signature-input"), /^sig1=/);
  assert.deepEqual(signed.cf, { cacheTtl: 0 });

  const probe = fakeNetwork(answer);
  await outboundRead(origin + "/page", { ...key, OUTBOUND_TRANSPORT: probe.transport }, get(PROBE));
  const bare = probe.content()[0];
  assert.equal(bare.headers.get("user-agent"), "fixture-agent/1.0", "unsigned-probe sends the caller's UA verbatim");
  for (const header of ["signature", "signature-input", "signature-agent"]) assert.equal(bare.headers.has(header), false, `unsigned-probe sends no ${header}`);
  assert.equal(probe.seen[0].url, origin + "/robots.txt", "and still reads the policy first");

  // The signed identity needs a key BEFORE any network activity; the probe does not sign at all.
  const keyless = fakeNetwork(answer);
  await assert.rejects(outboundRead(origin + "/page", { OUTBOUND_TRANSPORT: keyless.transport }, get(BOT)), /signing key/);
  assert.equal(keyless.seen.length, 0);
});

// The hop limit is each caller's own, stated at its call site. These pin the
// values that existed before the readers shared a module: 4 for the lens and
// door probes, native fetch's 20 for the cache probe.
test("each caller keeps its own identity, method and hop limit", async () => {
  const key = await signingEnv();
  const loop = ({ url }) => new Response(null, { status: 302, headers: { location: "/" + (Number(new URL(url).pathname.replace(/\D/g, "") || 0) + 1) } });
  const callers = [
    { name: "lensFetch", hops: 4, method: "GET", signed: true, run: (env) => lensFetch(origin + "/0", env) },
    { name: "lensFetchAsBot", hops: 4, method: "GET", signed: false, ua: "GPTBot/1.0", run: (env) => lensFetchAsBot(origin + "/0", env, undefined, "GPTBot/1.0") },
    { name: "MCP catalogue", hops: 4, method: "POST", signed: true, run: (env) => foreignMcpTools(origin, env) },
    { name: "NLWeb", hops: 4, method: "GET", signed: true, run: (env) => foreignNlwebAsk(origin, env) },
    { name: "cache probe", hops: 20, method: "GET", signed: true, run: (env) => probeRevalidation(origin + "/0", env) },
  ];
  for (const caller of callers) {
    const net = fakeNetwork(loop);
    await caller.run({ ...key, OUTBOUND_TRANSPORT: net.transport });
    const content = net.content();
    assert.equal(content.length, caller.hops + 1, `${caller.name} requests the URL plus ${caller.hops} redirect hops, then stops`);
    for (const record of content) {
      assert.equal(record.method, caller.method, caller.name);
      assert.equal(record.redirect, "manual", caller.name);
      assert.equal(record.headers.has("signature"), caller.signed, `${caller.name} signature`);
      assert.equal(record.headers.get("user-agent"), caller.ua || "AadharshBot/1.0 (+https://aadhar.sh/bot)", caller.name);
      assert.deepEqual(record.cf, { cacheTtl: 0 }, caller.name);
    }
    if (caller.method === "POST") {
      assert.equal(content[0].headers.get("mcp-method"), "tools/list");
      assert.equal(content[0].headers.get("accept"), "application/json, text/event-stream");
      assert.equal(content[0].headers.has("mcp-protocol-version"), false, "the revision header is a reply to a refusal, never a constant");
      assert.equal(JSON.parse(content[0].body).method, "tools/list");
    }
  }
});

test("the MCP probe retries once with MCP-Protocol-Version only on a refusal naming it", async () => {
  const key = await signingEnv();
  let calls = 0;
  const net = fakeNetwork(() => ++calls === 1
    ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32020, message: "Header mismatch: MCP-Protocol-Version is required" } }, { status: 400 })
    : answer());
  const out = await foreignMcpTools(origin, { ...key, OUTBOUND_TRANSPORT: net.transport });
  assert.equal(out.ok, true);
  const [first, second] = net.content();
  assert.equal(net.content().length, 2);
  assert.equal(first.headers.has("mcp-protocol-version"), false);
  assert.equal(second.headers.get("mcp-protocol-version"), JSON.parse(second.body).params._meta["io.modelcontextprotocol/protocolVersion"]);
});
