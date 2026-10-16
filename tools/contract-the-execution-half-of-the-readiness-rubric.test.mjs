// ── the execution half of the readiness rubric ──────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  EXECUTION_META,
  EXECUTION_PROBE,
  assert,
  executionChecks,
  httpWords,
  lensAgentDoors,
  lensReadiness,
  lensSitemapDeclared,
  lensSitemapVerdict,
  readFileSync,
  test,
} from "./contract-shared.ts";

test("execution checks stay NEUTRAL until an agent browser has actually rendered", () => {
  for (const ev of [null, undefined, {}, { ran: false }]) {
    const checks = executionChecks(ev);
    assert.equal(checks.agentScripts.status, "neutral", "no render means no verdict on scripts");
    assert.equal(checks.agentMedia.status, "neutral", "no render means no verdict on media");
    assert.match(checks.agentScripts.detail, /render/, "the detail has to say why it is neutral");
  }
});

test("a throw fails the script check and a decode failure fails the media check", () => {
  const clean = executionChecks({ ran: true, engine: "kitesurf", consoleErrors: 0, pageErrors: 0, totalImages: 26, brokenImages: 0 });
  assert.equal(clean.agentScripts.status, "pass");
  assert.equal(clean.agentMedia.status, "pass");

  const threw = executionChecks({ ran: true, consoleErrors: 1, firstError: "TypeError: navigation.addEventListener is not a function", totalImages: 26, brokenImages: 0 });
  assert.equal(threw.agentScripts.status, "fail");
  assert.match(threw.agentScripts.detail, /navigation\.addEventListener/, "the failing detail must name the error");

  const broke = executionChecks({ ran: true, totalImages: 26, brokenImages: 12, consoleErrors: 0 });
  assert.equal(broke.agentMedia.status, "fail");
  assert.match(broke.agentMedia.detail, /12 of 26/, "the detail must quote the count it measured");

  assert.equal(executionChecks({ ran: true, totalImages: 0, brokenImages: 0, consoleErrors: 0 }).agentMedia.status, "neutral");
});

test("the DOM census treats an empty alt as a decision, not an omission", () => {
  assert.match(EXECUTION_PROBE, /hasAttribute\("alt"\)/, "decorative images are found by the attribute being PRESENT and empty");
  assert.match(EXECUTION_PROBE, /imagesMissingAlt/, "a missing alt attribute is the only omission");
  assert.match(EXECUTION_PROBE, /imagesDecorative/, "decorative images need their own count so they leave both sides of the ratio");
  assert.match(EXECUTION_PROBE, /i\.complete && i\.naturalWidth === 0/, "an image is only broken once it is complete");
});

