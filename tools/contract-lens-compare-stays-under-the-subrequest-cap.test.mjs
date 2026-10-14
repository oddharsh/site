// ── lens compare stays under the subrequest cap ──────────────────────────
//
// Workers Free allows 50 subrequests per invocation, and KV and Cache API
// operations count (gotcha 36). A cold `/lens?url=A&vs=B` used to spend 72:
// per cold side, 3 on the robots gate, 1 on the page, 2 on the doors cache,
// 29 on the discovery fan-out and 1 on Markdown negotiation. Past 50 the
// runtime throws, every probe caught its own error, and the side that lost the
// race read as a site with no doors. Measured with the cap enforced, two
// byte-identical origins compared as readiness 27 against 7.
import { assert, test, testGlobals } from "./contract-shared.ts";
import { SUBREQUEST_CAP_FREE } from "../src/worker/lib/budget.ts";

const CAP_ERROR = "Too many subrequests by single Worker";

// lensInspect parses HTML with HTMLRewriter, a bun and workerd global, so
// test:node skips here the way contract-csp-scan does. `bun run test` runs them.
const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A page</title>
<meta name="description" content="Two origins serving identical bytes."></head>
<body><main><h1>Identical</h1><p>${"Words that an agent would read. ".repeat(40)}</p></main></body></html>`;

async function signingEnv() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { RN_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
}

// One ledger for every billable call. `enforce` makes the 51st throw exactly
// what the runtime throws, so a test can watch what the code does with it.
function harness({ enforce = false, store = new Map() } = {}) {
  const ledger = { fetch: 0, kv: 0, cache: 0, ai: 0, get total() { return this.fetch + this.kv + this.cache + this.ai; } };
  const charge = (kind) => {
    ledger[kind]++;
    if (enforce && ledger.total > SUBREQUEST_CAP_FREE) throw new Error(CAP_ERROR);
  };
  const fetch = async (input) => {
    charge("fetch");
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "cloudflare-dns.com") {
      return new Response(JSON.stringify({ Status: 3 }), { headers: { "content-type": "application/dns-json" } });
    }
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const RN_KV = {
    async get() { charge("kv"); return null; },
    async put() { charge("kv"); },
  };
  const caches = {
    default: {
      async match(req) { charge("cache"); const hit = store.get(req.url); return hit ? new Response(hit) : undefined; },
      async put(req, res) { charge("cache"); store.set(req.url, await res.text()); },
    },
  };
  const AI = {
    async run(_model, input) {
      charge("ai");
      return { answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: "noul", noul: 0.05 }])) };
    },
  };
  return { ledger, fetch, RN_KV, caches, store, AI };
}

async function withHarness(h, run) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  testGlobals.fetch = h.fetch;
  testGlobals.caches = h.caches;
  try { return await run(); } finally {
    testGlobals.fetch = realFetch;
    if (realCaches === undefined) delete testGlobals.caches; else testGlobals.caches = realCaches;
  }
}

const LEFT = "https://left.example/";
const RIGHT = "https://right.example/";

test("a cold compare stays under the cap and says which side it deferred", needsParser, async () => {
  const { compareLensTargets } = await import("../src/worker/lens.ts");
  const h = harness();
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI };
  const out = await withHarness(h, () => compareLensTargets(LEFT, RIGHT, env));

  assert.ok(h.ledger.total < SUBREQUEST_CAP_FREE,
    `cold compare spent ${h.ledger.total} subrequests (${JSON.stringify(h.ledger)}) against a cap of ${SUBREQUEST_CAP_FREE}`);
  assert.equal(h.ledger.total, 41, `the measured cold count moved: ${JSON.stringify(h.ledger)}`);
  assert.equal(h.ledger.ai, 0, "a compare samples no bot views, so it asks Clef nothing");

  assert.equal(out.left.phases.discovery, true);
  assert.equal(out.right.phases.discovery, false);
  assert.equal(out.right.phases.discoveryDeferred, true);
  assert.equal(out.discovery.left, "live");
  assert.equal(out.discovery.right, "deferred");

  assert.equal(out.right.readiness, null);
  assert.equal(out.right.doors, null);
  assert.equal(out.right.surfaces, null);
  for (const change of out.changes) {
    assert.ok(!/^(readiness|level|tier|doors|surfaces\.)/.test(change.field),
      `a deferred side must not produce a ${change.field} change`);
  }
});

test("control: two cold scans in one invocation with no board cross the cap", needsParser, async () => {
  const { lensInspect } = await import("../src/worker/lens.ts");
  const h = harness();
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI };
  await withHarness(h, () => Promise.all([
    lensInspect(LEFT, env, { skipBotViews: true }),
    lensInspect(RIGHT, env, { skipBotViews: true }),
  ]));
  assert.equal(h.ledger.total, 72, `the unarbitrated baseline moved: ${JSON.stringify(h.ledger)}`);
});

test("our own origin runs live beside a foreign one, since its probes self-dispatch", needsParser, async () => {
  const { compareLensTargets } = await import("../src/worker/lens.ts");
  const h = harness();
  const ASSETS = {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI, ASSETS, CF_VERSION_METADATA: { id: "test-version" } };
  const out = await withHarness(h, () => compareLensTargets("https://aadhar.sh/", RIGHT, env));
  assert.equal(out.discovery.left, "live");
  assert.equal(out.discovery.right, "live", "a free self-scan must not take the foreign side's live turn");
  assert.ok(h.ledger.total < SUBREQUEST_CAP_FREE, `self vs foreign spent ${h.ledger.total}`);
});

test("a second compare of the same pair completes both sides", needsParser, async () => {
  const { compareLensTargets } = await import("../src/worker/lens.ts");
  const store = new Map();
  const env = { ...(await signingEnv()) };

  const first = harness({ store });
  await withHarness(first, () => compareLensTargets(LEFT, RIGHT, { ...env, RN_KV: first.RN_KV, AI: first.AI }));
  assert.equal(store.size, 1, "the live side's discovery must be cached for the next compare");

  const second = harness({ store });
  const out = await withHarness(second, () => compareLensTargets(LEFT, RIGHT, { ...env, RN_KV: second.RN_KV, AI: second.AI }));
  assert.ok(second.ledger.total < SUBREQUEST_CAP_FREE, `warm compare spent ${second.ledger.total}`);
  assert.equal(out.discovery.left, "cached");
  assert.equal(out.discovery.right, "live");
  assert.equal(out.left.phases.discovery, true);
  assert.equal(out.right.phases.discovery, true);
  assert.equal(out.left.readiness, out.right.readiness);
  assert.equal(out.left.doors, out.right.doors);
  assert.equal(store.size, 2);
});

test("two pages on one origin share a single live discovery", needsParser, async () => {
  const { compareLensTargets } = await import("../src/worker/lens.ts");
  const h = harness();
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI };
  const out = await withHarness(h, () => compareLensTargets(LEFT, LEFT + "?b", env));
  assert.equal(out.discovery.left, "live");
  assert.equal(out.discovery.right, "shared");
  assert.equal(out.right.phases.discovery, true);
  assert.equal(out.left.readiness, out.right.readiness);
  assert.ok(h.ledger.total < SUBREQUEST_CAP_FREE, `same-origin compare spent ${h.ledger.total}`);
});

test("a single cold scan stays under the cap, with its headroom named", needsParser, async () => {
  const { lensInspect } = await import("../src/worker/lens.ts");
  const h = harness();
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI };
  const out = await withHarness(h, () => lensInspect(LEFT, env, {}));
  assert.equal(out.phases.discovery, true);
  assert.equal(h.ledger.total, 47, `the measured single-scan count moved: ${JSON.stringify(h.ledger)}`);
  assert.equal(h.ledger.ai, 1, "ten bot views, one Clef call");
  assert.ok(SUBREQUEST_CAP_FREE - h.ledger.total >= 3);
});

const DISCOVERY_CHECKS = [
  "robotsTxt", "sitemap", "dnsAid", "markdownNegotiation", "robotsTxtAiRules", "contentSignals",
  "webBotAuth", "apiCatalog", "oauthDiscovery", "oauthProtectedResource", "authMd",
  "mcpServerCard", "a2aAgentCard", "agentSkills",
];

async function refusedScan(spentElsewhere) {
  const { lensInspect } = await import("../src/worker/lens.ts");
  const h = harness({ enforce: true });
  const env = { ...(await signingEnv()), RN_KV: h.RN_KV, AI: h.AI };
  h.ledger.fetch = spentElsewhere;
  const out = await withHarness(h, () => lensInspect(LEFT, env, { skipBotViews: true }));
  return { out, h };
}

test("a fan-out the platform cut short says so, and is never cached as complete", needsParser, async () => {
  const { isSubrequestLimit, subrequestLimitIn } = await import("../src/worker/lib/budget.ts");
  const { out, h } = await refusedScan(30);
  assert.equal(out.phases.discovery, true);
  assert.equal(out.phases.subrequestCap, true, "a refused fan-out must say so in phases");
  assert.ok(subrequestLimitIn(out.discovery) || subrequestLimitIn(out.agent), "the refusal must stay visible on the probes it hit");
  assert.equal(h.store.size, 0, "a blob holding refusals must not be cached as the origin's answer");

  for (const door of [out.agent.mcp, out.agent.nlweb]) {
    if (isSubrequestLimit(door.error)) assert.equal(door.verdict, "unknown");
  }
  if (isSubrequestLimit(out.discovery.agentsMd.error)) assert.equal(out.discovery.agentsMd.unknown, true);
});

test("a probe the platform refused is never graded as absent", needsParser, async () => {
  const { out } = await refusedScan(46);
  assert.equal(out.phases.subrequestCap, true);
  const checks = out.readiness.checks;
  for (const key of DISCOVERY_CHECKS) {
    assert.equal(checks[key].status, "unknown", `${key} graded a refused probe as ${checks[key].status}: ${checks[key].detail}`);
  }
  assert.equal(out.agent.mcp.verdict, "unknown");
  assert.equal(out.agent.nlweb.verdict, "unknown");
  assert.equal(out.discovery.agentsMd.present, false);
  assert.equal(out.discovery.agentsMd.unknown, true);
  assert.ok(out.agent.strategy.unknowns.length >= 3, `doors verdict named ${out.agent.strategy.unknowns.length} unanswered probes`);
});

