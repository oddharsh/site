// ── the speculation ledger ────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  existsSync,
  readFile,
  readFileSync,
  readdir,
  test,
} from "./contract-shared.ts";

// ── the speculation ledger ────────────────────────────────────────────────────
// Both halves are best-effort counters wrapped around a live response, so the
// contract that matters most is the negative one: they must never throw, and
// they must never count something that isn't a speculation.

function speculationEnv() {
  const points = [];
  return { env: { SPECULATION: { writeDataPoint: (p) => points.push(p) } }, points };
}

test("the speculation denominator counts real speculations and nothing else", async () => {
  const { countSpeculativeLoad } = await import("../src/worker/speculation.ts");
  const ok = new Response("", { status: 200 });

  const cases = [
    ["prefetch", "prefetch", 1],
    ["prefetch;prerender", "prerender", 1],   // the stronger claim wins
    ["prerender", "prerender", 1],
    ["", null, 0],                            // a plain navigation is not a speculation
    ["fetch", null, 0],                       // Sec-Purpose exists but isn't speculative
  ];
  for (const [purpose, kind, expected] of cases) {
    const { env, points } = speculationEnv();
    // Record<string, string>, because the two arms otherwise infer as a union
    // whose second member has no "sec-purpose" and matches no HeadersInit.
    /** @type {Record<string, string>} */
    const headers = purpose ? { "sec-purpose": String(purpose) } : {};
    countSpeculativeLoad(env, new Request("https://aadhar.sh/garage", { headers }), ok, "/garage");
    assert.equal(points.length, expected, `sec-purpose: "${purpose}" should write ${expected}`);
    if (expected) {
      assert.equal(points[0].blobs[0], kind);
      assert.equal(points[0].blobs[1], "/garage");
      assert.deepEqual(points[0].indexes, [kind], "one index, so precision is a GROUP BY not a join");
    }
  }

  // a speculation that errored is not a speculation worth counting
  const { env, points } = speculationEnv();
  countSpeculativeLoad(env, new Request("https://aadhar.sh/nope", { headers: { "sec-purpose": "prefetch" } }),
    new Response("", { status: 404 }), "/nope");
  assert.equal(points.length, 0, "a 4xx speculation must not enter the denominator");

  // no binding, and a binding that throws, must both be survivable
  assert.doesNotThrow(() => countSpeculativeLoad({}, new Request("https://aadhar.sh/", {
    headers: { "sec-purpose": "prefetch" } }), ok, "/"));
  assert.doesNotThrow(() => countSpeculativeLoad(
    { SPECULATION: { writeDataPoint() { throw new Error("AE down"); } } },
    new Request("https://aadhar.sh/", { headers: { "sec-purpose": "prefetch" } }), ok, "/"));
});

