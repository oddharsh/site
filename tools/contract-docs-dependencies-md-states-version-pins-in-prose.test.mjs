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
} from "./contract-shared.ts";
import { spawnSync } from "node:child_process";

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
  const quiet = { aliases: [{ prose: "Wrangler", pkg: "wrangler" }], versionless: new Map(), floor: 0 };
  const ok = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`, pins, ...quiet });
  assert.deepEqual(ok.problems, [], "a matching doc must pass");

  const stale = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.0 is the pin.`, pins, ...quiet });
  assert.equal(stale.problems.length, 1);
  assert.match(stale.problems[0], /states "Wrangler 4\.120\.0" but package\.json pins wrangler at 4\.120\.1/);

  const undocumented = auditDependencyDocs({
    doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`,
    pins: { ...pins, "left-pad": "1.0.0" },
    ...quiet,
  });
  assert.equal(undocumented.problems.length, 1);
  assert.match(undocumented.problems[0], /left-pad is a root dependency/);

  const removed = auditDependencyDocs({ doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.`, pins: {}, ...quiet });
  assert.ok(removed.problems.some((p) => /wrangler is declared in DOC_ALIASES but package\.json no longer pins it/.test(p)),
    removed.problems.join("\n"));

  const empty = auditDependencyDocs({ doc: `${BASELINE_HEADING}\nno versions here`, pins: {} });
  assert.ok(empty.problems.some((p) => /below the floor/.test(p)));

  const pillow = auditDependencyDocs({
    doc: `${BASELINE_HEADING}\n- Wrangler 4.120.1 is the pin.\n- Pillow 12.3.0 is pinned.`,
    pins,
    ...quiet,
  });
  assert.ok(pillow.problems.some((p) => /Pillow version.*no Python/.test(p)));
});

test("the collapsed check keeps the two rules that came from #382", () => {
  const H = BASELINE_HEADING;
  const quiet = { aliases: [{ prose: "Wrangler", pkg: "wrangler" }], versionless: new Map(), floor: 0 };

  const ranged = auditDependencyDocs({
    doc: `${H}\n- Wrangler 4.120.1 is the pin.`,
    pins: { wrangler: "^4.120.1" },
    ...quiet,
  });
  assert.ok(ranged.problems.some((p) => /range-pinned \(\^4\.120\.1\).*Move it to VERSIONLESS/s.test(p)),
    ranged.problems.join("\n"));

  const dropped = auditDependencyDocs({
    doc: `${H}\n- nothing about wrangler here.`,
    pins: { wrangler: "4.120.1" },
    ...quiet,
  });
  assert.ok(dropped.problems.some((p) => /no longer states a version for Wrangler/.test(p)),
    dropped.problems.join("\n"));

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

  const bare = auditDependencyDocs({ doc: `${H}\n- linkedom 0.18.13 supplies a DOM.`, ...quiet, subManifests: sub() });
  assert.deepEqual(bare.problems, [], "an unbackticked name must still match");

  const stale = auditDependencyDocs({ doc: `${H}\n- \`linkedom\` 0.18.12 supplies a DOM.`, ...quiet, subManifests: sub() });
  assert.ok(stale.problems.some((p) => /states "linkedom 0\.18\.12" but lens-reader\/package\.json pins linkedom at 0\.18\.13/.test(p)),
    stale.problems.join("\n"));

  const undocumented = auditDependencyDocs({
    doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`,
    ...quiet,
    subManifests: sub({ pins: { linkedom: "0.18.13", "left-pad": "1.0.0" } }),
  });
  assert.ok(undocumented.problems.some((p) => /left-pad is a lens-reader\/package\.json dependency/.test(p)),
    undocumented.problems.join("\n"));

  const ranged = auditDependencyDocs({
    doc: `${H}\n- \`image\` 0.25 decodes input.`,
    ...quiet,
    subManifests: sub({ manifest: "tools/photos/zenc/Cargo.toml", aliases: [{ prose: "image", pkg: "image" }], pins: { image: "0.25" } }),
  });
  assert.ok(ranged.problems.some((p) => /image is range-pinned \(0\.25\)/.test(p)), ranged.problems.join("\n"));

  const missing = auditDependencyDocs({
    doc: `${H}\n- \`linkedom\` 0.18.13 supplies a DOM.`,
    ...quiet,
    subManifests: sub({ missing: true, pins: {} }),
  });
  assert.ok(missing.problems.some((p) => /lens-reader\/package\.json is declared in SUB_MANIFEST_POLICY but could not be read/.test(p)),
    missing.problems.join("\n"));

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
  assert.ok(!("version" in deps) && !("name" in deps) && !("opt-level" in deps),
    "only the [dependencies] table may be read");
  assert.deepEqual(parseCargoDeps("[package]\nname = \"x\"\n"), {}, "no [dependencies] table is an empty set");

  assert.deepEqual(
    parseCargoDeps('[package]\nname = "zenc"\n\n[dependencies]\nzenjpeg = "0.8.4"\n'),
    { zenjpeg: "0.8.4" },
    "a [dependencies] table with nothing after it must still be read",
  );
});

