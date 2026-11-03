// ── site search, photo query, coffee availability and the no-JS utility shells ──
import {
  _resetPhotoCaches,
  assert,
  context,
  getPublicAvailability,
  handleCoffeeAvailability,
  handlePhotoQuery,
  handleSearchJson,
  kvType,
  queryPhotos,
  renderRun,
  renderSearchPage,
  searchSite,
  staticAssets,
  test,
} from "./contract-shared.ts";
import { _resetSearchIndex } from "../../src/worker/search.ts";
import { fieldMatches } from "../../src/worker/lib/text.ts";
import {
  buildPhotoSearchIndex,
  decodePhotoSearchIndex,
  encodePhotoSearchIndex,
  matchingRows,
  PHOTO_FIELD_WEIGHTS,
  photoFields,
} from "../../src/worker/lib/photo-search.ts";
import { readFile } from "node:fs/promises";

// Moved out of the interaction-recipes file on 2026-10-24, where they had
// accumulated: none of them is about /lens, so a change to /lens must never be
// able to delete them. Each test says what it pins.

test("site search and JSON contract share the generated corpus", async () => {
  _resetSearchIndex(); // the corpus is memoised per process, like the photo maps
  const env = {
    ASSETS: staticAssets({
      "/search-index.json": {
        records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }],
      },
    }),
  };
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
  // The hash and alt maps are memoised per process, and `bun test --parallel
  // --no-isolate` shares one process across the files a worker draws, so
  // without this the fixture below loses to whichever file loaded hashes.json
  // first and thumb.small reads null (validate on #1008, 2026-09-29).
  _resetPhotoCaches();
  const env = {
    ASSETS: staticAssets({
      "/images/metadata.json": {
        A: { camera: "X-T50", lens: "XF18mm", film: "Classic Chrome", date: "2026:01:02", gps: "secret" },
        B: { camera: "Leica", film: "Monochrome", date: "2025:01:02" },
      },
      "/images/alt.json": { A: "a blue car", B: "a lamp" },
      "/images/hashes.json": { A: { a: "aaaa", j: "bbbb", s: "cccc" }, B: { a: "dddd", j: "eeee", s: "ffff" } },
    }),
  };
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
  return {
    ASSETS: staticAssets({
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
    }),
  };
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
  assert.deepEqual(
    result.photos.map((photo) => photo.stem),
    ["A", "C", "B"],
  );
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
  assert.deepEqual(
    result.photos.map((photo) => photo.stem),
    ["A", "C", "B"],
  );
  assert.equal(result.photos.find((photo) => photo.stem === "B").matched.includes("film"), false, "B is a Monochrome frame and must not match on film");
  // The digit-gated substring escape stays open for part numbers, which live
  // inside a larger alphanumeric run with no boundary to match on.
  const lens = await queryPhotos(rankingEnv(), { q: "27mm" });
  assert.equal(lens.total, 1);
  assert.equal(lens.photos[0].stem, "A");
});

test("fieldMatches finds token starts without splitting, astral letters included", () => {
  // fieldMatches stopped splitting fields into tokens on 2026-10-07 (the split
  // was most of a photo query's CPU) and decides each rule with indexOf plus a
  // boundary check instead. Every answer here is what the splitting version
  // gave. The astral rows are the part a UTF-16 boundary check gets wrong:
  // U+1D49C is a letter, so "x𝒜lpha" is ONE token and "𝒜lpha" does not start it.
  const cases = [
    ["Monochrome", "chrome", false],
    ["LEICA M MONOCHROM", "monochrome", true],
    ["Classic Negative", "neg", true],
    ["Nostalgic Neg", "negative", false],
    ["XF27mmF2.8 R WR", "27mm", true],
    ["a bridge", "bridges", true],
    ["x\u{1D49C}lpha", "\u{1D49C}lpha", false],
    ["the \u{1D49C}lpha", "\u{1D49C}lpha", true],
    ["\u{1D49C}\u{1D49C}beta", "\u{1D49C}beta", false],
    // a term with a separator in it never starts a token, but its first word
    // can still be a whole token the term begins with
    ["Classic Chrome", "chrome-x", true],
  ];
  for (const [field, term, expected] of cases) {
    assert.equal(fieldMatches(field, term), expected, `fieldMatches(${JSON.stringify(field)}, ${JSON.stringify(term)})`);
    // The photo index answers the same rules with dictionary lookups.
    const index = buildPhotoSearchIndex({ x: { film: String(field) } }, {}, null);
    assert.equal(matchingRows(index.fields[0], String(term), index.words)[0] === 1, expected, `index for (${JSON.stringify(field)}, ${JSON.stringify(term)})`);
  }
});

