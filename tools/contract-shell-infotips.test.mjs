// ── shell infotips ──────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  AGENT_SURFACES,
  DESKTOP_CHROME,
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
  kvForTracks,
  mcpPost,
  navFenceBody,
  readFenceBody,
  readFile,
  readManifest,
  readdir,
  runProfilesBody,
  sectionFavicons,
  speculationRulesJson,
  test,
  wmEnv,
  wmPost,
  workerModule,
} from "./contract-shared.ts";
import { SPECULATION } from "./photos/shell-data.ts";
import { CLIENT_ASSETS, hashOrder, minifiedScripts } from "./lib/client-assets.ts";
import { existsSync, readFileSync } from "node:fs";

// ── shell infotips ──────────────────────────────────────────────────────────
// infotip.js cannot be imported here: it reaches /hoist.js by absolute
// specifier, which node's loader will not resolve (the same wall gotcha 16
// describes). So these assert on the source text, and each one guards a
// failure that would ship silently.

test("\"what was hovered\" is answered in exactly one place", async () => {
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  assert.match(nav, /var INFOTIP_TARGETS = \[/, "nav.js owns the target selector");
  assert.match(nav, /var INFOTIP_SKIP = /, "and the list of hovers a richer surface already owns");
  assert.match(nav, /find: targetFor/, "and hands the matcher itself to the module");
  assert.match(tip, /const findTarget = o\.find;/, "infotip.js takes the matcher it is given");
  assert.doesNotMatch(tip, /\.axp-\w[^\n"]*,[^\n"]*\.axp-/, "a second target list in infotip.js is the drift this test exists to stop");
});

test("the infotip yields to every richer hover surface on the page", async () => {
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  const skip = (nav.match(/var INFOTIP_SKIP = "([^"]+)"/) || [, ""])[1].split(",");
  for (const owned of [".lx-term", ".photos a", ".np-list li", ".np-artist-link", ".car-link", ".ev[data-cover]"]) {
    assert.ok(skip.includes(owned), `${owned} has its own hover card — the infotip must not double up on it`);
  }
});

test("every string an infotip prints is escaped on the way in", async () => {
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  for (const hole of [/<div class="n">\$\{esc\(/, /<div class="h">\$\{esc\(/, /<dt>\$\{esc\(/, /<dd>\$\{esc\(/]) {
    assert.match(tip, hole, `${hole} must interpolate through esc()`);
  }
  const printed = tip.match(/<div class="n">\$\{[^}]+\}/g) || [];
  assert.ok(printed.length >= 2 && printed.every((p) => p.includes("esc(")),
    "every name line must be escaped, including any added later");
});

test("an infotip row is dropped rather than filled in", async () => {
  const tip = await readFile(new URL("src/client/infotip.js", ROOT), "utf8");
  assert.match(tip, /\.filter\(\(p\) => p && p\[1\]\)/, "card() must drop pairs with no value");
  assert.doesNotMatch(tip, /"unknown"|"n\/a"|\|\| 0\)\s*\+\s*" page/i, "no placeholder stands in for a value");
});

test("the shell infotip ships minified, hashed, and with a readable twin", async () => {
  assert.equal(minifiedScripts().find((row) => row.file === "infotip.js")?.twin, "/infotip.src.js", "infotip.js belongs in the registry");
  const infotip = CLIENT_ASSETS.find((asset) => asset.file === "infotip.js");
  assert.ok(infotip, "infotip.js is a registry row");
  assert.ok(infotip.load.some((loader) => loader.via === "import"), "nav.js's import() must be repointed");
  assert.ok(infotip.loadedBy.includes("public/nav.js"), "and nav.js is the loader the build witnesses");
  const order = hashOrder().map((asset) => asset.file);
  assert.ok(order.indexOf("hoist.js") < order.indexOf("infotip.js"),
    "hoist must be hashed before infotip, or infotip's /a/ copy keeps the unhashed specifier");
});

test("every workflow bootstraps the Bun source that config/bun-pin.json declares", async () => {
  const declared = JSON.parse(await readFile(new URL("config/bun-pin.json", ROOT), "utf8"));
  assert.match(String(declared.bun), /^(canary|\d+\.\d+\.\d+(-canary\.\d{8}\.\d+\+[0-9a-f]{7,40})?)$/,
    `config/bun-pin.json names ${declared.bun}; it must select a supported Bun source`);

  const dir = new URL(".github/workflows/", ROOT);
  const files = (await readdir(dir)).filter((n) => n.endsWith(".yml"));
  assert.ok(files.length >= 5, `expected the workflow set, found ${files.length}`);

  let checked = 0;
  for (const file of files) {
    const body = await readFile(new URL(file, dir), "utf8");
    const commands = body.split("\n").filter((l) => !/\becho\b/.test(l)).join("\n");
    if (!/^\s*bun\s+(install|run|test|x)\b/m.test(commands)) continue;
    assert.match(body, /uses: \.\/\.github\/actions\/setup-bun/,
      `.github/workflows/${file} runs bun without going through the shared setup-bun action`);
    assert.ok(!/bun-version:|oven-sh\/setup-bun/.test(body),
      `.github/workflows/${file} names a bun version inline instead of reading config/bun-pin.json`);
    checked++;
  }
  assert.ok(checked >= 4, `expected several bun bootstraps, matched ${checked}`);

  const action = await readFile(new URL(".github/actions/setup-bun/action.yml", ROOT), "utf8");
  const installer = await readFile(new URL(".github/install-bun.sh", ROOT), "utf8");
  assert.match(installer, /config\/bun-pin\.json/, "install-bun.sh must read the version from config/bun-pin.json");
  assert.match(action, /bash \.github\/install-bun\.sh /, "setup-bun must install through the shared installer");
  assert.match(action, /zstd/, "setup-bun must probe the dictionary capability before a build spends 40s discovering it");
});

test("every trustedDependencies entry is a live approval, never a dead one", async () => {
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
  const chrome = await readFile(new URL("src/worker/lib/desktop.ts", ROOT), "utf8");
  assert.doesNotMatch(chrome, /data-favicon/,
    "taskbar pins must not carry favicon data: the page's own <head> owns this");

  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  assert.doesNotMatch(nav, /setFavicon|rel\s*=\s*["']icon["']/,
    "nav.js must not set the tab favicon; the document declares it");

  assert.deepEqual(SECTION_FAVICONS, sectionFavicons(),
    "lib/desktop.js drifted from shell-data.mjs — run bun run gen:shell");
  for (const item of TASKBAR) {
    const href = SECTION_FAVICONS[item.path];
    assert.equal(href, faviconHref(item.label), `${item.path} favicon href`);
    await readFile(new URL("public" + href, ROOT), "utf8");
  }

  for (const [file, slug] of [["garage", "garage"], ["lwe", "lwe"], ["pixel-peeper", "pixel-peeper"]]) {
    const page = await readFile(new URL(`src/pages/${file}/index.html`, ROOT), "utf8");
    assert.match(page, new RegExp(`<link rel="icon" type="image/svg\\+xml" href="/section-icons/${slug}\\.svg">`),
      `src/pages/${file}/index.html must link its own section tile`);
  }
});

test("the speculation ruleset has exactly one author", async () => {
  const pages = (await readdir(new URL("src/pages", ROOT), { recursive: true }))
    .filter((relative) => relative.endsWith(".html"));
  let scanned = 0;
  for (const relative of pages) {
    const html = await readFile(new URL(`src/pages/${relative}`, ROOT), "utf8");
    const blocks = html.match(/<script\b[^>]*\btype=["']?speculationrules\b[^>]*>/g) || [];
    assert.equal(blocks.length, 0, `${relative} carries an inline ruleset; the Speculation-Rules header is the one author`);
    scanned++;
  }
  assert.ok(scanned >= 40, `only ${scanned} pages scanned; the walk has collapsed`);
  assert.doesNotMatch(DESKTOP_CHROME, /speculationrules/, "lib/desktop.ts must not carry a ruleset");
  assert.equal(speculationRulesJson(), JSON.stringify(SPECULATION));
  const security = await readFile(new URL("src/worker/lib/security.ts", ROOT), "utf8");
  assert.match(security, /headers\.set\("speculation-rules", `"\$\{SPECULATION_RULES\}"`\)/,
    "withSecurityHeaders names the ruleset file in a Speculation-Rules header");

  const generator = await readFile(new URL("pipelines/lwe/generate.mjs", ROOT), "utf8");
  assert.doesNotMatch(generator, /speculationrules/,
    "generate.mjs must emit DESKTOP_CHROME and never its own ruleset; a stale template here re-infects every page it regenerates");
  assert.doesNotMatch(generator, /serviceWorker\.register\(["']\/sw\.js["']\)/,
    "the LWE generator must not reinstall the retired service worker; /sw.js remains only as a cleanup stub for old clients");
  assert.match(generator, /<!-- axp:desktop -->\$\{DESKTOP_TOP\}<!-- \/axp:desktop -->/,
    "the LWE template must hand its desktop to the canonical shell compiler inside one generated sentinel");

  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  assert.doesNotMatch(nav, /type\s*=\s*["']speculationrules["']/,
    "nav.js must not inject a ruleset; it ships in the chrome now");
});

test("the staged Worker names the built ruleset on HTML and only on HTML", { skip: !existsSync(".build/src/worker/lib/shell-assets.ts") && "needs a build" }, async () => {
  const { SPECULATION_RULES } = await import(new URL("../.build/src/worker/lib/shell-assets.ts", import.meta.url).href);
  assert.match(SPECULATION_RULES, /^\/a\/speculation\.[0-9a-f]{8}\.json$/, "build.ts patched the ruleset URL in");
  const bytes = readFileSync(`.build/public${SPECULATION_RULES}`, "utf8");
  assert.equal(bytes, speculationRulesJson(), "the file is the projection of SPECULATION");
  assert.ok(existsSync(`.build/public${SPECULATION_RULES}.br`), "the ruleset has its q11 twin");

  const { withSecurityHeaders } = await import(new URL("../.build/src/worker/lib/security.ts", import.meta.url).href);
  const html = withSecurityHeaders(new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }), "/garage");
  // A structured-field list of one string: the quotes are the syntax.
  assert.equal(html.headers.get("speculation-rules"), `"${SPECULATION_RULES}"`);
  const json = withSecurityHeaders(new Response("{}", { headers: { "content-type": "application/json" } }), "/rn/tracks");
  assert.equal(json.headers.get("speculation-rules"), null, "a non-HTML response never carries it");
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
  assert.equal(findEndpointIn("<p>nothing here</p>", null, base), null);
});

test("the excerpt survives a page full of inline SVG chrome", async () => {
  const db = fakeD1();
  const target = "https://aadhar.sh/writing/in-flux";
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
  assert.equal(resources.find((r) => r.name === "/rn").mimeType, "text/markdown", "music advertises its on-site representation");
  const frames = ["/finger", "/radar", "/dict", "/cache", "/encode", "/agent-ready"];
  for (const name of frames) assert.equal(resources.find((r) => r.name === name).mimeType, "text/plain", `${name} advertises its frame`);
  assert.ok(resources.filter((r) => r.name !== "/rn" && !frames.includes(r.name)).every((r) => r.mimeType === "text/html"));
});

test("MCP reads a terminal tool's URI as its text/plain frame", async () => {
  let asked = "";
  const env = { SELF_FETCH: async (req) => {
    asked = req.headers.get("accept");
    return new Response("finger — aadharsh@aadhar.sh\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  } };
  const out = await readMcpResource("https://aadhar.sh/finger", env);
  assert.equal(asked, "text/plain", "the read asks for the representation the listing advertised");
  assert.equal(out.result.contents[0].mimeType, "text/plain");
  assert.match(out.result.contents[0].text, /aadharsh@aadhar\.sh/);
});

async function readMcpResource(uri, env, origin = "https://aadhar.sh") {
  const response = await handleSiteMcp(new Request(origin + "/mcp", {
    method: "POST", headers: { "content-type": "application/json", cookie: "private=fixture", authorization: "Bearer fixture" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri } }),
  }), env, context());
  return response.json();
}

test("MCP reads the listed music URI through its existing Markdown representation", async () => {
  const { handleRn, handleRnMarkdown } = await import("../src/worker/rn.ts");
  const realFetch = globalThis.fetch;
  let wireReads = 0;
  testGlobals.fetch = async () => { wireReads++; throw new Error("unexpected wire request"); };
  try {
    for (const RN_KV of [undefined, kvForTracks()]) {
      const env = { RN_KV, RN_BUST_SECRET: "must-not-bust" };
      const seen = [];
      const ctx = context();
      const uri = "https://aadhar.sh/rn?bust=must-not-bust#tracks";
      const result = await readMcpResource(uri, { ...env, SELF_FETCH: (request) => {
        seen.push([request.url, request.headers.get("accept")]);
        return handleRn(request, env, ctx);
      } });
      assert.ok(result.result, "a listed music read must not follow the browser redirect");
      const content = result.result.contents[0];
      assert.equal(content.uri, uri, "the stable resource URI is preserved");
      assert.equal(content.mimeType, "text/markdown");
      const twin = await handleRnMarkdown(new Request("https://aadhar.sh/rn.md"), env, ctx);
      assert.equal(content.text, await twin.text(), "MCP uses the same live renderer as the existing twin");
      assert.deepEqual(seen, [["https://aadhar.sh/rn", "text/markdown"]]);
      assert.match(content.text, RN_KV ? /## 1 track/ : /Could not load the track list/);
      assert.match(content.text, /https:\/\/aadhar\.sh\/rn\/tracks/);
      const browser = await handleRn(new Request("https://aadhar.sh/rn", { headers: { accept: "text/html" } }), env, ctx);
      assert.equal(browser.status, 302, "the browser contract remains a Spotify redirect");
      const location = browser.headers.get("location");
      assert.ok(location);
      assert.equal(new URL(location).hostname, "open.spotify.com");
    }
    assert.equal(wireReads, 0);
  } finally { testGlobals.fetch = realFetch; }
});

test("site MCP resources/read dispatches only listed local pages with public headers", async () => {
  const realFetch = globalThis.fetch;
  let wireReads = 0;
  testGlobals.fetch = async () => { wireReads++; return new Response("upstream failure", { status: 522 }); };
  const seen = [];
  const env = { SELF_FETCH: async (request) => {
    seen.push(request);
    return new Response("<!doctype html><title>local ✓</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  } };
  try {
    for (const origin of ["https://aadhar.sh", "https://preview.aadhar-sh.workers.dev"]) {
      const uri = origin + "/whoareyou?url=https://evil.example&admin=1#fragment";
      const content = (await readMcpResource(uri, env, origin)).result.contents[0];
      assert.deepEqual(content, { uri, mimeType: "text/html", text: "<!doctype html><title>local ✓</title>" });
      const request = seen.at(-1);
      assert.equal(request.url, origin + "/whoareyou", "queries and fragments never select extra work");
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("accept"), "text/html");
      assert.match(request.headers.get("user-agent"), /^AadharshBot\//);
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("authorization"), null);
    }
    for (const uri of ["https://aadhar.sh/etc/passwd", "https://evil.example/whoareyou", "https://aadhar.sh/mcp", "not a URL", null, ["https://aadhar.sh/"]]) {
      assert.equal((await readMcpResource(uri, env)).error.code, -32602);
    }
    for (const SELF_FETCH of [undefined, null]) {
      assert.equal((await readMcpResource("https://aadhar.sh/", { SELF_FETCH })).error.code, -32602);
    }
    assert.equal(seen.length, 2, "invalid inputs and disarmed dispatch never read a page");
    assert.equal(wireReads, 0, "no same-host network request or fallback");
  } finally { testGlobals.fetch = realFetch; }
});

test("site MCP resources/read refuses failed and redirected pages and cancels their bodies", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const status of [301, 302, 307, 308, 404, 500, 522]) {
      let cancelled = false;
      const fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("not a resource")); controller.close(); },
        cancel() { cancelled = true; },
      }), { status, headers: { location: "https://evil.example/", "content-type": "text/html" } });
      testGlobals.fetch = fetch;
      const out = await readMcpResource("https://aadhar.sh/whoareyou", { SELF_FETCH: fetch });
      assert.equal(out.error?.code, -32602, `HTTP ${status} must not become a complete resource`);
      assert.equal(out.result, undefined);
      assert.ok(cancelled, `HTTP ${status} body must be discarded`);
    }
    const out = await readMcpResource("https://aadhar.sh/", { SELF_FETCH: () => { throw new Error("broken dispatcher"); } });
    assert.equal(out.error.code, -32602);
  } finally { testGlobals.fetch = realFetch; }
});

test("site MCP resources/read returns whole bounded UTF-8 pages and cancels overflow", async () => {
  const realFetch = globalThis.fetch;
  const cap = 512 * 1024;
  try {
    for (const text of ["", "a".repeat(cap), "é".repeat(cap / 2)]) {
      const fetch = async () => new Response(text, { headers: { "content-type": "text/html" } });
      testGlobals.fetch = fetch;
      assert.equal((await readMcpResource("https://aadhar.sh/garage/horizon", { SELF_FETCH: fetch })).result.contents[0].text, text);
    }
    let pulls = 0, cancelled = false;
    const fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls > 32) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024).fill(65));
      },
      cancel() { cancelled = true; },
    }));
    testGlobals.fetch = fetch;
    const out = await readMcpResource("https://aadhar.sh/", { SELF_FETCH: fetch });
    assert.equal(out.error?.code, -32602, "a prefix is not a complete resource");
    assert.ok(cancelled, "overflow cancels the producer");
    assert.ok(pulls < 16, `bounded reader must not drain the whole body: ${pulls} pulls`);
  } finally { testGlobals.fetch = realFetch; }
});

test("site MCP resources/read deadlines cover stalled dispatch and body reads", async () => {
  const realFetch = globalThis.fetch, realTimer = globalThis.setTimeout;
  const budgets = [];
  testGlobals.setTimeout = (fn, ms, ...args) => {
    if (ms === 8000) { budgets.push(ms); return realTimer(fn, 10, ...args); }
    return realTimer(fn, ms, ...args);
  };
  try {
    for (const phase of ["dispatch", "body"]) {
      let signal, deliver, cancelled = false;
      const response = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      const fetch = async (request, init) => {
        signal = init?.signal || request.signal;
        return phase === "body" ? response() : new Promise((resolve) => { deliver = resolve; });
      };
      testGlobals.fetch = fetch;
      let watchdog;
      const out = await Promise.race([
        readMcpResource("https://aadhar.sh/", { SELF_FETCH: fetch }),
        new Promise((resolve) => { watchdog = realTimer(() => resolve(null), 500); }),
      ]);
      clearTimeout(watchdog);
      if (deliver) deliver(response());
      await new Promise((resolve) => realTimer(resolve, 0));
      assert.ok(out, `${phase} must return even when the producer ignores abort`);
      assert.equal(out.error.code, -32602);
      assert.ok(signal.aborted, `${phase} request is aborted`);
      assert.ok(cancelled, `${phase} body is cancelled, including late responses`);
    }
    assert.deepEqual(budgets, [8000, 8000]);
  } finally { testGlobals.fetch = realFetch; testGlobals.setTimeout = realTimer; }
});

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
