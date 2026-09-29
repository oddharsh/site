// ── /reading: Hacker News threads, matched exactly and shown only when read ──
// reading-hn.ts asks Algolia's HN index which /reading links have a thread.
// The failure worth pinning is a WRONG badge rather than a missing one:
// Algolia's url search is tokenized, so a query for a homepage returns every
// story on that host (measured 2026-09-29: danluu.com answered 554 hits, the
// top one a 777-comment thread about a different page). A badge built from the
// first hit would put that count on the homepage link and read as true.
import { CURIUS_CACHE_KEY, renderReadingPage } from "../src/worker/reading.ts";
import { HN_MAP_KEY, hnInterval, hnKey, hnThreadFor, pickPending, pickThread, readHnMap } from "../src/worker/reading-hn.ts";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const hit = (url, objectID, num_comments, points = 10) => ({ url, objectID, num_comments, points });

test("hnKey folds the spellings HN submitters vary on, and nothing else", () => {
  const key = "paulgraham.com/greatwork.html";
  for (const spelling of [
    "https://paulgraham.com/greatwork.html",
    "http://www.paulgraham.com/greatwork.html",
    "https://PaulGraham.com/greatwork.html/#top",
    "https://paulgraham.com/greatwork.html?utm_source=curius&ref=x",
  ]) assert.equal(hnKey(spelling), key, spelling);
  // A query parameter that names the PAGE survives, so two videos stay two.
  assert.equal(hnKey("https://www.youtube.com/watch?v=abc&si=share"), "youtube.com/watch?v=abc");
  assert.notEqual(hnKey("https://a.com/x?id=1"), hnKey("https://a.com/x?id=2"));
  assert.equal(hnKey("mailto:someone@example.com"), null);
  assert.equal(hnKey("not a url"), null);
});

test("pickThread takes only hits for the exact page, and the most-commented of those", () => {
  const body = { hits: [
    hit("https://danluu.com/look-stupid/", "28942189", 777),
    hit("http://danluu.com/", "100", 12),
    hit("https://danluu.com", "101", 40),
  ] };
  assert.deepEqual(pickThread("danluu.com", body), { id: 101, c: 40, p: 10, n: 2 });
  // The control: the same answer for a page nobody submitted is no thread at all.
  assert.deepEqual(pickThread("danluu.com/unsubmitted", body), { id: null, c: 0, p: 0, n: 0 });
  // An answer that is not Algolia's shape is no thread, never a throw.
  for (const junk of [null, "<html>", { hits: "x" }, { hits: [null, 3] }]) {
    assert.deepEqual(pickThread("danluu.com", junk), { id: null, c: 0, p: 0, n: 0 });
  }
});

test("pickPending asks never-asked links first, newest-saved first, then the stalest", () => {
  const items = [
    { link: "https://a.com/new", created: "2026-09-28T00:00:00Z" },
    { link: "https://a.com/stale", created: "2026-01-01T00:00:00Z" },
    { link: "https://a.com/fresh", created: "2026-09-27T00:00:00Z" },
    { link: "https://a.com/old", created: "2026-09-01T00:00:00Z" },
    { link: "https://news.ycombinator.com/item?id=1", created: "2026-09-28T00:00:00Z" },
    { link: "https://www.a.com/new/", created: "2026-09-28T00:00:00Z" },
  ];
  const map = readHnMap({
    "a.com/stale": { id: null, c: 0, p: 0, n: 0, checked: NOW - 40 * DAY },
    "a.com/fresh": { id: 7, c: 3, p: 5, n: 1, checked: NOW - 1000 },
  });
  const keys = pickPending(items, map, NOW).map((p) => p.key);
  // An HN link IS its thread, and a second spelling of one page is one lookup.
  assert.deepEqual(keys, ["a.com/new", "a.com/old", "a.com/stale"]);
  assert.deepEqual(pickPending(items, map, NOW, 1).map((p) => p.key), ["a.com/new"]);
});

test("hnInterval re-reads live threads often and settled answers rarely", () => {
  const thread = { id: 1, c: 1, p: 1, n: 1, checked: NOW, seen: NOW };
  const none = { ...thread, id: null };
  const h = (ms) => ms / (60 * 60 * 1000);
  assert.equal(h(hnInterval(thread, NOW - 2 * DAY, NOW)), 6);
  assert.equal(h(hnInterval(thread, NOW - 60 * DAY, NOW)), 7 * 24);
  assert.equal(h(hnInterval(none, NOW - 2 * DAY, NOW)), 12);
  assert.equal(h(hnInterval(none, NOW - 60 * DAY, NOW)), 7 * 24);
  assert.equal(h(hnInterval(none, NOW - 200 * DAY, NOW)), 30 * 24);
  assert.equal(h(hnInterval(none, null, NOW)), 30 * 24);
});

test("readHnMap drops entries it cannot trust instead of rendering them", () => {
  const map = readHnMap({
    good: { id: 5, c: 2, p: 3, n: 1, checked: 1, seen: 2 },
    unchecked: { id: 5, c: 2 },
    zeroId: { id: 0, c: 2, checked: 1 },
    junk: "x",
  });
  assert.deepEqual(Object.keys(map).sort(), ["good", "zeroId"]);
  assert.equal(map.zeroId.id, null);
  assert.deepEqual(readHnMap(null), {});
  assert.deepEqual(readHnMap([1, 2]), {});
});

test("/reading shows a thread only where it has comments, and says how many links have one", async () => {
  const items = [
    { title: "Discussed", link: "https://a.com/x?utm_source=y", domain: "a.com", created: "2026-09-28T00:00:00Z" },
    { title: "Quiet", link: "https://a.com/quiet", domain: "a.com", created: "2026-09-27T00:00:00Z" },
    { title: "Unasked", link: "https://b.com/", domain: "b.com", created: "2026-09-26T00:00:00Z" },
  ];
  const hn = readHnMap({
    "a.com/x": { id: 4242, c: 1, p: 9, n: 1, checked: NOW },
    "a.com/quiet": { id: 99, c: 0, p: 2, n: 1, checked: NOW },
  });
  const html = await (renderReadingPage({ items, fetchedAt: "2026-09-29T00:00:00Z" }, hn)).text();
  assert.match(html, /news\.ycombinator\.com\/item\?id=4242/);
  assert.match(html, /1 comment</, "the count reads in the singular for one comment");
  assert.doesNotMatch(html, /item\?id=99/, "a thread with no comments earned a badge");
  assert.match(html, /1 discussed on Hacker News/);
  assert.equal(hnThreadFor("https://b.com/", hn), null);
  // The control: with no map the page renders exactly as it did before.
  const bare = await (renderReadingPage({ items, fetchedAt: "2026-09-29T00:00:00Z" })).text();
  assert.doesNotMatch(bare, /Hacker News|rd-hn"/);
});

test("the HN job reads the Curius payload under the key /reading writes it to", async () => {
  // reading-hn.ts names the key as a literal, because importing it from
  // reading.ts would make the two modules import each other.
  const src = await readFile(new URL("src/worker/reading-hn.ts", ROOT), "utf8");
  assert.ok(src.includes(`"${CURIUS_CACHE_KEY}"`), `reading-hn.ts does not read ${CURIUS_CACHE_KEY}`);
  assert.notEqual(HN_MAP_KEY, CURIUS_CACHE_KEY);
});