test("the activation beacon answers 204 and records which page paid off", async () => {
  const { handlePrefetchActivation, prefetchActivationHeader } =
    await import("../src/worker/speculation.ts");

  // the header the browser is handed must round-trip a path through the query
  const value = prefetchActivationHeader("/garage/horizon");
  assert.equal(value, "/ledger/prefetch?p=%2Fgarage%2Fhorizon");
  assert.equal(new URL(value, "https://aadhar.sh").searchParams.get("p"), "/garage/horizon");

  // the browser sends HEAD; the response is an acknowledgement, never a document
  const { env, points } = speculationEnv();
  const res = handlePrefetchActivation(
    new Request("https://aadhar.sh" + value, { method: "HEAD" }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store", "a cached beacon counts once, forever");
  assert.equal(await res.text(), "", "204 means no body");
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[0], "activated");
  assert.equal(points[0].blobs[1], "/garage/horizon");

  // anything that isn't a read is refused, and says so properly
  const bad = handlePrefetchActivation(
    new Request("https://aadhar.sh/ledger/prefetch", { method: "POST" }), env);
  assert.equal(bad.status, 405);
  assert.equal(bad.headers.get("allow"), "GET, HEAD");

  // a beacon with no binding still answers; telemetry never gates the reply
  assert.equal(handlePrefetchActivation(
    new Request("https://aadhar.sh/ledger/prefetch", { method: "HEAD" }), {}).status, 204);
});

test("the activation header lands on navigable HTML only", async () => {
  const { withSecurityHeaders } = await import("../src/worker/lib/security.ts");
  const html = () => new Response("<p>hi", { headers: { "content-type": "text/html; charset=utf-8" } });
  const HDR = "on-prefetch-activation";

  assert.equal(withSecurityHeaders(html(), "/garage/horizon").headers.get(HDR),
    "/ledger/prefetch?p=%2Fgarage%2Fhorizon");

  // no pathname means no navigable document (the /lens self-fetch), so no beacon
  assert.equal(withSecurityHeaders(html()).headers.get(HDR), null);

  // a JSON endpoint is not something a browser navigates to and prerenders
  const json = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(withSecurityHeaders(json, "/ledger.json").headers.get(HDR), null);

  // redirects return untouched, so they can't carry it either
  const redirect = new Response(null, { status: 307, headers: { location: "/garage" } });
  assert.equal(withSecurityHeaders(redirect, "/garage/").headers.get(HDR), null);

  // gotcha 13: rebuilding a response must carry encodeBody, and adding this
  // header must not be the thing that quietly reintroduces double compression.
  const encoded = new Response("body", {
    headers: { "content-type": "text/html", "content-encoding": "br" },
  });
  assert.equal(withSecurityHeaders(encoded, "/").headers.get("content-encoding"), "br");
});

// Walk a `new Response(` call to its matching close paren, skipping strings,
// template literals and line comments, and return the rebuild sites: the ones
// whose FIRST argument is another response's `.body`. Those are the only calls
// that can inherit a content-encoding they did not set themselves.
export function responseRebuilds(src) {
  const out = [];
  const NEEDLE = "new Response(";
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
    const open = i + NEEDLE.length - 1;
    let depth = 0, quote = "", args = [], start = open + 1, j = open;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote && src[j - 1] !== "\\") quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); if (j === -1) break; continue; }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        depth--;
        if (depth === 0) { args.push(src.slice(start, j)); break; }
      } else if (c === "," && depth === 1) { args.push(src.slice(start, j)); start = j + 1; }
    }
    if (depth !== 0) continue;
    const body = (args[0] || "").trim();
    if (!body.endsWith(".body")) continue;
    const init = (args[1] || "").trim();

    // An identifier init is AMBIGUOUS and getting it wrong is the whole failure
    // this test exists to catch. `new Response(r.body, hit)` passes a RESPONSE,
    // which preserves encodeBody; `new Response(r.body, init)` passes a plain
    // object built earlier, which does not. Resolve it by looking for a
    // `const <ident> = {` declaration in the same file. A first draft of this
    // scanner skipped that step and reported both security.ts sites as safe by
    // the wrong reasoning, which is the shape of a check that only agrees with
    // itself.
    // `preserves` means the runtime keeps the flag on its own because the init is
    // another Response; `carries` means this call sets it explicitly.
    let preserves, carries;
    if (init === "") { preserves = false; carries = false; }
    else if (init.startsWith("{")) { preserves = false; carries = /\bencodeBody\b/.test(init); }
    else if (/^[A-Za-z_$][\w$]*$/.test(init)) {
      // Scope BOTH lookups to the nearest declaration before this call, never to
      // the whole file. security.ts has two rebuild sites that both name their
      // init `init`, so a file-wide search lets one site's carry vouch for the
      // other: deleting the flag from one of them left this test green, which is
      // precisely the regression it is here to catch.
      const decl = new RegExp(`(?:const|let|var)\\s+${init}\\s*=\\s*\\{`, "g");
      let declAt = -1, m;
      while ((m = decl.exec(src)) !== null && m.index < i) declAt = m.index;
      preserves = declAt === -1;
      carries = declAt !== -1
        && new RegExp(`\\b${init}\\.encodeBody\\b`).test(src.slice(declAt, i));
    } else { preserves = false; carries = /\bencodeBody\b/.test(init); }

    out.push({ line: src.slice(0, i).split("\n").length, body, preserves, carries });
  }
  return out;
}

