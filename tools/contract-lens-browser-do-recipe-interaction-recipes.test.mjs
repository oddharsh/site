// ── /lens/browser?do=<recipe> — interaction recipes ────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  MODERN_META,
  SITE_MCP_TOOLS,
  _resetPhotoCaches,
  assert,
  context,
  fakeImages,
  getPublicAvailability,
  handleCoffeeAvailability,
  handleLensBrowser,
  handleLensCompare,
  handlePhotoQuery,
  handleSearchJson,
  handleSiteMcp,
  kvType,
  lensRecipe,
  lensRecipeIds,
  lensRecipeScript,
  mcpPost,
  queryPhotos,
  readFileSync,
  renderRun,
  renderSearchPage,
  representationD1,
  searchSite,
  staticAssets,
  test,
} from "./contract-shared.ts";
import { imageCompare, photoRecipe } from "../src/worker/image-tools.ts";

// ── /lens/browser?do=<recipe> — interaction recipes ────────────────────────
// The feature runs JavaScript inside somebody else's page. Almost every test
// below is about the blast radius of that rather than the feature working.

const recipeEnv = (content, capture) => ({
  BROWSER: {
    async quickAction(name, input) {
      if (capture) capture[name] = input;
      return Response.json({ result: { content }, meta: { status: 200 } });
    },
  },
});
const browserReq = (query) => new Request("https://aadhar.sh/lens/browser?url=https%3A%2F%2Fexample.com%2F" + query);

test("a plain browser run is byte-for-byte what it was before recipes existed", async () => {
  const captured = {};
  const response = await handleLensBrowser(browserReq(""), recipeEnv("<html><body>hi</body></html>", captured), context());
  const body = await response.json();
  // The whole backwards-compatibility claim in one place: no injection is sent,
  // and no consumer of this route sees a new key appear.
  assert.equal(captured.snapshot.addScriptTag, undefined, "a plain run must inject nothing");
  assert.equal(captured.snapshot.waitForTimeout, undefined);
  assert.equal("interaction" in body, false, "the field is absent, not null, on a plain run");
  assert.equal(body.ok, true);
});

test("an unknown recipe is refused rather than quietly served as a plain render", async () => {
  // Falling through to the plain render would hand back a perfectly good
  // snapshot the caller believes is post-interaction. That is the exact failure
  // this feature exists to avoid, so a typo has to be loud.
  for (const bad of ["", "   ", "../", "expand;", "<script>", "EXPAND", " expand", "x".repeat(10000)]) {
    let called = false;
    const env = { BROWSER: { quickAction: async () => { called = true; return Response.json({}); } } };
    const response = await handleLensBrowser(browserReq("&do=" + encodeURIComponent(bad)), env, context());
    assert.equal(response.status, 400, `"${bad.slice(0, 20)}" must 400`);
    assert.equal(called, false, `"${bad.slice(0, 20)}" must never reach the binding`);
    const body = await response.json();
    assert.deepEqual(body.recipes, lensRecipeIds(), "a refusal names the ids that would work");
  }
});

test("no caller byte reaches the injected script, and none ever will", async () => {
  // THE test. `addScriptTag` runs arbitrary JS in a third-party page, so a `js=`
  // or `selector=` parameter would make /lens an open remote-code-execution
  // proxy running attacker code from Cloudflare IPs under this account's browser
  // identity. The allowlist is the only thing standing there.
  for (const id of lensRecipeIds()) {
    const captured = {};
    // Every hostile shape a caller controls, all at once: extra query params the
    // handler must ignore, and payload-ish text inside the url itself.
    await handleLensBrowser(
      new Request("https://aadhar.sh/lens/browser?url=" + encodeURIComponent("https://example.com/?evil=</script><script>alert(1)</script>") +
        "&do=" + id + "&js=alert(9)&selector=body&script=pwn"),
      recipeEnv("<html></html>", captured),
      context(),
    );
    const sent = captured.snapshot.addScriptTag;
    assert.equal(sent.length, 1, `${id} must inject exactly one tag`);
    const nonce = (sent[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/) || [])[1];
    assert.ok(nonce, `${id} must carry a server-generated 16-hex nonce`);
    // As an IIFE argument, never a top-level `var`. A `var` lands on `window`,
    // where any timer on the page reads it and forges a receipt that passes the
    // nonce check. Verified in Chromium 2026-08-08 before this was tightened.
    assert.equal(/^\s*var\s/.test(sent[0].content), false, `${id} must not leak the nonce to window`);
    assert.equal(sent[0].content, lensRecipeScript(lensRecipe(id), nonce), `${id} must be the registry script verbatim`);

    // Nothing the caller typed may appear anywhere in the payload except in url.
    const rest = JSON.stringify({ ...captured.snapshot, url: "" });
    for (const smuggled of ["alert(9)", "selector", "pwn", "evil"]) {
      assert.equal(rest.includes(smuggled), false, `${id} leaked "${smuggled}" into the payload`);
    }
  }
});