const archiveFile = (name) => readFile(new URL(`../../public/images/${name}`, import.meta.url), "utf8");

// The index is right only while it agrees with fieldMatches, its specification.
// This holds every bit of the real archive's index to it, after a round trip
// through the baked encoding: every field, every token the archive holds, its
// plural, a truncation, and a digit run's tail (the substring rule's case).
test("the baked photo index matches exactly the photos fieldMatches does", async () => {
  const [metadata, alt, semantics] = (await Promise.all(["metadata.json", "alt.json", "semantics.json"].map(archiveFile))).map((text) => JSON.parse(text));
  const index = decodePhotoSearchIndex(encodePhotoSearchIndex(buildPhotoSearchIndex(metadata, alt, semantics)).buffer);
  assert.deepEqual(index.stems, Object.keys(metadata));
  const texts = index.stems.map((stem) => photoFields(stem, metadata[stem], alt[stem], semantics[stem]?.terms));
  const probes = new Set<string>();
  for (const field of index.fields) {
    for (const token of field.tokens) {
      probes.add(token);
      probes.add(`${token}s`);
      probes.add(token.slice(0, Math.max(2, token.length - 2)));
      if (/\d/.test(token)) probes.add(token.slice(2));
    }
  }
  const disagreements = (terms: Iterable<string>) => {
    const found: string[] = [];
    for (const term of terms) {
      index.fields.forEach((field, f) => {
        const name = PHOTO_FIELD_WEIGHTS[f][0];
        const rows = matchingRows(field, term, index.words);
        index.stems.forEach((stem, row) => {
          const indexed = ((rows[row >>> 5] >>> (row & 31)) & 1) === 1;
          if (indexed !== fieldMatches(texts[row][name], term)) found.push(`${name} ${JSON.stringify(term)} ${stem}`);
        });
      });
    }
    return found;
  };
  assert.deepEqual(disagreements(probes), []);

  // CONTROL: one flipped bit is a disagreement the comparison reports.
  const film = index.fields[0];
  film.tokenRows[film.tokens.indexOf("chrome") * index.words] ^= 1;
  assert.deepEqual(disagreements(["chrome"]), [`film "chrome" ${index.stems[0]}`]);
});