test("every Response rebuilt from another response's body either preserves encodeBody or is recorded as not needing it", async () => {
  // gotcha 13, and the assertion above is why this one exists. That one builds a
  // response carrying `content-encoding: br`, runs it through withSecurityHeaders
  // and checks the header survived. The header survives whether or not the flag
  // was carried, and `node --test` runs undici, which does not implement
  // `encodeBody` at all, so nothing written there can observe the thing it claims
  // to cover. workerd exposes no getter either (measured 2026-08-18:
  // `{encodeBody_own: false, in_prototype: false, keys: []}`), so the only place
  // this invariant can be checked without booting a Worker is the SOURCE.
  //
  // What makes it worth checking: the loss depends on the SHAPE of the init.
  // Measured on workerd 1.20260811.1, `new Response(r.body, r)` preserves the
  // flag and `new Response(r.body, {status, headers})` drops it while leaving
  // `content-encoding` on the response, so the runtime encodes the body twice.
  // A client that decodes once, as the header instructs, gets compressed noise.
  // Upstream: https://github.com/cloudflare/workerd/issues/7066
  //
  // This is a TRIPWIRE rather than a proof. It cannot know whether a given path
  // carries a content-encoding, so it records the object-init sites that exist
  // today with the reason each is believed safe, and fails when that set moves.
  // A new object-init rebuild is then a decision somebody makes on purpose.
  const RECORDED = {
    "src/worker/lib/assets.ts": {
      count: 2,
      why: "rebuilds an env.ASSETS.fetch() response. MEASURED 2026-08-18: the binding "
         + "hands the Worker decoded bytes with content-encoding: null, so there is no "
         + "flag to lose. The three sites in this file that DO build encoded responses "
         + "from .br bytes set encodeBody themselves.",
    },
    "src/worker/photos.ts": {
      count: 2,
      why: "rebuilds an R2 object body. R2 sets content-encoding only when the upload "
         + "set httpMetadata.contentEncoding, and the photo pipeline never does. Note "
         + "this is an upload-time property rather than anything the code enforces.",
    },
    "src/worker/rn.ts": {
      count: 1,
      why: "rebuilds an image-transform response; the body is image bytes and the path "
         + "sets no content-encoding.",
    },
    "serendipity/serendipity.ts": {
      count: 4,
      why: "three rebuild locally-built HTML or add a cookie, and one is this file's own "
         + "withSecurityHeaders twin. None of them is a precompressed path today. NOT "
         + "measured the way the assets.ts entry was: if serendipity ever serves "
         + "precompressed bytes, that twin needs the same conditional carry security.ts has.",
    },
  };

  const files = [];
  for (const dir of ["src/worker", "cal/src", "serendipity"]) {
    for (const name of await readdir(new URL(`${dir}/`, ROOT), { recursive: true })) {
      if (/\.(ts|js)$/.test(name)) files.push(`${dir}/${name}`);
    }
  }

  let scanned = 0;
  const unrecorded = [];
  const seen = {};
  for (const file of files.sort()) {
    for (const hit of responseRebuilds(await readFile(new URL(file, ROOT), "utf8"))) {
      scanned++;
      if (hit.preserves || hit.carries) continue;
      seen[file] = (seen[file] || 0) + 1;
      if (!RECORDED[file]) unrecorded.push(`${file}:${hit.line} (${hit.body})`);
    }
  }

  // A scanner that matches nothing reports a pass, so pin the floor. 20 sites on
  // 2026-08-18; this only has to catch a collapse, not track the exact number.
  assert.ok(scanned >= 15,
    `the rebuild scanner found ${scanned} sites, so it has probably stopped matching`);

  assert.deepEqual(unrecorded, [],
    "a Response rebuilt from another response's body with an object init drops "
  + "encodeBody. Either pass the response itself as init (and mutate headers on the "
  + "result), set encodeBody when a content-encoding is present the way security.ts "
  + "does, or add an entry to RECORDED above saying why this path cannot carry one.");

  // A stale entry is the other direction: if a file stops having these sites, the
  // recorded reason outlives what it described and the next reader trusts it.
  for (const [file, { count }] of Object.entries(RECORDED)) {
    assert.equal(seen[file] || 0, count,
      `RECORDED says ${file} has ${count} object-init rebuild(s) and the scan found ${seen[file] || 0}. `
    + "Re-check the reason, then update the count.");
  }
});