test("two runs of one recipe never share a nonce", async () => {
  // A fixed nonce would be discoverable by rendering the page once, which is
  // exactly what the attacker here is already able to do.
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const captured = {};
    await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html></html>", captured), context());
    seen.add(captured.snapshot.addScriptTag[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/)[1]);
  }
  assert.equal(seen.size, 5, "each run must mint a fresh nonce");
});

test("the recipe registry stays inside what it is allowed to do", async () => {
  const { LENS_RECIPES } = await import("../src/worker/lens-recipes.ts");
  const ids = new Set();
  for (const r of LENS_RECIPES) {
    assert.match(r.id, /^[a-z][a-z0-9-]{1,15}$/, `${r.id} is not a safe id`);
    assert.equal(ids.has(r.id), false, `${r.id} is declared twice`);
    ids.add(r.id);
    assert.ok(r.label && r.claim, `${r.id} must say what it does before it does it`);
    // A recipe is a DOM edit, never a network actor. Any of these would turn an
    // observation into an action taken on somebody else's behalf.
    for (const banned of ["fetch(", "XMLHttpRequest", "import(", "eval(", "new Function", "document.cookie",
      "localStorage", "sessionStorage", "sendBeacon", "location=", "location =", ".submit(", "postMessage"]) {
      assert.equal(r.script.includes(banned), false, `${r.id} must not contain ${banned}`);
    }
    // Parses as a program. A syntax error would surface as a page that silently
    // never interacts, which reads identically to a CSP refusal.
    new Function(r.script);
  }
});

test("no shipping recipe presses a control on somebody else's page", async () => {
  const { LENS_RECIPES } = await import("../src/worker/lens-recipes.ts");
  // Removing a consent overlay from our own copy of the DOM sets no cookie and
  // records no choice. Clicking "Accept all" from a Cloudflare IP would be this
  // site manufacturing a consent record on a third party's page, which is the
  // machine behaviour /lens was built to criticise. The distinction is the whole
  // ethical argument for shipping `consent` at all, so it is pinned here rather
  // than left to a reviewer noticing a `.click()` in a minified string.
  for (const r of LENS_RECIPES) {
    assert.equal(r.script.includes(".click("), false, `${r.id} must not click`);
    assert.equal(/\.(submit|requestSubmit)\(/.test(r.script), false, `${r.id} must not submit`);
  }
});

test("the published scripts are the scripts that run", async () => {
  const { LENS_RECIPES } = await import("../src/worker/lens-recipes.ts");
  const response = await handleLensBrowser(new Request("https://aadhar.sh/lens/browser?recipes=1"), {}, context());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.recipes.map((r) => r.id), LENS_RECIPES.map((r) => r.id));
  for (const published of body.recipes) {
    // Disclosure that can drift from execution is worse than no disclosure.
    assert.equal(published.script, LENS_RECIPES.find((r) => r.id === published.id).script);
  }
});

test("the receipt is read, then removed before anything counts or caps it", async () => {
  const nonceOf = (captured) => captured.snapshot.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
  const captured = {};
  const env = {
    BROWSER: {
      async quickAction(name, input) {
        captured[name] = input;
        const n = input.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
        // 500 words of padding inside the receipt: if the strip happens after
        // documentTally, they land in the word count and the delta lies.
        return Response.json({
          result: { content: `<html><body><p>one two three</p><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"${n}","acted":4,"scanned":9,"note":"acted","pad":"${"word ".repeat(500)}"}</script></body></html>` },
          meta: { status: 200 },
        });
      },
    },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(nonceOf(captured).length, 16);
  assert.equal(body.interaction.ran, true);
  assert.equal(body.interaction.acted, 4);
  assert.equal(body.interaction.scanned, 9);
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "the receipt must not reach the reader's content");
  assert.equal(body.tally.words, 3, "the receipt must be gone before the words are counted");
});

