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
} from "./contract-shared.ts";

function metaEnv({ tracks, meta, seed = {} }) {
  const store = new Map([
    ["playlist-id", "0raTdu2MZH4dNvfG5keVAL"],
    ["tracks:0raTdu2MZH4dNvfG5keVAL", JSON.stringify({ tracks, playlist_id: "0raTdu2MZH4dNvfG5keVAL" })],
    ["trackmeta:v1", JSON.stringify(meta)],
    ...Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  ]);
  const reads = [];
  const decode = (raw, t) => {
    if (raw === undefined) return null;
    return (t === "json" || t?.type === "json") ? JSON.parse(raw) : raw;
  };
  return {
    store,
    reads,
    env: {
      RN_KV: {
        // The bulk contract as Cloudflare documents it: an array of keys answers
        // with a Map carrying EVERY requested key, null where nothing is stored.
        // A fake that took an array and answered one value would report the
        // collapse as working while production read nothing.
        get: async (k, t) => {
          reads.push(k);
          if (!Array.isArray(k)) return decode(store.get(k), t);
          assert.ok(k.length <= 100, "a bulk read carries at most 100 keys");
          return new Map(k.map((key) => [key, decode(store.get(key), t)]));
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
  const { store, env } = metaEnv({ tracks: [{ id: "a" }, { id: "b" }], meta: metaFor(all) });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.deepEqual(Object.keys(after).sort(), all, "a short read must delete nothing");
  for (const id of all) assert.ok(after[id].image_url, `${id} keeps its cover`);
});

test("an entry unseen past the age window is pruned, so the map stays bounded", async () => {
  const stale = 31 * 24 * 60 * 60 * 1000;
  const meta = metaFor(["a", "b"]);
  meta.b.seen = Date.now() - stale;
  const { store, env } = metaEnv({ tracks: [{ id: "a" }], meta });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.deepEqual(Object.keys(after), ["a"], "only the long-unseen entry goes");
});

test("an entry written before `seen` existed is stamped, never dropped", async () => {
  const meta = { a: { image_url: "https://i.scdn.co/image/a", artists: [] } };
  const { store, env } = metaEnv({ tracks: [{ id: "a" }], meta });
  await cronEnrichTracks(env, null);
  const after = JSON.parse(store.get("trackmeta:v1"));
  assert.ok(after.a, "the upgrade must not become the outage it prevents");
  assert.equal(typeof after.a.seen, "number");
});

test("the enrich tick reads KV in bulk, so its cost does not scale with artists", async () => {
  const artistIds = ["p", "q", "r", "s", "t"];
  const seed = Object.fromEntries(artistIds.map((a) => [
    `artist:${a}`, { name: a.toUpperCase(), image_url: `https://i.scdn.co/image/${a}` },
  ]));
  const meta = {
    a: {
      image_url: "https://i.scdn.co/image/a",
      seen: Date.now(),
      artists: artistIds.map((id) => ({ id, name: id.toUpperCase(), image_url: null })),
    },
  };
  const { store, reads, env } = metaEnv({ tracks: [{ id: "a" }], meta, seed });
  await cronEnrichTracks(env, null);

  assert.deepEqual(reads, [
    "playlist-id",
    ["tracks:0raTdu2MZH4dNvfG5keVAL", "trackmeta:v1"],
    artistIds.map((id) => `artist:${id}`),
  ], "the tick must read three times regardless of how many artists are pending");

  const after = JSON.parse(store.get("trackmeta:v1"));
  for (const a of after.a.artists) {
    assert.equal(a.image_url, `https://i.scdn.co/image/${a.id}`, `${a.id} keeps its photo`);
  }
});

test("the artist slots go to live tracks, and an artist with no photo stops asking", async () => {
  const now = Date.now();
  const staleArtists = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const meta = {
    gone: {
      image_url: "https://i.scdn.co/image/gone",
      seen: now,
      artists: staleArtists.map((id) => ({ id, name: id, image_url: null })),
    },
    live: {
      image_url: "https://i.scdn.co/image/live",
      seen: now,
      artists: [
        { id: "nophoto", name: "scarletchoir", image_url: null },
        { id: "x", name: "X", image_url: null },
      ],
    },
  };
  const seed = {
    "artist:nophoto": { name: "scarletchoir", image_url: null },
    "artist:x": { name: "X", image_url: "https://i.scdn.co/image/x" },
  };
  const { store, reads, env } = metaEnv({ tracks: [{ id: "live" }], meta, seed });
  await cronEnrichTracks(env, null);

  assert.deepEqual(reads[2], ["artist:nophoto", "artist:x"],
    "only live tracks' artists take slots; a retired playlist's six would have filled all of them");
  const after = JSON.parse(store.get("trackmeta:v1"));
  const [nophoto, x] = after.live.artists;
  assert.equal(x.image_url, "https://i.scdn.co/image/x", "the live artist lands in one tick");
  assert.equal(nophoto.image_url, null);
  assert.equal(typeof nophoto.checked, "number", "a read that found no photo is recorded as read");
  const payload = JSON.parse(store.get("tracks:0raTdu2MZH4dNvfG5keVAL"));
  assert.ok(payload.tracks[0].artists.every((a) => !("checked" in a)), "bookkeeping stays out of /rn/tracks");

  reads.length = 0;
  await cronEnrichTracks(env, null);
  assert.equal(reads.length, 2, `a settled artist must not be read again: ${JSON.stringify(reads)}`);

  const aged = JSON.parse(store.get("trackmeta:v1"));
  aged.live.artists[0].checked = now - 31 * 24 * 60 * 60 * 1000;
  store.set("trackmeta:v1", JSON.stringify(aged));
  reads.length = 0;
  await cronEnrichTracks(env, null);
  assert.deepEqual(reads[2], ["artist:nophoto"], "an expired mark puts the artist back in the queue");
});

test("the published key directory advertises only what the bot signs with", async () => {
  const dir = JSON.parse(await readFile(new URL("./public/.well-known/http-message-signatures-directory", ROOT), "utf8"));
  for (const key of dir.keys) assert.equal(key.d ?? key.priv, undefined, `the published ${key.kty} key must never carry its private half`);
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

test("bounded response reads cancel stalled producers and never report aborted prefixes", async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("read budget exhausted");
    let cancelled;
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("partial")); },
      cancel(error) { cancelled = error; },
    }));
    if (alreadyAborted) controller.abort(reason);
    const read = readResponseCapped(response, 100, controller.signal);
    if (!alreadyAborted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(reason);
    }
    await assert.rejects(read, (error) => error === reason);
    assert.equal(cancelled, reason, "the producer receives the caller's cancellation");
    await assert.rejects(readResponseCapped(new Response(null), 100, controller.signal), (error) => error === reason);
  }
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
  const html = renderTrackListHtml(TRACKS).html;
  assert.match(html, /^<li\b/);
  assert.match(html, /np-title/);
  assert.match(html, /A &lt;song&gt;/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
});

