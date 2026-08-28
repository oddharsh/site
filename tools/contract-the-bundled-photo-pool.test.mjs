// ── the bundled photo pool ──────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  ROOT,
  assert,
  cachedRender,
  derivePhotoPool,
  existsSync,
  getImagesManifest,
  ifNoneMatchMatches,
  notModifiedIfFresh,
  readFile,
  readFileSync,
  readdir,
  renderPhotoSlots,
  test,
  withWeakEtag,
} from "./contract-shared.ts";

// ── the bundled photo pool ──────────────────────────────────────────
// The pool is BUILD DATA: photos.js imports photo-index.json + hashes.json and
// derives the render-ready rows at module scope. These tests run the real
// derivation over the real committed files, so a half-run pipeline (an index
// entry without hashes, a hash without an index entry, a malformed /i/ URL)
// fails here as well as in check-photo-pipeline.mjs — the worker and the
// checker must not be able to disagree about what is published.
test("bundled photo pool derives one well-formed row per committed stem", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const pool = derivePhotoPool(index, hashes);
  assert.equal(pool.length, Object.keys(index).length, "every indexed stem must derive a row");
  assert.equal(pool.length, Object.keys(hashes).length, "index and hashes must be in bijection");
  for (const p of pool) {
    assert.match(p.thumb_avif, new RegExp(`^/i/${p.stem}\\.[a-f0-9]{8}\\.avif$`));
    assert.match(p.thumb_jpg, new RegExp(`^/i/${p.stem}\\.[a-f0-9]{8}\\.jpg$`));
    assert.match(p.thumb_small, new RegExp(`^/i/${p.stem}-400\\.[a-f0-9]{8}\\.avif$`));
    assert.ok(p.full.startsWith(`${p.stem}.`), `${p.stem}: full must be the stem's R2 key`);
    assert.ok(Number.isInteger(p.size) && p.size > 0, `${p.stem}: size must be positive bytes`);
  }
  const fulls = pool.map((p) => p.full);
  assert.deepEqual(fulls, [...fulls].sort((a, b) => a.localeCompare(b)), "pool keeps the manifest's sort order");
  // an incomplete hash entry is SKIPPED, never rendered as /i/undefined
  assert.equal(derivePhotoPool({ X1: { full: "X1.jpg", size: 1, uploaded: null } }, { X1: { a: "aaaaaaaa" } }).length, 0);
});

test("getImagesManifest serves the bundled pool without env", async () => {
  // no env, no ctx: the pool must not depend on any binding
  const pool = await getImagesManifest(undefined, undefined);
  assert.ok(Array.isArray(pool) && pool.length > 0);
});

test("both homepage fragments are preloaded, and the reason that is free still holds", async () => {
  const page = await readFile(new URL("src/pages/index.html", ROOT), "utf8");

  // `crossorigin` is load-bearing even same-origin: without it the preload is
  // mode "no-cors" and will NOT match the hydrator's fetch(), whose default is
  // "cors". The two would not dedupe and the page would fetch each fragment
  // TWICE, turning a latency win into an extra request for every visitor.
  for (const href of ["/photos/grid.html", "/rn/tracks.html"]) {
    assert.match(page, new RegExp(
      `<link rel="preload" as="fetch" href="${href}" crossorigin>`),
      `${href} must be preloaded with crossorigin, or its hydrator fetch is made twice`);
  }

  // A preload can only ever be free while the fetch it names is UNCONDITIONAL.
  // The tracks hydrator is guarded on data-ssr="0", which is currently vacuous
  // because the worker no longer server-renders the playlist at all. If SSR ever
  // comes back, the guard starts declining and this preload starts paying for a
  // fragment nobody fetches, so pin the premise rather than trust the comment:
  // the last two times this stopped being true, only the comments knew.
  assert.match(page, /<ol class="np-list" id="np-list" data-ssr="0">/,
    "the document must ship data-ssr='0', or the preloaded fragment goes unfetched");
  const workerDir = new URL("src/worker/", ROOT);
  for (const file of await readdir(workerDir)) {
    if (!file.endsWith(".js")) continue;
    const src = await readFile(new URL(file, workerDir), "utf8");
    assert.doesNotMatch(src, /SSR_DEADLINE_MS|serveHomepageWithPrerenderedTracks/,
      `${file} reintroduces homepage SSR; revisit the /rn/tracks.html preload and the comments that call the fetch unconditional`);
  }
});

