// ── /lens need: score what a site serves (src/worker/lens-need.ts) ───────────
// The readiness mirror weighs twenty declarations the same, so a blog that does
// everything a reader needs still loses points for OAuth it has no use for.
// These pin the applicability rule borrowed from Is Agentic, the cap on
// emerging doors, the skip list that keeps a blog off the OAuth treadmill, and
// the ledger that files every is-agentic check exactly once.
import { assert, lensReadiness, test } from "./contract-shared.ts";
import { ISAG_CATALOG, ISAG_LEDGER, NEED_POOLS, lensNeed, openapiOperationIds } from "../src/worker/lens-need.ts";

const words = (n) => Array.from({ length: n }, (_, i) => "word" + i).join(" ");
const page = (extra = "") =>
  `<!doctype html><html lang="en"><head><link rel="canonical" href="https://blog.test/"></head><body><h1>A blog</h1><p>${words(120)}</p>${extra}</body></html>`;
const control = { key: "chrome", role: "control", status: 200 };
const crawler = (key) => ({ key, role: "answers", status: 200 });
// find() answers T | undefined; a missing row is itself the failure worth naming.
const pick = (list, key) => {
  const row = list.find((x) => x.key === key);
  assert.ok(row, `${key} should be in the list`);
  return row;
};

// A plain blog that does everything a reader needs and publishes no agent doors.
function blog(over = {}) {
  const readiness = /** @type {any} */ (
    lensReadiness({
      headers: {},
      robots: { ok: true, status: 200, body: "User-agent: *\nAllow: /\n" },
      sitemap: null,
      terms: null,
      discovery: null,
      agent: null,
      openapi: null,
      botViews: [],
    })
  );
  readiness.field = { components: [{ key: "sampledBots", score: 100, detail: "8 of 8 named bot identities received an unblocked response" }] };
  return {
    status: 200,
    url: "https://blog.test/",
    finalUrl: "https://blog.test/",
    isHtml: true,
    anatomy: { rawHtml: page(), text: "A blog " + words(120), headings: [{ level: 1, text: "A blog" }] },
    structured: {
      relLinks: [{ rel: "canonical", href: "https://blog.test/" }],
      og: { image: "https://blog.test/og.png", type: "website" },
      meta: {},
      jsonld: [],
    },
    headers: {},
    cost: null,
    readiness,
    agent: {
      mcp: { verdict: "no" },
      openapi: { present: false },
      apiCatalog: { present: false },
      aiPlugin: { present: false },
      llmsTxt: { present: false },
      nlweb: { verdict: "no" },
    },
    terms: {
      scoreboard: [
        { ua: "ChatGPT-User", kind: "answers", verdict: "allow" },
        { ua: "Claude-User", kind: "answers", verdict: "allow" },
        { ua: "GPTBot", kind: "train", verdict: "block" },
      ],
    },
    openapi: null,
    botViews: [control, crawler("GPTBot")],
    ...over,
  };
}

test("a blog that serves its readers is not docked for OAuth, MCP or payments", () => {
  const need = lensNeed(blog());
  assert.equal(need.essential.earned, NEED_POOLS.essential, "every essential check passes on a plain blog");
  for (const s of ["api", "mcp", "auth", "commerce"]) {
    assert.equal(pick(need.surfaces, s).applies, false, `${s} must not apply without evidence`);
  }
  assert.ok(
    !need.recommended.checks.some((c) => /protectedResource|mcpFindable|machinePayment|apiDescribed/.test(c.key)),
    "no surface-gated check may appear when its surface is absent",
  );
  // Missing JSON-LD and sitemap cost recommended points, nothing more.
  assert.ok((need.overall ?? 0) >= 80, `a blog with only website basics scores ${need.overall}, which should be at least 80`);
  // The mirror's fails it has no reason to fix are named, with a reason.
  const skipped = need.skip.map((s) => s.key);
  for (const k of ["oauthDiscovery", "oauthProtectedResource", "authMd", "mcpServerCard"]) {
    assert.ok(skipped.includes(k), `${k} belongs on the skip list for a site with no API or MCP`);
  }
});

test("refusing a training crawler costs nothing; refusing a user-sent agent does", () => {
  const ok = pick(lensNeed(blog()).essential.checks, "userAgents");
  assert.equal(ok.status, "pass", "GPTBot blocked, ChatGPT-User and Claude-User allowed, is a pass");
  const refused = pick(
    lensNeed(
      blog({
        terms: {
          scoreboard: [
            { ua: "ChatGPT-User", kind: "answers", verdict: "block" },
            { ua: "Claude-User", kind: "answers", verdict: "allow" },
          ],
        },
      }),
    ).essential.checks,
    "userAgents",
  );
  assert.equal(refused.status, "partial");
  assert.match(refused.detail, /ChatGPT-User/, "the detail names the refused agent");
});