test("the homepage's Link header carries the shell preloads, or it gets no Early Hints 103", async () => {
  // Cloudflare Early Hints harvests ONLY the rel=preload entries out of a Link
  // header. `/` had none between the serveStaticPage refactor and this test, so
  // it was the single page on the site answering without a 103 — verified
  // against production on 2026-07-30, where /whoareyou returned one carrying
  // luna.css + nav.js and `/` returned discovery links alone.
  //
  // Nothing failed when that broke. The route kept serving, the discovery links
  // kept working, and the preloads were still written down in a function no
  // route imported. This test is the part that was missing: an assertion that
  // ties the header to the route rather than to a helper that may drift out of
  // the call graph.
  const index = await readFile(new URL("src/worker/index.ts", ROOT), "utf8");
  const block = index.match(/const HOMEPAGE_HEADERS = \{[\s\S]*?\};/);
  assert.ok(block, "HOMEPAGE_HEADERS must still exist");
  assert.match(block[0], /SHELL_PRELOAD_LINK/,
    "the homepage Link header must include the shell preloads, or Early Hints has nothing to harvest");
  assert.match(block[0], /HOMEPAGE_DISCOVERY_LINK/,
    "the homepage Link header must still carry the discovery links");

  // Dead code is how this hid the first time: the behaviour stayed described in
  // lib/security.js while nothing called it, so reading that file suggested the
  // homepage was fine. One home for the header, and it is the route's.
  // Matched on the DEFINITIONS, not on mentions: the comment left behind in that
  // file explains what used to live there and why it went, which is worth
  // keeping. It is a second LIVE definition that must not come back.
  const security = await readFile(new URL("src/worker/lib/security.ts", ROOT), "utf8");
  assert.doesNotMatch(security, /^\s*(export )?function withHomepageDiscoveryHeaders/m,
    "lib/security.js should not keep a second, uncalled definition of the homepage Link header");
  assert.doesNotMatch(security, /^\s*(export )?const HOMEPAGE_LINK\s*=/m,
    "the homepage Link header should be composed at the route, not in a constant nothing imports");

  // `/` shipped `private, no-cache, must-revalidate` from its SSR era, which cost it
  // two things at once: no shared cache could hold it (so every front-door hit ran the
  // worker) and no browser would keep a dictionary offered under it (so it was the one
  // page outside the per-page dcz tier). It takes PAGE_CACHE_CONTROL now. Four surfaces
  // have to agree on that string or the fix is partial in a way nothing else reports.
  assert.match(block[0], /\.\.\.GENERATED_PAGE_HEADERS/,
    "the homepage must take the shared generated-page policy, not a hand-written one");
  assert.doesNotMatch(block[0], /no-cache|must-revalidate|private/,
    "no-cache/must-revalidate/private each veto dictionary registration; `/` cannot carry them");
  assert.match(index, /WORKERS_CACHEABLE_PATHS = new Set\("\/ /,
    "`/` must be in WORKERS_CACHEABLE_PATHS, or a cacheable homepage still invokes the worker every hit");

  // The HEAD path used to write its own headers, which is how it drifted: a
  // hand-maintained duplicate can only be checked by asserting it restates the
  // right constants, and that check passed while its markdown branch quietly
  // omitted x-markdown-tokens. The duplicate is gone, so assert it stays gone
  // rather than that a second copy still agrees. Same move as the
  // withHomepageDiscoveryHeaders assertions above.
  const home = await readFile(new URL("src/worker/home.ts", ROOT), "utf8");
  assert.doesNotMatch(home, /^\s*(export )?function homepageHeadResponse/m,
    "the homepage HEAD must not go back to a hand-written header set; it takes the GET's own path");
  assert.doesNotMatch(index, /method === "HEAD"\s*\)\s*return homepageHeadResponse/,
    "routeHomepage must not fork on HEAD again");

  // _headers is the static-asset fallback for the same URL, and check-dictionary-support
  // exists precisely because production policy for some pages comes from this file, which
  // canRegisterAsDictionary never sees.
  const { PAGE_CACHE_CONTROL } = await import("../src/worker/lib/const.ts");
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  const rootRule = headers.match(/^\/\n((?:  .*\n)+)/m);
  assert.ok(rootRule, "_headers must still carry a rule for /");
  assert.match(rootRule[1], new RegExp(`Cache-Control: ${PAGE_CACHE_CONTROL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
    "_headers `/` must state the same policy the worker route does");

  // The predicate itself is exercised where serveStaticPage is already under test, in
  // "static page negotiation prefers 304, then DCZ with the current validator".
});

// Every `_headers` rule for a page has to be written against the TWIN, because that is
// the asset serveStaticPage actually fetches: findBrotli reads `<base>.html.br` and
// copies ITS cache-control and link onto the page response. So a rule spelled as the
// request path (`/pixel-peeper`) matches nothing, and the page silently falls back to
// the Workers-assets default `public, max-age=0, must-revalidate`.
//
// That failed quietly in production for as long as /pixel-peeper had been a page. Two
// costs, and the second is the one nothing reports: no s-maxage means no shared cache
// entry, and must-revalidate VETOES dictionary registration (canRegisterAsDictionary in
// lib/assets.js), so the page drops out of the per-page dcz tier while still
// advertising `vary: available-dictionary`. /garage/* and /lwe/* were always fine
// because a glob covers the twin, the plain .html, and a section index's
// `<base>/index.html.br` alike, which is exactly why one hand-written exact rule could
// sit wrong next to them without ever looking wrong.
test("_headers page rules match the twin the worker fetches, not the request path", async () => {
  const { PAGE_CACHE_CONTROL } = await import("../src/worker/lib/const.ts");
  const { readdir } = await import("node:fs/promises");
  const raw = await readFile(new URL("public/_headers", ROOT), "utf8");

  // `_headers` blocks: a line starting with `/`, then its indented header lines.
  const rules = [...raw.matchAll(/^(\/\S*)\n((?:[ \t]+\S.*\n)+)/gm)].map(([, pattern, body]) => ({
    pattern,
    cacheControl: (body.match(/^[ \t]+Cache-Control:[ \t]*(.+?)\s*$/mi) || [])[1] || null,
    // Matching rules ACCUMULATE and duplicate headers are comma-joined with no
    // most-specific-wins, so `*` has to be modelled as a real glob, not a prefix test.
    matches: (path) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`).test(path),
  }));

  // The families whose pages take their policy from this file. Pages routed with
  // GENERATED_PAGE_HEADERS get theirs from the worker instead and are pinned above.
  const families = ["garage", "lwe", "pixel-peeper"];
  let checked = 0;
  for (const family of families) {
    for (const file of (await readdir(new URL(`src/pages/${family}`, ROOT))).sort()) {
      if (!file.endsWith(".html")) continue;
      const twin = `/${family}/${file}.br`;
      const hit = rules.filter((rule) => rule.matches(twin) && rule.cacheControl);
      assert.ok(hit.length > 0,
        `${twin}: no _headers rule matches the twin, so this page ships the Workers-assets default`);
      for (const rule of hit) {
        assert.equal(rule.cacheControl, PAGE_CACHE_CONTROL,
          `${rule.pattern} matches ${twin} but states a different policy than every other page`);
      }
      checked++;
    }
  }
  // A collapsed loop would pass vacuously, which is the failure mode this whole file
  // keeps re-learning (the markdown-twin contract test asserted nothing for a while).
  assert.ok(checked >= 30, `expected to check 30+ page twins, checked ${checked}`);

  // The other half of the same edit: a page rule must not widen into a sibling that
  // sets its own policy, because the comma-join would prepend max-age=0 to it.
  const tile = "/pixel-peeper/tiles/05c532a8be2a.jpg";
  const tileRules = rules.filter((rule) => rule.matches(tile) && rule.cacheControl);
  assert.deepEqual(tileRules.map((rule) => rule.cacheControl), ["public, max-age=31536000, immutable"],
    "exactly one rule may set Cache-Control on a pixel-peeper tile, or its immutable year gets clamped");
});