test("homepage selects 12 photos and transfers all of them", async () => {
  const worker = await readFile(new URL("src/worker/home.ts", ROOT), "utf8");
  const page = await readFile(new URL("src/pages/index.html", ROOT), "utf8");
  const luna = await readFile(new URL("src/styles/luna.css", ROOT), "utf8");
  const nav = await readFile(new URL("src/client/nav.js", ROOT), "utf8");
  const hoist = await readFile(new URL("src/client/hoist.js", ROOT), "utf8");
  const tooltip = await readFile(new URL("src/client/tooltip.js", ROOT), "utf8");

  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(worker, /pickRandom\(pool,\s*12\)/, "the per-request random draw must remain 12");
  assert.match(build, /deterministicTwelve/, "the document must carry a baked fallback grid, or `/` stops being crawlable without JS");
  // The two renderings differ in exactly one way, so assert on the OUTPUT
  // rather than on the source that produces it.
  const photo = [{ stem: "X1", full: "X1.jpg", thumb_jpg: "/i/X1.aaaaaaaa.jpg", thumb_avif: "/i/X1.aaaaaaaa.avif", thumb_small: "/i/X1-400.aaaaaaaa.avif", thumb_xs: "/i/X1-200.aaaaaaaa.avif", size: 1, uploaded: "2026-01-01" }];
  const baked = renderPhotoSlots(photo, {});
  const fragment = renderPhotoSlots(photo, {}, { deferred: false });

  // Baked: a fallback the hydrator replaces, so a real src outside the
  // <noscript> twin is a thumbnail fetched and discarded milliseconds later.
  assert.match(baked, /data-photo-deferred/, "baked tiles must keep their URLs in data-* until hydration decides");
  assert.match(baked, /data-src="\/i\/X1-400\.aaaaaaaa\.avif"/, "the baked tile carries its one 400px AVIF in data-src");
  assert.match(baked, /data-srcset="[^"]*200w[^"]*400w[^"]*600w[^"]*"/,
    "the baked tile's candidates ride in data-srcset, for the same reason its src does");
  assert.doesNotMatch(baked.slice(0, baked.indexOf("<noscript>")), /\ssrcset="/,
    "a real srcset outside the twin selects and fetches before the hydrator can");
  assert.match(baked, /<noscript><img/, "every baked tile needs its script-off twin");
  // ONE url in the twin too. <picture> here is safe but not free: 195 bytes a
  // tile against 130, to serve a client that must be no-JS AND no-AVIF at once,
  // when the engine this repair exists for runs JavaScript and takes the
  // onerror path instead. Tried and reverted 2026-08-12.
  assert.doesNotMatch(baked, /<noscript>[\s\S]*?<(picture|source)/,
    "the script-off twin names one image, like every other tile on this page");
  assert.doesNotMatch(baked, /<noscript>[\s\S]*?\.jpg/,
    "no JPEG ships to a browser that can decode the AVIF it is already being sent");
  assert.doesNotMatch(baked.slice(0, baked.indexOf("<noscript>")), /\ssrc="/,
    "a real src outside the noscript twin is a discarded download");

  // Fragment: these tiles ARE the grid. Nothing replaces them, so they carry
  // live URLs and start on innerHTML.
  assert.match(fragment, /\ssrc="\/i\/X1-400\.aaaaaaaa\.avif"/, "the fragment tile must carry its live 400px AVIF");
  // ONE FORMAT, which is what the old "one browser image resource" rule was
  // actually protecting. That rule banned `srcset=` too, because at the time one
  // URL and one format were the same policy. They are not: <picture>/<source>
  // select on TYPE and leave a loser to be instantiated (13 JPEG loads for one
  // tile, 2026-08-11), while srcset selects on SIZE and resolves to a single
  // candidate. Measured before this changed, 12 tiles and two full hover passes
  // at DPR 1 and 2: 0 image loads beyond the initial 12, identical to a
  // single-URL control. So the assertion now pins the invariant rather than the
  // proxy — no type selection, no JPEG, and every candidate the same format.
  assert.doesNotMatch(fragment, /<picture|<source|\ssrc="[^"]+\.jpg"/,
    "a grid tile must not select on TYPE: that is the fallback that churns on hover");
  const cands = (/\ssrcset="([^"]+)"/.exec(fragment)?.[1] || "").split(",").map((c) => c.trim()).filter(Boolean);
  assert.equal(cands.length, 3, "the fragment tile offers all three size candidates");
  for (const c of cands) assert.match(c, /\.avif \d+w$/, `every srcset candidate is one AVIF with a width descriptor: ${c}`);
  assert.match(fragment, /\ssizes="184px"/,
    "sizes must name the fixed .photos column, or the browser guesses 100vw and picks the largest tier");

  // THE BARS RIDE ON THE TILE. Measured on production before this: a photo hover
  // stalled 135ms then 117ms waiting for /images/meta/<stem>.json, once per photo,
  // with the histogram blank until it landed. It has to be in the markup rather
  // than warmed by tooltip.js, because index.html loads that module on the FIRST
  // hover on purpose, so anything it warms is too late for the hover that caused
  // the load. Controlled in a browser with /images/meta/* aborted outright: bars
  // drew on 6 of 6 hovers.
  const packed = "?".repeat(128) + "~".repeat(128);   // 256 chars, both ends of the safe range
  const withHist = renderPhotoSlots(photo, {}, { deferred: false, histograms: { X1: packed } });
  assert.match(withHist, /data-hist="/, "a tile whose histogram is known carries it");
  assert.equal(/data-hist="([^"]*)"/.exec(withHist)[1], packed, "the packed histogram ships verbatim");
  // Absent is a LEGAL state, not a failure: tooltip.js falls back to the per-photo
  // fetch, which is what a stem baked before this existed gets.
  assert.doesNotMatch(renderPhotoSlots(photo, {}, { deferred: false }), /data-hist=/,
    "a tile with no known histogram omits the attribute rather than shipping an empty one");
  assert.doesNotMatch(fragment, /data-photo-deferred|data-src=|data-srcset=/,
    "a fragment tile has nothing to defer for; leaving it deferred is how the grid went blank in an unrendered tab");

  // The live tiles stay single-URL, so an engine that cannot decode AVIF needs a
  // RECOVERY path rather than a second candidate. Measured 2026-08-12: Kitesurf
  // fetched all twelve with HTTP 200 and decoded none, and it does fire `error`,
  // which is the event this listener rides. Capture is required because `error`
  // on an <img> does not bubble, and the stem is parsed back out of the failing
  // URL so the repair costs no bytes on a tile that will never use it.
  const home = await readFile(new URL("src/pages/index.html", ROOT), "utf8");
  const repair = home.slice(home.indexOf("AVIF DECODE REPAIR"), home.indexOf("fetch(\"/photos/grid.html\")"));
  assert.ok(repair.length > 0, "the homepage must carry the AVIF decode repair");
  assert.match(repair, /addEventListener\("error"[\s\S]*\}, true\)/, "the repair must listen in the CAPTURE phase or it never fires");
  assert.match(repair, /\(\?:-\(\?:200\|400\)\)\?/, "both minted tier suffixes must be matched literally rather than as -\\d+");
  // srcset beats src, so a repair that only assigns src leaves the browser
  // re-picking the AVIF candidate it just failed to decode. Silent by nature:
  // the handler runs, the attribute changes, and the image stays broken.
  assert.match(repair, /removeAttribute\("srcset"\)/, "the repair must clear the source set before assigning src, or it does nothing");
  assert.match(repair, /dataset\.jpgTried/, "a failing JPEG must not loop back into the handler");
  assert.match(repair, /"\/images\/" \+ stem\[1\] \+ "\.jpg"/, "recover through the legacy redirect, which needs no hash in the page");
  assert.doesNotMatch(fragment, /<noscript>/, "the fragment only ever arrives via fetch(), so a script-off twin is dead bytes");
  assert.match(worker, /deferred: false/, "/photos/grid.html must render the live-URL form");

  // Priority is split WITHIN the grid, and the two halves fail differently.
  // The CEILING is the #156 invariant: the LCP element is the prose, so no tile
  // may ever be raised to high. The FLOOR is the reason the split exists: one
  // urgency bucket for all twelve is what makes the edge round-robin them, and
  // AVIF has no progressive mode, so an interleaved tile paints nothing until
  // it is whole. Assert the exact PARTITION rather than a count, because six
  // low tiles in the wrong six is the same bug wearing the right total.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...photo[0], stem: `X${i}`, full: `X${i}.jpg` }));
  const grid12 = renderPhotoSlots(twelve, {}, { deferred: false });
  const tiles = grid12.split("<a href=").slice(1);
  assert.equal(tiles.length, 12, "the fragment must render all twelve tiles");
  assert.deepEqual(
    tiles.map((t) => /fetchpriority="low"/.test(t)),
    [false, false, false, false, false, false, true, true, true, true, true, true],
    "the first six tiles ride the default urgency and the last six stay low; flattening that back to one bucket restores the fair-share interleave",
  );
  assert.doesNotMatch(grid12, /fetchpriority="high"/,
    "no photo may outrank the introductory prose, which is the measured LCP element at 390px and 1280px alike");

  // A → B → A must move A's already-loaded nodes back into the shared surface,
  // not parse a third image element. The HAR that motivated this recorded up to
  // 13 memory-cache image loads for one photo and repeated album/artist AVIFs.
  assert.match(hoist, /const rendered = new Map\(\)/);
  assert.match(hoist, /node\.replaceChildren\(\.\.\.children\)/);
  assert.doesNotMatch(hoist, /node\.innerHTML\s*=\s*html/);
  assert.doesNotMatch(tooltip, /<picture><source type="image\/avif"|dataset\.(?:track|artist)Imageset/,
    "album and artist cards must not reconstruct a picture fallback set");

  // The hover target includes the list padding and the grid gutters. Those used
  // to alternate auto/pointer under a moving cursor even though one hover system
  // owned the whole region.
  assert.match(page, /\.photos\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(luna, /\.np-list li\[data-track-title\]\s*\{\s*cursor:\s*pointer;\s*\}/);

  assert.doesNotMatch(worker, /rel="preload" as="image"/, "a non-LCP random photo must not consume the preload lane");
  assert.match(page, /fetch\("\/photos\/grid\.html"\)/, "the homepage must hydrate its random twelve");
  assert.match(page, /\.catch\(\(\) => \{\}\)\s*\.then\(boot\)/, "a failed grid fetch must still hydrate the baked tiles");
  // Removed 2026-07-29. It withheld 3 of 12 tiles to save ~34 KB out of ~136 KB,
  // and the 9 it allowed finished 48ms apart, so the row it held back showed up
  // as white squares on the first scroll for no measurable gain.
  // Matches the construction, not the word, so the comment explaining why the
  // observer is gone does not trip its own tripwire.
  assert.doesNotMatch(page, /new IntersectionObserver|rootMargin:/,
    "the photo grid must not reintroduce viewport gating; the whole set is ~136 KB off the LCP path, and the urgency split is what orders it now");
  assert.doesNotMatch(page, /requestIdleCallback\(load/, "the tooltip island must not transfer before hover intent");
  assert.match(nav, /var bar = D\.getElementById\("axp-taskbar"\);\s*if \(!bar \|\| !D\.getElementById\("axp-desktop"\)\) return;/,
    "every compiled shell must be present before nav.js enhances it");
  assert.match(nav, /prerenderDocument\.prerendering\) return boot\(\)/, "prerendered static shells must enhance before activation");
  assert.match(nav, /requestAnimationFrame\(\(\) => requestAnimationFrame\(boot\)\)/, "ordinary static shell enhancement must follow the first useful paint");
  assert.ok(
    page.indexOf('type="application/ld+json"') > page.indexOf('<section class="now-playing"'),
    "non-rendering JSON-LD belongs after the visible homepage content",
  );
  assert.match(luna, /homepage music island \(below the fold\)/);
  assert.match(luna, /homepage hover island \(non-critical\)/);
});


