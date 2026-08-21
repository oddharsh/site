// ── docs/DEPENDENCIES.md states version pins in prose ─────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  BASELINE_HEADING,
  FLOOR_CLAIMS,
  PAGE_FAMILY_MATCH,
  ROOT,
  assert,
  auditDependencyDocs,
  baselineSection,
  checkDependencyDocs,
  collectBlockClasses,
  findClaims,
  parseCargoDeps,
  readDocument,
  readFile,
  readdir,
  serveMarkdown,
  serveStaticPage,
  test,
} from "./contract-shared.mjs";

// ── docs/DEPENDENCIES.md states version pins in prose ─────────────────────────
// and dependabot rewrites those pins daily, so the file goes stale on a cadence
// rather than by accident: twice in two days before this landed. These assert
// the doc against the manifests, and then assert the CHECK itself has teeth,
// because a version of this that only ever agreed with the current tree would
// be the third check in this repo to pass while asserting nothing.

test("docs/DEPENDENCIES.md agrees with the manifests", async () => {
  const { claims, problems } = await checkDependencyDocs();
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(
    claims.length >= FLOOR_CLAIMS,
    `only ${claims.length} version claims matched, floor is ${FLOOR_CLAIMS}`,
  );
});

test("the dependency-doc check catches every drift it exists for", () => {
  const pins = { wrangler: "4.120.1" };
  // one rule at a time: just the alias under test, no exemptions to go stale,
  // no floor to trip. The real policy is the default and these override it.
  const quiet = { aliases: [{ prose: "Wrangler", pkg: "wrangler" }], versionless: new Map(), floor: 0 };
  const ok = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`, pins, ...quiet });
  assert.deepEqual(ok.problems, [], "a matching doc must pass");

  // 1. the exact bug that motivated this: a bumped pin, an unbumped sentence
  const stale = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.0 is the pin.`, pins, ...quiet });
  assert.equal(stale.problems.length, 1);
  assert.match(stale.problems[0], /states "Wrangler 4\.120\.0" but package\.json pins wrangler at 4\.120\.1/);

  // 2. a new dependency that nobody documented
  const undocumented = auditDependencyDocs({
    doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`,
    pins: { ...pins, "left-pad": "1.0.0" },
    ...quiet,
  });
  assert.equal(undocumented.problems.length, 1);
  assert.match(undocumented.problems[0], /left-pad is a root dependency/);

  // 3. a claim surviving the package's removal. The message tells you to stop
  // restating the number, because a stale version inside its own correction is
  // still a greppable stale version.
  const removed = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`, pins: {}, ...quiet });
  assert.ok(removed.problems.some((p) => /wrangler is declared in DOC_ALIASES but package\.json no longer pins it/.test(p)),
    removed.problems.join("\n"));

  // 4. the floor: a doc with no claims at all must fail rather than pass empty
  const empty = auditDependencyDocs({ doc: `${BASELINE_HEADING}\nno versions here`, pins: {} });
  assert.ok(empty.problems.some((p) => /below the floor/.test(p)));

  // 5. Pillow lives in requirements.txt, not package.json
  const pillow = auditDependencyDocs({
    doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.\n- Pillow 12.3.0 is pinned.`,
    pins,
    requirements: "Pillow==12.4.0\n",
    ...quiet,
  });
  assert.ok(pillow.problems.some((p) => /Pillow 12\.3\.0.*pins 12\.4\.0/.test(p)));
});

test("the collapsed check keeps the two rules that came from #382", () => {
  const H = BASELINE_HEADING;
  const quiet = { aliases: [{ prose: "Wrangler", pkg: "wrangler" }], versionless: new Map(), floor: 0 };

  // (a) RANGE PINS. Stripping the caret and comparing would let ^1.2.3 agree
  // with a doc claiming 1.2.3, which is a range the prose cannot honestly
  // state. It must be moved to VERSIONLESS instead, and say so.
  const ranged = auditDependencyDocs({
    doc: `${H}\n- Wrangler 4.120.1 is the pin.`,
    pins: { wrangler: "^4.120.1" },
    ...quiet,
  });
  assert.ok(ranged.problems.some((p) => /range-pinned \(\^4\.120\.1\).*Move it to VERSIONLESS/s.test(p)),
    ranged.problems.join("\n"));

  // (b) A DECLARED PACKAGE LOSING ITS SENTENCE. Deleting the line must not
  // silently drop it from the check, which is what a forward-only scan does.
  const dropped = auditDependencyDocs({
    doc: `${H}\n- nothing about wrangler here.`,
    pins: { wrangler: "4.120.1" },
    ...quiet,
  });
  assert.ok(dropped.problems.some((p) => /no longer states a version for Wrangler/.test(p)),
    dropped.problems.join("\n"));

  // (c) BASELINE SCOPING. A claim in the intro prose is not the baseline making
  // it, so the scan must not see it, and a renamed heading must fail loudly
  // rather than slice to one character and report a clean pass.
  assert.equal(baselineSection("no heading here"), null);
  const outside = auditDependencyDocs({
    doc: `Wrangler 9.9.9 in the intro.\n${H}\n- Wrangler 4.120.1 is the pin.`,
    pins: { wrangler: "4.120.1" },
    ...quiet,
  });
  assert.deepEqual(outside.problems, [], "a version in the intro must not be read as a baseline claim");

  const renamed = auditDependencyDocs({ doc: "## Something Else\n- Wrangler 4.120.1", pins: {}, ...quiet });
  assert.ok(renamed.problems.some((p) => /has no "## Current baseline" section/.test(p)));
});

test("the dependency-doc check reaches the four manifests outside the root", () => {
  const H = BASELINE_HEADING;
  // Root kept quiet so each assertion is about the sub-manifest under test.
  const quiet = { aliases: [], versionless: new Map(), floor: 0, pins: {} };
  const sub = (over = {}) => [{
    manifest: "lens-reader/package.json",
    aliases: [{ prose: "linkedom", pkg: "linkedom" }],
    versionless: new Map(),
    pins: { linkedom: "0.18.13" },
    ...over,
  }];

  const ok = auditDependencyDocs({ doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`, ...quiet, subManifests: sub() });
  assert.deepEqual(ok.problems, [], "a matching sub-manifest claim must pass");

  // 1. THE BACKTICK. This doc writes package names as `code`, so a pattern that
  //    only matched a bare name would silently match nothing for every entry in
  //    the file's own house style, and the floor is the only thing that would
  //    have noticed.
  const bare = auditDependencyDocs({ doc: `${H}\n- linkedom 0.18.13 supplies a DOM.`, ...quiet, subManifests: sub() });
  assert.deepEqual(bare.problems, [], "an unbackticked name must still match");

  // 2. a bumped sub-manifest pin against an unbumped sentence
  const stale = auditDependencyDocs({ doc: `${H}\n- \`linkedom\` 0.18.12 supplies a DOM.`, ...quiet, subManifests: sub() });
  assert.ok(stale.problems.some((p) => /states "linkedom 0\.18\.12" but lens-reader\/package\.json pins linkedom at 0\.18\.13/.test(p)),
    stale.problems.join("\n"));

  // 3. a NEW sub-manifest dependency nobody documented. This is the direction
  //    that found serde_json, which arrived with #373 and was unmentioned.
  const undocumented = auditDependencyDocs({
    doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`,
    ...quiet,
    subManifests: sub({ pins: { linkedom: "0.18.13", "left-pad": "1.0.0" } }),
  });
  assert.ok(undocumented.problems.some((p) => /left-pad is a lens-reader\/package\.json dependency/.test(p)),
    undocumented.problems.join("\n"));

  // 4. a RANGE in a sub-manifest alias table. Cargo's bare "0.25" is a caret
  //    range, so it has to fail here exactly as a ^ would.
  const ranged = auditDependencyDocs({
    doc: `${H}\n- \`image\` 0.25 decodes input.`,
    ...quiet,
    subManifests: sub({ manifest: "tools/photos/zenc/Cargo.toml", aliases: [{ prose: "image", pkg: "image" }], pins: { image: "0.25" } }),
  });
  assert.ok(ranged.problems.some((p) => /image is range-pinned \(0\.25\)/.test(p)), ranged.problems.join("\n"));

  // 5. a manifest that cannot be read must be REPORTED, never audited as {}.
  //    An empty pin set scans clean and asserts nothing, which is how a moved
  //    file would read as a healthy project forever.
  const missing = auditDependencyDocs({
    doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`,
    ...quiet,
    subManifests: sub({ missing: true, pins: {} }),
  });
  assert.ok(missing.problems.some((p) => /lens-reader\/package\.json is declared in SUB_MANIFEST_POLICY but could not be read/.test(p)),
    missing.problems.join("\n"));

  // 6. a stale exemption in a sub-manifest, same rule the root has.
  const staleExempt = auditDependencyDocs({
    doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`,
    ...quiet,
    subManifests: sub({ versionless: new Map([["gone-pkg", "reason"]]) }),
  });
  assert.ok(staleExempt.problems.some((p) => /gone-pkg is exempted .* but is no longer a lens-reader\/package\.json dependency/.test(p)),
    staleExempt.problems.join("\n"));
});