test("a check Lens did not measure leaves the denominator", () => {
  // A self-scan skips bot views. Docking the site for that would be docking it
  // for our own instrument, the rule lensReadiness keeps for execution checks.
  const need = lensNeed(blog({ botViews: [] }));
  const reach = pick(need.essential.checks, "crawlerReach");
  assert.equal(reach.status, "neutral");
  assert.equal(need.essential.total, need.essential.checks.length - 1, "the neutral check leaves the denominator");
  assert.equal(need.essential.earned, NEED_POOLS.essential);
});

test("emerging doors are capped, and the excess is called out as past need", () => {
  const b = blog();
  for (const k of ["robotsTxtAiRules", "contentSignals", "linkHeaders", "dnsAid", "webBotAuth", "agentSkills", "webMcp"]) {
    b.readiness.checks[k] = { ...b.readiness.checks[k], status: "pass" };
  }
  b.agent.llmsTxt = { present: true };
  const need = lensNeed(b);
  assert.ok(need.bonus.signals.length > NEED_POOLS.bonusCap, "the fixture has more doors than the cap");
  assert.equal(need.bonus.points, NEED_POOLS.bonusCap, "no number of drafts buys more than the cap");
  assert.ok(
    need.beyondNeed.some((x) => /emerging doors/.test(x.label)),
    "the excess is named rather than silently dropped",
  );
});

test("OAuth metadata guarding nothing is past need; in front of an API it is a requirement", () => {
  const lone = blog();
  lone.readiness.checks.oauthProtectedResource = { ...lone.readiness.checks.oauthProtectedResource, status: "pass" };
  const need = lensNeed(lone);
  assert.equal(pick(need.surfaces, "auth").applies, false);
  assert.ok(need.beyondNeed.some((x) => x.label === "OAuth metadata"));

  const api = blog({ agent: { ...blog().agent, mcp: { verdict: "likely", detail: "401 + WWW-Authenticate at /mcp (OAuth-protected server)" } } });
  api.readiness.checks.oauthProtectedResource = { ...api.readiness.checks.oauthProtectedResource, status: "fail" };
  const gated = lensNeed(api);
  assert.equal(pick(gated.surfaces, "auth").applies, true);
  const prm = pick(gated.recommended.checks, "protectedResource");
  assert.equal(prm.status, "fail", "an MCP server behind a 401 needs protected-resource metadata");
  assert.ok(!gated.skip.some((s) => s.key === "oauthProtectedResource"), "and it may not be skipped there");
});

test("markdown is Recommended only when the HTML tax is real", () => {
  const lean = blog({
    cost: {
      tiers: [
        { key: "html", tokens: 3000 },
        { key: "markdown", tokens: 2000 },
      ],
    },
  });
  assert.ok(!lensNeed(lean).recommended.checks.some((c) => c.key === "markdown"), "a lean page owes no twin");
  const heavy = blog({
    cost: {
      tiers: [
        { key: "html", tokens: 60000 },
        { key: "markdown", tokens: 3000 },
      ],
    },
  });
  const md = pick(lensNeed(heavy).recommended.checks, "markdown");
  assert.match(md.detail, /20x/);
});

test("operationId coverage reads the OpenAPI document", () => {
  const spec = JSON.stringify({ openapi: "3.1.0", paths: { "/a": { get: { operationId: "listA" }, post: {} }, "/b": { delete: { operationId: "dropB" } } } });
  assert.deepEqual(openapiOperationIds(spec), { ops: 3, named: 2 });
  assert.equal(openapiOperationIds("not json"), null);
});

test("every Is Agentic check is filed exactly once", () => {
  const filed = [...Object.values(ISAG_LEDGER.scored).flat(), ...ISAG_LEDGER.bonus, ...ISAG_LEDGER.declined.flatMap((g) => g.ids)];
  const dupes = filed.filter((id, i) => filed.indexOf(id) !== i);
  assert.deepEqual(dupes, [], "an id filed twice says two different things about one check");
  const missing = ISAG_CATALOG.filter((id) => !filed.includes(id));
  assert.deepEqual(missing, [], "a new is-agentic check has to be scored, counted as bonus, or declined with a reason");
  const unknown = filed.filter((id) => !ISAG_CATALOG.includes(id));
  assert.deepEqual(unknown, [], "the ledger names an id the catalog does not carry");
  for (const g of ISAG_LEDGER.declined) assert.ok(g.why.length > 40, "a declined group carries its reason");
});