test("the packed histogram survives the round trip tooltip.js does", async () => {
  const { packHistogram, CHANNELS, BINS, HIST_BASE, HIST_LEVELS } = await import("../tools/photos/build-histogram-index.ts");
  const hi = {};
  for (const [ci, c] of CHANNELS.entries()) hi[c] = Array.from({ length: BINS }, (_, i) => (i * 7 + ci * 13) % 101);
  const packed = packHistogram(hi);
  assert.equal(packed.length, CHANNELS.length * BINS, "one character per bin, no padding");

  // The exact decode tooltip.js runs.
  const decode = (s, ci, i) => Math.round((s.charCodeAt(ci * BINS + i) - HIST_BASE) * 100 / (HIST_LEVELS - 1));
  let worst = 0;
  for (const [ci, c] of CHANNELS.entries()) {
    for (let i = 0; i < BINS; i++) worst = Math.max(worst, Math.abs(decode(packed, ci, i) - hi[c][i]));
  }
  // 64 levels over a 0-100 source, rendered into a 32-unit-tall SVG, so one
  // level is half a pixel and this bound is the whole quality argument.
  assert.ok(worst <= 1, `round trip is within one unit of 100, got ${worst}`);

  // THE ENCODING'S SAFETY IS STRUCTURAL, not a property of the current data:
  // 63..126 holds none of & < > " (34, 38, 60, 62), so the attribute can never
  // need escaping. Asserted over every committed histogram rather than a
  // fixture, because the day this breaks is the day a bin goes out of range.
  const committed = JSON.parse(readFileSync("public/images/histograms.json", "utf8"));
  const stems = Object.keys(committed);
  assert.ok(stems.length > 100, `expected the real corpus, got ${stems.length} entries`);
  for (const stem of stems) {
    const v = committed[stem];
    assert.equal(v.length, CHANNELS.length * BINS, `${stem} packs to one character per bin`);
    assert.doesNotMatch(v, /["&<>]/, `${stem} carries no character that would need escaping in an attribute`);
    for (let i = 0; i < v.length; i++) {
      const code = v.charCodeAt(i);
      assert.ok(code >= HIST_BASE && code < HIST_BASE + HIST_LEVELS,
        `${stem} character ${i} is inside the safe range`);
    }
  }

  // A malformed channel yields null rather than a plausible wrong shape, which is
  // the same rule the photo pipeline follows everywhere: skip what you cannot
  // state, never fabricate it.
  assert.equal(packHistogram({ l: [1, 2], r: [], g: [], b: [] }), null, "a short channel packs to null");
  assert.equal(packHistogram(null), null, "no histogram packs to null");
});

test("robots.txt never forbids a path the site advertises to agents", async () => {
  // Found by a Cloudflare agent-readiness scan on 2026-08-07, which counted
  // </rn/tracks>; rel="service-desc" toward a discoverability PASS while
  // robots.txt carried `Disallow: /rn/tracks`. Sixteen conflicts across six
  // surfaces at the time. Both sides are this site's own declarations, so one of
  // them was always going to be a lie, and neither side can see the other.
  //
  // The rule is about FETCHING, not indexing: a path that should stay out of a
  // search index says so with X-Robots-Tag, which a crawler can only read if it
  // is allowed to fetch the response carrying it.
  const read = (p) => readFile(new URL(p, ROOT), "utf8");
  const robots = await read("public/robots.txt");

  const disallowed = [...new Set(
    robots.split("\n").filter((l) => /^Disallow:/i.test(l)).map((l) => l.slice(9).trim()),
  )];
  assert.ok(disallowed.length, "robots.txt must still carry Disallow rules");
  // The action endpoints. Nothing advertises them and nothing should.
  assert.deepEqual(disallowed.sort(), ["/lwe/ask", "/rn/admin", "/rn/set"]);

  const { HOMEPAGE_DISCOVERY_LINK } = await import("../src/worker/lib/security.ts");
  const surfaces = {
    "the homepage Link header": HOMEPAGE_DISCOVERY_LINK,
    "_headers":                 await read("public/_headers"),
    ".well-known/api-catalog":  await read("public/.well-known/api-catalog"),
    "agent-card.json":          await read("public/.well-known/agent-card.json"),
    "auth.md":                  await read("src/content/auth.md"),
    "llms.txt":                 await read("public/llms.txt"),
  };

  for (const [name, text] of Object.entries(surfaces)) {
    const advertised = new Set();
    // absolute URLs (auth.md, llms.txt, the JSON catalogs) …
    for (const m of text.matchAll(/https:\/\/aadhar\.sh(\/[^\s"'`)>,]*)/g)) advertised.add(m[1]);
    // … and RFC 8288 Link targets, which are relative here
    for (const m of text.matchAll(/<(\/[^\s">]*)>\s*;\s*rel=/g)) advertised.add(m[1]);
    for (const path of advertised) {
      // robots.txt prefix semantics: /around also covers /around/json. Match the
      // separator too, so /aroundabout would not count as blocked by /around.
      const rule = disallowed.find((d) => path === d || path.startsWith(`${d}/`) || path.startsWith(`${d}.`));
      assert.ok(!rule, `${name} advertises ${path}, which robots.txt blocks with Disallow: ${rule}`);
    }
  }
});

test("browser RUM and its ledger proxy stay fully removed", async () => {
  const page = await readFile(new URL("src/pages/index.html", ROOT), "utf8");
  const worker = await readFile(new URL("src/worker/index.ts", ROOT), "utf8");
  const wrangler = await readFile(new URL("wrangler.jsonc", ROOT), "utf8");
  const wranglerDev = await readFile(new URL("wrangler.dev.jsonc", ROOT), "utf8");
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  const whoareyou = await readFile(new URL("src/worker/whoareyou.ts", ROOT), "utf8");
  const whoareyouMd = await readFile(new URL("src/content/md/whoareyou.md", ROOT), "utf8");
  const securityPage = await readFile(new URL("src/worker/security.ts", ROOT), "utf8");

  // The loader, both route legs, both asset allowlists, and the dedicated module
  // are one feature. Leaving any one behind either recreates the reported 404 or
  // keeps an unused third-party forwarder exposed.
  for (const [name, source] of [
    ["index.html", page],
    ["_worker.js/index.js", worker],
    ["wrangler.jsonc", wrangler],
    ["wrangler.dev.jsonc", wranglerDev],
  ]) {
    assert.doesNotMatch(source, /\/ledger\/rum|data-cf-beacon|cloudflareinsights\.com/, `${name} must carry no browser RUM wiring`);
  }
  assert.equal(existsSync(new URL("src/worker/rum.js", ROOT)), false,
    "the retired RUM proxy module must not remain reachable for a future import");

  // The CSP must not permit the retired collector. _headers is matched as TEXT
  // (it is a literal header line). security.js is matched on the
  // policy it ASSEMBLES, because the per-document script-src work split the string
  // into pieces and a source scrape would now be checking punctuation instead of
  // the thing that reaches the browser. `/unmapped` deliberately misses the hash
  // map, so this is the fallback policy every live worker page still gets.
  const { cspHeadersFor } = await import("../src/worker/lib/security.ts");
  const assembled = cspHeadersFor("/unmapped-probe")["content-security-policy"];
  for (const [name, text] of [["_headers", headers], ["lib/security.js", assembled]]) {
    const policy = (text.match(/default-src 'self';[^"\n]*upgrade-insecure-requests/) || [])[0];
    assert.ok(policy, `${name} must still declare a CSP`);
    assert.doesNotMatch(policy, /cloudflareinsights\.com/, `${name}: keep the retired collector out of CSP`);
    assert.match(policy, /connect-src 'self';/, `${name}: connect-src should be back to pure 'self'`);
    assert.match(policy, /script-src 'self' 'unsafe-inline';/, `${name}: script-src should carry no external origin`);
    // Same rule, one directive over: album art is re-hosted behind /rn/art/, so
    // the two Spotify hosts that used to sit in img-src have nothing left to
    // serve. rn.js's artAttrs is what makes this safe (it emits no attribute for
    // art it cannot re-host) and the rn test asserts that end.
    assert.match(policy, /img-src 'self' data:;/, `${name}: img-src should be this origin only`);
    assert.doesNotMatch(policy, /scdn\.co|spotifycdn\.com/, `${name}: album art is first-party now`);
  }

  // Public disclosures must describe the new absence, not the former proxy.
  for (const [name, source] of [["/whoareyou", whoareyou], ["/whoareyou.md", whoareyouMd]]) {
    assert.match(source, /No page loads a Web Analytics or RUM beacon/, `${name} must state that browser analytics is absent`);
    assert.match(source, /Page-load\s+timings are not\s+sent to Cloudflare/, `${name} must state the data consequence`);
    assert.doesNotMatch(source, /\/ledger\/rum|forwards those timings/, `${name} must not describe the retired proxy`);
  }
  assert.match(securityPage, /no external script or connect origin/,
    "/security must keep describing the browser-facing CSP accurately");
});

// Local dev serves a SYMLINK FARM (tools/dev-stage.ts) because the served URL
// root is composed from five authored directories and assets.directory can only
// name one. That makes the farm a second definition of "the served tree", and a
// second definition is a thing that drifts: this config named a directory that
// had been deleted for a day after the 2026-08-18 split, and dev simply did not
// start. The failure this test guards is the QUIET version of that — a sixth
// root reaching production while dev keeps composing five, where dev starts fine
// and merely 404s whatever the new root holds.
test("local dev composes the same served tree the build stages", async () => {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  const { ASSET_ROOTS, FARM } = await import("./dev-stage.ts");
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  const devConfig = parseJsonc(await readFile(new URL("wrangler.dev.jsonc", ROOT), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));

  // Step 1's cp calls into .build/public ARE the production definition of the
  // served root. Read them rather than restating the list, so this test cannot
  // agree with a copy of itself (the failure mode gotcha 24 names). They run in
  // parallel now; build.ts separately blocks any path collision before staging.
  const staged = [...build.matchAll(/\bcp\("([^"]+)",\s*`\$\{OUT\}\/public`/g)].map((m) => m[1]);
  assert.ok(staged.length >= 3, "build.mjs step 1 should still stage several roots into .build/public");
  assert.ok(staged.includes("public"), "the byte-for-byte asset root must still be staged");
  // public/ is the cp with the STAGE_SKIP filter, so it matches a different
  // shape above; assert it explicitly rather than loosening the regex.
  assert.match(build, /\bcp\("public", `\$\{OUT\}\/public`/, "build.mjs must still stage public/ into the served root");
  assert.deepEqual(ASSET_ROOTS, staged,
    "dev-stage.mjs's roots must equal build.mjs step 1's, in the same canonical order");

  assert.equal(devConfig.assets.directory, FARM,
    "wrangler.dev.jsonc must serve the farm, not one authored root (pointing it at any single root 404s every document the others hold)");

  // The farm is BUILD OUTPUT with no watcher: nothing regenerates it except the
  // dev scripts, so a script that skips the stager serves whatever the last run
  // left behind, or fails to start on a clean checkout.
  for (const script of ["dev", "dev:remote"]) {
    // The RUNNER is not the point of this assertion; staging before wrangler
    // boots is. Pinning it to one interpreter is what made a toolchain swap
    // fail a test about dev-server ordering.
    assert.match(pkg.scripts[script], /(node|bun) tools\/dev-stage\.ts/,
      `${script} must stage the farm before booting wrangler`);
  }

  // It must never be committed: it is a tree of symlinks into the source, so a
  // checkout that carried it would go stale silently rather than break.
  const ignored = await readFile(new URL(".gitignore", ROOT), "utf8");
  assert.match(ignored, new RegExp(`^${FARM}$`, "m"), `${FARM} must be gitignored`);
});

test("production minifies the Worker without obscuring deployed stack traces", async () => {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  const production = parseJsonc(await readFile(new URL("wrangler.jsonc", ROOT), "utf8"));
  const development = parseJsonc(await readFile(new URL("wrangler.dev.jsonc", ROOT), "utf8"));

  assert.equal(production.minify, true,
    "production should upload the smaller minified Worker bundle");
  assert.equal(production.upload_source_maps, true,
    "production minification must keep original stack locations available to Workers Logs");
  assert.equal(development.minify, undefined,
    "local development should keep readable code and its faster edit/reload loop");
  assert.equal(development.upload_source_maps, undefined,
    "local source locations need no separately uploaded map");

  // Minifying moved the worker-bundle advisory from firing to silent WITHOUT the
  // code shrinking, which is the one way to turn that check green while every
  // constant in perf-budget.mjs holds still. The guard is a source-bytes twin
  // that a minifier cannot move, and it is asserted HERE, beside the setting
  // that made it necessary, so removing one while keeping the other fails.
  const budget = await readFile(new URL("tools/perf-budget.ts", ROOT), "utf8");
  assert.match(budget, /const WORKER_BASELINE_SOURCE_KIB = [\d.]+;/,
    "a minified production bundle needs a source-bytes baseline the minifier cannot move");
  assert.match(budget, /worker source \$\{sourceKib/,
    "the source-bytes total must be REPORTED, since a constant nothing prints guards nothing");
  assert.match(budget, /input\.bytes/,
    "the source-bytes total must read esbuild's per-input source sizes, not bytesInOutput");
  assert.match(budget, /227\.67 KiB OBSERVED/,
    "the baseline history must record the drop minification produced, or it reads as a real improvement");
});

test("weak validators turn unchanged rendered HTML into an empty 304", async () => {
  const tagged = await withWeakEtag(new Response("<!doctype html><p>same</p>", {
    headers: { "content-type": "text/html", "cache-control": "public, max-age=0", "content-encoding": "br" },
  }));
  const etag = tagged.headers.get("etag");
  assert.match(etag, /^W\/"sha256-[0-9a-f]{64}"$/);
  assert.equal(ifNoneMatchMatches(new Request("https://aadhar.sh/x", { headers: { "if-none-match": etag } }), etag), true);
  assert.equal(ifNoneMatchMatches(new Request("https://aadhar.sh/x", { headers: { "if-none-match": etag.replace(/^W\//, "") } }), etag), true);
  const notModified = notModifiedIfFresh(new Request("https://aadhar.sh/x", {
    headers: { "if-none-match": `"old", ${etag}` },
  }), tagged);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("content-encoding"), null);
  assert.equal(await notModified.text(), "");
});

test("cached renders stream the first miss while tagging the background copy", async () => {
  const priorCaches = globalThis.caches;
  const stored = [];
  testGlobals.caches = {
    default: {
      match: async () => undefined,
      put: async (_key, response) => {
        stored.push({ response, body: await response.text() });
      },
    },
  };
  const pending = [];
  try {
    const first = await cachedRender(
      new Request("https://aadhar.sh/whoareyou"),
      { waitUntil: (promise) => pending.push(promise) },
      async () => new Response("rendered", { headers: { "content-type": "text/html" } }),
      "/whoareyou",
      { CF_VERSION_METADATA: { id: "test" } },
    );
    assert.equal(first.headers.get("etag"), null, "the miss does not buffer before sending");
    assert.equal(await first.text(), "rendered");
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.match(stored[0].response.headers.get("etag"), /^W\//);
    assert.equal(stored[0].body, "rendered");
  } finally {
    if (priorCaches === undefined) delete globalThis.caches;
    else testGlobals.caches = priorCaches;
  }
});

// The twin converter reads each page's own inline CSS to find elements the page
// takes out of the inline flow, because otherwise their text welds together. It
// looked only at the element's OWN display, which a flex or grid ITEM never
// declares: its box comes from the parent. /updates converted
// `<span class=wu-tag>hit-route</span><span class=wu-desc>counter tick …</span>`
// into "hit-routecounter tick …", a string that appears nowhere on the page.
//
// buildTwins and friends were imported here and never called, so this file
// asserted nothing about any of it. Same shape as the quiz test CLAUDE.md
// describes, which read the wrong field names and passed while checking nothing.
