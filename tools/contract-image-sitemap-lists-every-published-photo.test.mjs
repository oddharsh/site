// ── /sitemap-images.xml ──────────────────────────────────────────────
// build.ts step 1e writes it from the bundled photo pool through
// imageSitemapXml() in src/worker/photos.ts, and robots.txt advertises it. These
// tests hold the three properties a crawler depends on without a build: every
// published photo is listed exactly once, under the page that shows it, at the
// full-size URL its tile opens; the XML is well formed enough to parse; and
// robots.txt names the file.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

test("every published photo is listed once, under /photos or its album, at its full-size URL", async () => {
  const { imageSitemapXml, PHOTO_POOL, curatedPool, albumPool } = await import("../src/worker/photos.ts");
  const { ALBUMS, albumPath } = await import("../src/worker/albums.ts");
  const albums = Object.values(ALBUMS);
  const xml = imageSitemapXml(PHOTO_POOL, albums);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1">/);
  assert.ok(xml.trimEnd().endsWith("</urlset>"));

  const pages = new Map([...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)]
    .map(([, loc, body]) => [loc, [...body.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((m) => m[1])]));
  const expect = [{ path: "/photos", members: curatedPool(PHOTO_POOL) },
    ...albums.map((a) => ({ path: albumPath(a), members: albumPool(PHOTO_POOL, a) }))];
  assert.equal(pages.size, expect.length, "one <url> per photo page");
  for (const { path, members } of expect) {
    const listed = pages.get(`https://aadhar.sh${path}`);
    assert.ok(listed, `${path} has no <url>`);
    assert.equal(listed.length, members.filter((p) => p.full).length, `${path}: listed count`);
    for (const loc of listed) assert.match(loc, /^https:\/\/aadhar\.sh\/images\/full\/[^\s"<>]+$/, `${path}: ${loc}`);
  }
  const all = [...pages.values()].flat();
  assert.equal(new Set(all).size, all.length, "a photo is listed twice");
  // The floor mirrors build.ts's.
  assert.ok(all.length >= 100, `only ${all.length} images`);
});

test("an ampersand in a key is escaped, so one odd filename cannot break the file", async () => {
  const { imageSitemapXml, PHOTO_POOL } = await import("../src/worker/photos.ts");
  const xml = imageSitemapXml([{ ...PHOTO_POOL[0], full: "R&D shoot/a.jpg" }], []);
  assert.ok(!/&(?!amp;)/.test(xml), xml);
});

test("robots.txt advertises the image sitemap beside the page sitemap", () => {
  const robots = readFileSync("public/robots.txt", "utf8");
  assert.match(robots, /^Sitemap: https:\/\/aadhar\.sh\/sitemap\.xml$/m);
  assert.match(robots, /^Sitemap: https:\/\/aadhar\.sh\/sitemap-images\.xml$/m);
});