test("the Cargo reader takes both dependency shapes and ignores the rest", () => {
  const toml = [
    "[package]", 'name = "zenc"', 'version = "0.1.0"',
    "", "[dependencies]",
    "# a comment",
    'zenjpeg = { version = "0.8.4", features = ["parallel"] }',
    'image = "0.25"',
    'serde_json = { version = "1.0", features = ["preserve_order"] }',
    "", "[profile.release]", "opt-level = 3",
  ].join("\n");
  const deps = parseCargoDeps(toml);
  assert.deepEqual(deps, { zenjpeg: "0.8.4", image: "0.25", serde_json: "1.0" });
  // [package] and [profile.release] must not leak in: `version = "0.1.0"` sits
  // in [package] and would otherwise read as a dependency called "version".
  assert.ok(!("version" in deps) && !("name" in deps) && !("opt-level" in deps),
    "only the [dependencies] table may be read");
  assert.deepEqual(parseCargoDeps("[package]\nname = \"x\"\n"), {}, "no [dependencies] table is an empty set");

  // The [dependencies] table LAST, with no section after it. The first draft
  // anchored on `\Z`, which JavaScript does not have, so this case returned {}
  // and scanned clean. oxlint found it; this pins it.
  assert.deepEqual(
    parseCargoDeps('[package]\nname = "zenc"\n\n[dependencies]\nzenjpeg = "0.8.4"\n'),
    { zenjpeg: "0.8.4" },
    "a [dependencies] table with nothing after it must still be read",
  );
});

