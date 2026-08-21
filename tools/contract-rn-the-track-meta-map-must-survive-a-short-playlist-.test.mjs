// ── rn: the track-meta map must survive a SHORT playlist read ────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  ART_VERSION,
  ROOT,
  TRACKS,
  WARM_MAX_URLS,
  artUrls,
  artWarmList,
  assert,
  assertFullDocument,
  canonicalArtUrl,
  context,
  cronEnrichTracks,
  diffAroundRows,
  handleAroundChangesJson,
  handleLensBrowser,
  handleLensFetch,
  handleLensShot,
  handleRnArt,
  handleRnTracks,
  handleRnTracksHtml,
  kvForTracks,
  lensDetectWebmcp,
  lensFieldEvidence,
  lensParseCloudflareAgentScore,
  mapWithConcurrency,
  readAroundChanges,
  readFile,
  readResponseCapped,
  renderLensShell,
  renderTrackListHtml,
  spotifyArtHash,
  test,
  warmArtCache,
} from "./contract-shared.mjs";

// ── rn: the track-meta map must survive a SHORT playlist read ────────
// Regression, 2026-08-15. The prune deleted any entry missing from
// `payload.tracks`, and `shouldStore` accepts any non-empty payload, so one
// truncated playlist embed stored a 6-track playlist as the whole thing and
// took 15 covers with it. Absence from a single read is not evidence.

function metaEnv({ tracks, meta }) {
  const store = new Map([
    ["playlist-id", "0raTdu2MZH4dNvfG5keVAL"],
    ["tracks:0raTdu2MZH4dNvfG5keVAL", JSON.stringify({ tracks, playlist_id: "0raTdu2MZH4dNvfG5keVAL" })],
    ["trackmeta:v1", JSON.stringify(meta)],
  ]);
  return {
    store,
    env: {
      RN_KV: {
        get: async (k, t) => {
          const v = store.get(k);
          if (v === undefined) return null;
          return (t === "json" || t?.type === "json") ? JSON.parse(v) : v;
        },
        put: async (k, v) => void store.set(k, v),
      },
    },
  };
}

const metaFor = (ids) => Object.fromEntries(
  ids.map((id) => [id, { image_url: `https://i.scdn.co/image/${id}`, artists: [], seen: Date.now() }])
);

test("a SHORT playlist read cannot delete track meta", async () => {
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // the payload has regressed to two tracks; the map still holds all eight
  const { store, env } = metaEnv({ tracks: [{ id: "a" }, { id: "b" }], meta: metaFor(all) });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.deepEqual(Object.keys(after).sort(), all, "a short read must delete nothing");
  for (const id of all) assert.ok(after[id].image_url, `${id} keeps its cover`);
});

test("an entry unseen past the age window is pruned, so the map stays bounded", async () => {
  const stale = 31 * 24 * 60 * 60 * 1000;
  const meta = metaFor(["a", "b"]);
  meta.b.seen = Date.now() - stale;          // dropped from the playlist a month ago
  const { store, env } = metaEnv({ tracks: [{ id: "a" }], meta });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.deepEqual(Object.keys(after), ["a"], "only the long-unseen entry goes");
});

test("an entry written before `seen` existed is stamped, never dropped", async () => {
  const meta = { a: { image_url: "https://i.scdn.co/image/a", artists: [] } };  // no `seen`
  const { store, env } = metaEnv({ tracks: [{ id: "a" }], meta });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.ok(after.a, "the upgrade must not become the outage it prevents");
  assert.equal(typeof after.a.seen, "number");
});

test("the published key directory advertises only what the bot signs with", async () => {
  const dir = JSON.parse(await readFile(new URL("./public/.well-known/http-message-signatures-directory", ROOT), "utf8"));
  // Advertising a key we no longer sign with is the dangling-pointer problem
  // the DNS-AID note refuses for `_a2a`: it passes a scanner and misleads a
  // verifier that goes looking for the label.
  assert.equal(dir.keys.some((k) => k.kty === "AKP"), false, "the retired ML-DSA key must not be published");
  const ed = dir.keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519");
  assert.ok(ed, "directory must publish the ed25519 key the bot signs sig1 with");
  assert.equal(ed.alg, "EdDSA");
  assert.equal(ed.use, "sig");
  assert.equal(Buffer.from(ed.x, "base64url").length, 32);
  assert.equal(ed.d, undefined, "a published key must never carry the seed");
});