test("a page cannot forge a result for a script it was not given", async () => {
  // Without the nonce a hostile page ships its own receipt claiming Lens tore
  // down a wall it never touched, and /lens repeats the lie in its own voice.
  const body = await (await handleLensBrowser(
    browserReq("&do=consent"),
    recipeEnv('<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"deadbeefdeadbeef","acted":9999,"scanned":9999,"note":"acted"}</script></body></html>'),
    context(),
  )).json();
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "forged-receipt");
  assert.equal(body.interaction.acted, 0, "a forged count must never be repeated as ours");
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "and it still must not reach the reader");
});

test("nonsense counts in a receipt are clamped rather than believed", async () => {
  const { lensRecipeReceipt } = await import("../src/worker/lens-recipes.ts");
  const wrap = (json) => `<script type="application/lens-receipt" id="lens-recipe-receipt">${json}</script>`;
  const read = (json) => lensRecipeReceipt(wrap(json), "n").receipt;
  assert.equal(read('{"n":"n","acted":"12","scanned":0,"note":"acted"}').acted, 0, "a string is not a count");
  assert.equal(read('{"n":"n","acted":1e9,"scanned":0,"note":"acted"}').acted, 100000, "clamped, not believed");
  assert.equal(read('{"n":"n","acted":-5,"scanned":0,"note":"acted"}').acted, 0);
  assert.equal(read('{"n":"n","acted":1,"scanned":0,"note":"whatever"}').note, "unknown", "an unknown note is not echoed");
  assert.equal(lensRecipeReceipt("<p>no receipt here</p>", "n").receipt, null);
  assert.equal(lensRecipeReceipt(wrap("{not json"), "n").receipt, null);
});

test("a recipe that finds nothing, or never runs, is a 200 and says which", async () => {
  // Both are successful observations. Reporting either as an error would teach
  // the reader to distrust the instrument on the pages where it is most useful.
  const nothing = await handleLensBrowser(
    browserReq("&do=expand"),
    recipeEnv('<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"REPLACED","acted":0,"scanned":12,"note":"none-found"}</script></body></html>'),
    context(),
  );
  assert.equal(nothing.status, 200);
  // The nonce will not match, so this lands as forged; what matters here is the
  // status and that a body came back. The no-receipt path is the real case:
  const blind = await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html><body><p>a b c</p></body></html>"), context());
  const body = await blind.json();
  assert.equal(blind.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "no-receipt", "a CSP-refused injection is reported, not hidden");
  assert.equal(body.tally.words, 3, "and the snapshot itself is still returned in full");
});

test("a recipe run caches beside the plain snapshot, never on top of it", async () => {
  // The plain key keeps its exact legacy shape. Changing its format would
  // invalidate the whole namespace in one deploy and buy a wave of fresh Quick
  // Actions against a budget of ten browser-minutes a day.
  const writes = [];
  const kv = {
    get: async () => null,
    put: async (k, _v, o) => { writes.push([k, o]); },
  };
  const env = { ...recipeEnv("<html></html>"), RN_KV: kv };
  await handleLensBrowser(browserReq(""), env, context());
  await handleLensBrowser(browserReq("&do=expand"), env, context());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(writes.length, 2);
  assert.match(writes[0][0], /^lens:browser:[0-9a-f]{64}$/, "the plain key shape is load-bearing");
  assert.equal(writes[1][0], writes[0][0] + ":expand", "a recipe appends, so the plain entry survives as the before");
  // 6h, raised from 15 minutes on 2026-08-14. Deliberately a LITERAL rather than
  // an imported constant: the number is the budget control for the most
  // expensive call this site can make, so changing it should cost a visible edit
  // here. A test that imported the value would agree with any future change.
  // Keep it equal to /lens/shot and /lens/wire, which both sit at 21600.
  assert.equal(writes[0][1].expirationTtl, 21600);
  assert.equal(writes[1][1].expirationTtl, 21600);
});