test("both execution checks are declared in the category the rubric scores", () => {
  // The meta table and the checks the scorer runs name the same two keys, so
  // the loop below walks both checks rather than whatever the table holds.
  assert.deepEqual(Object.keys(EXECUTION_META), Object.keys(executionChecks(null)));
  assert.deepEqual(Object.keys(executionChecks(null)), ["agentScripts", "agentMedia"]);
  for (const [key, meta] of Object.entries(EXECUTION_META)) {
    assert.equal(meta.category, "execution", `${key} must sit in the execution category`);
    assert.ok(meta.label && meta.label.length > 0, `${key} needs a label the grid can render`);
    assert.ok(/** @type {any} */ (meta).countInScore !== false, `${key} must count once it has evidence`);
  }
  const lens = readFileSync("./src/worker/lens.ts", "utf8");
  assert.match(lens, /\.\.\.EXECUTION_META/, "lens.js must spread the shared meta rather than restate it");
  assert.match(lens, /key: "execution"/, "the execution category has to exist in LENS_READINESS_CATEGORIES");
  assert.doesNotMatch(lens, /agentScripts: \{ category/, "lens.js must not re-declare an execution check locally");
});

test("an unrendered scan does not enlarge the readiness denominator", () => {
  const base = { headers: {}, robots: null, sitemap: null, terms: null, discovery: null, agent: null, openapi: null, botViews: [] };
  const noRender = lensReadiness({ ...base, execution: null });
  const rendered = lensReadiness({ ...base, execution: { ran: true, consoleErrors: 1, totalImages: 26, brokenImages: 12 } });

  const catOf = (r) => r.categories.find((c) => c.key === "execution");
  assert.equal(catOf(noRender).total, 0, "an unrendered scan scores nothing in this category");
  assert.equal(catOf(noRender).checkCount, 2, "both checks are still SHOWN, so the visitor learns they exist");
  assert.equal(catOf(rendered).total, 2, "a render makes both checks count");
  assert.equal(rendered.counted - noRender.counted, 2, "exactly the two execution checks join the denominator");
  assert.ok(/neutral/.test(noRender.scoringNote) && /render/.test(noRender.scoringNote),
    "the published scoring note has to explain the neutral rule, since the number is shown to strangers");
});

test("a 200 at the sitemap URL is not a sitemap until something reads it", () => {
  const html = { ok: true, status: 200, contentType: "text/html", body: "<!doctype html><html><body>Not found</body></html>", url: "https://x.test/sitemap.xml" };
  assert.equal(lensSitemapVerdict(html).valid, false, "an HTML page at the sitemap URL is not a sitemap");
  assert.match(lensSitemapVerdict(html).reason, /HTML/, "and the reason has to name what it actually got");

  const xml = { ok: true, status: 200, contentType: "application/xml", body: '<?xml version="1.0"?><urlset><url><loc>https://x.test/</loc></url><url><loc>https://x.test/a</loc></url></urlset>', url: "https://x.test/sitemap.xml" };
  assert.equal(lensSitemapVerdict(xml).valid, true, "a real urlset passes");
  assert.equal(lensSitemapVerdict(xml).entries, 2, "and its entries are counted for the detail line");

  const index = { ok: true, status: 200, contentType: "application/xml", body: "<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>", url: "https://x.test/sitemap.xml" };
  assert.equal(lensSitemapVerdict(index).valid, true, "a sitemapindex is a sitemap too");

  const text = { ok: true, status: 200, contentType: "text/plain", body: "https://x.test/\nhttps://x.test/a\n", url: "https://x.test/sitemap.txt" };
  assert.equal(lensSitemapVerdict(text).valid, true, "a plain-text URL list is a legal sitemap");

  const gz = { ok: true, status: 200, contentType: "application/gzip", body: "\u001f\u008b\u0008", url: "https://x.test/sitemap.xml.gz" };
  assert.equal(lensSitemapVerdict(gz).valid, false, "a compressed sitemap is not verified");
  assert.equal(lensSitemapVerdict(gz).compressed, true, "but it is flagged as compressed rather than absent");

  assert.equal(lensSitemapVerdict(null).valid, false, "a missing probe is not a sitemap");
  assert.equal(lensSitemapVerdict({ ok: false, status: 404 }).valid, false, "and neither is a 404");
});

test("robots.txt decides where the sitemap is, not the /sitemap.xml convention", () => {
  // RFC 9309 2.2.3 makes the Sitemap directive authoritative. Probing only the
  // convention called Stripe's real sitemap (/sitemap/sitemap.xml) missing, and
  // did the same to 13 more sites in the 2026-08-15 survey.
  const robots = (body) => ({ ok: true, status: 200, body });
  assert.equal(
    lensSitemapDeclared(robots("User-agent: *\nSitemap: https://x.test/sitemap/sitemap.xml"), "https://x.test"),
    "https://x.test/sitemap/sitemap.xml", "the declared location is followed");
  assert.equal(
    lensSitemapDeclared(robots("Sitemap: https://www.x.test/sitemap-index.xml"), "https://x.test"),
    "https://www.x.test/sitemap-index.xml", "a cross-host sitemap is still the site's own declaration");
  assert.equal(
    lensSitemapDeclared(robots("Sitemap: https://x.test/sitemap.xml"), "https://x.test"),
    null, "the conventional path is not probed a second time");
  assert.equal(lensSitemapDeclared(robots("Sitemap: http://127.0.0.1/sitemap.xml"), "https://x.test"), null, "a private host is refused");
  assert.equal(lensSitemapDeclared(robots("Sitemap: file:///etc/passwd"), "https://x.test"), null, "a non-http scheme is refused");
  assert.equal(lensSitemapDeclared({ ok: false, status: 404 }, "https://x.test"), null, "no robots.txt means nothing is declared");

  const lens = readFileSync("./src/worker/lens.ts", "utf8");
  assert.match(lens, /if \(!lensSitemapVerdict\(sitemap\)\.valid\) \{/,
    "the follow-up probe must be CONDITIONAL, so the common path keeps its parallel fan-out");
});

test("the readiness rubric scores the declared sitemap and refuses the fake one", () => {
  const base = { headers: {}, robots: null, terms: null, discovery: null, agent: null, openapi: null, botViews: [], execution: null };
  const good = '<urlset><url><loc>https://x.test/</loc></url></urlset>';

  const fake = lensReadiness({ ...base, sitemap: { ok: true, status: 200, contentType: "text/html", body: "<html><body>hi</body></html>", url: "https://x.test/sitemap.xml" } });
  assert.equal(fake.checks.sitemap.status, "fail", "an HTML 200 must not score a sitemap pass");

  const declared = lensReadiness({
    ...base,
    sitemap: { ok: false, status: 404, url: "https://x.test/sitemap.xml" },
    sitemapDeclared: { ok: true, status: 200, contentType: "application/xml", body: good, url: "https://x.test/sitemap/sitemap.xml" },
  });
  assert.equal(declared.checks.sitemap.status, "pass", "a sitemap at the declared location counts");
  assert.match(declared.checks.sitemap.detail, /robots\.txt declares/, "and the detail says where it was found");

  const compressed = lensReadiness({ ...base, sitemap: { ok: true, status: 200, contentType: "application/gzip", body: "x", url: "https://x.test/sitemap.xml.gz" } });
  assert.equal(compressed.checks.sitemap.status, "unknown", "a sitemap we could not decode is unknown, never a fail");
});

test("a door that never answered is not an action surface", () => {
  const lens = readFileSync("./src/worker/lens.ts", "utf8");
  assert.match(lens, /if \(json && res\.ok\) return \{ verdict: "maybe"/,
    "an NLWeb candidate has to have ANSWERED, not merely returned JSON");
  assert.match(lens, /json && res\.status === 401 && www/,
    "a 401 counts only when the origin says how to authenticate, the same rule /mcp uses");

  const doorsFor = (verdict) => lensAgentDoors({
    llmsTxt: { ok: false }, mdNego: null, mcp: { verdict: "no" }, nlweb: { verdict },
    webmcp: { found: false }, agentCard: { ok: false }, openapi: { ok: false },
    aiPlugin: { ok: false }, apiCatalog: { ok: false },
  });
  assert.equal(doorsFor("maybe").strategy.action.length, 1, "a live /ask is an action surface");
  assert.equal(doorsFor("likely").strategy.action.length, 1, "so is an auth-gated one that names its scheme");
  assert.equal(doorsFor("no").strategy.action.length, 0, "a refused /ask is not");
  assert.equal(doorsFor("unknown").strategy.action.length, 0, "and neither is one that never answered");
});

test("a capped level explains itself on every surface that shows the level", () => {
  const worker = readFileSync("./src/worker/lens.ts", "utf8");
  const client = readFileSync("./src/client/lens.js", "utf8");

  assert.match(worker, /levelNote: readiness\.levelNote/, "the observation summary has to carry the note, or compare mode cannot show it");
  assert.match(worker, /overall, level: level\.number, levelName: level\.name, levelNote/, "the readiness envelope has to publish it");
  assert.match(worker, /s\.levelNote \? ' title="'/, "the SSR badge explains itself for the no-JS floor");
  assert.match(client, /r\.levelNote \?/, "and the client renders it for everyone else");
  assert.match(worker, /\.lx-level-note \{/, "the note needs a style, or it renders as unlabelled prose");

  assert.match(client, /badge\("Level " \+ \(s\.level == null \? "\?" : s\.level\), levelKind, s\.levelNote/, "the compare column passes the note through");
  assert.match(client, /function badge\(text, kind, title\)/, "badge takes an optional title rather than a second helper");
});

test("a level may claim at most one rung beyond what the score supports", () => {
  const base = { headers: {}, robots: { ok: true, status: 200, body: "User-agent: *" }, terms: null, discovery: null, openapi: null, botViews: [], execution: null };
  const withDoor = { strategy: { verdict: "agent-native", action: ["an MCP endpoint"], readable: [], unknowns: [] } };

  const thin = lensReadiness({ ...base, sitemap: null, agent: withDoor });
  assert.ok(thin.overall < 40, "precondition: this site passes almost nothing");
  assert.ok(thin.level < 5, "a 13-of-100 site cannot be published as Agent-Native on one probe");
  assert.ok(thin.levelNote && /held at/.test(thin.levelNote), "and the cap has to be stated, not applied silently");

  const rich = lensReadiness({
    ...base,
    sitemap: { ok: true, status: 200, contentType: "application/xml", body: "<urlset><url><loc>https://x.test/</loc></url></urlset>", url: "https://x.test/sitemap.xml" },
    agent: withDoor,
  });
  assert.ok(rich.level >= thin.level, "a better-scoring site with the same door never ranks lower");
  assert.equal(lensReadiness({ ...base, sitemap: null, agent: null }).levelNote, null, "an uncapped level carries no note");
});

test("the agent check's word count strips a script closed any legal way", () => {
  // CodeQL, on #353. An end tag may carry attributes and may hold whitespace, so
  // `</script >` and `</script bar>` close a script element as surely as
  // `</script>` does, and a stripper spelled the short way hands the whole body
  // through. Same class and same fix as #347.
  for (const html of [
    "<p>keep</p><script>var leak=1;</script>tail",
    "<p>keep</p><script >var leak=1;</script >tail",
    "<p>keep</p><script>var leak=1;</script bar>tail",
    "<p>keep</p><script\ntype=\"module\">var leak=1;</script\n>tail",
  ]) {
    assert.equal(httpWords(html), 2, `script body leaked into the count: ${html}`);
  }
  for (const html of [
    "<p>keep</p><style>.x{color:red}</style>tail",
    "<p>keep</p><style >.x{color:red}</style >tail",
    "<p>keep</p><style>.x{color:red}</style bar>tail",
  ]) {
    assert.equal(httpWords(html), 2, `style body leaked into the count: ${html}`);
  }
  assert.equal(httpWords("<h1>one two</h1><p>three</p>"), 3, "prose must survive the strip");
});