test("Cargo dependencies survive TOML quoting, comments and dependency subtables", async () => {
  const source = `[package]
name = "fixture"

[dependencies] # ordinary Cargo dependencies
'image' = '0.25'
"codec" = { features = ["a#b"], version = '1.2.3' }
local = { path = "../local" }

[dependencies.halflight]
git = "https://example.test/halflight.git"
rev = "edc6358de58e5de93309d01500971bb056c65708"

[profile.release]
opt-level = 3
`;
  assert.deepEqual(parseCargoDeps(source), { image: "0.25", codec: "1.2.3", local: null, halflight: null });
  const toml = await readFile(new URL("./photos/zenc/Cargo.toml", import.meta.url), "utf8");
  assert.equal(parseCargoDeps(toml).halflight, null, "the real git dependency is present without a version claim");
});

test("the Cargo reader refuses malformed manifests instead of auditing a partial census", () => {
  for (const toml of [
    '[dependencies]\ncodec = { version = "1.2.3"\n',
    '[dependencies]\ncodec = "1.2.3"\ncodec = "2.0.0"\n',
    '[dependencies]\ncodec = "1.2.3" trailing\n',
    '[dependencies]\ncodec = false\n',
    '[dependencies]\ncodec = { version = 123 }\n',
    'dependencies = []\n',
    '[dependencies]\ncodec = 2026-09-01\n',
    '[dependencies]\ncodec = []\n',
  ]) assert.throws(() => parseCargoDeps(toml), Error, toml);
});