test("bounded response reads report truncation without buffering the tail", async () => {
  const capped = await readResponseCapped(new Response("abcdef"), 3);
  assert.equal(capped.text, "abc");
  assert.equal(capped.bytesRead, 3);
  assert.equal(capped.truncated, true);

  const exact = await readResponseCapped(new Response("abc"), 3);
  assert.equal(exact.text, "abc");
  assert.equal(exact.truncated, false);
});

test("scheduled crawl fan-out respects its concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(output, [2, 4, 6, 8, 10]);
});

test("Change Radar reports normalized field and bounded-content changes", () => {
  const changes = diffAroundRows(
    { status: 200, title: "New title", body_hash: "b", robots: "allow" },
    { status: 200, title: "Old title", body_hash: "a", robots: "allow" },
  );
  assert.deepEqual(changes, [
    { field: "title", before: "Old title", after: "New title" },
    { field: "content", detail: "bounded response sample changed" },
  ]);
});

test("Change Radar keeps the latest two observations per target", async () => {
  const db = {
    prepare() {
      return {
        async all() {
          return { results: [
            { target: "https://example.com/", name: "Example", observed_at: 2000, status: 503, title: null, body_hash: null, robots: "allow" },
            { target: "https://example.com/", name: "Example", observed_at: 1000, status: 200, title: "Example", body_hash: "a", robots: "allow" },
          ] };
        },
      };
    },
  };
  const payload = await readAroundChanges({ RESTORE_DB: db });
  assert.equal(payload.available, true);
  assert.equal(payload.changes.length, 1);
  assert.equal(payload.changes[0].changes[0].field, "status");
});

test("Change Radar remains a stable public JSON surface without D1", async () => {
  const response = await handleAroundChangesJson(
    new Request("https://aadhar.sh/around/changes.json"),
    {},
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal((await response.json()).available, false);
});


test("Lens shell is a complete document, not a fragment", () => {
  const response = renderLensShell();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/);
  return response.text().then(assertFullDocument);
});

test("Lens shell states the past, present, and future argument before the instrument", async () => {
  const html = await renderLensShell().text();
  assert.match(html, /The semantic web asked publishers to mark meaning/);
  assert.match(html, /today&rsquo;s models scrape the human page/);
  assert.match(html, /the next web must decide how machines act/);
  assert.doesNotMatch(html, /6-minute tour|Demo path/);
});

test("Lens state facts link to the evidence, not publication homepages", async () => {
  const html = await renderLensShell().text();
  const links = [...html.matchAll(/<div class="lx-sow-src"><a href="([^"]+)"/g)]
    .map((match) => new URL(match[1].replaceAll("&amp;", "&")));

  assert.equal(links.length, 6, "every state-of-the-web card must carry one source");
  for (const url of links) {
    assert.equal(url.protocol, "https:", `${url.href} must be a public source`);
    if (url.hostname === "www.x402scan.com") {
      assert.equal(url.pathname, "/", "x402scan's homepage is the live statistics dashboard");
    } else {
      assert.notEqual(url.pathname, "/", `${url.href} is a publication homepage, not evidence`);
    }
  }
});

test("Lens dialogs leave layout and hit testing when closed", async () => {
  const html = await renderLensShell().text();
  assert.match(html, /\.lx-sow-dialog\s*\{[^}]*display:none[^}]*\}/);
  assert.match(html, /\.lx-sow-dialog\[open\]\s*\{[^}]*display:flex[^}]*\}/);
  assert.doesNotMatch(html, /<dialog[^>]*\sopen(?:\s|=|>)/i);
});