test("the before comes from the cached plain snapshot, and is never manufactured", async () => {
  // Rendering a before on demand would be two Quick Actions for one click.
  let quickActions = 0;
  const plain = { ok: true, tally: { words: 210, headings: 2, links: 14, images: 3, jsonld: 0 } };
  const env = {
    BROWSER: { async quickAction() { quickActions++; return Response.json({ result: { content: "<html><body>a b c</body></html>" }, meta: {} }); } },
    RN_KV: { get: async (k) => (k.endsWith(":expand") ? null : plain), put: async () => {} },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(quickActions, 1, "one click must cost exactly one render");
  assert.deepEqual(body.interaction.before, plain.tally);
  assert.equal(body.interaction.beforeSource, "kv");

  // And with no plain entry, no delta is claimed rather than a zero invented.
  const bare = { ...env, RN_KV: { get: async () => null, put: async () => {} } };
  const alone = await (await handleLensBrowser(browserReq("&do=expand"), bare, context())).json();
  assert.equal(alone.interaction.before, null);
  assert.equal(alone.interaction.beforeSource, "none");
});

test("a recipe run bills against the same two buckets as a plain one", async () => {
  // A third bucket would let one visitor stack 3 plain + 3 recipe renders a
  // minute while the shared ceiling is 4, so the per-IP limit would stop
  // bounding anything. This repo has already made that mistake once.
  for (const spent of ["LENS_RL_BROWSER", "LENS_RL_BROWSER_ALL"]) {
    let called = false;
    const env = {
      BROWSER: { quickAction: async () => { called = true; return Response.json({}); } },
      [spent]: { limit: async () => ({ success: false }) },
    };
    const response = await handleLensBrowser(browserReq("&do=expand"), env, context());
    assert.equal(response.status, 429, `${spent} must bound the recipe path too`);
    assert.equal(called, false, `${spent} must short-circuit before the render`);
  }
});


test("site search and JSON contract share the generated corpus", async () => {
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }] },
  }) };
  const result = await searchSite(env, "cloudflare", 5);
  assert.equal(result.total, 1);
  assert.equal(result.results[0].url, "/writing/agents");
  const response = await handleSearchJson(new Request("https://aadhar.sh/search.json?q=cloudflare"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).returned, 1);
  assert.equal((await handleSearchJson(new Request("https://aadhar.sh/search.json"), env)).status, 400);
});

test("the buildable utility shells preserve their no-JS forms", async () => {
  const run = await renderRun().text();
  assert.match(run, /<form action="\/run" method="get">/);
  assert.match(run, /name="cmd"/);
  assert.match(run, /<meta name="robots" content="noindex">/);

  const search = await renderSearchPage().text();
  assert.match(search, /<form method="get" action="\/search"/);
  assert.match(search, /name="q"/);
  assert.match(search, /Search the public pages/);
});

test("photo query filters public metadata and never exposes unlisted fields", async () => {
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": { A: { camera: "X-T50", lens: "XF18mm", film: "Classic Chrome", date: "2026:01:02", gps: "secret" }, B: { camera: "Leica", film: "Monochrome", date: "2025:01:02" } },
    "/images/alt.json": { A: "a blue car", B: "a lamp" },
    "/images/hashes.json": { A: { a: "aaaa", j: "bbbb", s: "cccc" }, B: { a: "dddd", j: "eeee", s: "ffff" } },
  }) };
  const result = await queryPhotos(env, { camera: "x-t50", film: "chrome", limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  assert.equal(result.photos[0].thumb.small, "/i/A-400.cccc.avif");
  assert.equal("gps" in result.photos[0].metadata, false);
  const response = await handlePhotoQuery(new Request("https://aadhar.sh/photos/query.json?q=car"), env, context());
  assert.equal(response.status, 200);
});

// The archive the ranking tests run against. B exists to be a plausible WRONG
// answer for "classic chrome": it carries both words in its caption without
// being a Classic Chrome frame, which is exactly the confusion a joined
// haystack cannot resolve and a field weighting can.
function rankingEnv() {
  _resetPhotoCaches();
  return { ASSETS: staticAssets({
    "/images/metadata.json": {
      A: { camera: "X-T50", lens: "XF27mm", film: "Classic Chrome", date: "2026:01:02" },
      B: { camera: "Leica Q3", lens: "Summilux", film: "Monochrome", date: "2025:01:02" },
      C: { camera: "X-T50", lens: "XF18mm", film: "Classic Chrome", date: "2024:05:05" },
    },
    "/images/alt.json": {
      A: "a bridge over a river",
      B: "a chrome bumper on a classic car",
      C: "a lamp on a desk",
    },
    "/images/hashes.json": {},
  }) };
}

