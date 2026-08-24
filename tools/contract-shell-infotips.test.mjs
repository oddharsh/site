// ── shell infotips ──────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  AGENT_SURFACES,
  MODERN_META,
  ROOT,
  SECTION_FAVICONS,
  SERENDIPITY_MCP_SERVER_INFO,
  SITE_MCP_SERVER_INFO,
  TASKBAR,
  assert,
  context,
  deferredContext,
  fakeD1,
  faviconHref,
  findEndpointIn,
  handleSiteMcp,
  handleWebmention,
  mcpPost,
  navFenceBody,
  readFenceBody,
  readFile,
  readManifest,
  readdir,
  runProfilesBody,
  sectionFavicons,
  speculationHtml,
  test,
  wmEnv,
  wmPost,
  workerModule,
} from "./contract-shared.mjs";

// ── shell infotips ──────────────────────────────────────────────────────────
// infotip.js cannot be imported here: it reaches /hoist.js by absolute
// specifier, which node's loader will not resolve (the same wall gotcha 16
// describes). So these assert on the source text, and each one guards a
// failure that would ship silently.

test("\"what was hovered\" is answered in exactly one place", async () => {
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  // nav.js's loader has to match the same elements the module does, or the
  // first hover over something it forgot never loads the module at all — and
  // the failure is a tooltip that works everywhere except where you look first.
  // So the matcher is a function nav.js passes over, not a selector each side
  // keeps a copy of.
  assert.match(nav, /var INFOTIP_TARGETS = \[/, "nav.js owns the target selector");
  assert.match(nav, /var INFOTIP_SKIP = /, "and the list of hovers a richer surface already owns");
  assert.match(nav, /find: targetFor/, "and hands the matcher itself to the module");
  assert.match(tip, /const findTarget = o\.find;/, "infotip.js takes the matcher it is given");
  // It still reads the DOM for per-family facts (which builder, and whether the
  // target sits on the taskbar), and those are single selectors. What it must
  // never grow is a LIST — that is the copy this test exists to stop.
  assert.doesNotMatch(tip, /\.axp-\w[^\n"]*,[^\n"]*\.axp-/, "a second target list in infotip.js is the drift this test exists to stop");
});

test("the infotip yields to every richer hover surface on the page", async () => {
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  const skip = (nav.match(/var INFOTIP_SKIP = "([^"]+)"/) || [, ""])[1].split(",");
  // Each of these draws its own card from the same engine, and `.lx-term` is
  // the sharp one: those ship a `title` as their no-JS fallback and lens.js
  // strips it once its surface is live, so without the skip a race between two
  // lazy modules decides whether you get the glossary card or a flat line.
  for (const owned of [".lx-term", ".photos a", ".np-list li", ".np-artist-link", ".car-link", ".ev[data-cover]"]) {
    assert.ok(skip.includes(owned), `${owned} has its own hover card — the infotip must not double up on it`);
  }
});

test("every string an infotip prints is escaped on the way in", async () => {
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  // The surface renders `title` text from ANY page now, and some of those
  // strings are not ours: /inbox carries webmention titles, /around and
  // /reading carry text from sites this server crawled. innerHTML with one
  // un-escaped hole would turn a remote string into markup on every page that
  // loads the shell. Verified in a browser too (a title holding
  // `<img src=x onerror=alert(1)>` renders as text and creates no element),
  // but the source assertion is what fails a future edit.
  for (const hole of [/<div class="n">\$\{esc\(/, /<div class="h">\$\{esc\(/, /<dt>\$\{esc\(/, /<dd>\$\{esc\(/]) {
    assert.match(tip, hole, `${hole} must interpolate through esc()`);
  }
  const printed = tip.match(/<div class="n">\$\{[^}]+\}/g) || [];
  assert.ok(printed.length >= 2 && printed.every((p) => p.includes("esc(")),
    "every name line must be escaped, including any added later");
});

test("an infotip row is dropped rather than filled in", async () => {
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  // Same rule the photo tooltip follows: a missing value prints nothing. A
  // card that rendered "Contains: 0 pages" or "Colo: unknown" would be stating
  // something the shell does not know, on chrome describing the shell.
  assert.match(tip, /\.filter\(\(p\) => p && p\[1\]\)/, "card() must drop pairs with no value");
  assert.doesNotMatch(tip, /"unknown"|"n\/a"|\|\| 0\)\s*\+\s*" page/i, "no placeholder stands in for a value");
});

test("the shell infotip ships minified, hashed, and with a readable twin", async () => {
  const build = await readFile(new URL("tools/build.mjs", ROOT), "utf8");
  // Missing from SHELLS it would ship unminified with no /infotip.src.js twin;
  // missing from STRING_ASSETS its import specifier would stay unhashed and
  // the module would serve at max-age=300 forever beside its immutable peers.
  assert.match(build, /\["infotip\.js",\s*"\/infotip\.src\.js"/, "infotip.js belongs in SHELLS");
  assert.match(build, /\{ file: "\/infotip\.js",\s*base: "infotip"/, "and in STRING_ASSETS, so nav.js's import() is repointed");
  const shells = build.slice(build.indexOf("const SHELLS = ["));
  assert.ok(shells.indexOf('"/hoist.js"') < shells.indexOf('{ file: "/infotip.js"'),
    "hoist must be hashed before infotip, or infotip's /a/ copy keeps the unhashed specifier");
});

test("every workflow bootstraps the bun that package.json pins", async () => {
  // Inherited from the pnpm era, and the reasoning survives the swap with one
  // change: pnpm self-switched, so a workflow naming the wrong version merely
  // wasted time. Nothing self-switches here. A workflow that installs some
  // other bun builds this repo with a compiler nobody declared, and the output
  // is content-addressed, so that re-mints URLs rather than erroring.
  //
  // The 1.4 release retired the digest pin this test used to assert. A released
  // tag is immutable, so the VERSION is the guarantee the SHA-256 provided while
  // the canary tag was rolling daily. config/bun-canary.json is gone with it.
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.match(pkg.packageManager, /^bun@\d+\.\d+\.\d+$/,
    `packageManager is ${pkg.packageManager}; it must name a RELEASED bun, since that is the only string Cloudflare's build image resolves`);

  const dir = new URL(".github/workflows/", ROOT);
  const files = (await readdir(dir)).filter((n) => n.endsWith(".yml"));
  assert.ok(files.length >= 5, `expected the workflow set, found ${files.length}`);

  let checked = 0;
  for (const file of files) {
    const body = await readFile(new URL(file, dir), "utf8");
    // EXECUTION, not mention. promote-production.yml prints "bun run
    // deploy:promote" as advice in an echo and runs no bun at all; a scanner
    // that reads the string demands a bootstrap that workflow does not need.
    // Same shape as every other naive scanner this repo has had to sharpen.
    const commands = body.split("\n").filter((l) => !/\becho\b/.test(l)).join("\n");
    if (!/^\s*bun\s+(install|run|test|x)\b/m.test(commands)) continue;
    // ONE bootstrap, and it reads packageManager itself. A workflow that curls
    // its own bun, or names a version inline, is a second declaration that can
    // drift from the first.
    assert.match(body, /uses: \.\/\.github\/actions\/setup-bun/,
      `.github/workflows/${file} runs bun without going through the shared setup-bun action`);
    assert.ok(!/bun-version:|oven-sh\/setup-bun/.test(body),
      `.github/workflows/${file} names a bun version inline instead of reading packageManager`);
    checked++;
  }
  assert.ok(checked >= 4, `expected several bun bootstraps, matched ${checked}`);

  // The action is the single place the version is read, so it must read it.
  const action = await readFile(new URL(".github/actions/setup-bun/action.yml", ROOT), "utf8");
  assert.match(action, /packageManager/, "setup-bun must read the version from packageManager");
  assert.match(action, /zstd/, "setup-bun must probe the dictionary capability before a build spends 40s discovering it");
});

test("every trustedDependencies entry is a live approval, never a dead one", async () => {
  // bun's answer to pnpm's allowBuilds, and the failure mode this guards is the
  // same one: an entry for a package the tree no longer has reads as a reviewed
  // decision and is actually nothing. It also cannot be caught by a clean
  // install, which is why it needs asserting rather than noticing.
  //
  // Declaring this key REPLACES bun's built-in default allowlist rather than
  // adding to it, so the moment it exists, a dependency that genuinely needs a
  // postinstall and is absent here silently does not run one.
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const trusted = pkg.trustedDependencies || [];
  assert.ok(trusted.length >= 1, "trustedDependencies is declared, so it should name something");

  const lock = await readFile(new URL("bun.lock", ROOT), "utf8");
  for (const name of trusted) {
    assert.ok(lock.includes(`"${name}@`) || lock.includes(`"${name}"`),
      `trustedDependencies names ${name}, which is not in bun.lock — a dead approval`);
  }
});

test("a section's favicon is in its own <head>, never set by script", async () => {
  // setFavicon() used to read a data-favicon attribute off the matching taskbar
  // pin at boot. That cost one attribute per pin on EVERY page so that 11 of them
  // could read one, and it painted the wrong icon first and swapped. The document
  // states its own favicon now, so the three ways it can regress are asserted.

  // 1. The pins carry no favicon data. A reintroduced attribute is the whole
  //    per-page cost coming back, and nothing would fail without this.
  const chrome = await readFile(new URL("src/worker/lib/desktop.ts", ROOT), "utf8");
  assert.doesNotMatch(chrome, /data-favicon/,
    "taskbar pins must not carry favicon data: the page's own <head> owns this");

  // 2. nav.js sets no favicon. A favicon applied after boot is a visible flip.
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  assert.doesNotMatch(nav, /setFavicon|rel\s*=\s*["']icon["']/,
    "nav.js must not set the tab favicon; the document declares it");

  // 3. Every taskbar route resolves to an icon that EXISTS on disk, through the
  //    generated map the worker actually reads. A route added to TASKBAR without
  //    its tile would otherwise ship a 404 favicon.
  assert.deepEqual(SECTION_FAVICONS, sectionFavicons(),
    "lib/desktop.js drifted from shell-data.mjs — run bun run gen:shell");
  for (const item of TASKBAR) {
    const href = SECTION_FAVICONS[item.path];
    assert.equal(href, faviconHref(item.label), `${item.path} favicon href`);
    await readFile(new URL("public" + href, ROOT), "utf8");
  }

  // 4. The three hand-authored section pages link their own tile. These are the
  //    only section pages outside lunaPage, so they are the ones that go quiet.
  for (const [file, slug] of [["garage", "garage"], ["lwe", "lwe"], ["pixel-peeper", "pixel-peeper"]]) {
    const page = await readFile(new URL(`src/pages/${file}/index.html`, ROOT), "utf8");
    assert.match(page, new RegExp(`<link rel="icon" type="image/svg\\+xml" href="/section-icons/${slug}\\.svg">`),
      `src/pages/${file}/index.html must link its own section tile`);
  }
});

test("the speculation ruleset has exactly one author", async () => {
  // This block lived in 26 documents plus a runtime injector, and the copies had
  // forked (#338). Two of the three ways it can fork again are structural, so
  // they are asserted here rather than left to review.
  //
  // 1. A hand-written block anywhere in public/. The build already byte-compares
  //    every static page against a fresh render, so a page that carries one fails
  //    the deploy; this names the rule so the failure is legible.
  const pages = (await readdir(new URL("src/pages", ROOT), { recursive: true }))
    .filter((relative) => relative.endsWith(".html"));
  const canonical = speculationHtml();
  let carrying = 0;
  for (const relative of pages) {
    const html = await readFile(new URL(`src/pages/${relative}`, ROOT), "utf8");
    // Count real tags only. /garage/horizon discusses this very block in prose as
    // escaped `&lt;script type="speculationrules"&gt;`, and it is the fourth naive
    // scanner that page's demo content would have caught.
    const blocks = html.match(/<script\b[^>]*\btype="speculationrules"[^>]*>/g) || [];
    if (!blocks.length) continue;
    carrying++;
    assert.equal(blocks.length, 1, `${relative} carries ${blocks.length} rulesets; the browser unions them`);
    assert.ok(html.includes(canonical), `${relative} has a ruleset that is not the projection of SPECULATION; run bun run gen:shell`);
  }
  assert.ok(carrying >= 30, `only ${carrying} pages carry the ruleset; the projection has collapsed`);

  // 2. The lwe generator getting its own template back. It had one, it went stale
  //    when two commits removed exclusions site-wide, and regenerating a page then
  //    silently restored the old rules onto it (src/pages/lwe/encoding.html).
  const generator = await readFile(new URL("pipelines/lwe/generate.mjs", ROOT), "utf8");
  assert.doesNotMatch(generator, /speculationrules/,
    "generate.mjs must emit DESKTOP_CHROME and never its own ruleset; a stale template here re-infects every page it regenerates");
  assert.doesNotMatch(generator, /serviceWorker\.register\(["']\/sw\.js["']\)/,
    "the LWE generator must not reinstall the retired service worker; /sw.js remains only as a cleanup stub for old clients");
  assert.match(generator, /<!-- axp:desktop -->\$\{DESKTOP_TOP\}<!-- \/axp:desktop -->/,
    "the LWE template must hand its desktop to the canonical shell compiler inside one generated sentinel");

  // 3. nav.js building one at runtime again, which is where the injected copy
  //    lived. Rules in the HTML parse with the document; injected ones landed
  //    after first paint and could not prerender anything hovered before that.
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  assert.doesNotMatch(nav, /type\s*=\s*["']speculationrules["']/,
    "nav.js must not inject a ruleset; it ships in the chrome now");
});

test("outbound endpoint discovery follows the spec's precedence", () => {
  const base = "https://example.com/post";
  // Link header wins over markup.
  assert.equal(
    findEndpointIn('<link rel="webmention" href="/from-markup">', '</from-header>; rel="webmention"', base),
    "https://example.com/from-header");
  // then <link>, resolved relative to the fetched URL
  assert.equal(findEndpointIn('<link rel="webmention" href="/wm">', null, base), "https://example.com/wm");
  // then <a>, and rel lists with extra tokens still count
  assert.equal(findEndpointIn('<a rel="me webmention" href="https://wm.example/e">x</a>', null, base), "https://wm.example/e");
  // no endpoint is the common case, and is not an error
  assert.equal(findEndpointIn("<p>nothing here</p>", null, base), null);
});

test("the excerpt survives a page full of inline SVG chrome", async () => {
  // A real mention from a GitHub gist arrived with 280 characters of SVG path
  // geometry as its excerpt, which is what made a legitimate mention read as
  // spam. Two causes: <svg> was not stripped alongside <script>/<style>, and the
  // fixed-width window around the link opens mid-attribute (the target lives in
  // an href), leaving a partial tag that the complete-tag stripper cannot touch.
  const db = fakeD1();
  const target = "https://aadhar.sh/writing/in-flux";
  // The path has to be long enough that the 400-character window opening before
  // the link lands INSIDE the d="..." attribute, because that is the only way
  // the geometry escapes: the tag stripper removes complete tags, attributes and
  // all, so a short icon is harmless. On the real gist the icon sat directly
  // before the link with roughly this much path data, which is why it leaked.
  const path = "M9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018Z".repeat(12);
  const page = `<html><body>
    <svg aria-hidden="true"><path d="${path}"></path></svg>
    <p>The teardown at <a href="${target}" class="Link--primary">this note</a> is the useful part.</p>
    </body></html>`;
  const realFetch = globalThis.fetch;
  testGlobals.fetch = async () => new Response(page, { headers: { "content-type": "text/html" } });
  try {
    const ctx = deferredContext();
    await handleWebmention(wmPost("https://gist.example/x", target), wmEnv(db), ctx);
    await ctx.settle();
  } finally {
    testGlobals.fetch = realFetch;
  }
  const row = db.rows[0];
  assert.ok(row, "the mention verified and stored");
  assert.doesNotMatch(row.excerpt, /\d\.\d{3}\s|[Ma]\d+\.\d+[a-z]/, `SVG path data leaked into the excerpt: ${row.excerpt}`);
  assert.doesNotMatch(row.excerpt, /^["'>]/, "excerpt starts with the tail of a chopped attribute");
  assert.match(row.excerpt, /is the useful part/, "the sentence around the link survived");
});

test("an accepted webmention answers 202 without a Location header", async () => {
  // The spec ties Location to 201, where it must name a status URL the sender
  // can poll. On a 202 it has no defined meaning, and webmention.rocks receiver
  // test #1 fails an endpoint that sends one anyway. Easy to reintroduce by
  // "helpfully" pointing at /inbox, so pin it.
  const db = fakeD1();
  const realFetch = globalThis.fetch;
  testGlobals.fetch = async () =>
    new Response('<a href="https://aadhar.sh/writing/in-flux">x</a>', { headers: { "content-type": "text/html" } });
  try {
    const res = await handleWebmention(
      wmPost("https://mari.example/post", "https://aadhar.sh/writing/in-flux"),
      wmEnv(db),
      deferredContext()
    );
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("location"), null, "202 must not carry a Location header");
  } finally {
    testGlobals.fetch = realFetch;
  }
});

test("endpoint discovery survives the webmention.rocks decoys", () => {
  // Fixtures lifted from the live pages at webmention.rocks/test/N, the
  // IndieWeb conformance suite. Kept as fixtures rather than live fetches
  // because this file is deliberately network-free; the real 23 were run
  // against the deployed implementation and all pass. Numbers name the test.
  const at = (n) => `https://webmention.rocks/test/${n}`;
  const cases = [
    // #1 relative Link header, unquoted rel. #2 absolute. #7 odd casing.
    [1, "", "</test/1/webmention>; rel=webmention", at(1) + "/webmention"],
    [8, "", '<https://webmention.rocks/test/8/webmention>; rel="webmention"', at(8) + "/webmention"],
    // #10 the rel is a token LIST; webmention is one of several.
    [10, "", '<https://webmention.rocks/test/10/webmention>; rel="webmention somethingelse"', at(10) + "/webmention"],
    // #19 one header, several values: the non-webmention one must not win.
    [19, "", '<https://webmention.rocks/test/19/webmention/error>; rel="other", <https://webmention.rocks/test/19/webmention>; rel="webmention"', at(19) + "/webmention"],
    // #12 rel="not-webmention" is a DIFFERENT rel. A \bwebmention\b regex
    // matches it anyway, because "-" is a word boundary.
    [12, '<link rel="not-webmention" href="/test/12/webmention/error"><a href="/test/12/webmention" rel="webmention">ok</a>', null, at(12) + "/webmention"],
    // #13 a decoy inside an HTML comment is not markup.
    [13, 'comment <!-- <a href="/test/13/webmention/error" rel="webmention"></a> --> then <a href="/test/13/webmention" rel="webmention">correct</a>', null, at(13) + "/webmention"],
    // #14 the same decoy, escaped. Never matched a "<"-anchored pattern.
    [14, '<code>&lt;a href="/test/14/webmention/error" rel="webmention"&gt;&lt;/a&gt;</code><a href="/test/14/webmention" rel="webmention">x</a>', null, at(14) + "/webmention"],
    // #15 href="" is a legitimate self-reference, not a missing href.
    [15, '<link rel="webmention" href="">', null, at(15)],
    // #16 <a> first, <link> later: DOCUMENT ORDER decides, not tag name. An
    // implementation that scans every <link> before any <a> takes the decoy.
    [16, '<a href="/test/16/webmention" rel="webmention">a</a><link rel="webmention" href="/test/16/webmention/error">', null, at(16) + "/webmention"],
    // #17 the same page with the tags swapped, to catch the opposite bias.
    [17, '<link rel="webmention" href="/test/17/webmention"><a href="/test/17/webmention/error" rel="webmention">a</a>', null, at(17) + "/webmention"],
    // #20 a candidate with NO href is not an endpoint. Skip it and keep
    // looking, rather than letting it shadow the real one below.
    [20, '<link rel="webmention"><a href="/test/20/webmention" rel="webmention">x</a>', null, at(20) + "/webmention"],
  ];
  for (const [n, html, header, expected] of cases) {
    assert.equal(findEndpointIn(html, header, at(n)), expected, `webmention.rocks discovery test #${n}`);
  }
});

test("site-manifest.json is a well-formed registry with unique paths", async () => {
  const { surfaces } = readManifest();
  assert.ok(surfaces.length > 0);
  const seen = new Set();
  for (const s of surfaces) {
    assert.match(s.path, /^\//, `path must be absolute: ${s.path}`);
    assert.ok(s.title && s.description && s.hint, `${s.path} missing title/description/hint`);
    for (const f of ["run", "taskbar", "sitemap", "gallery", "agents", "searchIndex"]) {
      assert.equal(typeof s.flags?.[f], "boolean", `${s.path} flag ${f} must be boolean`);
    }
    assert.ok(!seen.has(s.path), `duplicate path ${s.path}`);
    seen.add(s.path);
  }
});

test("committed manifest projections match a fresh generation", async () => {
  // guards against a commit that edits site-manifest.json but forgets
  // `bun run gen:manifest` — the same drift build.mjs #8 blocks, checked here too.
  const { surfaces } = readManifest();
  const mod = await readFile("src/worker/lib/site-manifest.ts", "utf8");
  assert.equal(mod.trim(), workerModule(surfaces).trim(), "lib/site-manifest.js is stale — run bun run gen:manifest");
  const nav = await readFile("src/client/nav-run.js", "utf8");
  for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
    assert.equal(readFenceBody(nav, marker), navFenceBody(surfaces, section), `nav-run.js generated:${marker} is stale — run bun run gen:manifest`);
  }
  assert.equal(readFenceBody(nav, "run-profiles"), runProfilesBody(), "nav-run.js profiles are stale — run bun run gen:manifest");
});

test("site MCP lists the agent surfaces as resources", async () => {
  const init = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), headers: { "content-type": "application/json" } }), {}, context());
  assert.deepEqual((await init.json()).result.capabilities.resources, {}, "initialize must declare the resources capability");
  const list = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }), headers: { "content-type": "application/json" } }), {}, context());
  const resources = (await list.json()).result.resources;
  assert.equal(resources.length, AGENT_SURFACES.length);
  assert.ok(resources.length > 0);
  const home = resources.find((r) => r.name === "/");
  assert.equal(home.uri, "https://aadhar.sh/", "uri is absolute against the request origin");
  assert.equal(home.mimeType, "text/html");
});

test("site MCP resources/read serves listed surfaces only, same-origin", async () => {
  const realFetch = globalThis.fetch;
  testGlobals.fetch = async () => new Response("<!doctype html><title>ok</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  try {
    const read = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "https://aadhar.sh/whoareyou" } }), headers: { "content-type": "application/json" } }), {}, context());
    const content = (await read.json()).result.contents[0];
    assert.equal(content.uri, "https://aadhar.sh/whoareyou");
    assert.match(content.text, /ok/);
    // an unlisted path and a cross-origin host are both rejected without fetching.
    for (const uri of ["https://aadhar.sh/etc/passwd", "https://evil.example.com/whoareyou"]) {
      const bad = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri } }), headers: { "content-type": "application/json" } }), {}, context());
      assert.equal((await bad.json()).error.code, -32602, `must reject ${uri}`);
    }
  } finally { testGlobals.fetch = realFetch; }
});