test("the offscreen Horizon iframe does not start ticking during initial load", async () => {
  const horizon = await readFile(new URL("src/pages/garage/horizon.html", ROOT), "utf8");
  const iframe = horizon.match(/<iframe\s+[^>]*id="mb-frame"[^>]*>/)?.[0];
  assert.ok(iframe, "the state-preserving move demo must keep its uptime iframe");
  assert.match(iframe, /\sloading="lazy"(?:\s|>)/,
    "the deep-page iframe runs a perpetual timer and must wait until it nears the viewport");
});

test("the CSP falls back to 'unsafe-inline' only where the build cannot speak", async () => {
  const { canonicalPath, scriptHashesFor } = await import("../src/worker/lib/csp-hashes.ts");

  // canonicalPath folds the spellings a request can arrive in onto the one the
  // build emits. If these two ever disagree the map misses SILENTLY and the page
  // just stays loose, so pin the folding rather than trusting it.
  assert.equal(canonicalPath("/"), "/");
  assert.equal(canonicalPath("/index.html"), "/");
  assert.equal(canonicalPath("/garage/"), "/garage");
  assert.equal(canonicalPath("/garage/index.html"), "/garage");
  assert.equal(canonicalPath("/garage/scroll.html"), "/garage/scroll");
  assert.equal(canonicalPath("/writing/colophon"), "/writing/colophon");

  // The committed map is empty on purpose (readable dev serves unminified bytes
  // whose hashes differ), so every lookup here misses and takes the loose policy.
  assert.equal(scriptHashesFor("/garage/scroll"), null);
  // and a response with no pathname must never inherit the homepage's entry
  assert.equal(scriptHashesFor(undefined), null);
  assert.equal(scriptHashesFor(""), null);
});

test("the hashed policy REPLACES the asset layer's generic stamp, and never a bespoke one", async () => {
  const { withSecurityHeaders, SECURITY_HEADERS } = await import("../src/worker/lib/security.ts");
  const mod = await import("../src/worker/lib/csp-hashes.ts");
  const LOOSE = SECURITY_HEADERS["content-security-policy"];

  // Every staged document reaches withSecurityHeaders from the ASSETS binding with
  // `_headers`' copy of this exact string already on it. A `.has()` bail reads that
  // as a route having chosen a policy and skips the hashed one, which is how the
  // enforcing half sat inert through the whole report-only era while the twin (a
  // DIFFERENT header name) looked perfect. Absence of a regression here is silent:
  // the loose policy still ships and every page still works.
  const original = { ...mod.PAGE_SCRIPT_HASHES };
  try {
    mod.PAGE_SCRIPT_HASHES["/probe"] = ["AAAA"];

    const stamped = new Response("<!doctype html>", {
      headers: { "content-type": "text/html", "content-security-policy": LOOSE },
    });
    const out = await withSecurityHeaders(stamped, "/probe");
    assert.match(out.headers.get("content-security-policy"), /'sha256-AAAA'/,
      "the generic _headers stamp must not shadow the per-document hashes");
    assert.ok(!/script-src 'self' 'unsafe-inline'/.test(out.headers.get("content-security-policy")),
      "'unsafe-inline' must be gone from script-src once a document is hashed");

    // The bail still has a job: lens.js composes its own policy for the framed
    // view, and that one is an OPINION rather than a default.
    const bespoke = "default-src 'none'; frame-src https://example.com";
    const framed = new Response("<!doctype html>", {
      headers: { "content-type": "text/html", "content-security-policy": bespoke },
    });
    const kept = await withSecurityHeaders(framed, "/probe");
    assert.equal(kept.headers.get("content-security-policy"), bespoke,
      "a route that set its own policy keeps it");
  } finally {
    for (const k of Object.keys(mod.PAGE_SCRIPT_HASHES)) delete mod.PAGE_SCRIPT_HASHES[k];
    Object.assign(mod.PAGE_SCRIPT_HASHES, original);
  }
});

