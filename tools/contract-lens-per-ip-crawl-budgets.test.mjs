// ── /lens per-IP crawl budgets ──────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  configText,
  context,
  testGlobals,
  assert,
  readFile,
  test,
} from "./contract-shared.ts";

test("every rate-limit ceiling matches the ratelimits declared in the site config", async () => {
  const { LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const { MCP_BUDGETS } = await import("../src/worker/mcp.ts");
  const { WEBMENTION_BUDGET } = await import("../src/worker/webmention.ts");
  const { ASK_BUDGET } = await import("../src/worker/ask-rank.ts");
  const { API_READ_BUDGET } = await import("../src/worker/lib/api-limits.ts");
  const { PIXEL_PEEPER_BUDGET } = await import("../src/worker/pixel-peeper-crowd.ts");
  const { parseJsonc } = await import("./lib/jsonc.ts");

  const BUDGETS = { ...LENS_BUDGETS, ...MCP_BUDGETS, webmention: WEBMENTION_BUDGET, ask: ASK_BUDGET, read: API_READ_BUDGET, pixelPeeper: PIXEL_PEEPER_BUDGET };
  assert.equal(Object.keys(BUDGETS).length,
    Object.keys(LENS_BUDGETS).length + Object.keys(MCP_BUDGETS).length + 4,
    "two budgets share a key, so one of them is not being checked");

  const bindings = Object.values(BUDGETS).map((b) => b.binding);
  assert.equal(new Set(bindings).size, bindings.length, "two budgets share one binding");

  const config = "cloudflare.config.ts";
  const declared = parseJsonc(await configText(config)).ratelimits;
  assert.ok(Array.isArray(declared) && declared.length, `${config} declares no ratelimits`);
  const byName = new Map(declared.map((r) => [r.name, r]));

  for (const [budget, { binding, max }] of Object.entries(BUDGETS)) {
    const rule = byName.get(binding);
    assert.ok(rule, `${config} has no ratelimit named ${binding} for budget ${budget}`);
    assert.equal(rule.simple?.limit, max,
      `${config} limits ${binding} to ${rule.simple?.limit} but the 429 message says ${max}`);
    // The binding supports 10 or 60 only, and every budget here is per-minute.
    // RATE_WINDOW_S is the same number as the Retry-After every 429 sends.
    const { RATE_WINDOW_S } = await import("../src/worker/lib/ratelimit.ts");
    assert.equal(rule.simple?.period, RATE_WINDOW_S, `${binding} must use the ${RATE_WINDOW_S}s period Retry-After quotes`);
  }
  const used = new Set(Object.values(BUDGETS).map((b) => b.binding));
  for (const name of byName.keys()) {
    assert.ok(used.has(name), `${config} declares ${name} but no budget in this test uses it`);
  }
});

test("overBudget fails open without a limiter and closes when one says no", async () => {
  const { LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const { overBudget } = await import("../src/worker/lib/ratelimit.ts");
  const req = new Request("https://aadhar.sh/lens/fetch?url=https://example.com", {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

  assert.equal(await overBudget(LENS_BUDGETS.inspect, req, {}), false);
  assert.equal(await overBudget(LENS_BUDGETS.inspect, req, { LENS_RL_INSPECT: {} }), false,
    "a binding without .limit() is not a limiter");

  assert.equal(await overBudget(LENS_BUDGETS.inspect, req, {
    LENS_RL_INSPECT: { limit: () => { throw new Error("limiter down"); } },
  }), false);

  let seen = null;
  const env = { LENS_RL_SHOT: { limit: (arg) => { seen = arg; return { success: false }; } } };
  assert.equal(await overBudget(LENS_BUDGETS.shot, req, env), true);
  assert.deepEqual(seen, { key: "203.0.113.7" });

  const names = Object.values(LENS_BUDGETS).map((b) => b.binding);
  assert.equal(new Set(names).size, names.length, "two budgets share one binding");
});

const CACHED_LENSES = [
  { name: "shot", url: "/lens/shot", budget: "shot", prefix: "lens:shot:", png: true },
  { name: "browser", url: "/lens/browser", budget: "browser", prefix: "lens:browser:" },
  { name: "cloudflare-score", url: "/lens/fetch?mode=cloudflare&", budget: "inspect", prefix: "lens:cloudflare-score:" },
  { name: "wire", url: "/lens/wire", budget: "wire", prefix: "lens:wire:" },
  { name: "tools", url: "/lens/tools", budget: "tools", prefix: "lens:tools:" },
  { name: "nlweb", url: "/lens/nlweb", budget: "nlweb", prefix: "lens:nlweb:" },
  { name: "markdown", url: "/lens/markdown", budget: "markdown", prefix: "lens:md:" },
];

async function lensHandlers() {
  const lens = await import("../src/worker/lens.ts");
  const { handleLensWire } = await import("../src/worker/lens-wire.ts");
  const { handleLensTools } = await import("../src/worker/lens-tools.ts");
  const { handleLensNlweb } = await import("../src/worker/lens-nlweb.ts");
  const { handleLensMarkdown } = await import("../src/worker/lens-markdown.ts");
  return {
    shot: lens.handleLensShot, browser: lens.handleLensBrowser, "cloudflare-score": lens.handleLensFetch,
    wire: handleLensWire, tools: handleLensTools, nlweb: handleLensNlweb, markdown: handleLensMarkdown,
  };
}

function refusingEnv(kv, budgets) {
  const calls = [];
  const env = {
    RN_KV: kv,
    BROWSER: {
      quickAction: () => { throw new Error("a hit must not render"); },
      fetch: () => { throw new Error("a hit must not open a session"); },
    },
  };
  for (const { binding } of Object.values(budgets)) {
    env[binding] = { limit: () => { calls.push(binding); return { success: false }; } };
  }
  return { env, calls };
}

function fakeKv(entry) {
  const reads = [];
  return {
    reads,
    get: async (key, type) => {
      reads.push(key);
      if (entry === undefined) return null;
      if (entry instanceof Error) throw entry;
      return type === "arrayBuffer" ? new TextEncoder().encode("PNG").buffer : entry;
    },
    put: async () => { throw new Error("nothing may be written on these paths"); },
  };
}

test("every cached lens answers a hit without consulting a budget", async () => {
  const { LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const handlers = await lensHandlers();
  assert.equal(Object.keys(handlers).length, CACHED_LENSES.length, "a cached lens is missing from the list");

  for (const lens of CACHED_LENSES) {
    const kv = fakeKv({ ok: true, available: true, host: "example.com" });
    const { env, calls } = refusingEnv(kv, LENS_BUDGETS);
    const sep = lens.url.includes("?") ? "" : "?";
    const res = await handlers[lens.name](new Request(`https://aadhar.sh${lens.url}${sep}url=https://example.com/`), env, context());
    assert.equal(res.status, 200, `${lens.name}: a cached answer was refused (${res.status})`);
    assert.deepEqual(calls, [], `${lens.name}: a hit consulted ${calls.join(", ")}`);
    assert.ok(kv.reads.length === 1 && kv.reads[0].startsWith(lens.prefix), `${lens.name}: read ${kv.reads[0]}, not a ${lens.prefix} key`);
    // A served answer names the door's policy (draft-ietf-httpapi-ratelimit-
    // headers-11, section 3), own budget first, the shared browser one after.
    const policy = res.headers.get("ratelimit-policy") || "";
    assert.ok(policy.startsWith(`"${lens.budget}";q=${LENS_BUDGETS[lens.budget].max};w=60`), `${lens.name}: RateLimit-Policy was ${policy}`);
    assert.equal(res.headers.get("ratelimit"), null, `${lens.name}: a hit spends nothing, so it claims no remaining count`);
    if (lens.png) {
      assert.equal(res.headers.get("x-lens-cache"), "hit");
    } else {
      const body = await res.json();
      assert.equal(body.fromCache, true, `${lens.name}: a hit must say fromCache: true`);
      assert.equal(body.ok, true);
      assert.equal("cached" in body, false, `${lens.name}: the hit flag is spelled fromCache, never cached`);
    }
  }
});

test("every cached lens charges its own budget on a miss, and quotes it", async () => {
  const { LENS_BUDGETS, budgetMessage } = await import("../src/worker/lens.ts");
  const handlers = await lensHandlers();
  for (const lens of CACHED_LENSES) {
    const { env, calls } = refusingEnv(fakeKv(undefined), LENS_BUDGETS);
    const sep = lens.url.includes("?") ? "" : "?";
    const res = await handlers[lens.name](new Request(`https://aadhar.sh${lens.url}${sep}url=https://example.com/`), env, context());
    assert.equal(res.status, 429, `${lens.name}: a miss over budget answered ${res.status}`);
    assert.equal(calls[0], LENS_BUDGETS[lens.budget].binding, `${lens.name}: the first budget charged was ${calls[0]}`);
    assert.equal((await res.json()).error, budgetMessage(/** @type {any} */ (lens.budget)), `${lens.name}: the 429 is not the derived message`);
    assert.equal(res.headers.get("retry-after"), "60", `${lens.name}: a 429 over our own budget says when to come back`);
    assert.equal(res.headers.get("ratelimit"), `"${lens.budget}";r=0;t=60`, `${lens.name}: the refused policy has nothing left`);
    assert.equal(res.headers.get("ratelimit-policy"), `"${lens.budget}";q=${LENS_BUDGETS[lens.budget].max};w=60`);
  }
});

test("/lens/fetch, /lens/compare.json and webmention say when to come back, too", async () => {
  const { LENS_BUDGETS, handleLensFetch, handleLensCompare } = await import("../src/worker/lens.ts");
  const { rateLimitedHeaders, RATE_WINDOW_S } = await import("../src/worker/lib/ratelimit.ts");
  assert.deepEqual(rateLimitedHeaders("webmention", 10), {
    "retry-after": "60",
    "ratelimit-policy": '"webmention";q=10;w=60',
    "ratelimit": '"webmention";r=0;t=60',
  });
  /** @type {Array<[handler: (req: Request, env: any, ctx: any) => Promise<Response>, path: string]>} */
  const doors = [
    [handleLensFetch, "/lens/fetch?url=https://example.com/"],
    [handleLensCompare, "/lens/compare.json?left=https://example.com/&right=https://example.org/"],
  ];
  for (const [handler, path] of doors) {
    const { env } = refusingEnv(fakeKv(undefined), LENS_BUDGETS);
    const res = await handler(new Request(`https://aadhar.sh${path}`), env, context());
    assert.equal(res.status, 429, `${path} answered ${res.status}`);
    assert.equal(res.headers.get("retry-after"), String(RATE_WINDOW_S), `${path}: Retry-After`);
    assert.match(res.headers.get("ratelimit") || "", /^"(inspect|compare)";r=0;t=60$/, `${path}: RateLimit`);
  }
  const bad = await handleLensFetch(new Request("https://aadhar.sh/lens/fetch?url=http://localhost/"), refusingEnv(fakeKv(undefined), LENS_BUDGETS).env, context());
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("retry-after"), null, "a bad target is not a rate limit");
  assert.equal(bad.headers.get("ratelimit"), null, "and claims no remaining count");

  const { WEBMENTION_BUDGET, handleWebmention } = await import("../src/worker/webmention.ts");
  const { env } = refusingEnv(fakeKv(undefined), { webmention: WEBMENTION_BUDGET });
  const form = new URLSearchParams({ source: "https://example.com/post", target: "https://aadhar.sh/writing" });
  const res = await handleWebmention(new Request("https://aadhar.sh/webmention", {
    method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" },
  }), env, context());
  assert.equal(res.status, 429, `webmention answered ${res.status}: ${await res.clone().text()}`);
  assert.equal(res.headers.get("retry-after"), String(RATE_WINDOW_S));
  assert.equal(res.headers.get("ratelimit-policy"), `"webmention";q=${WEBMENTION_BUDGET.max};w=60`);
});

test("a cache read that throws is a miss, never the route's failure", async () => {
  const { LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const handlers = await lensHandlers();
  for (const lens of CACHED_LENSES) {
    const { env } = refusingEnv(fakeKv(new Error("KV is down")), LENS_BUDGETS);
    const sep = lens.url.includes("?") ? "" : "?";
    const res = await handlers[lens.name](new Request(`https://aadhar.sh${lens.url}${sep}url=https://example.com/`), env, context());
    assert.equal(res.status, 429, `${lens.name}: a throwing KV read should fall through to the budget, got ${res.status}`);
  }
});

test("the pipeline caches what a lens reached and nothing it was refused", async () => {
  const { defineLens, lensJson } = await import("../src/worker/lens-pipeline.ts");
  const writes = [];
  const kv = { get: async () => null, put: async (key, value, opts) => { writes.push({ key, value, opts }); } };
  let answer;
  const probe = defineLens({
    budget: "tools",
    targets: (p) => p.get("url") || "",
    cache: { prefix: "lens:contract-probe:", ttl: 123 },
    run: async () => answer,
  });
  const req = new Request("https://aadhar.sh/x?url=https://example.com/");

  answer = { ok: false, status: 200, outcome: "shut", payload: { ok: false, error: "no MCP here" } };
  const shut = await (await probe.handle(req, { RN_KV: kv })).json();
  assert.deepEqual(shut, { ok: false, error: "no MCP here" });
  assert.equal(writes.length, 0, "a refused result was cached");

  answer = { ok: true, value: { ok: false, error: "looks like an answer" } };
  await probe.handle(req, { RN_KV: kv });
  assert.equal(writes.length, 0, "an ok:false payload was cached because run called it ok");

  answer = { ok: true, value: { ok: true, tools: 3 } };
  const read = await (await probe.handle(req, { RN_KV: kv })).json();
  assert.deepEqual(read, { ok: true, tools: 3, fromCache: false }, "a miss says fromCache: false");
  assert.equal(writes.length, 1);
  assert.ok(writes[0].key.startsWith("lens:contract-probe:"));
  assert.deepEqual(writes[0].opts, { expirationTtl: 123 });

  const hit = await lensJson({ kind: "ok", value: { ok: true, cached: 4 }, fromCache: true }).json();
  assert.equal(hit.cached, 4);
  assert.equal(hit.fromCache, true);
});

test("a lens is refused at definition when its spec breaks a rule the order depends on", async () => {
  const { defineLens } = await import("../src/worker/lens-pipeline.ts");
  /** @type {any} */
  const base = { targets: () => "", run: async () => ({ ok: true, value: {} }) };
  assert.throws(() => defineLens({ ...base, budget: "browserAll" }), /not a per-route budget/);
  assert.throws(() => defineLens({ ...base, budget: /** @type {any} */ ("nope") }), /not a per-route budget/);
  assert.throws(() => defineLens({ ...base, budget: "tools", cache: { prefix: "lens:md:", ttl: 1 } }), /declared twice/);
});

test("every lens 429 is derived from LENS_BUDGETS, never typed", async () => {
  const { LENS_BUDGETS, budgetMessage } = await import("../src/worker/lens.ts");
  // One per-visitor budget and the shared one, word for word, since the two
  // are worded differently on purpose.
  assert.equal(budgetMessage("wire"), "Wire traces are rate-limited to 2/min. Hang on a moment.");
  assert.equal(budgetMessage("browserAll"), "The shared browser budget (4/min across every visitor) is spent for this minute. Try again shortly.");
  for (const name of Object.keys(LENS_BUDGETS)) {
    assert.ok(budgetMessage(/** @type {any} */ (name)).includes(`${LENS_BUDGETS[name].max}/min`), `${name}: the message does not quote its own ceiling`);
  }
  const DOORS = ["src/worker/lens.ts", "src/worker/lens-pipeline.ts", "src/worker/lens-wire.ts", "src/worker/lens-tools.ts",
    "src/worker/lens-nlweb.ts", "src/worker/lens-markdown.ts", "src/worker/terminal.ts", "src/worker/lib/tools.ts"];
  const typed = (src) => src.split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /(?<![$\w}])\d+\s*\/\s*min\b|\b\d+ lookups a minute/.test(line));
  assert.equal(typed(`  error: "Lens comparisons are rate-limited to 4/min."`).length, 1);
  assert.equal(typed("  error: `Slow down — 30 lookups a minute.`").length, 1);
  assert.equal(typed("  error: `rate-limited to ${b.max}/min`").length, 0);
  for (const file of DOORS) {
    const hits = typed(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.deepEqual(hits, [], `${file} types a rate-limit number by hand`);
  }
});

test("documentTally counts substance, not framework payload", async () => {
  const { documentTally } = await import("../src/worker/lens-render.ts");

  const raw = `<html><head><title>Shop</title></head><body><div id="root"></div>
    <script>${"var padding='x';".repeat(400)}</script></body></html>`;
  const shell = documentTally(raw);
  assert.equal(shell.words, 1, "the title counts, the 6KB script body does not");
  assert.equal(shell.headings, 0);
  assert.equal(shell.jsonld, 0);

  const rendered = documentTally(`<html><body><h1>Winter jackets</h1>
    <p>Forty two jackets, wool and down, in stock today.</p>
    <a href="/a">one</a><a href="/b">two</a><img src="/j.png">
    <script type="application/ld+json">{"@type":"Product"}</script></body></html>`);
  assert.ok(rendered.words > 10);
  assert.equal(rendered.headings, 1);
  assert.equal(rendered.links, 2);
  assert.equal(rendered.images, 1);
  assert.equal(rendered.jsonld, 1, "structured data that exists only after render");
});

test("the kitesurf selector is tried, and a rejection is remembered rather than reported", async () => {
  const { runBrowserAction, _resetKitesurfProbe, _kitesurfParamLive } =
    await import("../src/worker/lens-render.ts");
  const env = { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" };
  const realFetch = globalThis.fetch;
  const calls = [];

  try {
    // `browser=kitesurf` is documented on Cloudflare's Kitesurf page and NOT in
    // the Quick Actions reference. A 400 on the attempt carrying it must not
    // surface as "the scanned site is broken", which is what hard-coding the
    // parameter would have produced on every single render.
    _resetKitesurfProbe();
    testGlobals.fetch = async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: String(url).includes("browser=kitesurf") ? 400 : 200 });
    };
    const first = await runBrowserAction("snapshot", { url: "https://example.com" }, env);
    assert.equal(calls.length, 2, "tried the selector, then retried without it");
    assert.ok(calls[0].includes("browser=kitesurf"));
    assert.ok(!calls[1].includes("browser=kitesurf"));
    assert.equal(first.engine, "chromium-rest", "the engine reported is the one that answered");
    assert.equal(_kitesurfParamLive(), false);

    calls.length = 0;
    const second = await runBrowserAction("snapshot", { url: "https://example.com" }, env);
    assert.equal(calls.length, 1, "the known-dead selector is not retried");
    assert.equal(second.engine, "chromium-rest", "REST still serves, just without the dead selector");
  } finally {
    testGlobals.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("the selector rides the browser-run path, which is the only one it works on", async () => {
  const { restUrl, runBrowserAction, _resetKitesurfProbe } =
    await import("../src/worker/lens-render.ts");

  // Both spellings ROUTE — probed unauthenticated against the real account id,
  // each answers error 10000 rather than 7003 "could not route to". So posting
  // to the wrong one costs no error and no log line; it costs the opt-in. This
  // is a one-word difference with no symptom, which is exactly the kind that
  // survives a review, so it gets an assertion of its own rather than riding
  // along inside a behavioural test.
  const url = restUrl("acct", "snapshot", "kitesurf");
  assert.ok(url.includes("/browser-run/snapshot"), "Kitesurf documents this path alone");
  assert.ok(!url.includes("/browser-rendering/"), "the alias silently drops the selector");
  assert.ok(url.endsWith("?browser=kitesurf"));
  assert.equal(restUrl("acct", "snapshot", ""), restUrl("acct", "snapshot"), "no engine, no query string");

  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    _resetKitesurfProbe();
    testGlobals.fetch = async (u) => { calls.push(String(u)); return new Response("{}", { status: 200 }); };
    await runBrowserAction("snapshot", { url: "https://example.com" }, { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" });
    assert.ok(calls[0].includes("/browser-run/snapshot?browser=kitesurf"), calls[0]);
  } finally {
    testGlobals.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("a 200 is not evidence that kitesurf rendered, and is not reported as if it were", async () => {
  const { runBrowserAction, _resetKitesurfProbe } =
    await import("../src/worker/lens-render.ts");
  const realFetch = globalThis.fetch;

  try {
    _resetKitesurfProbe();
    testGlobals.fetch = async () => new Response(
      JSON.stringify({ success: true, result: { content: "<html></html>" }, meta: { status: 200, title: "x" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const run = await runBrowserAction("snapshot", { url: "https://example.com" }, { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" });
    assert.equal(run.engine, "kitesurf-requested", "a 200 means the call worked, not that Kitesurf served it");
    assert.notEqual(run.engine, "kitesurf", "only a control that sees an invented engine name rejected can promote this label");
  } finally {
    testGlobals.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("the binding is the kitesurf door, and its label is a bare kitesurf", async () => {
  const { runBrowserAction } = await import("../src/worker/lens-render.ts");
  const realFetch = globalThis.fetch;
  const sent = [];
  const goto = { waitUntil: "networkidle2", timeout: 18000 };
  const payload = { url: "https://example.com", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, gotoOptions: goto };
  const env = {
    CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok",
    BROWSER: { quickAction: async (action, body) => { sent.push({ action, body }); return new Response("{}", { status: 200 }); } },
  };
  try {
    // Measured 2026-09-28: the binding validates `browser` as an enum whose only
    // member is "kitesurf", and rejects an invented engine name. So a 200 from
    // this door IS Kitesurf, which the REST door has never been able to say.
    testGlobals.fetch = async () => { throw new Error("REST must not be called while the binding exists"); };
    const run = await runBrowserAction("snapshot", payload, env);
    assert.ok(run);
    assert.equal(run.engine, "kitesurf");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.browser, "kitesurf");
    // Kitesurf answers 501 "Unsupported options: viewport.deviceScaleFactor",
    // and 1 is Chromium's default, so the key is dropped rather than paid for.
    assert.deepEqual(sent[0].body.viewport, { width: 1280, height: 800 });
    assert.equal(sent[0].body.gotoOptions, goto, "nested config keeps its identity");
    assert.equal(payload.viewport.deviceScaleFactor, 1, "the caller's payload is not mutated");
    assert.ok(!("browser" in payload));
  } finally {
    testGlobals.fetch = realFetch;
  }
});

test("a refused request shape falls back to chromium once, and a spent budget does not", async () => {
  const { runBrowserAction, kitesurfPayload } = await import("../src/worker/lens-render.ts");
  const payload = { url: "https://example.com", viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } };
  assert.equal(kitesurfPayload(payload).viewport.deviceScaleFactor, 2);

  const cases = [{ status: 501, retries: true }, { status: 400, retries: true }, { status: 429, retries: false }, { status: 500, retries: false }, { status: 200, retries: false }];
  for (const { status, retries } of cases) {
    const sent = [];
    const env = {
      BROWSER: {
        quickAction: async (_action, body) => {
          sent.push(body);
          return new Response("{}", { status: body.browser === "kitesurf" ? status : 200 });
        },
      },
    };
    const run = await runBrowserAction("snapshot", payload, env);
    assert.ok(run);
    if (retries) {
      // A 400/501 rendered nothing (790ms, no x-browser-ms-used), so the second
      // call is free, and it carries the caller's payload whole.
      assert.equal(sent.length, 2, `status ${status} retries`);
      assert.equal(sent[1], payload, "chromium gets the original payload");
      assert.equal(run.engine, "chromium-binding", "the engine reported is the one that answered");
    } else {
      assert.equal(sent.length, 1, `status ${status} does not retry`);
      assert.equal(run.engine, "kitesurf");
      assert.equal(run.response.status, status);
    }
  }
});

test("an explicit chromium request skips kitesurf on the binding", async () => {
  const { runBrowserAction } = await import("../src/worker/lens-render.ts");
  const sent = [];
  const env = { BROWSER: { quickAction: async (_a, body) => { sent.push(body); return new Response("{}", { status: 200 }); } } };
  const run = await runBrowserAction("snapshot", { url: "https://example.com" }, env, { engine: "chromium" });
  assert.ok(run);
  assert.equal(sent.length, 1);
  assert.ok(!("browser" in sent[0]));
  assert.equal(run.engine, "chromium-binding");
});

test("the ramp guard asks whether it can authenticate, not whether it is CI", async () => {
  const { releaseCredentialError } = await import("./lib/release-guard.ts");

  assert.equal(releaseCredentialError({}), null);
  assert.equal(releaseCredentialError({ CLOUDFLARE_API_TOKEN: "" }), null);

  assert.match(releaseCredentialError({ CI: "true" }) || "", /CLOUDFLARE_API_TOKEN/);

  // Two accounts on this login means a non-interactive wrangler call dies with
  // "More than one account available", which reads like a bad token and is a
  // missing line of config. Caught here, by name, rather than mid-ramp.
  assert.match(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t" }) || "", /CLOUDFLARE_ACCOUNT_ID/);

  assert.equal(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }), null);
});

test("the shared browser ceiling bills everyone to one bucket, not per caller", async () => {
  const { BROWSER_FREE_PLAN, LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const { overBudget } = await import("../src/worker/lib/ratelimit.ts");

  const keys = [];
  const env = { LENS_RL_BROWSER_ALL: { limit: (arg) => { keys.push(arg.key); return { success: true }; } } };
  for (const ip of ["203.0.113.7", "198.51.100.4"]) {
    const req = new Request("https://aadhar.sh/lens/shot?url=https://example.com", { headers: { "cf-connecting-ip": ip } });
    await overBudget(LENS_BUDGETS.browserAll, req, env);
  }
  assert.deepEqual(keys, ["browser-run", "browser-run"], "the shared ceiling must not key on the caller");

  // The per-caller ceilings on the browser routes have to stay UNDER the
  // account's own limit, or one visitor can spend everyone's minute. Measured
  // 2026-08-06: free plan is 1 Quick Action per 10s account-wide, and `shot`
  // used to allow 8/min to a single IP.
  for (const name of ["shot", "browser"]) {
    assert.ok(LENS_BUDGETS[name].max <= BROWSER_FREE_PLAN.perMinute,
      `${name} allows ${LENS_BUDGETS[name].max}/min to one caller, over the account's ${BROWSER_FREE_PLAN.perMinute}/min`);
  }
  assert.ok(LENS_BUDGETS.browserAll.max <= BROWSER_FREE_PLAN.perMinute,
    "the shared ceiling must sit under the account allowance it exists to protect");
});
