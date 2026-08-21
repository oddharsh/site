// ── /lens per-IP crawl budgets ──────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  readFile,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── /lens per-IP crawl budgets ──────────────────────────────────────
// These moved off KV counters and onto the Rate Limiting binding on 2026-08-04.
// The route they guard is the one that fetches third parties and spends Browser
// Run, so "fails open when the binding is missing" and "the 429 quotes the real
// ceiling" are both worth pinning.

test("every rate-limit ceiling matches the ratelimits declared in both wrangler configs", async () => {
  const { LENS_BUDGETS } = await import("../src/worker/lens.ts");
  const { parseJsonc } = await import("./lib/jsonc.mjs");

  // EVERY per-IP budget on the site, not just Lens's. The orphan check at the
  // bottom is the reason this has to be exhaustive: it fails on any declared
  // limiter no code reads, which is what caught ASK_RL the moment it was
  // declared and would catch the next one too. A budget that lives in a module
  // this list forgets reads as an orphan and fails here, which is the correct
  // and cheap way to find out.
  const BUDGETS = { ...LENS_BUDGETS };

  // The number in LENS_BUDGETS is what the 429 message quotes; the number in
  // wrangler.jsonc is what actually limits. A message that disagrees with the
  // ceiling is worse than no message, and nothing else would catch the drift.
  for (const config of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
    const declared = parseJsonc(readFileSync(config, "utf8")).ratelimits;
    assert.ok(Array.isArray(declared) && declared.length, `${config} declares no ratelimits`);
    const byName = new Map(declared.map((r) => [r.name, r]));

    for (const [budget, { binding, max }] of Object.entries(BUDGETS)) {
      const rule = byName.get(binding);
      assert.ok(rule, `${config} has no ratelimit named ${binding} for budget ${budget}`);
      assert.equal(rule.simple?.limit, max,
        `${config} limits ${binding} to ${rule.simple?.limit} but the 429 message says ${max}`);
      // The binding supports 10 or 60 only, and every budget here is per-minute.
      assert.equal(rule.simple?.period, 60, `${binding} must use the 60s period`);
    }
    // No orphans: a declared limiter nothing reads is a limit nobody enforces.
    const used = new Set(Object.values(BUDGETS).map((b) => b.binding));
    for (const name of byName.keys()) {
      assert.ok(used.has(name), `${config} declares ${name} but no budget in this test uses it`);
    }
  }
});

test("overLensBudget fails open without a limiter and closes when one says no", async () => {
  const { LENS_BUDGETS, overLensBudget } = await import("../src/worker/lens.ts");
  const req = new Request("https://aadhar.sh/lens/fetch?url=https://example.com", {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

  // Fails OPEN with no binding at all. This is the local-dev and contract-test
  // shape, and it matches the KV version's behaviour without RN_KV: abuse
  // control, not authorization. validateLensTarget's SSRF guard has no fallback
  // and is what actually keeps this route safe.
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, {}), false);
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, { LENS_RL_INSPECT: {} }), false,
    "a binding without .limit() is not a limiter");

  // ...and open when the limiter throws. A limiter blip must cost the rate
  // limit, never the route: an unhandled throw here renders Cloudflare's HTML
  // 1101 page, which the caller then tries to JSON.parse.
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, {
    LENS_RL_INSPECT: { limit: () => { throw new Error("limiter down"); } },
  }), false);

  // Closes when the limiter says so, and keys on the caller's IP.
  let seen = null;
  const env = { LENS_RL_SHOT: { limit: (arg) => { seen = arg; return { success: false }; } } };
  assert.equal(await overLensBudget(LENS_BUDGETS.shot, req, env), true);
  assert.deepEqual(seen, { key: "203.0.113.7" });

  // Each budget reads its OWN binding, which is the property that stopped /mcp
  // from being a second unmetered door onto the same crawler.
  const names = Object.values(LENS_BUDGETS).map((b) => b.binding);
  assert.equal(new Set(names).size, names.length, "two budgets share one binding");
});