test("the hashed policy is well-formed and keeps 'self' for the external scripts", async () => {
  const { cspHeadersFor } = await import("../src/worker/lib/security.ts");
  const csp = cspHeadersFor("/anything-unmapped")["content-security-policy"];

  // the fallback is exactly today's policy, so an unmapped page is never a regression
  assert.match(csp, /script-src 'self' 'unsafe-inline';/);
  assert.match(csp, /default-src 'self';/);
  assert.match(csp, /object-src 'none';/);
  // EXACTLY ONE header, always. The rollout flag that made this a pair went on
  // 2026-08-23; before it did, the hashed policy could ship under a second header
  // name while the enforcing one stayed loose, and this asserts that shape cannot
  // come back by accident. Count the keys rather than probing one name, since a
  // twin under any other spelling is the same regression.
  assert.deepEqual(Object.keys(cspHeadersFor("/anything-unmapped")), ["content-security-policy"]);

  // Rebuild the hashed arm against a stub map, so this asserts the SHAPE the
  // build's output will take rather than waiting on a staged tree.
  const mod = await import("../src/worker/lib/csp-hashes.ts");
  const original = { ...mod.PAGE_SCRIPT_HASHES };
  try {
    mod.PAGE_SCRIPT_HASHES["/probe"] = ["AAAA", "BBBB"];
    const pair = cspHeadersFor("/probe");
    assert.deepEqual(Object.keys(pair), ["content-security-policy"]);
    const hashed = pair["content-security-policy"];
    assert.match(hashed, /script-src 'self' 'sha256-AAAA' 'sha256-BBBB';/);
    // 'strict-dynamic' would make 'self' inert for scripts and break /a/nav.js,
    // /tooltip.js, /hoist.js and the homepage's dynamic import()s.
    assert.ok(!hashed.includes("strict-dynamic"));
    // 'unsafe-hashes' would re-permit event-handler attributes, which is the
    // thing the two refactors in this change exist to avoid.
    assert.ok(!hashed.includes("unsafe-hashes"));
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(hashed));

    // a document with no inline script at all earns the strictest form
    mod.PAGE_SCRIPT_HASHES["/empty"] = [];
    const bareCsp = cspHeadersFor("/empty")["content-security-policy"];
    assert.match(bareCsp, /script-src 'self';/);

    // upgrade-insecure-requests must be PRESENT. It used to be the directive the
    // report-only twin had to drop, because a browser ignores it in a reporting
    // policy and files a security issue per page load (DevTools 2026-08-07). With
    // one policy left, the assertion inverts: the only way to get this wrong now
    // is to lose it, and asserting the omission is what would pass just as
    // happily if the directive fell out of everything.
    assert.match(hashed, /upgrade-insecure-requests/);
    assert.match(bareCsp, /upgrade-insecure-requests/);

    // The hashed and loose policies are ONE policy differing only in script-src.
    // That was previously checked between the enforcing header and its twin; the
    // twin is gone, so it is checked between the two arms that remain.
    assert.equal(
      hashed.replace(/script-src [^;]*;/, ""),
      cspHeadersFor("/anything-unmapped")["content-security-policy"].replace(/script-src [^;]*;/, ""),
      "the hashed and loose policies must differ in script-src alone",
    );
  } finally {
    for (const k of Object.keys(mod.PAGE_SCRIPT_HASHES)) delete mod.PAGE_SCRIPT_HASHES[k];
    Object.assign(mod.PAGE_SCRIPT_HASHES, original);
  }
});