// Server cards are pre-connection metadata. The live `server/discover` and
// `tools/list` responses remain the protocol source of truth, so the cards are
// generated projections rather than a second hand-maintained tool catalog.
test("published MCP server cards and discovery files stay aligned with both live servers", async () => {
  const { handleMcp } = await import("../serendipity/serendipity.ts");
  const siteLive = await (await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "site-tools", method: "tools/list", params: { ...MODERN_META },
  }), {}, context())).json();
  const serendipityPost = (body) => new Request("https://aadhar.sh/serendipity/mcp", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
  const serendipityLive = await (await handleMcp(serendipityPost({
    jsonrpc: "2.0", id: "serendipity-tools", method: "tools/list", params: { ...MODERN_META },
  }), {}, null)).json();
  const cards = [
    {
      file: "public/.well-known/mcp/server-card.json",
      endpoint: "https://aadhar.sh/mcp",
      live: siteLive.result.tools,
      info: { name: SITE_MCP_SERVER_INFO.name, title: SITE_MCP_SERVER_INFO.title, version: SITE_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: true, prompts: false },
    },
    {
      file: "public/.well-known/mcp.json",
      endpoint: "https://aadhar.sh/serendipity/mcp",
      live: serendipityLive.result.tools,
      info: { name: SERENDIPITY_MCP_SERVER_INFO.name, title: SERENDIPITY_MCP_SERVER_INFO.title, version: SERENDIPITY_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: false, prompts: false },
    },
    {
      file: "public/.well-known/mcp/serendipity.json",
      endpoint: "https://aadhar.sh/serendipity/mcp",
      live: serendipityLive.result.tools,
      info: { name: SERENDIPITY_MCP_SERVER_INFO.name, title: SERENDIPITY_MCP_SERVER_INFO.title, version: SERENDIPITY_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: false, prompts: false },
    },
  ];
  for (const { file, endpoint, live, info, capabilities } of cards) {
    const card = JSON.parse(await readFile(new URL(file, ROOT), "utf8"));
    assert.equal(card.protocolVersion, "2026-07-28", `${file} must advertise the current MCP revision`);
    assert.deepEqual(card.serverInfo, { ...info, description: card.serverInfo.description }, `${file} server identity drifted`);
    assert.equal(card.transport.url, endpoint, `${file} points at the wrong transport`);
    assert.deepEqual(card.capabilities, capabilities, `${file} capabilities drifted`);
    assert.deepEqual(card.tools, live, `${file} tool metadata drifted from tools/list`);
  }

  const agentCard = JSON.parse(await readFile(new URL("public/.well-known/agent-card.json", ROOT), "utf8"));
  const interfaces = agentCard["x-aadhar-sh"].interfaces.mcp;
  assert.deepEqual(
    interfaces.map((entry) => [entry.url, entry.serverCard]),
    [
      ["https://aadhar.sh/mcp", "https://aadhar.sh/.well-known/mcp/server-card.json"],
      ["https://aadhar.sh/serendipity/mcp", "https://aadhar.sh/.well-known/mcp/serendipity.json"],
    ],
    "agent-card MCP interfaces must name their server cards",
  );
  const catalog = JSON.parse(await readFile(new URL("public/.well-known/api-catalog", ROOT), "utf8"));
  const links = new Map(catalog.linkset.map((entry) => [entry.anchor, entry]));
  assert.equal(links.get("https://aadhar.sh/mcp")["service-desc"][0].href, "https://aadhar.sh/.well-known/mcp/server-card.json");
  assert.equal(links.get("https://aadhar.sh/serendipity/mcp")["service-desc"][0].href, "https://aadhar.sh/.well-known/mcp/serendipity.json");
  const llms = await readFile(new URL("public/llms.txt", ROOT), "utf8");
  assert.match(llms, /https:\/\/aadhar\.sh\/\.well-known\/mcp\/server-card\.json/);
  assert.match(llms, /https:\/\/aadhar\.sh\/\.well-known\/mcp\/serendipity\.json/);
});