test("every browser lens reads its cache before it checks a budget", async () => {
  // STRUCTURAL, and it says so here because the behavioural version needs a
  // Rate Limiting binding plus a populated KV, neither of which node --test has.
  // What it pins is an ORDER in the source, which is exactly what regressed.
  //
  // The rule: the per-minute limits exist to ration Browser Run, a cache hit
  // spends none of it, so a hit must be answered before any limit is consulted.
  // Getting this backwards refuses a reader a snapshot the Worker is already
  // holding, and it does so hardest when the cache is fullest.
  const files = {
    "lens.js": await readFile(new URL("../src/worker/lens.ts", import.meta.url), "utf8"),
    "lens-wire.js": await readFile(new URL("../src/worker/lens-wire.ts", import.meta.url), "utf8"),
  };
  const cases = [
    { file: "lens.js", handler: "handleLensShot", key: '"lens:shot:"' },
    { file: "lens.js", handler: "handleLensBrowser", key: '"lens:browser:"' },
    { file: "lens-wire.js", handler: "handleLensWire", key: '"lens:wire:"' },
  ];
  for (const c of cases) {
    const src = files[c.file];
    const from = src.indexOf("export async function " + c.handler);
    assert.ok(from > -1, `${c.handler} not found in ${c.file}`);
    // The next exported function is where this one ends. Scanning to end-of-file
    // would let a LATER handler's cache read satisfy an earlier handler's test.
    const next = src.indexOf("export async function ", from + 1);
    const body = src.slice(from, next === -1 ? src.length : next);

    const cacheAt = body.indexOf(c.key);
    const budgetAt = body.indexOf("overLensBudget(");
    assert.ok(cacheAt > -1, `${c.handler} no longer builds its ${c.key} cache key`);
    assert.ok(budgetAt > -1, `${c.handler} no longer checks a budget, so this test is now vacuous`);
    assert.ok(cacheAt < budgetAt,
      `${c.handler} checks a rate limit before reading its cache, so a cached answer can be refused`);
  }
});

test("documentTally counts substance, not framework payload", async () => {
  const { documentTally } = await import("../src/worker/lens-render.ts");

  // A client-rendered shell: almost all of its bytes are an inline script, and
  // none of that is anything a reader or a parser gets. This is why the shape
  // has no `bytes` field at all — bytes would score the framework payload as
  // content and call this page mostly-visible to a crawler.
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

    // Remembered for the isolate: the second render must not pay the failed
    // attempt again, because every render would otherwise cost two REST calls.
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

  // And the shipped caller must use that builder rather than its own literal,
  // which is the drift this exists to prevent.
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
    // An endpoint that IGNORES an unrecognised query parameter answers exactly
    // this: 200, with the documented envelope, which carries no engine field.
    // The old code read that as confirmation and labelled the render `kitesurf`,
    // so a Chromium render was reported as Kitesurf on the one page whose entire
    // premise is showing what a machine actually saw.
    testGlobals.fetch = async () => new Response(
      JSON.stringify({ success: true, result: { content: "<html></html>" }, meta: { status: 200, title: "x" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const run = await runBrowserAction("snapshot", { url: "https://example.com" }, { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" });
    assert.equal(run.engine, "kitesurf-requested", "a 200 means the call worked, not that Kitesurf served it");
    assert.notEqual(run.engine, "kitesurf", "only bun run kitesurf:check can promote this label");
  } finally {
    testGlobals.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("the ramp guard asks whether it can authenticate, not whether it is CI", async () => {
  const { releaseCredentialError } = await import("./lib/release-guard.mjs");

  // Interactive: wrangler's stored OAuth login IS the credential. Demanding an
  // env var here would break every workstation ramp this repo has ever done.
  assert.equal(releaseCredentialError({}), null);
  assert.equal(releaseCredentialError({ CLOUDFLARE_API_TOKEN: "" }), null);

  // In CI there is no login to fall back on. This used to be a flat `if (CI)
  // die()`, which refused the case it was built to protect — a ramp with a real
  // token, gated by a human — while doing nothing about the case that actually
  // breaks: a ramp that starts unauthenticated and fails partway, possibly after
  // traffic already moved to 10%.
  assert.match(releaseCredentialError({ CI: "true" }) || "", /CLOUDFLARE_API_TOKEN/);

  // Two accounts on this login means a non-interactive wrangler call dies with
  // "More than one account available", which reads like a bad token and is a
  // missing line of config. Caught here, by name, rather than mid-ramp.
  assert.match(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t" }) || "", /CLOUDFLARE_ACCOUNT_ID/);

  // Fully configured CI is allowed through — the whole point of the change.
  assert.equal(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }), null);
});

test("the shared browser ceiling bills everyone to one bucket, not per caller", async () => {
  const { BROWSER_FREE_PLAN, LENS_BUDGETS, overLensBudget } = await import("../src/worker/lens.ts");

  // A budget carrying a fixed key must IGNORE the caller's IP. Two different
  // visitors have to land in the same bucket, because the allowance they are
  // spending belongs to the account rather than to either of them.
  const keys = [];
  const env = { LENS_RL_BROWSER_ALL: { limit: (arg) => { keys.push(arg.key); return { success: true }; } } };
  for (const ip of ["203.0.113.7", "198.51.100.4"]) {
    const req = new Request("https://aadhar.sh/lens/shot?url=https://example.com", { headers: { "cf-connecting-ip": ip } });
    await overLensBudget(LENS_BUDGETS.browserAll, req, env);
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