test("queryPhotos ranks the same from the baked index as from the JSON", async () => {
  const names = ["metadata.json", "alt.json", "semantics.json", "hashes.json"];
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [`/images/${name}`, await archiveFile(name)])));
  const [metadata, alt, semantics] = names.map((name) => JSON.parse(files[`/images/${name}`]));
  const envWith = (baked: ReturnType<typeof encodePhotoSearchIndex> | null) => {
    _resetPhotoCaches();
    return {
      ASSETS: {
        async fetch(input) {
          const path = new URL(input).pathname;
          if (path === "/images/photo-search.bin" && baked) return new Response(baked);
          return path in files ? new Response(files[path]) : new Response("not found", { status: 404 });
        },
      },
    };
  };
  const baked = encodePhotoSearchIndex(buildPhotoSearchIndex(metadata, alt, semantics));
  const queries = [
    { q: "classic chrome street" },
    { q: "long exposure" },
    { q: "monochrome" },
    { q: "xf27mm" },
    { q: "leica night street" },
    { q: "acros portrait 2026" },
    { q: "bridges" },
    { q: "chrome", film: "classic chrome" },
  ];
  for (const options of queries) {
    const fromJson = await queryPhotos(envWith(null), { ...options, limit: 50 });
    const fromBaked = await queryPhotos(envWith(baked), { ...options, limit: 50 });
    assert.deepEqual(fromBaked, fromJson, JSON.stringify(options));
  }
  const street = await queryPhotos(envWith(baked), { q: "classic chrome street" });
  assert.equal(street.ranking.mode, "all-terms");
  assert.notEqual(street.total, 0);

  // CONTROL: the baked file is what ranked. Baked from a caption the JSON does
  // not carry, it answers a query the JSON cannot.
  const stem = Object.keys(metadata)[0];
  const altered = encodePhotoSearchIndex(buildPhotoSearchIndex(metadata, { ...alt, [stem]: "zyzzyva" }, semantics));
  assert.deepEqual(
    (await queryPhotos(envWith(altered), { q: "zyzzyva" })).photos.map((photo) => photo.stem),
    [stem],
  );
  assert.equal((await queryPhotos(envWith(null), { q: "zyzzyva" })).total, 0);
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
  assert.deepEqual(
    result.photos.map((photo) => photo.stem),
    ["A", "C"],
  );
});

test("a term that matches most of the corpus in a field stops counting there", async () => {
  // The live failure: every Fuji recipe card carries "Exposure Compensation",
  // so "long exposure" matched "exposure" in 151 of 158 cards and returned the
  // entire archive ranked by a word that distinguished nothing. Nothing in the
  // archive is a long exposure, so the only correct total is zero.
  _resetPhotoCaches();
  const metadata: Record<string, any> = {};
  const alt: Record<string, any> = {};
  for (let i = 0; i < 8; i += 1) {
    metadata[`P${i}`] = {
      camera: "X-T50",
      film: i < 4 ? "Classic Chrome" : "Nostalgic Neg",
      date: `2026:01:0${i + 1}`,
      recipe: { "Exposure Compensation": "0", "Color Chrome Effect": "Strong" },
    };
    alt[`P${i}`] = "a street";
  }
  const env = {
    ASSETS: staticAssets({
      "/images/metadata.json": metadata,
      "/images/alt.json": alt,
      "/images/hashes.json": {},
    }),
  };
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
  const env = {
    ASSETS: staticAssets({
      "/images/metadata.json": { A: { camera: "X-T50", film: "Classic Chrome", date: "2026:01:02" } },
      "/images/alt.json": { A: "a bridge over a river" },
      "/images/hashes.json": {},
      "/images/semantics.json": { A: { terms: "span crossing viaduct overpass" } },
    }),
  };
  const expanded = await queryPhotos(env, { q: "viaduct" });
  assert.equal(expanded.ranking.semantic, true);
  assert.equal(expanded.total, 1, "matched a word that appears in no caption or EXIF field");
  assert.deepEqual(expanded.photos[0].matched, ["expansion"]);
});

function coffeeEnv() {
  const snapshot = { busy: [], ts: Date.now() };
  return {
    HOST_TIMEZONE: "America/New_York",
    WORKING_HOURS_START: "9",
    WORKING_HOURS_END: "18",
    WORKING_DAYS: "1,2,3,4,5",
    SLOT_MINUTES: "30",
    BUFFER_MINUTES: "15",
    MIN_NOTICE_HOURS: "0",
    MAX_LOOKAHEAD_DAYS: "2",
    DAILY_LIMIT: "3",
    WEEKLY_LIMIT: "5",
    // listHeld pages KV with list({ prefix: "held:" }), one key per held slot.
    // An empty first page is the "nothing booked" fixture.
    BOOKINGS: {
      async get(key, typeOrOptions) {
        if (key === "cal:busy" && kvType(typeOrOptions) === "json") return snapshot;
        return null;
      },
      async list() {
        return { keys: [], list_complete: true, cursor: null };
      },
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
