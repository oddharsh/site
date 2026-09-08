// ── 0-RTT early data, and the speculation ledger read back ───────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// A request that arrived as TLS early data can be replayed, so the GET-shaped
// writes answer 425 Too Early (RFC 8470) and every other request is untouched.
// The list is preview.ts's, on purpose: one list, two guards.
test("early data: the GET-shaped writes answer 425, everything else passes", async () => {
  const { earlyDataDenial } = await import("../src/worker/lib/early-data.ts");
  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  assert.ok(PREVIEW_GET_WRITES.size >= 6, "the shared write list must not quietly collapse");

  const early = (path, method = "GET") => new Request(`https://aadhar.sh${path}`, { method, headers: { "early-data": "1" } });
  const plain = (path) => new Request(`https://aadhar.sh${path}`);

  for (const path of PREVIEW_GET_WRITES) {
    const res = earlyDataDenial(early(path), path);
    assert.ok(res, `${path} in early data must be refused`);
    assert.equal(res.status, 425);
    assert.equal(res.headers.get("cache-control"), "no-store", "a 425 is about this handshake, never the resource");
    assert.equal(await res.text(), "", "425 carries no body");
    assert.equal(earlyDataDenial(plain(path), path), null, `${path} without Early-Data must pass`);
  }
  // The documents and assets stay on the fast path: this is the whole point of
  // turning 0-RTT on, and a guard that widened past the write list would spend
  // the round trip it exists to save.
  for (const path of ["/", "/garage/compression", "/a/nav.deadbeef.js", "/i/x.00000000.avif", "/ledger.json", "/coffee"]) {
    assert.equal(earlyDataDenial(early(path), path), null, `${path} must not be refused in early data`);
  }
  // RFC 8470: the header value is exactly "1"; anything else is not early data.
  assert.equal(earlyDataDenial(new Request("https://aadhar.sh/hit", { headers: { "early-data": "0" } }), "/hit"), null);
});

test("early data: the guard runs in the dispatcher ahead of routing, and the setting is declared", () => {
  const idx = readFileSync("src/worker/index.ts", "utf8");
  const guard = idx.indexOf("earlyDataDenial(request, url.pathname)");
  const routing = idx.indexOf("await route(request, env, ctx)");
  assert.ok(guard !== -1, "index.ts no longer calls earlyDataDenial");
  assert.ok(routing !== -1 && guard < routing, "the early-data guard must run before route(): a guard after routing has already lost");
  const infra = JSON.parse(readFileSync("config/infra.json", "utf8"));
  assert.equal(infra.zone?.zero_rtt?.setting, "0rtt", "infra.json must declare the zone setting the guard exists for");
  assert.equal(infra.zone?.zero_rtt?.value, "on");
  const check = readFileSync("tools/check-infra.ts", "utf8");
  assert.match(check, /infra\.zone\?\.zero_rtt/, "check-infra.ts must assert the declared 0-RTT value");
});