test("Cargo comments at EOF cannot hang the dependency audit or relocker", () => {
  const reader = new URL("./lib/dependency-docs.ts", import.meta.url).href;
  const script = `
    const { parseCargoDeps } = await import(${JSON.stringify(reader)});
    try { console.log(JSON.stringify({ dependencies: parseCargoDeps(process.argv[1]) })); }
    catch { console.log(JSON.stringify({ rejected: true })); }
  `;
  for (const [toml, expected] of /** @type {const} */ ([
    ['[package]\nvalues = [1 #', { rejected: true }],
    ['[package]\nvalues = { key = 1 #', { rejected: true }],
    ['[dependencies]\ncodec = { version = "1.2.3", features = ["a" #', { rejected: true }],
    ['[dependencies]\ncodec = { version = "1.2.3" #', { rejected: true }],
    ['[dependencies]\ncodec = { version = "1.2.3", features = ["a" # comment\n] }\n', { dependencies: { codec: "1.2.3" } }],
    ['[dependencies]\ncodec = "1.2.3" #', { dependencies: { codec: "1.2.3" } }],
  ])) {
    const result = spawnSync(process.execPath, ["--eval", script, toml], { encoding: "utf8", timeout: 3000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test("versionless Cargo dependencies require policy and do not look removed", () => {
  const pins = parseCargoDeps('[dependencies]\nhalflight = { git = "https://example.test/halflight.git", rev = "abc" }\n');
  const sub = { manifest: "Cargo.toml", pins, aliases: [], versionless: new Map() };
  const run = () => auditDependencyDocs({ doc: BASELINE_HEADING, pins: {}, aliases: [], versionless: new Map(), floor: 0, subManifests: [sub] });
  assert.ok(run().problems.some((p) => /halflight is a Cargo.toml dependency/.test(p)), "git dependencies cannot disappear from the reverse check");
  sub.versionless.set("halflight", "A git revision has no semantic version to quote.");
  assert.deepEqual(run().problems, [], "present without a version is different from absent");
  delete pins.halflight;
  assert.ok(run().problems.some((p) => /halflight is exempted .* but is no longer/.test(p)), "removal still invalidates the policy");
});

test("the dependency-doc scanner does not read prose as a version claim", () => {
  const prose = [
    "TypeScript 7.0 ships no stable programmatic API",
    "Oxlint 1.87 adds type-aware rules",
    "the CSS Overflow 5 selectors /garage/horizon ships deliberately",
    "Vite 8 keeps 0.28.2 as an OPTIONAL peer",
    "Wrangler hard-depends on 0.28.1 for Cloudflare's Worker bundler",
  ].join("\n");
  assert.deepEqual(findClaims(prose), [], "prose must yield no version claims");

  assert.equal(findClaims("- Lightning CSS 1.33.0 and esbuild are pins").length, 1);
});

test("a flex item is its own box, and promoting one never eats an image", () => {
  const page = (style, body) =>
    `<html><head><title>T</title><style>${style}</style></head><body><main>${body}</main></body></html>`;

  const welded = readDocument(
    page(".tag{flex:0 0 92px}", "<p><span class=tag>hit-route</span><span>counter tick endpoint renamed</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.doesNotMatch(welded.body, /hit-routecounter/, "a flex item must not weld onto the text after it");
  assert.match(welded.body, /hit-route/);
  assert.match(welded.body, /counter tick endpoint renamed/);

  const withImage = readDocument(
    page(".pic{flex:0 0 auto}", '<p>before<img src="/enc/c.jpg" alt="sample photo" class="pic">after</p>'),
    { origin: "https://aadhar.sh" });
  assert.match(withImage.body, /!\[sample photo\]\(https:\/\/aadhar\.sh\/enc\/c\.jpg\)/,
    "an image must survive its class being promoted out of the inline flow");

  const container = readDocument(
    page(".row{flex-direction:row;flex-flow:wrap}", "<p><span class=row>alpha</span><span>beta</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.match(container.body, /alphabeta|alpha beta/, "flex-direction/flex-flow describe children, not this box");

  assert.ok(collectBlockClasses("<style>.x{display:block}.y{float:right}.z{flex:1}</style>").size >= 3);
});

test("a twin never emits a link on a scheme that executes", () => {
  const link = (href) =>
    readDocument(`<html><body><main><p><a href="${href}">CLICKME</a></p></main></body></html>`,
      { origin: "https://aadhar.sh" }).body;

  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "vbscript:msgbox(1)",
                      "data:text/html,<script>alert(1)</script>", "\tdata:text/html;base64,PHM+"]) {
    assert.equal(link(href), "CLICKME", `${href} must render as text, never as a link`);
  }

  assert.equal(link("https://example.com/real"), "[CLICKME](https://example.com/real)");
  assert.equal(link("/garage/horizon"), "[CLICKME](https://aadhar.sh/garage/horizon)");
});

// RFC 9110 asks a HEAD to send the header fields its GET would send. serveStaticPage
// bailed on the method before reaching the Markdown branch, so HEAD answered
// text/html on pages whose GET answers text/markdown. Verified on production
// 2026-07-31 (GET /garage/encoding -> text/markdown, HEAD -> text/html), which is
// also a convincing false positive for the #195 cache bug because `curl -I` is the
// reflex probe.
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

  for (const name of ["cache-control", "vary", "x-markdown-tokens", "x-content-type-options"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), `HEAD and GET must agree on ${name}`);
  }
  assert.equal(head.headers.get("x-markdown-tokens"), get.headers.get("x-markdown-tokens"));

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
    "public, max-age=0, s-maxage=86400",
    "public, max-age=0, must-revalidate, s-maxage=86400",
    "max-age=0, must-revalidate, stale-while-revalidate=604800", // must-revalidate wins
    "max-age=0, must-revalidate, stale-while-revalidate=60",   // ...at any window
    "private, no-cache, must-revalidate",
    "max-age=3600, no-cache",                                  // no-cache vetoes a live max-age
    "no-store",
  ]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"), null, `must not self-offer under "${cc}"`);
  }
  // ...and it comes back on its own if a page is ever given a policy that survives to the
  // moment of use. stale-while-revalidate is RFC 5861's permission to serve stale, which
  // is the second arm of RFC 9842's "fresh or allowed to be served stale". must-revalidate
  // cancels only that second arm, so a positive max-age still registers under it
  // (measured in Chrome 152, 2026-09-23).
  for (const cc of ["public, max-age=600", "public, max-age=0, stale-while-revalidate=604800", "max-age=3600, must-revalidate"]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"),
                 'match="/lwe/drivers", match-dest=("document")', `must self-offer under "${cc}"`);
  }

  const { PAGE_CACHE_CONTROL } = await import("../src/worker/lib/const.ts");
  const shipped = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "available-dictionary": available },
  }), makeEnv(PAGE_CACHE_CONTROL));
  assert.equal(shipped.headers.get("use-as-dictionary"),
               'match="/lwe/drivers", match-dest=("document")',
               `PAGE_CACHE_CONTROL must register as a dictionary, got "${PAGE_CACHE_CONTROL}"`);
  const swr = Number(PAGE_CACHE_CONTROL.match(/stale-while-revalidate=(\d+)/)?.[1] || 0);
  assert.ok(swr >= 86400, `PAGE_CACHE_CONTROL needs a useful dictionary lifetime, got swr=${swr}`);
});