test("photo query scores each term independently instead of matching one substring", async () => {
  // The regression this whole path exists for. The old haystack joined five
  // fields and required `q` to appear inside the result CONTIGUOUSLY, so a
  // query naming a film simulation and a subject could never match a photo that
  // had both — the words were present but not adjacent.
  const result = await queryPhotos(rankingEnv(), { q: "classic chrome bridge" });
  assert.equal(result.ranking.mode, "all-terms");
  assert.deepEqual(result.ranking.terms, ["classic", "chrome", "bridge"]);
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  // Scored on the film simulation AND the caption, which is the claim.
  assert.deepEqual(result.photos[0].matched.slice().sort(), ["alt", "film"]);
});

test("photo ranking prefers the film simulation over the same words in a caption", async () => {
  const result = await queryPhotos(rankingEnv(), { q: "classic chrome" });
  assert.equal(result.total, 3, "all three mention both words somewhere");
  // A and C are genuine Classic Chrome frames and outrank B, whose caption
  // merely contains the words. A leads C on date, both leading B on score.
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C", "B"]);
  assert.ok(result.photos[0].score > result.photos[2].score);
  assert.deepEqual(result.photos[2].matched, ["alt"]);
});

test("photo query reports partial coverage rather than silently widening", async () => {
  // "sunset" is in no field, so nothing covers both terms. The partial set is
  // still the best available answer and comes back labelled as partial.
  const result = await queryPhotos(rankingEnv(), { q: "monochrome sunset" });
  assert.equal(result.ranking.mode, "partial");
  assert.equal(result.photos[0].stem, "B");
  assert.equal(result.photos[0].matched.includes("film"), true);
  // Nothing matched at all is a different answer from partially matched, and a
  // caller deciding whether to broaden its query needs the two kept apart.
  const none = await queryPhotos(rankingEnv(), { q: "aurora borealis" });
  assert.equal(none.ranking.mode, "no-match");
  assert.equal(none.total, 0);
});

test("word boundaries keep chrome out of monochrome", async () => {
  // A plain substring test passes every other assertion in this file and still
  // scores every black-and-white frame as a Classic Chrome match, at the FILM
  // weight — the highest there is — so the false hits outrank the true ones.
  const result = await queryPhotos(rankingEnv(), { q: "chrome" });
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C", "B"]);
  assert.equal(result.photos.find((photo) => photo.stem === "B").matched.includes("film"), false,
    "B is a Monochrome frame and must not match on film");
  // The digit-gated substring escape stays open for part numbers, which live
  // inside a larger alphanumeric run with no boundary to match on.
  const lens = await queryPhotos(rankingEnv(), { q: "27mm" });
  assert.equal(lens.total, 1);
  assert.equal(lens.photos[0].stem, "A");
});

test("photo query drops stopwords and says which it dropped", async () => {
  const result = await queryPhotos(rankingEnv(), { q: "show me photos of a bridge" });
  assert.deepEqual(result.ranking.terms, ["bridge"]);
  assert.ok(result.ranking.dropped.includes("photos"));
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  // A query that is nothing BUT stopwords must not score every photo on noise.
  const empty = await queryPhotos(rankingEnv(), { q: "show me some photos" });
  assert.equal(empty.ranking.mode, "no-terms");
  assert.equal(empty.total, 0);
});

test("photo query omits score entirely when nothing was ranked", async () => {
  // Absent, not zero — the same rule lens follows for a phase it never ran.
  const result = await queryPhotos(rankingEnv(), { film: "classic" });
  assert.equal(result.ranking.mode, "filters-only");
  assert.equal(result.total, 2);
  assert.equal("score" in result.photos[0], false);
  assert.equal("matched" in result.photos[0], false);
  // Filters stay exact even while `q` is ranked, so a filter cannot be widened
  // into a near miss.
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C"]);
});