test("track HTML renderer emits rows only", () => {
  const html = renderTrackListHtml(TRACKS);
  assert.match(html, /^<li\b/);
  assert.match(html, /np-title/);
  assert.match(html, /A &lt;song&gt;/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
});

test("Spotify art collapses onto one host, and only where it is safe to", () => {
  const hash = "ab67616d00001e026b458d1409d938dad4e3ba2c";
  // every alias lands on the canonical host, path untouched
  for (const host of ["image-cdn-fa", "image-cdn-ak", "image-cdn-zz9"]) {
    assert.equal(
      canonicalArtUrl(`https://${host}.spotifycdn.com/image/${hash}`),
      `https://i.scdn.co/image/${hash}`,
    );
  }
  // already canonical is a no-op, so applying it at both scrape and emit is safe
  assert.equal(canonicalArtUrl(`https://i.scdn.co/image/${hash}`), `https://i.scdn.co/image/${hash}`);
  // anything the rewrite was not proven safe for passes through UNCHANGED. a
  // wrong rewrite is a broken image; the untouched value is one that already works.
  for (const keep of [
    "https://mosaic.scdn.co/640/abc",                          // different scdn service
    "https://image-cdn-fa.spotifycdn.com/other/xyz",           // right host, not an /image/ path
    "https://evil.example.com/image/abc",                      // unrelated host
    "not-a-url",                                               // unparseable
    "",
    null,
    undefined,
  ]) assert.equal(canonicalArtUrl(keep), keep);
});

const ART_HASH_A = "ab67616d00001e026b458d1409d938dad4e3ba2c";

test("art URLs are derived from the hash, whatever alias it arrived under", () => {
  for (const host of ["i.scdn.co", "image-cdn-fa.spotifycdn.com", "image-cdn-ak.spotifycdn.com"]) {
    assert.equal(spotifyArtHash(`https://${host}/image/${ART_HASH_A}`), ART_HASH_A);
  }
  // null means "emit no browser image", so every unrecognized shape has to land
  // here rather than produce a /rn/art/ URL that would 404 or a CSP-blocked
  // third-party frame.
  for (const no of [
    "https://mosaic.scdn.co/640/abc",
    `https://evil.example.com/image/${ART_HASH_A}`,
    "https://i.scdn.co/image/NOTHEX",
    "https://i.scdn.co/image/ab67616d",            // too short
    `https://i.scdn.co/image/${ART_HASH_A}extra`,  // too long
    "not-a-url", "", null, undefined,
  ]) assert.equal(spotifyArtHash(no), null);

  const u = artUrls(`https://i.scdn.co/image/${ART_HASH_A}`);
  assert.equal(u.src, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  // The warm tier and browser tier are the SAME URL. Keeping a JPEG fallback
  // and 120w candidate beside it is what let repeated hover reconstruction turn
  // one cover into an unbounded list of image work in the 2026-08-11 HAR.
  assert.equal(u.warm, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  assert.equal(u.src, u.warm);
  assert.equal("srcset" in u, false);
  assert.equal(artUrls("https://mosaic.scdn.co/640/abc"), null);
});

// 40 lowercase hex, the shape ART_HASH demands, and injective in n so no two
// fixtures can collide and quietly weaken a dedupe or cap assertion.
const artHash = (n) => n.toString(16).padStart(40, "0");

test("the art warm list covers first, dedupes, and skips what cannot be re-hosted", () => {
  const payload = {
    tracks: [
      // Two tracks sharing one album cover, so the dedupe has something to do.
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://image-cdn-fa.spotifycdn.com/image/${artHash(3)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://i.scdn.co/image/${artHash(4)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(2)}`, artists: [] },
      // A collage cover and an artist with no picture: neither can be re-hosted,
      // so neither may appear. A /rn/art/ URL for these would 404 on hover.
      { image_url: "https://mosaic.scdn.co/640/abc", artists: [{ image_url: null }] },
    ],
  };
  const urls = artWarmList(payload, "https://aadhar.sh");

  assert.deepEqual(urls, [
    `https://aadhar.sh/rn/art/${artHash(1)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(2)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(3)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(4)}-240-${ART_VERSION}.avif`,
  ]);
  // Covers ahead of artist pictures, because the cap truncates the tail and a
  // row is a far bigger hover target than the artist name inside it.
  assert.ok(urls.indexOf(`https://aadhar.sh/rn/art/${artHash(2)}-240-${ART_VERSION}.avif`)
          < urls.indexOf(`https://aadhar.sh/rn/art/${artHash(3)}-240-${ART_VERSION}.avif`));

  // Every warmed URL must be one handleRnArt will actually serve, or the warm
  // spends a subrequest and a transformation to cache a 404.
  for (const u of urls) {
    assert.match(new URL(u).pathname,
      /^\/rn\/art\/[0-9a-f]{40}-(120|240)-\d{1,4}\.(avif|jpg)$/);
  }

  assert.deepEqual(artWarmList({ tracks: [] }, "https://aadhar.sh"), []);
  assert.deepEqual(artWarmList(null, "https://aadhar.sh"), []);
});

test("the art warm is capped, so one long playlist cannot drain the subrequest budget", () => {
  const many = { tracks: Array.from({ length: 60 }, (_, i) => ({
    image_url: `https://i.scdn.co/image/${artHash(i)}`,
    artists: [{ image_url: `https://i.scdn.co/image/${artHash(i + 100)}` }],
  })) };
  const urls = artWarmList(many, "https://aadhar.sh");
  assert.equal(urls.length, WARM_MAX_URLS);
  // Workers allows 1000 subrequests per request and the warm rides in the
  // fragment's waitUntil, so the cap is headroom rather than a hard limit. It is
  // asserted anyway: an uncapped warm scales with a playlist anyone can lengthen.
  assert.ok(WARM_MAX_URLS <= 50);
});

// REGRESSION. The first version of the warm probed urls[0] and returned early on
// a cache hit, assuming the set is only ever warmed as a set. It is not: one
// HOVER warms one URL, /rn/art is immutable for a year, and the first track's
// cover is the likeliest thing to be hovered first. Measured in production
// 2026-08-10 on the shipped build — urls[0] was `hit`, and 11 of 13 artist
// images the warm should have covered were still cold.
//
// This drives the real handleRnArt against a fake cache and a fake upstream,
// because the bug lived in the interaction between the two, and a test of
// artWarmList alone could never have seen it.
test("the art warm attempts every URL even when one is already cached", async () => {
  const store = new Map();
  const realFetch = globalThis.fetch;
  const hadCaches = "caches" in globalThis;
  testGlobals.caches = {
    default: {
      async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
      async put(req, res) { store.set(req.url, res); },
    },
  };
  testGlobals.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });

  try {
    const payload = { tracks: [
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://i.scdn.co/image/${artHash(2)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(3)}`, artists: [] },
    ] };
    const urls = artWarmList(payload, "https://aadhar.sh");
    assert.equal(urls.length, 3);

    // The exact production state: ONE url already warm because somebody hovered
    // it. The old guard read that as "the whole set is warm" and did nothing.
    store.set(urls[0], new Response(new Uint8Array([9]), { status: 200 }));

    const waits = [];
    const res = await warmArtCache(
      payload, new Request("https://aadhar.sh/rn/tracks.html"), {}, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    assert.equal(res.already, 1, "the pre-warmed URL must report as already cached, not as work done");
    assert.equal(res.warmed, 2, "a warm colo entry must not stop the other URLs from being warmed");
    for (const u of urls) assert.ok(store.has(u), `${u} was never warmed`);
  } finally {
    testGlobals.fetch = realFetch;
    if (!hadCaches) delete globalThis.caches;
  }
});

test("rendered track rows re-host recognized art and pass everything else through", () => {
  const html = renderTrackListHtml({
    tracks: [{
      title: "t", song_link_url: "https://song.link/x", duration_ms: 1000,
      image_url: `https://image-cdn-ak.spotifycdn.com/image/${ART_HASH_A}`,
      artists: [{ name: "a", spotify_url: "https://open.spotify.com/artist/1",
                  image_url: `https://image-cdn-fa.spotifycdn.com/image/${ART_HASH_A}` }],
    }],
  });
  assert.match(html, new RegExp(`data-track-image="/rn/art/${ART_HASH_A}-240-${ART_VERSION}\\.avif"`));
  assert.match(html, new RegExp(`data-artist-image="/rn/art/${ART_HASH_A}-240-${ART_VERSION}\\.avif"`));
  assert.doesNotMatch(html, /data-(?:track|artist)-imageset=|\/rn\/art\/[^" ]+\.jpg/,
    "each hover target must name the one warmed AVIF, not alternate browser resources");
  // the whole point: a hover no longer reaches Spotify at all
  assert.doesNotMatch(html, /scdn\.co|spotifycdn\.com/);

  // art with no parseable hash emits NO image attribute at all. It used to fall
  // back to the Spotify URL, which was right while img-src still allowed those
  // hosts; now that it does not, that URL would render as a frame the browser
  // refuses to load. The row falls through to the text card instead.
  const odd = renderTrackListHtml({
    tracks: [{ title: "t", song_link_url: "https://song.link/x",
               image_url: "https://mosaic.scdn.co/640/abc", artists: [] }],
  });
  assert.doesNotMatch(odd, /data-track-image/);
  assert.doesNotMatch(odd, /data-track-imageset/);
  assert.doesNotMatch(odd, /scdn\.co|spotifycdn\.com/);
  // the text card's inputs still have to survive, or "falls through to the text
  // card" is a claim about a card with nothing on it
  assert.match(odd, /data-track-title="t"/);
});

// (the CSP's img-src end of this bargain is asserted alongside the other
// directives in the no-RUM contract test near the bottom of this file)

test("the art route 404s every shape that is not one it minted", async () => {
  // This grammar is the only thing between the route and an open image proxy,
  // so each rejection below is a way someone could otherwise aim it or burn the
  // monthly transformation allowance by hand.
  const bad = [
    `/rn/art/${ART_HASH_A}-999-${ART_VERSION}.avif`,   // width not in the tier set
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.png`,    // format we do not mint
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}`,        // no extension
    `/rn/art/${ART_HASH_A.toUpperCase()}-240-1.avif`,  // uppercase hex
    "/rn/art/nothex-240-1.avif",
    `/rn/art/${ART_HASH_A}.avif`,
    "/rn/art/",
    `/rn/art/${ART_HASH_A}-240-1.avif/../../etc`,
  ];
  for (const p of bad) {
    const res = await handleRnArt(new Request(`https://aadhar.sh${p}`), {}, null);
    assert.equal(res.status, 404, `expected 404 for ${p}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `a 404 for ${p} must not be cacheable`);
  }
});

test("track endpoints keep JSON and HTML contracts independent of Accept", async () => {
  const env = { RN_KV: kvForTracks() };
  const request = new Request("https://aadhar.sh/rn/tracks", {
    headers: { accept: "text/html" },
  });
  const json = await handleRnTracks(request, env, context());
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.deepEqual(await json.json(), TRACKS);

  const html = await handleRnTracksHtml(
    new Request("https://aadhar.sh/rn/tracks.html", { headers: { accept: "application/json" } }),
    env,
    context(),
  );
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /^text\/html/);
  assert.equal(html.headers.get("vary"), null);
  const body = await html.text();
  assert.match(body, /^<li\b/);
  assert.doesNotMatch(body, /<(?:!doctype|html|head|body)\b/i);

  // Both representations say "read me, don't list me" with the header that can
  // actually say it. robots.txt used to try with `Disallow: /rn/tracks` while
  // four discovery surfaces pointed agents here, which blocked the fetch and so
  // blocked its own noindex.
  assert.equal(json.headers.get("x-robots-tag"), "noindex");
  assert.equal(html.headers.get("x-robots-tag"), "noindex");
});

test("Lens fetch keeps its JSON contract regardless of Accept", async () => {
  const json = await handleLensFetch(
    new Request("https://aadhar.sh/lens/fetch?url=javascript%3Aalert(1)", {
      headers: { accept: "text/html" },
    }),
    {},
    context(),
  );
  assert.equal(json.status, 400);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.equal((await json.json()).ok, false);
});

test("Lens parses only Cloudflare's normalized readiness level from an MCP SSE answer", () => {
  const body = 'event: message\ndata: ' + JSON.stringify({
    jsonrpc: "2.0", id: "lens-cloudflare-score",
    result: { content: [{ type: "text", text: "## Result\n**Level 4/5 — Agent-Optimized**\n21 checks follow" }] },
  }) + "\n\n";
  assert.deepEqual(lensParseCloudflareAgentScore(body), {
    available: true,
    level: 4,
    score: 80,
    levelName: "Agent-Optimized",
    source: "Cloudflare Agent Readiness",
    sourceUrl: "https://isitagentready.com/",
  });
  assert.equal(lensParseCloudflareAgentScore("not a score"), null);
});

test("Lens field evidence scores observed access without borrowing the standards rubric", () => {
  // Eight SCORED crawler identities, two of them refused, plus the two controls.
  // The controls must not move this number: they answer whether the instrument
  // got in, and a browser is not a bot identity that retrieved anything.
  const crawlers = Array.from({ length: 8 }, (_, i) => ({ status: i < 2 ? 403 : 200, blocked: i < 2, challenge: false }));
  const controls = [
    { role: "control", status: 200, blocked: false, challenge: false },
    { role: "control", status: 999, blocked: true, challenge: false },
  ];
  const field = lensFieldEvidence({
    status: 200,
    anatomy: { wordCount: 300 },
    agent: { strategy: { action: [], readable: ["markdown negotiation"], unknowns: [] } },
    botViews: [...controls, ...crawlers],
  });
  assert.deepEqual(field.components.map((component) => component.score), [100, 75, 100, 60]);
  assert.equal(field.overall, 84);

  const partial = lensFieldEvidence({ status: 200, anatomy: { wordCount: 300 }, agent: null, botViews: [...controls, ...crawlers.slice(0, 5)] });
  assert.equal(partial.overall, null, "missing evidence must leave the score unfinished, not reweight it");
});

test("Lens refuses to read crawler refusals as policy when no control got in", () => {
  // Every crawler 403s, which reads as a total AI block. It is only that if
  // something else got through: medium.com and quora.com answer 403 to Chrome
  // too, and grading them would report our own exclusion as their policy.
  const crawlers = Array.from({ length: 8 }, () => ({ status: 403, blocked: true, challenge: false }));
  const shut = lensFieldEvidence({
    status: 200, anatomy: { wordCount: 300 }, agent: null,
    botViews: [{ role: "control", status: 403, blocked: true }, { role: "control", status: 403, blocked: true }, ...crawlers],
  });
  const shutBots = shut.components.find((c) => c.key === "sampledBots");
  assert.equal(shutBots.score, null, "with every control refused, crawler rows are not user-agent policy");
  assert.match(shutBots.detail, /no control identity/);

  // One control in, and the identical crawler rows become a real 0.
  const open = lensFieldEvidence({
    status: 200, anatomy: { wordCount: 300 }, agent: null,
    botViews: [{ role: "control", status: 200, blocked: false }, { role: "control", status: 403, blocked: true }, ...crawlers],
  });
  assert.equal(open.components.find((c) => c.key === "sampledBots").score, 0, "a control got in, so the refusals are about the name");
});

test("Lens proxies Cloudflare's public scanner but stores only the normalized score", async () => {
  const realFetch = globalThis.fetch;
  const writes = [];
  let upstream = null;
  try {
    testGlobals.fetch = async (url, init) => {
      upstream = { url: String(url), body: JSON.parse(init.body) };
      return new Response('data: ' + JSON.stringify({
        jsonrpc: "2.0", id: "lens-cloudflare-score",
        result: { content: [{ type: "text", text: "**Level 5/5 -- Agent-Native**\nprivate report details" }] },
      }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const response = await handleLensFetch(
      new Request("https://aadhar.sh/lens/fetch?mode=cloudflare&url=https%3A%2F%2Fexample.com"),
      { RN_KV: { get: async () => null, put: async (key, value, options) => writes.push({ key, value, options }) } },
      context(),
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.score, 100);
    assert.equal(payload.level, 5);
    assert.equal(upstream.url, "https://isitagentready.com/mcp");
    assert.equal(upstream.body.params.arguments.url, "https://example.com/");
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].value), {
      available: true, level: 5, score: 100, levelName: "Agent-Native",
      source: "Cloudflare Agent Readiness", sourceUrl: "https://isitagentready.com/",
    });
    assert.doesNotMatch(writes[0].value, /private report details/);
  } finally {
    testGlobals.fetch = realFetch;
  }
});

test("the WebMCP detector sees a CDN bridge, not just hand-written call sites", () => {
  // The detector read the document for `navigator.modelContext` and friends, which
  // finds a site that wrote its own tools and MISSES the far larger population that
  // flipped WebMCP on at their CDN: the loader tag is all that reaches the HTML, and
  // every registerTool call lives in the external module. That population grows by
  // dashboard toggle, so the blind spot widens on its own.
  const bridge = lensDetectWebmcp('<script type="module" src="/.webmcp/bridge.js" data-packs="c2pa,mcp-server-client"></script>');
  assert.equal(bridge.found, true, "an injected bridge loader is WebMCP");
  assert.equal(bridge.kind, "bridge");

  // Both spellings of the page API. Chrome 146 ships `document.modelContext`; the
  // earlier drafts (and this site's own retired inline block) used `navigator`.
  for (const marker of ["document.modelContext.registerTool({})", "navigator.modelContext.registerTool({})"]) {
    const hit = lensDetectWebmcp(`<script>${marker}</script>`);
    assert.equal(hit.found, true, `${marker} must register as WebMCP`);
    assert.equal(hit.kind, "inline", "a page that calls the API itself is not a bridge");
  }

  // The claim has to stay falsifiable: a page merely TALKING about WebMCP is not a
  // page serving it. /garage and /lwe are full of prose about specs the site does
  // not implement, and this detector runs over arbitrary third-party HTML.
  assert.equal(lensDetectWebmcp("<p>WebMCP is a browser standard for model context.</p>").found, false);
  assert.equal(lensDetectWebmcp("").found, false);
});

test("Lens Browser Run endpoint validates targets before invoking the binding", async () => {
  let called = false;
  const response = await handleLensBrowser(
    new Request("https://aadhar.sh/lens/browser?url=javascript%3Aalert(1)", {
      headers: { accept: "text/html" },
    }),
    { BROWSER: { quickAction: async () => { called = true; } } },
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal((await response.json()).ok, false);
});

test("both browser routes report an upstream 429 as a 429, not a bad gateway", async () => {
  // Production, 2026-08-06: /lens/browser answered 502 with a body carrying
  // {"code":2001,"message":"Rate limit exceeded"}. /lens/shot had already been
  // taught that Browser Run refusing US is not the scanned site failing; the
  // sibling route had not, so the same bug shipped on half the surface. On the
  // free plan (one Quick Action per 10s account-wide) this is the single most
  // likely response either route will ever get, and a 502 sends whoever reads it
  // to go inspect a third-party site that is perfectly healthy.
  const env = { BROWSER: { quickAction: async () => new Response('{"errors":[{"code":2001}]}', { status: 429 }) } };
  const url = "?url=https%3A%2F%2Fexample.com%2F";

  // TUPLES: inference widens the rows to (string | Function)[], so `handler` is
  // a union that includes string and stops being callable.
  /** @type {Array<[name: string, handler: (req: Request, env: any, ctx: any) => Promise<Response>]>} */
  const lensHandlers = [["shot", handleLensShot], ["browser", handleLensBrowser]];
  for (const [name, handler] of lensHandlers) {
    const response = await handler(new Request(`https://aadhar.sh/lens/${name}${url}`), env, context());
    assert.equal(response.status, 429, `/lens/${name} must pass the upstream 429 through as a 429`);
    const body = await response.json();
    assert.equal(body.ok, false);
    // The message has to name OUR budget, since that is the thing the reader can
    // act on. Naming the target would be the same lie the 502 told.
    assert.match(body.error, /rate-limited|budget/i, `/lens/${name} must say whose limit was hit`);
  }
});

test("Lens Browser Run endpoint normalizes a snapshot into the comparison contract", async () => {
  let action;
  let payload;
  const response = await handleLensBrowser(
    new Request("https://aadhar.sh/lens/browser?url=https%3A%2F%2Fexample.com%2F"),
    {
      BROWSER: {
        async quickAction(name, input) {
          action = name;
          payload = input;
          return Response.json({
            result: {
              content: "<html><title>Rendered</title><body><p>hello</p></body></html>",
              markdown: "# hello",
              accessibilityTree: { role: "RootWebArea", children: [] },
              screenshot: "AAAA",
            },
            meta: { status: 200, title: "Rendered", url: "https://example.com/" },
          });
        },
      },
    },
    context(),
  );
  assert.equal(response.status, 200);
  assert.equal(action, "snapshot");
  assert.deepEqual(payload.formats, ["content", "screenshot", "markdown", "accessibilityTree"]);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, "Rendered");
  assert.equal(body.finalUrl, "https://example.com/");
  assert.equal(body.screenshot, "data:image/png;base64,AAAA");
  assert.equal(body.webmcp.status, "lab-required");
  assert.doesNotMatch(body.content, /__lens_webmcp_runtime__/);
});

test("Lens screenshot endpoint delegates PNG rendering to the Browser Run binding", async () => {
  let action;
  const png = new Uint8Array([137, 80, 78, 71]);
  const response = await handleLensShot(
    new Request("https://aadhar.sh/lens/shot?url=https%3A%2F%2Fexample.com%2F"),
    {
      BROWSER: {
        async quickAction(name) {
          action = name;
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      },
    },
    context(),
  );
  assert.equal(response.status, 200);
  assert.equal(action, "screenshot");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

test("neither browser route waits on a condition a live site never reaches", async () => {
  // `networkidle0` demands ZERO in-flight connections for 500ms, which any page
  // carrying analytics, ads, a websocket or a poll never reaches. The wait then
  // burns the whole timeout and Cloudflare discards a render it already had
  // (`422 / code 6002`). Both routes shipped it until 2026-08-07; measured
  // against production, theverge.com failed on BOTH at ~18.8s while the static
  // example.com passed, so the failure tracked the TARGET and read as flaky.
  //
  // This is pinned rather than left to review because the cost is invisible at
  // the call site: the setting is one word in a payload, the failure looks like
  // the scanned site being slow, and each timeout also spends 18s of a browser
  // budget that is 10 MINUTES PER DAY account-wide on the free plan.
  const captured = {};
  const env = {
    BROWSER: {
      async quickAction(name, input) {
        captured[name] = input;
        if (name === "screenshot") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return Response.json({ result: { content: "<html></html>" }, meta: { status: 200 } });
      },
    },
  };
  const url = "?url=https%3A%2F%2Fexample.com%2F";
  await handleLensShot(new Request(`https://aadhar.sh/lens/shot${url}`), env, context());
  await handleLensBrowser(new Request(`https://aadhar.sh/lens/browser${url}`), env, context());

  assert.deepEqual(Object.keys(captured).sort(), ["screenshot", "snapshot"], "both routes must have reached the binding");
  for (const [action, payload] of Object.entries(captured)) {
    assert.notEqual(payload.gotoOptions.waitUntil, "networkidle0", `${action} must not wait for total network silence`);
    assert.equal(payload.gotoOptions.waitUntil, "networkidle2", `${action} must wait for the page to settle, not go silent`);
    assert.ok(payload.gotoOptions.timeout > 0, `${action} must keep a bounded timeout`);
  }
  // One object, so a later edit cannot fix one route and leave the other.
  assert.equal(captured.screenshot.gotoOptions, captured.snapshot.gotoOptions, "both routes must share one goto config");
});