test("the dependency-doc scanner does not read prose as a version claim", () => {
  // Every one of these appears in the real file and breaks a naive
  // /(\w+) (\d[\d.]*)/ sweep. A two-component number is prose about a major
  // line; the others are not packages at all.
  const prose = [
    "TypeScript 7.0 ships no stable programmatic API",
    "the CSS Overflow 5 selectors /garage/horizon ships deliberately",
    "Vite 8 keeps 0.28.2 as an OPTIONAL peer",
    "Wrangler hard-depends on 0.28.1 for Cloudflare's Worker bundler",
  ].join("\n");
  assert.deepEqual(findClaims(prose), [], "prose must yield no version claims");

  // and the real thing still matches, so the guard above is not just strictness
  assert.equal(findClaims("- TypeScript 7.0.2 and @cloudflare/workers-types are pins").length, 1);
});

test("a flex item is its own box, and promoting one never eats an image", () => {
  const page = (style, body) =>
    `<html><head><title>T</title><style>${style}</style></head><body><main>${body}</main></body></html>`;

  // the /updates shape: the item declares `flex`, never `display`
  const welded = readDocument(
    page(".tag{flex:0 0 92px}", "<p><span class=tag>hit-route</span><span>counter tick endpoint renamed</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.doesNotMatch(welded.body, /hit-routecounter/, "a flex item must not weld onto the text after it");
  assert.match(welded.body, /hit-route/);
  assert.match(welded.body, /counter tick endpoint renamed/);

  // the /lwe/encoding regression: an <img> carrying a flex-item class renders as
  // a token already, and the block path has no case for it, so promoting it drops
  // the image entirely.
  const withImage = readDocument(
    page(".pic{flex:0 0 auto}", '<p>before<img src="/enc/c.jpg" alt="sample photo" class="pic">after</p>'),
    { origin: "https://aadhar.sh" });
  assert.match(withImage.body, /!\[sample photo\]\(https:\/\/aadhar\.sh\/enc\/c\.jpg\)/,
    "an image must survive its class being promoted out of the inline flow");

  // container properties say nothing about THIS element and must not promote it
  const container = readDocument(
    page(".row{flex-direction:row;flex-flow:wrap}", "<p><span class=row>alpha</span><span>beta</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.match(container.body, /alphabeta|alpha beta/, "flex-direction/flex-flow describe children, not this box");

  // and the original heuristic still holds
  assert.ok(collectBlockClasses("<style>.x{display:block}.y{float:right}.z{flex:1}</style>").size >= 3);
});

// RFC 9110 asks a HEAD to send the header fields its GET would send. serveStaticPage
// bailed on the method before reaching the Markdown branch, so HEAD answered
// text/html on pages whose GET answers text/markdown. Verified on production
// 2026-07-31 (GET /garage/encoding -> text/markdown, HEAD -> text/html), which is
// also a convincing false positive for the #195 cache bug because `curl -I` is the
// reflex probe.
// The homepage was the last route answering HEAD from a hand-written header set,
// and the one header it dropped was x-markdown-tokens. It hid because `/` is
// workers-cacheable: a plain HEAD is satisfied from the stored GET entry and never
// runs the duplicate, so the only path that DID run it was the markdown one, which
// bails the cache. The unwatched path is the one that drifted.
test("the homepage HEAD carries the token count its GET sends", async () => {
  const env = {
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/index.md") return new Response("# aadhar.sh\n\nsome prose about the site");
        return new Response("<h1>aadhar.sh</h1>", { headers: { "content-type": "text/html" } });
      },
    },
  };
  const md = { accept: "text/markdown" };
  const get = await serveMarkdown(new Request("https://aadhar.sh/", { headers: md }), env);
  const head = await serveMarkdown(new Request("https://aadhar.sh/", { method: "HEAD", headers: md }), env);

  assert.equal(head.headers.get("x-markdown-tokens"), get.headers.get("x-markdown-tokens"));
  assert.ok(Number(head.headers.get("x-markdown-tokens")) > 0, "a token count of zero is not a count");
  assert.equal(await head.text(), "", "a HEAD carries no body");
  for (const name of ["content-type", "cache-control", "vary", "link", "x-content-type-options"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), `HEAD and GET must agree on ${name}`);
  }
  // the homepage's own discovery links are the one thing this route adds over the
  // shared negotiated response, so losing them in the delegation would be silent
  assert.match(get.headers.get("link") || "", /rel="sitemap"/);
  // and the negotiated representation must stay uncacheable, per the edge's per-URL key
  assert.match(get.headers.get("cache-control"), /no-store/);
});

test("HEAD advertises the same representation its GET would serve", async () => {
  const env = {
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/garage/encoding.md") return new Response("# Encoding\n\nbody text here");
        if (path === "/garage/encoding") return new Response("<h1>Encoding</h1>", { headers: { "content-type": "text/html" } });
        return new Response("not found", { status: 404 });
      },
    },
  };
  const md = { accept: "text/markdown" };
  const get = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { headers: md }), env);
  const head = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { method: "HEAD", headers: md }), env);

  assert.equal(get.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(head.headers.get("content-type"), "text/markdown; charset=utf-8",
    "HEAD must not advertise HTML for a URL whose GET negotiates Markdown");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "", "a HEAD carries no body");

  // The whole header set, not just the content-type: a HEAD that agreed on the media
  // type but disagreed on freshness would be the same class of lie.
  for (const name of ["cache-control", "vary", "x-markdown-tokens", "x-content-type-options"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), `HEAD and GET must agree on ${name}`);
  }
  assert.equal(head.headers.get("x-markdown-tokens"), get.headers.get("x-markdown-tokens"));

  // A HEAD that is NOT negotiating still takes the asset layer, exactly as before.
  const plain = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { method: "HEAD" }), env);
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get("content-type"), /text\/html/);
});