test("the tracks fragment answers as an island, marker and all, even in its error state", async () => {
  const res = await handleRnTracksHtml(new Request("https://aadhar.sh/rn/tracks.html"), {}, { waitUntil() {} });
  assert.equal(res.headers.get("x-island"), "1");
  assert.equal(res.headers.get("x-rn-fragment"), null, "one marker, the island convention's");
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.ok(res.status >= 400, "a failed read is not a 2xx, so the page keeps its placeholder");
  assert.match(res.headers.get("cache-control") ?? "", /max-age=30/, "an error state caches briefly, not for the playlist's 5 minutes");
  assert.match(await res.text(), /class="np-empty"/);
});

test("Spotify art collapses onto one host, and only where it is safe to", () => {
  const hash = "ab67616d00001e026b458d1409d938dad4e3ba2c";
  for (const host of ["image-cdn-fa", "image-cdn-ak", "image-cdn-zz9"]) {
    assert.equal(
      canonicalArtUrl(`https://${host}.spotifycdn.com/image/${hash}`),
      `https://i.scdn.co/image/${hash}`,
    );
  }
  assert.equal(canonicalArtUrl(`https://i.scdn.co/image/${hash}`), `https://i.scdn.co/image/${hash}`);
  for (const keep of [
    "https://mosaic.scdn.co/640/abc",
    "https://image-cdn-fa.spotifycdn.com/other/xyz",
    "https://evil.example.com/image/abc",
    "not-a-url",
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
  for (const no of [
    "https://mosaic.scdn.co/640/abc",
    `https://evil.example.com/image/${ART_HASH_A}`,
    "https://i.scdn.co/image/NOTHEX",
    "https://i.scdn.co/image/ab67616d",
    `https://i.scdn.co/image/${ART_HASH_A}extra`,
    "not-a-url", "", null, undefined,
  ]) assert.equal(spotifyArtHash(no), null);

  const u = artUrls(`https://i.scdn.co/image/${ART_HASH_A}`);
  assert.equal(u.src, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  assert.equal(u.warm, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  assert.equal(u.src, u.warm);
  assert.equal("srcset" in u, false);
  assert.equal(artUrls("https://mosaic.scdn.co/640/abc"), null);
});

const artHash = (n) => n.toString(16).padStart(40, "0");

test("the art warm list covers first, dedupes, and skips what cannot be re-hosted", () => {
  const payload = {
    tracks: [
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://image-cdn-fa.spotifycdn.com/image/${artHash(3)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://i.scdn.co/image/${artHash(4)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(2)}`, artists: [] },
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
  assert.ok(urls.indexOf(`https://aadhar.sh/rn/art/${artHash(2)}-240-${ART_VERSION}.avif`)
          < urls.indexOf(`https://aadhar.sh/rn/art/${artHash(3)}-240-${ART_VERSION}.avif`));

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
  assert.ok(WARM_MAX_URLS <= 50);
});

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

    store.set(urls[0], new Response(new Uint8Array([9]), { status: 200 }));

    const waits = [];
    const res = await warmArtCache(
      payload, new Request("https://aadhar.sh/rn/tracks.html"), {}, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    assert.equal(res.already, 1, "the pre-warmed URL must report as already cached, not as work done");
    assert.equal(res.warmed, 2, "a warm colo entry must not stop the other URLs from being warmed");
    assert.equal(res.failed, 0);
    for (const u of urls) assert.ok(store.has(u), `${u} was never warmed`);
  } finally {
    testGlobals.fetch = realFetch;
    if (!hadCaches) delete globalThis.caches;
  }
});

test("the art warm counts a failed or untransformed cover as such, never as warmed", async () => {
  const store = new Map();
  const realFetch = globalThis.fetch;
  const hadCaches = "caches" in globalThis;
  testGlobals.caches = {
    default: {
      async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
      async put(req, res) { store.set(req.url, res); },
    },
  };
  const ok = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  testGlobals.fetch = async (url, init) => {
    if (String(url).includes(artHash(3))) throw new Error("Too many subrequests by single Worker invocation.");
    if (String(url).includes(artHash(2)) && init?.cf?.image) return new Response("9422", { status: 403 });
    return ok();
  };

  try {
    const payload = { tracks: [1, 2, 3].map((n) => ({ image_url: `https://i.scdn.co/image/${artHash(n)}`, artists: [] })) };
    const waits = [];
    const res = await warmArtCache(
      payload, new Request("https://aadhar.sh/rn/tracks.html"), {}, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    assert.deepEqual(res, { warmed: 1, already: 0, untransformed: 1, failed: 1 });
    assert.equal(store.size, 1, "only the transformed cover may reach the cache");
  } finally {
    testGlobals.fetch = realFetch;
    if (!hadCaches) Reflect.deleteProperty(globalThis, "caches");
  }
});

test("rendered track rows re-host recognized art and pass everything else through", () => {
  const { html } = renderTrackListHtml({
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
  assert.doesNotMatch(html, /scdn\.co|spotifycdn\.com/);

  const odd = renderTrackListHtml({
    tracks: [{ title: "t", song_link_url: "https://song.link/x",
               image_url: "https://mosaic.scdn.co/640/abc", artists: [] }],
  }).html;
  assert.doesNotMatch(odd, /data-track-image/);
  assert.doesNotMatch(odd, /data-track-imageset/);
  assert.doesNotMatch(odd, /scdn\.co|spotifycdn\.com/);
  assert.match(odd, /data-track-title="t"/);
});

test("the art route 404s every shape that is not one it minted", async () => {
  const bad = [
    `/rn/art/${ART_HASH_A}-999-${ART_VERSION}.avif`,
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.png`,
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}`,
    `/rn/art/${ART_HASH_A.toUpperCase()}-240-1.avif`,
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

test("Lens caches only the completed Cloudflare score response, never progress or tool errors", async () => {
  const id = "lens-cloudflare-score";
  const result = { content: [{ type: "text", text: "Level 4/5 — Agent-Optimized" }] };
  const reply = { jsonrpc: "2.0", id, result };
  const frame = (value) => JSON.stringify(value, null, 2).split("\n").map((line) => `data: ${line}\n`).join("") + "\n";
  const noise = frame({ jsonrpc: "2.0", method: "notifications/progress", params: { message: "Level 1/5 — Working" } })
    + frame({ ...reply, id: "another-scan", result: { content: [{ type: "text", text: "Level 2/5 — Other" }] } });
  const compact = 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"message":"Level 1/5 — Working"}}\n\n'
    + 'data: ' + JSON.stringify(reply) + '\n\n';
  const realFetch = globalThis.fetch;
  try {
    for (const body of [noise + frame(reply), JSON.stringify(reply), compact, noise, noise + frame(reply).trimEnd(),
      frame({ ...reply, result: { ...result, isError: true } }), frame({ jsonrpc: "2.0", id, error: { message: "Level 5/5 — Failed" } })]) {
      const writes = [];
      testGlobals.fetch = async (_url, init) => {
        assert.equal(JSON.parse(init.body).id, id);
        return new Response(body.replace(/\n/g, "\r\n"), { headers: { "content-type": body.startsWith("{") ? "application/json" : "text/event-stream" } });
      };
      const response = await handleLensFetch(new Request("https://aadhar.sh/lens/fetch?mode=cloudflare&url=https://example.com"),
        { RN_KV: { get: async () => null, put: async (_key, value) => { writes.push(JSON.parse(value)); } } }, context());
      const payload = await response.json();
      const available = body === noise + frame(reply) || body === JSON.stringify(reply) || body === compact;
      assert.equal(payload.available, available);
      assert.equal(writes.length, available ? 1 : 0);
      if (available) {
        assert.equal(payload.level, 4);
        assert.equal(writes[0].score, 80);
      }
    }
  } finally { testGlobals.fetch = realFetch; }
});

test("Lens field evidence scores observed access without borrowing the standards rubric", () => {
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
  const crawlers = Array.from({ length: 8 }, () => ({ status: 403, blocked: true, challenge: false }));
  const shut = lensFieldEvidence({
    status: 200, anatomy: { wordCount: 300 }, agent: null,
    botViews: [{ role: "control", status: 403, blocked: true }, { role: "control", status: 403, blocked: true }, ...crawlers],
  });
  const shutBots = shut.components.find((c) => c.key === "sampledBots");
  assert.equal(shutBots.score, null, "with every control refused, crawler rows are not user-agent policy");
  assert.match(shutBots.detail, /no control identity/);

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
  const bridge = lensDetectWebmcp('<script type="module" src="/.webmcp/bridge.js" data-packs="c2pa,mcp-server-client"></script>');
  assert.equal(bridge.found, true, "an injected bridge loader is WebMCP");
  assert.equal(bridge.kind, "bridge");

  for (const marker of ["document.modelContext.registerTool({})", "navigator.modelContext.registerTool({})"]) {
    const hit = lensDetectWebmcp(`<script>${marker}</script>`);
    assert.equal(hit.found, true, `${marker} must register as WebMCP`);
    assert.equal(hit.kind, "inline", "a page that calls the API itself is not a bridge");
  }

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
  const env = { BROWSER: { quickAction: async () => new Response('{"errors":[{"code":2001}]}', { status: 429 }) } };
  const url = "?url=https%3A%2F%2Fexample.com%2F";

  // TUPLES: inference widens the rows to (string | Function)[], so `handler` is
  // a union that includes string and stops being callable.
  /** @type {Array<[name: string, handler: (req: Request, env: any, ctx: any) => Promise<Response>]>} */
  const lensHandlers = [["shot", handleLensShot], ["browser", handleLensBrowser]];
  for (const [name, handler] of lensHandlers) {
    const response = await handler(new Request(`https://aadhar.sh/lens/${name}${url}`), env, context());
    assert.equal(response.status, 429, `/lens/${name} must pass the upstream 429 through as a 429`);
    assert.equal(response.headers.get("retry-after"), null, `/lens/${name} must not quote our window for Browser Run's limit`);
    const body = await response.json();
    assert.equal(body.ok, false);
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
  assert.equal(captured.screenshot.gotoOptions, captured.snapshot.gotoOptions, "both routes must share one goto config");
});