// The edge probe for the same setting is a HARD failure on a workstation and an
// ADVISORY on a hosted runner, keyed on GITHUB_ACTIONS. Three spaced rejections
// from GitHub's network have read as drift on three runs while the zone was fine
// (2026-08-20, and twice on 2026-09-02, once on main, where it left a merged PR
// unpromoted); a workstation has never produced a false one. Pinned at the source
// so the split cannot be tidied away into "it is an edge check, so it fails".
test("early data: the edge probe's rejection is advisory on a hosted runner and a drift on a workstation", () => {
  const check = readFileSync("tools/check-infra.ts", "utf8");
  const arm = check.indexOf("if (want.earlyData)");
  assert.ok(arm !== -1, "check-infra.ts no longer has the earlyData arm");
  const body = check.slice(arm, check.indexOf("continue;", arm));
  assert.match(body, /process\.env\.GITHUB_ACTIONS\) warn\(/, "a hosted-runner rejection must be an advisory (warn), keyed on GITHUB_ACTIONS");
  assert.match(body, /else drift\(/, "a workstation rejection must stay a drift");
  assert.ok(body.indexOf("GITHUB_ACTIONS) warn(") < body.indexOf("else drift("), "the advisory arm must be tested before the drift arm");
  const infra = JSON.parse(readFileSync("config/infra.json", "utf8"));
  const entry = infra.edge.checks.find((c) => c.id === "tls-0rtt-on");
  assert.match(entry.gotcha, /ADVISORY IN HOSTED CI/, "infra.json's entry must say the check is advisory in hosted CI, or the split is undocumented");
});

// The readback folds the ledger's per-(kind, path) rows into one row per path
// with an activation rate. Pinned as arithmetic, because a rate that quietly
// counted the wrong denominator would order the candidates backwards.
test("speculation readback: rows fold per path and the rate orders them", async () => {
  const { summarizeSpeculation } = await import("../src/worker/speculation.ts");
  const rows = summarizeSpeculation([
    { kind: "prerender", path: "/garage", n: 40 },
    { kind: "prefetch", path: "/garage", n: 10 },
    { kind: "activated", path: "/garage", n: 25 },
    { kind: "prerender", path: "/lwe", n: 100 },
    { kind: "activated", path: "/lwe", n: 2 },
    { kind: "activated", path: "/orphan", n: 3 },      // an activation with no counted speculation
    { kind: "prerender", path: "/ghost", n: 0 },       // zero rows are not rows
    { kind: "banana", path: "/garage", n: 999 },        // unknown kinds are ignored, never counted
  ]);
  assert.deepEqual(rows.map((r) => r.path), ["/lwe", "/garage", "/orphan"], "sorted by speculations, descending");
  const garage = rows.find((r) => r.path === "/garage");
  assert.deepEqual(garage, { path: "/garage", prefetch: 10, prerender: 40, activated: 25, speculated: 50, rate: 0.5 });
  assert.equal(rows.find((r) => r.path === "/lwe")?.rate, 0.02);
  assert.equal(rows.find((r) => r.path === "/orphan")?.rate, null, "no denominator, no rate");
  assert.equal(rows.some((r) => r.path === "/ghost"), false);
});

test("speculation readback: the route is wired, allowlisted, and refuses writes", async () => {
  const { handleSpeculationJson } = await import("../src/worker/speculation.ts");
  const bad = await handleSpeculationJson(new Request("https://aadhar.sh/ledger/speculation.json", { method: "POST" }), {});
  assert.equal(bad.status, 405);
  // no token: an honest "unconfigured" 200, the same answer /ledger.json gives
  const none = await handleSpeculationJson(new Request("https://aadhar.sh/ledger/speculation.json"), {});
  assert.equal(none.status, 200);
  const body = await none.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "unconfigured");
  assert.equal(none.headers.get("cache-control"), "no-store", "an unconfigured answer must not be cached as the ledger");

  const idx = readFileSync("src/worker/index.ts", "utf8");
  assert.match(idx, /\["\/ledger\/speculation\.json", handleSpeculationJson\]/);
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  assert.match(wrangler, /"\/ledger\/\*"/, "the ledger's sub-routes ride one run_worker_first glob");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["speculation:report"], "bun tools/speculation-report.ts");
});

// RFC 9218: the family dictionary is the one response whose client-side
// priority the server can honestly overrule. Chrome fetches it at VeryLow on
// idle; u=7 says "after everything" outright, on every HTTP/3 connection that
// carries it. It is the only Priority override on the site, and the sprite,
// scripts and styles are deliberately left to the client's signal.
test("the family dictionary is served at urgency 7, and nothing else is overridden", () => {
  const assets = readFileSync("src/worker/lib/assets.ts", "utf8");
  const overrides = assets.match(/headers\.set\("priority", "[^"]+"\)/g) || [];
  assert.deepEqual(overrides, ['headers.set("priority", "u=7")'], "exactly one Priority override, on the dictionary");
  const at = assets.indexOf('headers.set("priority", "u=7")');
  const guard = assets.lastIndexOf('if (ext === "dict")', at);
  assert.ok(guard !== -1 && at - guard < 200, "the override must be gated on the dictionary extension");
});