test("every inline script in the STAGED tree is covered by the emitted hash map", async () => {
  // The build derives the map from the staged bytes; this re-derives it with a
  // deliberately different parser and compares. Same-code-twice would prove
  // nothing, and the failure this guards against (a blocked script leaves the
  // page rendering and merely dead) is invisible without it.
  if (!existsSync("./.build/public/_worker.js/lib/csp-hashes.js")) return; // no staged tree; `bun run build` first
  const { createHash } = await import("node:crypto");
  const { readdir } = await import("node:fs/promises");

  const emitted = readFileSync("./.build/public/_worker.js/lib/csp-hashes.js", "utf8")
    .match(/^export const PAGE_SCRIPT_HASHES = (.*); \/\/ build:csp-hashes$/m);
  assert.ok(emitted, "the build did not rewrite the build:csp-hashes marker");
  const map = JSON.parse(emitted[1]);

  const pages = (await readdir("./.build/public", { recursive: true }))
    .filter((p) => p.endsWith(".html") && !p.endsWith(".src.html"));
  assert.ok(pages.length >= 40, `expected the full staged document set, saw ${pages.length}`);

  const EXECUTABLE = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module|speculationrules)$/;

  // This scanner has to WALK tags, not string-search for "<script". /garage/horizon
  // holds two scripts inside other tags' attribute values:
  //
  //   <input value="&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;bad()&lt;/script&gt;">
  //   <iframe srcdoc="...&lt;script&gt;let n=0;setInterval(...)&lt;/script&gt;...">
  //
  // Both are entity-escaped in the source. HTML5 lets a QUOTED attribute value carry
  // raw < and >, so minify-html decodes them (no option turns that off, and the DOM
  // value is identical either way), and from 2026-07-31 every page goes through the
  // minifier. A searcher then finds `<script>bad()</script>` in the middle of an
  // attribute and demands a CSP hash for something no browser will ever execute as
  // part of this document.
  //
  // Independence from build.mjs's collector is the point of this test, so this is a
  // separate implementation. Being different is not the goal though, and the earlier
  // regex here was different by being wrong. A correct walk is the only correct
  // answer: consume each tag whole so attribute text is never read as content, and
  // treat <script> as a script only when it opens in content position.
  const inlineScripts = function* (source) {
    const low = source.toLowerCase();
    let i = 0;
    while (i < source.length) {
      const lt = source.indexOf("<", i);
      if (lt === -1) return;
      if (low.startsWith("<!--", lt)) {
        const end = source.indexOf("-->", lt + 4);
        if (end === -1) return;
        i = end + 3;
        continue;
      }
      // find this tag's `>`, stepping over quoted attribute values
      let j = lt + 1, quote = "";
      while (j < source.length) {
        const ch = source[j];
        if (quote) { if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        j++;
      }
      if (j >= source.length) return;
      const name = (low.slice(lt + 1, j).match(/^\/?\s*([a-z][^\s/>]*)/) || [])[1];
      if (name === "script") {
        const close = low.indexOf("</script", j + 1);
        if (close === -1) return;
        yield { attrs: source.slice(lt + 7, j), body: source.slice(j + 1, close) };
        i = close + 8;
        continue;
      }
      i = j + 1;   // consumed the whole tag, attributes included
    }
  };

  let checked = 0;
  for (const page of pages) {
    const html = readFileSync(`./.build/public/${page}`, "utf8");
    const key = "/" + page.replace(/\.html$/, "").replace(/(^|\/)index$/, "") || "/";
    const path = key.length > 1 && key.endsWith("/") ? key.slice(0, -1) : key;
    assert.ok(map[path], `${page}: no entry at ${path} — it would silently fall back to 'unsafe-inline'`);

    for (const m of inlineScripts(html)) {
      const attrs = m.attrs;
      if (/\ssrc\s*=/i.test(attrs)) continue;
      // minify-html UNQUOTES attribute values wherever it legally can, so the
      // staged homepage carries `type=application/ld+json` bare. A quoted-only
      // match reads that as type="" and calls a JSON-LD data block executable,
      // then fails demanding a hash for something no browser ever runs. Same
      // don't-trust-the-quoting trap the inline favicon data-URIs hit.
      const t = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
      const type = (t ? (t[1] ?? t[2] ?? t[3] ?? "") : "").toLowerCase();
      if (!EXECUTABLE.test(type)) continue;
      const digest = createHash("sha256").update(m.body, "utf8").digest("base64");
      assert.ok(map[path].includes(digest),
        `${page}: an inline <script${type ? ` type="${type}"` : ""}> is not in the hash map — it would be BLOCKED once the flag flips`);
      checked++;
    }
  }
  // guard against the assertion loop quietly matching nothing, the failure mode
  // the md-twin quiz test shipped with and reported as a pass for weeks
  assert.ok(checked >= 60, `only ${checked} inline blocks verified; the extractor probably stopped matching`);
});

