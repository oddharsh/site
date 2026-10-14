// ── RSS feeds ────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  existsSync,
  readFileSync,
  test,
} from "./contract-shared.ts";

test("every feed is well-formed, dated, and newest-first", async () => {
  const { buildFeeds, FEEDS, rfc822 } = await import("./gen-feeds.ts");
  const feeds = buildFeeds(".");
  assert.equal(feeds.size, FEEDS.length);

  for (const [route, body] of feeds) {
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, `${route} must open with the XML declaration`);
    assert.match(body, /<rss version="2\.0"/, `${route} must declare RSS 2.0`);
    assert.ok(body.includes(`<atom:link href="https://aadhar.sh${route}" rel="self"`), `${route} must point at itself`);

    const items = [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item);
    assert.ok(items.length, `${route} has no items`);

    const dates = items.map((item) => {
      const raw = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
      assert.ok(raw, `${route} has an item with no pubDate`);
      const parsed = Date.parse(raw);
      assert.ok(Number.isFinite(parsed), `${route} has an unparseable pubDate: ${raw}`);
      return parsed;
    });
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a), `${route} is not newest-first`);

    for (const item of items) {
      const guid = item.match(/<guid isPermaLink="true">([^<]+)<\/guid>/)?.[1];
      const link = item.match(/<link>([^<]+)<\/link>/)?.[1];
      assert.equal(guid, link, `${route} has an item whose guid and link disagree`);
      assert.match(guid, /^https:\/\/aadhar\.sh\//, `${route} has a non-absolute guid`);
      for (const field of ["title", "description"]) {
        const value = item.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`))?.[1] ?? "";
        assert.doesNotMatch(value, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/, `${route} has an unescaped & in an item ${field}`);
        assert.doesNotMatch(value, /[<>]/, `${route} has a raw angle bracket in an item ${field}`);
      }
    }
  }

  assert.equal(rfc822("not-a-date"), null);
  assert.equal(rfc822("2026-06-07"), "Sun, 07 Jun 2026 12:00:00 GMT");
});

test("feed dates come from the sitemap the crawler already reads", async () => {
  const { buildFeeds, sitemapDates } = await import("./gen-feeds.ts");
  const dates = sitemapDates(readFileSync("public/sitemap.xml", "utf8"));
  assert.ok(dates.size >= 40, `expected the sitemap to carry lastmod dates, found ${dates.size}`);

  const garage = buildFeeds(".").get("/garage/feed.xml");
  for (const [, item] of garage.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const path = item.match(/<link>https:\/\/aadhar\.sh([^<]+)<\/link>/)[1];
    const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)[1];
    assert.equal(pubDate, new Date(`${dates.get(path)}T12:00:00Z`).toUTCString(),
      `${path} is dated differently in the feed and the sitemap`);
  }
});

test("each section advertises its feed", () => {
  for (const [file, feed] of [["src/pages/garage/index.html", "/garage/feed.xml"], ["src/pages/lwe/index.html", "/lwe/feed.xml"]]) {
    const html = readFileSync(file, "utf8");
    assert.ok(html.includes(`type="application/rss+xml"`) && html.includes(`href="${feed}"`),
      `${file} does not advertise ${feed}`);
  }
  assert.match(readFileSync("src/worker/writing.ts", "utf8"), /application\/rss\+xml[^"]*"[^"]*"\s*\+?[^"]*writing\/feed\.xml|writing\/feed\.xml/);
});

test("a garage card cites nothing the page it describes does not", () => {
  const index = readFileSync("src/pages/garage/index.html", "utf8");
  const cards = index.match(/<li>[\s\S]*?<\/li>/g) || [];
  let checked = 0, cited = 0;
  for (const card of cards) {
    const slug = /class="name"><a href="([^"]+)"/.exec(card);
    const desc = /<div class="desc">([\s\S]*?)<\/div>/.exec(card);
    if (!slug || !desc) continue;
    checked++;
    const urls = [...desc[1].matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    if (!urls.length) continue;
    const file = slug[1] === "/pixel-peeper"
      ? "src/pages/pixel-peeper/index.html"
      : `src/pages${slug[1]}.html`;
    assert.ok(existsSync(file),
      `the /garage card for ${slug[1]} carries a citation, but ${file} does not exist — a Worker-rendered page has to carry its own credit`);
    const page = readFileSync(file, "utf8");
    for (const url of urls) {
      cited++;
      assert.ok(page.includes(url),
        `the /garage card for ${slug[1]} cites ${url}, which never appears on ${file}`);
    }
  }
  assert.ok(checked >= 20, `only found ${checked} garage cards, so the shape changed`);
  assert.ok(cited >= 14, `only found ${cited} cited URLs, so the citations are being missed`);
});