test("a term that matches most of the corpus in a field stops counting there", async () => {
  // The live failure: every Fuji recipe card carries "Exposure Compensation",
  // so "long exposure" matched "exposure" in 151 of 158 cards and returned the
  // entire archive ranked by a word that distinguished nothing. Nothing in the
  // archive is a long exposure, so the only correct total is zero.
  _resetPhotoCaches();
  const metadata = {};
  const alt = {};
  for (let i = 0; i < 8; i += 1) {
    metadata[`P${i}`] = {
      camera: "X-T50", film: i < 4 ? "Classic Chrome" : "Nostalgic Neg",
      date: `2026:01:0${i + 1}`,
      recipe: { "Exposure Compensation": "0", "Color Chrome Effect": "Strong" },
    };
    alt[`P${i}`] = "a street";
  }
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": metadata, "/images/alt.json": alt, "/images/hashes.json": {},
  }) };
  const flood = await queryPhotos(env, { q: "long exposure" });
  assert.equal(flood.total, 0, "a universal recipe word must not drag in the archive");
  assert.equal(flood.ranking.mode, "no-match");
  assert.deepEqual(flood.ranking.common, ["exposure"]);

  // Suppression is per FIELD, not per term. "chrome" is in all 8 recipe cards
  // AND is the film simulation of 4 of them; killing the term outright would
  // blind the query to exactly the photos it describes best.
  _resetPhotoCaches();
  const film = await queryPhotos(env, { q: "classic chrome" });
  assert.equal(film.total, 4);
  assert.deepEqual(film.photos[0].matched, ["film"]);
  assert.equal("common" in film.ranking, false);

  // A term nothing has is ABSENT, not common, and the two must not be conflated
  // — one says broaden your query, the other says this word is useless here.
  _resetPhotoCaches();
  const missing = await queryPhotos(env, { q: "aurora" });
  assert.equal(missing.ranking.mode, "no-match");
  assert.equal("common" in missing.ranking, false);
});

test("photo query reports whether the offline semantic tier is present", async () => {
  const bare = await queryPhotos(rankingEnv(), { q: "bridge" });
  assert.equal(bare.ranking.semantic, false, "no semantics.json shipped");
  _resetPhotoCaches();
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": { A: { camera: "X-T50", film: "Classic Chrome", date: "2026:01:02" } },
    "/images/alt.json": { A: "a bridge over a river" },
    "/images/hashes.json": {},
    "/images/semantics.json": { A: { terms: "span crossing viaduct overpass" } },
  }) };
  const expanded = await queryPhotos(env, { q: "viaduct" });
  assert.equal(expanded.ranking.semantic, true);
  assert.equal(expanded.total, 1, "matched a word that appears in no caption or EXIF field");
  assert.deepEqual(expanded.photos[0].matched, ["expansion"]);
});

function coffeeEnv() {
  const snapshot = { busy: [], ts: Date.now() };
  return {
    HOST_TIMEZONE: "America/New_York", WORKING_HOURS_START: "9", WORKING_HOURS_END: "18",
    WORKING_DAYS: "1,2,3,4,5", SLOT_MINUTES: "30", BUFFER_MINUTES: "15",
    MIN_NOTICE_HOURS: "0", MAX_LOOKAHEAD_DAYS: "2", DAILY_LIMIT: "3", WEEKLY_LIMIT: "5",
    // listHeld pages KV with list({ prefix: "held:" }), one key per held slot.
    // An empty first page is the "nothing booked" fixture.
    BOOKINGS: {
      async get(key, typeOrOptions) { if (key === "cal:busy" && kvType(typeOrOptions) === "json") return snapshot; return null; },
      async list() { return { keys: [], list_complete: true, cursor: null }; },
    },
  };
}

test("coffee availability reuses the booking slot calculation and returns a safe shape", async () => {
  const payload = await getPublicAvailability(coffeeEnv(), context());
  assert.equal(payload.available, true);
  assert.equal(payload.timezone, "America/New_York");
  assert.ok(Array.isArray(payload.slots));
  assert.ok(payload.slots.every((slot) => slot.start.endsWith("Z") && slot.durationMinutes === 30));
  const response = await handleCoffeeAvailability(new Request("https://aadhar.sh/coffee/availability.json"), coffeeEnv(), context());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
});

test("Lens comparison rejects invalid targets before any fetch", async () => {
  const response = await handleLensCompare(new Request("https://aadhar.sh/lens/compare.json?left=javascript%3Aalert(1)&right=https%3A%2F%2Fexample.com"), {}, context());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
});

test("site MCP exposes one read-only tool catalog and calls shared search", async () => {
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }] },
  }) };
  const initialize = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), headers: { "content-type": "application/json" } }), env, context());
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.serverInfo.name, "aadhar.sh");
  const call = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_site", arguments: { q: "cloudflare" } } }), headers: { "content-type": "application/json" } }), env, context());
  const callBody = await call.json();
  assert.equal(callBody.result.structuredContent.returned, 1);
  assert.equal((await handleSiteMcp(new Request("https://aadhar.sh/mcp"), env, context())).status, 405);
});