test("LWE pages share one base stylesheet and the build derives one site-page dictionary", async () => {
  const base = await readFile(new URL("src/styles/lwe-base.css", ROOT), "utf8");
  assert.match(base, /\.msgr-head \.ava::before \{ content: var\(--glyph\)/);
  assert.doesNotMatch(base, /\.controls/);
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(build, /site-page corpus/);
  assert.match(build, /familyDictionaryName\(hash8\(dictionary\)\)/);
  assert.match(build, /src\/dict\/p-dict/);
  assert.match(build, /site-page dictionary/);
  const served = await readdir(new URL("public/", ROOT));
  assert.ok(!served.includes("p-dict") && !served.includes("a-dict"),
    "dictionary snapshots are build input and must not sit in the served tree");
  const security = await readFile(new URL("src/worker/lib/security.ts", ROOT), "utf8");
  assert.match(security, /rel="compression-dictionary"/);
  const lwePages = (await readdir(new URL("src/pages/lwe/", ROOT)))
    .filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
  assert.ok(lwePages.length >= 12, `expected the LWE section to hold pages, saw ${lwePages.length}`);
  for (const name of lwePages) {
    const html = await readFile(new URL(`src/pages/lwe/${name}.html`, ROOT), "utf8");
    assert.match(html, /<link rel="stylesheet" href="\/lwe-base\.css">/);
    assert.doesNotMatch(html, /compression-dictionary/);
    const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
    assert.doesNotMatch(inline, /\.controls/, `${name}: caption buttons are luna.css's`);
    assert.doesNotMatch(inline, /^\.msgr-head \{/m, `${name}: the Messenger header is lwe-base.css's`);
    assert.match(inline, /^(<style>)?:root\{[^}]*--(glyph|accent|icon-border):/m, `${name}: names its concept on :root`);
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