test("static page negotiation prefers 304, then DCZ with the current validator", async () => {
  const digest = Buffer.alloc(32, 1);
  const tag = digest.toString("hex").slice(0, 16);
  const available = `:${digest.toString("base64")}:`;
  const makeEnv = (cacheControl) => ({
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/lwe/drivers.html.br") {
          return new Response("brotli bytes", {
            headers: {
              "etag": '"page"',
              "cache-control": cacheControl,
              "link": "</shell.css>; rel=preload; as=style",
            },
          });
        }
        if (path === `/pd/lwe__drivers.${tag}.dcz`) {
          return new Response("delta bytes", { headers: { "cache-control": "public, max-age=0" } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  });
  const env = makeEnv("public, max-age=0, s-maxage=86400");
  const currentBr = 'W/"page-br"';
  const currentDcz = 'W/"page-dcz"';
  const unchanged = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": currentBr, "available-dictionary": available },
  }), env);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), currentBr);

  const changed = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": '"old"', "available-dictionary": available },
  }), env);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("content-encoding"), "dcz");
  assert.equal(changed.headers.get("etag"), currentDcz);
  assert.equal(changed.headers.get("cache-control"), "public, max-age=0, s-maxage=86400");
  assert.equal(changed.headers.get("link"), "</shell.css>; rel=preload; as=style");
  assert.equal(changed.headers.get("vary"), "accept-encoding, available-dictionary");

  const dczUnchanged = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": currentDcz, "available-dictionary": available },
  }), env);
  assert.equal(dczUnchanged.status, 304);
  assert.equal(dczUnchanged.headers.get("etag"), currentDcz);

  // A page offers ITSELF as a dictionary only when its cache-control lets the browser
  // keep the offer. Chromium sizes a registered dictionary's lifetime from the response's
  // own freshness, so an offer on a stale-on-arrival response is stored already-expired
  // and dropped, costing a DevTools error per navigation and buying nothing. Measured in
  // Chrome 2026-07-29 across seven policies; the table is in lib/assets.js.
  for (const cc of [
    "public, max-age=0, s-maxage=86400",                       // today's page policy
    "public, max-age=0, must-revalidate, s-maxage=86400",
    "max-age=0, must-revalidate, stale-while-revalidate=604800", // must-revalidate wins
    "private, no-cache, must-revalidate",                      // `/` until 2026-07-31
    "no-store",
  ]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"), null, `must not self-offer under "${cc}"`);
  }
  // ...and it comes back on its own if a page is ever given a policy that survives to the
  // moment of use. stale-while-revalidate is RFC 5861's permission to serve stale, which
  // is the second arm of RFC 9842's "fresh or allowed to be served stale".
  for (const cc of ["public, max-age=600", "public, max-age=0, stale-while-revalidate=604800"]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"),
                 'match="/lwe/drivers", match-dest=("document")', `must self-offer under "${cc}"`);
  }

  // The policy every deploy-time document actually ships has to be one of those, or the
  // whole per-page tier (its /pd/ deltas, its committed p-dict snapshots, its build time)
  // is spent on offers no browser keeps. Pinned against the live constant rather than a
  // copy, so editing the policy runs this check instead of quietly bypassing it.
  const { PAGE_CACHE_CONTROL } = await import("../src/worker/lib/const.ts");
  const shipped = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "available-dictionary": available },
  }), makeEnv(PAGE_CACHE_CONTROL));
  assert.equal(shipped.headers.get("use-as-dictionary"),
               'match="/lwe/drivers", match-dest=("document")',
               `PAGE_CACHE_CONTROL must register as a dictionary, got "${PAGE_CACHE_CONTROL}"`);
  // swr is the clause doing that work AND the registered dictionary's lifetime, so a
  // future trim below a day would keep every assertion above green while shortening how
  // long the tier keeps working. Measured 2026-07-29: swr=5 registered nothing.
  const swr = Number(PAGE_CACHE_CONTROL.match(/stale-while-revalidate=(\d+)/)?.[1] || 0);
  assert.ok(swr >= 86400, `PAGE_CACHE_CONTROL needs a useful dictionary lifetime, got swr=${swr}`);
});