test("Workers Cache never answers a content-negotiated request from the stored representation", async () => {
  // The regression this exists for, live in production on 2026-07-31: `/` joined
  // WORKERS_CACHEABLE_PATHS and `Accept: text/markdown` on the homepage started
  // returning HTML. Nothing in the route was wrong. Workers Cache keys the URL, the
  // stored HTML carries `vary: accept-encoding, available-dictionary` and says
  // nothing about `accept`, so a cache HIT answered a request asking for a different
  // media type at the same URL.
  //
  // It shipped through a green CI because the predicate was a private function in
  // _worker.js/index.js, and that module imports `cloudflare:workers`, so no test
  // under plain node could reach it (gotcha 16). Moving it to lib/cache.js is what
  // makes this test possible, and the test is the point of the move.
  const { shouldUseWorkersCache } = await import("../src/worker/lib/cache.ts");
  const PATHS = new Set(["/", "/bot", "/lens", "/reading"]);
  const req = (url, headers = {}) => new Request(url, { headers });

  // the whole reason `/` is in the set: a plain navigation should still be cacheable
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
  }), PATHS), true, "an ordinary browser navigation must still reach Workers Cache");

  // ...and the bug: markdown at the same URL must bypass it
  // The last entry is the TIE, added 2026-08-27 with the wantsMarkdown fix: both
  // types at q=1, decided by order. It used to resolve to HTML, so it never
  // bailed, and a cached HTML copy would now answer an agent asking for Markdown.
  for (const accept of ["text/markdown", "text/markdown, text/html;q=0.5", "text/markdown;q=1.0, text/html;q=0.9",
                        "text/markdown, text/html, */*"]) {
    for (const path of ["/", "/bot", "/lens", "/reading"]) {
      assert.equal(shouldUseWorkersCache(req(`https://aadhar.sh${path}`, { accept }), PATHS), false,
        `${path} with "${accept}" must bypass Workers Cache or the stored HTML answers it`);
    }
  }

  // A lower-ranked markdown offer is NOT a negotiated request: wantsMarkdown does
  // real q-value comparison, so html-outranks-markdown stays cacheable. Pinning it
  // keeps a future over-broad "has an accept header" bail from silently disabling
  // the cache for every browser on the site.
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", {
    accept: "text/html, text/markdown;q=0.1",
  }), PATHS), true, "html outranking markdown is an ordinary request and must stay cacheable");

  // the bails that were already there, so a rewrite cannot quietly drop one
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/?cb=1"), PATHS), false, "query strings bypass");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", { "if-none-match": 'W/"x"' }), PATHS), false, "revalidation bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", { range: "bytes=0-9" }), PATHS), false, "range bypasses");
  assert.equal(shouldUseWorkersCache(new Request("https://aadhar.sh/", { method: "POST" }), PATHS), false, "POST bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/nope"), PATHS), false, "an unlisted path bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/writing/colophon"), PATHS), true, "the /writing/ prefix is cacheable");
});

// The same class of bug on the other axis the key cannot see. A hit answers
// before the dispatcher, so every host-based decision in there is skipped:
// cal.aadhar.sh's 404 and a preview's noindex both live past this point.
//
// Reproduced on production 2026-08-08 rather than reasoned about. GET
// https://aadhar.sh/reading twice (MISS, then HIT at age 1), then
// https://cal.aadhar.sh/reading: 200, HIT, age 1, the same 91,980-byte page, on a
// host whose origin answers 404 for that path. /photos and /writing reported
// byte-identical `age` on both hostnames in the same second, so it is one object
// rather than two copies, and `?cb=` on any of them returned the real 404 through
// the query-string bail.
test("only the canonical hostname may be served from Workers Cache", async () => {
  const { shouldUseWorkersCache } = await import("../src/worker/lib/cache.ts");
  const { isCanonicalHost } = await import("../src/worker/lib/const.ts");
  const PATHS = new Set(["/", "/photos", "/reading", "/writing"]);
  const req = (url) => new Request(url, { headers: { accept: "text/html" } });

  for (const path of ["/", "/photos", "/reading", "/writing/colophon"]) {
    assert.equal(shouldUseWorkersCache(req(`https://aadhar.sh${path}`), PATHS), true, `aadhar.sh${path} is the site and stays cacheable`);
    for (const host of ["cal.aadhar.sh", "aadhar-sh.workers.dev", "a1b2c3-aadhar-sh.workers.dev", "aadhar-sh.pages.dev"]) {
      assert.equal(
        shouldUseWorkersCache(req(`https://${host}${path}`), PATHS), false,
        `${host}${path} must reach the dispatcher — a hit here publishes the canonical page on a second hostname`,
      );
    }
  }

  // Exact match. A near-miss treated as canonical is precisely how a duplicate
  // hostname gets published, and a subdomain suffix test would admit all of them.
  assert.equal(isCanonicalHost("aadhar.sh"), true);
  assert.equal(isCanonicalHost("AADHAR.SH"), true, "the Host header's case is not significant");
  for (const host of ["www.aadhar.sh", "cal.aadhar.sh", "aadhar.sh.evil.example", "notaadhar.sh", "", null, undefined]) {
    assert.equal(isCanonicalHost(host), false, `${host} is not the canonical host`);
  }
});