// The annotations are a CLAIM made to every client that lists this server, so
// the test names the exceptions instead of asserting one shape over all of them.
// A blanket "everything is read-only" assertion passed right up until the vault
// tools landed, and would have kept passing while advertising a tool that writes
// a D1 row as read-only.
const MCP_WRITE_TOOLS = new Set(["representation_capture", "representation_compare"]);

test("MCP tools publish honest client metadata for calling and WebMCP", async () => {
  const response = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "metadata", method: "tools/list", params: { ...MODERN_META },
  }), {}, context());
  const listed = (await response.json()).result.tools;
  assert.deepEqual(listed, SITE_MCP_TOOLS, "tools/list must expose the canonical decorated registry");
  assert.equal(listed.length, 25);
  for (const tool of listed) {
    assert.ok(tool.title, `${tool.name} needs a human-readable title`);
    const writes = MCP_WRITE_TOOLS.has(tool.name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: !writes,
      destructiveHint: false,
      idempotentHint: !writes,
      openWorldHint: tool.annotations.openWorldHint,
    }, `${tool.name} annotations must be explicit`);
    assert.deepEqual(tool.outputSchema, { type: "object", additionalProperties: true }, `${tool.name} needs an object output schema`);
    // A write must ALSO say so in its description, because Cloudflare's WebMCP
    // bridge registers {name, description, inputSchema, execute} and drops
    // `annotations` entirely — a browser agent never sees the flags asserted
    // above. Description is the only field that reaches it, so the two have to
    // agree. Asserting both directions is the point: prose on a read-only tool
    // would be a false warning, and that rots as quietly as a missing one.
    assert.equal(
      /\bWrites:/.test(tool.description), writes,
      writes
        ? `${tool.name} writes, so its description must carry the "Writes:" clause the WebMCP bridge can actually see`
        : `${tool.name} is read-only but its description claims it writes`,
    );
  }
  assert.equal(listed.find((tool) => tool.name === "lens_inspect").annotations.openWorldHint, true);
  assert.equal(listed.find((tool) => tool.name === "search_site").annotations.openWorldHint, false);
  // Every tool that can be handed a caller-supplied URL reaches off this origin,
  // and that is the whole meaning of openWorldHint. Pinning the set here is what
  // makes the omission loud the next time a fetching tool is added.
  for (const name of ["image_transform", "photo_recipe", "representation_capture"]) {
    assert.equal(listed.find((tool) => tool.name === name).annotations.openWorldHint, true, `${name} fetches caller-supplied URLs`);
  }
});

test("site MCP image workbench returns an image content block and exact receipt", async () => {
  const env = { IMAGES: fakeImages() };
  const list = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), headers: { "content-type": "application/json" } }), env, context());
  const names = (await list.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("image_inspect"));
  assert.ok(names.includes("image_transform"));
  assert.ok(names.includes("image_compare"));
  const call = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_transform", arguments: { image_data: "aGVsbG8=", preset: "thumbnail" } } }), headers: { "content-type": "application/json" } }), env, context());
  const body = await call.json();
  assert.equal(body.result.structuredContent.engine, "cloudflare-images");
  assert.equal(body.result.content[1].type, "image");
  assert.equal(body.result.content[1].mimeType, "image/avif");
});

test("image_compare encodes independent formats in one binding latency window", async () => {
  let active = 0;
  let peak = 0;
  const env = { IMAGES: {
    async info(bytes) { return { format: "jpeg", width: 1, height: 1, fileSize: bytes.byteLength }; },
    input() {
      return {
        transform() { return this; },
        output(options) { return { response: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return new Response(options.format, { headers: { "content-type": options.format } });
        } }; },
      };
    },
  } };

  const result = await imageCompare({ image_data: "aGVsbG8=", formats: ["avif", "webp", "jpeg"] }, env);
  assert.ok("_mcp" in result);
  assert.equal(result._mcp.structured.variants.length, 3);
  assert.equal(peak, 3, "all three Images pipelines should overlap");
});