test("LWE pages share one base stylesheet and the build derives one site-page dictionary", async () => {
  const base = await readFile(new URL("src/styles/lwe-base.css", ROOT), "utf8");
  assert.match(base, /\.controls \{ display: inline-flex/);
  const build = await readFile(new URL("tools/build.mjs", ROOT), "utf8");
  assert.match(build, /site-page corpus/);
  assert.match(build, /page-family\.\$\{hash8\(dictionary\)\}\.dict/);
  assert.match(build, /src\/dict\/p-dict/);
  assert.match(build, /site-page dictionary/);
  // The snapshots live at src/dict/ now, OUTSIDE the served tree, which is a
  // stronger statement than the .assetsignore entry this used to assert: an
  // ignore line keeps a file from being uploaded, while being outside public/
  // means the build never stages it in the first place.
  const served = await readdir(new URL("public/", ROOT));
  assert.ok(!served.includes("p-dict") && !served.includes("a-dict"),
    "dictionary snapshots are build input and must not sit in the served tree");
  const security = await readFile(new URL("src/worker/lib/security.ts", ROOT), "utf8");
  assert.match(security, /rel="compression-dictionary"/);
  for (const name of ["index", "dac", "drivers", "encoding", "fhe", "knots", "mpc", "pcrypto", "tee", "utf8", "vigenere"]) {
    const html = await readFile(new URL(`src/pages/lwe/${name}.html`, ROOT), "utf8");
    assert.match(html, /<link rel="stylesheet" href="\/lwe-base\.css">/);
    assert.doesNotMatch(html, /compression-dictionary/);
    assert.doesNotMatch(html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "", /\.controls \{ display: inline-flex/);
  }
});

test("the page-family dictionary outranks exact snapshots without narrowing its scope", async () => {
  const pattern = new URLPattern({ pathname: PAGE_FAMILY_MATCH, baseURL: "https://aadhar.sh" });
  assert.equal(pattern.hasRegExpGroups, false, "RFC 9842 rejects URLPatterns with custom regexp groups");

  const pages = (await readdir(new URL("src/pages", ROOT), { recursive: true }))
    .filter((path) => path.endsWith(".html"));
  const routes = pages.map((path) => {
    const route = path.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1");
    return `/${route}`.replace(/\/$/, "") || "/";
  });
  for (const route of routes) {
    assert.equal(pattern.test(`https://aadhar.sh${route}`), true, `${PAGE_FAMILY_MATCH} must match ${route}`);
    assert.ok(PAGE_FAMILY_MATCH.length > route.length,
      `the family match must outrank the exact-page match for ${route}`);
  }
});