test("photo_recipe only claims exact archive identities", async () => {
  const metadata = JSON.parse(readFileSync("public/images/metadata.json", "utf8"));
  const hashes = JSON.parse(readFileSync("public/images/hashes.json", "utf8"));
  const alt = JSON.parse(readFileSync("public/images/alt.json", "utf8"));
  const fingerprints = JSON.parse(readFileSync("public/images/fingerprints.json", "utf8"));
  const stem = Object.keys(metadata)[0];
  const env = { ASSETS: staticAssets({ "/images/metadata.json": metadata, "/images/hashes.json": hashes, "/images/alt.json": alt, "/images/fingerprints.json": fingerprints }) };
  const exact = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "photo_recipe", arguments: { stem } } }), headers: { "content-type": "application/json" } }), env, context());
  const exactBody = await exact.json();
  assert.equal(exactBody.result.structuredContent.matched, true);
  assert.equal(exactBody.result.structuredContent.photo.stem, stem);
  assert.equal("gps" in exactBody.result.structuredContent.photo.metadata, false);
  const jpgPath = `public/i/${stem}.${hashes[stem].j}.jpg`;
  const bytes = readFileSync(jpgPath).toString("base64");
  const byBytes = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: bytes } } }), headers: { "content-type": "application/json" } }), env, context());
  const byBytesBody = await byBytes.json();
  assert.equal(byBytesBody.result.structuredContent.matched, true);
  assert.equal(byBytesBody.result.structuredContent.photo.matchKind, "published-thumbnail");
  assert.equal(byBytesBody.result.structuredContent.photo.matchedTier, "j");
  const miss = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: "aGVsbG8=" } } }), headers: { "content-type": "application/json" } }), env, context());
  const missBody = await miss.json();
  assert.equal(missBody.result.structuredContent.matched, false);
});

test("photo_recipe fetches only the indexes its lookup can use, without a serial asset waterfall", async () => {
  const files = {
    "/images/metadata.json": { L1000069_3: { camera: "Leica M11" } },
    "/images/hashes.json": { L1000069_3: { a: "aaaa", j: "bbbb", s: "cccc" } },
    "/images/alt.json": { L1000069_3: "a test frame" },
    "/images/fingerprints.json": {},
  };
  let active = 0;
  let peak = 0;
  const paths = [];
  const env = { ASSETS: { async fetch(input) {
    const path = new URL(input).pathname;
    paths.push(path);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return Response.json(files[path]);
  } } };

  const exact = await photoRecipe({ stem: "L1000069_3" }, env);
  assert.ok("matched" in exact);
  assert.equal(exact.matched, true);
  assert.deepEqual(paths.slice().sort(), ["/images/alt.json", "/images/hashes.json", "/images/metadata.json"]);
  assert.equal(peak, 3, "the independent projection reads should overlap");

  paths.length = 0;
  peak = 0;
  const miss = await photoRecipe({ image_data: "aGVsbG8=" }, env);
  assert.ok("matched" in miss);
  assert.equal(miss.matched, false);
  assert.deepEqual(paths, ["/images/fingerprints.json"], "a byte miss should not load an unused projection");
});

test("representation vault stores normalized snapshots and compares digests", async () => {
  const db = representationD1();
  const realFetch = globalThis.fetch;
  let version = "one";
  let active = 0;
  let peak = 0;
  testGlobals.fetch = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return new Response(`<!doctype html><title>${version}</title><p>${version}</p>`, { headers: { "content-type": "text/html; charset=utf-8", etag: `"${version}"`, "cache-control": "public, max-age=60" } });
  };
  try {
    const env = { RESTORE_DB: db };
    const capture = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "representation_capture", arguments: { url: "https://example.com/page", profiles: ["browser", "identity"] } } }), headers: { "content-type": "application/json" } }), env, context());
    const captured = (await capture.json()).result.structuredContent;
    const first = captured.snapshots[0];
    assert.equal(captured.snapshots.length, 2);
    assert.equal(peak, 2, "two requested origin profiles should share one network latency window");
    assert.equal(db.batchCount, 1, "successful profile rows should use one D1 batch");
    assert.ok(first.id);
    assert.equal(first.title, "one");
    assert.equal(db.rows[0].body, undefined);
    version = "two";
    const compare = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "representation_compare", arguments: { snapshot_id: first.id } } }), headers: { "content-type": "application/json" } }), env, context());
    const compared = (await compare.json()).result.structuredContent;
    assert.equal(compared.changed, true);
    assert.ok(compared.changes.body_hash);
  } finally { testGlobals.fetch = realFetch; }
});
