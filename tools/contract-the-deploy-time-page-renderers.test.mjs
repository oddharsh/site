// ── the deploy-time page renderers ──────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ALBUMS,
  ROOT,
  albumPath,
  albumPool,
  assert,
  curatedPool,
  derivePhotoPool,
  readFile,
  renderAlbumPage,
  renderPhotosPage,
  test,
} from "./contract-shared.ts";

const FIXTURE_ALBUM = { slug: "fixture-album", title: "Fixture Album", lede: ["A first line", "and a second's"], description: "a test album" };
const withFixtureAlbum = (pool) => pool.map((p, i) =>
  i < 3 ? { ...p, album: FIXTURE_ALBUM.slug, heif: i === 0 ? `${p.stem}.HIF` : null } : p);
const albumsUnderTest = () => [...Object.values(ALBUMS), FIXTURE_ALBUM];

test("renderPhotosPage is pure over the committed pool", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const alt = JSON.parse(await readFile(new URL("public/images/alt.json", ROOT), "utf8"));
  const pool = derivePhotoPool(index, hashes);

  const a = await renderPhotosPage(pool, alt).text();
  const b = await renderPhotosPage(pool, alt).text();
  assert.equal(a, b, "same inputs must give byte-identical output");
  assert.equal(a.split('class="ph"').length - 1, curatedPool(pool).length, "one tile per curated photo");
  for (const album of Object.values(ALBUMS)) {
    const n = albumPool(pool, album).length;
    if (n) assert.ok(a.includes(`href="${albumPath(album)}">${album.title}</a> (${n})`), `${album.slug}: the lede must link the album with its count`);
    for (const p of albumPool(pool, album)) assert.ok(!a.includes(`>${p.stem}</span>`), `${p.stem} is in album ${album.slug} and must not be tiled on /photos`);
  }
  assert.ok(a.includes("<!DOCTYPE html>") || a.includes("<!doctype html>"), "must be a whole document");

  const empty = renderPhotosPage([], alt);
  assert.equal(empty.status, 503, "an empty pool must refuse rather than ship bare frames");
  const albumOnly = renderPhotosPage([{ ...pool[0], album: FIXTURE_ALBUM.slug }], alt);
  assert.equal(albumOnly.status, 503, "a pool with no curated photo must refuse too");
});

test("renderAlbumPage is pure over the committed pool and never invents a format", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const alt = JSON.parse(await readFile(new URL("public/images/alt.json", ROOT), "utf8"));
  const pool = withFixtureAlbum(derivePhotoPool(index, hashes));

  for (const album of albumsUnderTest()) {
    const members = albumPool(pool, album);
    assert.ok(members.length > 0, `${album.slug}: registered in albums.ts but no photo-index.json entry carries it; run add-photos.sh with ALBUM=${album.slug}`);
    const a = await renderAlbumPage(album, pool, alt).text();
    const b = await renderAlbumPage(album, pool, alt).text();
    assert.equal(a, b, `${album.slug}: same inputs must give byte-identical output`);
    assert.equal(a.split('class="ph"').length - 1, members.length, `${album.slug}: one tile per member`);
    const jxl = members.filter((p) => /\.jxl$/i.test(p.full ?? "")).length;
    assert.equal(a.split(">JPEG</a>").length - 1, members.length - jxl, `${album.slug}: every JPEG original downloads as JPEG`);
    assert.equal(a.split(">JPEG XL</a>").length - 1, jxl, `${album.slug}: every JPEG XL original downloads as JPEG XL`);
    assert.equal(a.split(">HEIF</a>").length - 1, members.filter((p) => p.heif).length, `${album.slug}: a HEIF link only where the index records one`);
    for (const p of members) {
      if (p.heif) assert.ok(a.includes(`href="/images/full/${p.heif}" download>HEIF</a>`), `${p.stem}: the HEIF link names its own key`);
      assert.ok(!a.includes(`/images/full/undefined`), "no tile may link a missing key");
    }
    assert.ok(a.includes(album.title), `${album.slug}: the page carries its title`);
    for (const line of album.lede) assert.ok(a.includes(line.replace(/'/g, "&#39;")), `${album.slug}: the lede line "${line}" reaches the page`);
  }

  const none = renderAlbumPage({ slug: "nope", title: "Nope", lede: [], description: "" }, pool, alt);
  assert.equal(none.status, 503, "an album nobody ran the pipeline for must refuse rather than ship an empty sheet");
  assert.equal(albumPool(curatedPool(pool), FIXTURE_ALBUM).length, 0, "curated and album pools are disjoint");
  assert.equal(albumPool(pool, FIXTURE_ALBUM).length, 3);
});

test("the contact sheets defer every tile past the first screen", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const alt = JSON.parse(await readFile(new URL("public/images/alt.json", ROOT), "utf8"));
  const pool = derivePhotoPool(index, hashes);
  const sheets = [["/photos", await renderPhotosPage(pool, alt).text()]];
  const albumSheetPool = withFixtureAlbum(pool);
  for (const album of albumsUnderTest()) {
    if (albumPool(albumSheetPool, album).length) sheets.push([albumPath(album), await renderAlbumPage(album, albumSheetPool, alt).text()]);
  }
  const EAGER = 12;
  for (const [path, doc] of sheets) {
    const tiles = doc.split('<div class="ph">').slice(1).map((t) => t.slice(0, t.indexOf("</div>")));
    // what the browser parses with scripts on: <noscript> content is inert text then
    const live = (tile) => tile.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    tiles.forEach((tile, i) => {
      const where = `${path} tile ${i}`;
      assert.ok(!live(tile).includes('loading="lazy"'), `${where}: loading="lazy" hands the fetch distance back to the browser`);
      if (i < EAGER) {
        assert.ok(!tile.includes("data-defer"), `${where}: the first ${EAGER} tiles load with the page`);
        assert.match(tile, /<source type="image\/avif" srcset="[^"]+">/, `${where}: an eager tile names its AVIF`);
      } else {
        assert.ok(live(tile).includes("<picture data-defer>"), `${where}: a tile past the first screen is deferred`);
        assert.ok(!/ (srcset|src)="/.test(live(tile).replace(/ (href)="[^"]*"/g, "")), `${where}: a deferred tile names no URL the browser would fetch`);
        assert.match(live(tile), /<source type="image\/avif" data-srcset="[^"]+">/, `${where}: the AVIF source is deferred too, or the browser fetches it anyway`);
        assert.match(live(tile), /<img data-src="[^"]+"/, `${where}: the JPEG fallback is deferred`);
        assert.match(tile, /<noscript><picture>\s*<source type="image\/avif" srcset="[^"]+">\s*<img src="[^"]+"/, `${where}: a reader without scripts still gets the photo`);
      }
    });
    assert.equal(doc.split("picture[data-defer]{display:none}").length - 1, 1, `${path}: without scripts the empty deferred tile is hidden, once`);
    assert.equal(doc.split('rootMargin:"25%"').length - 1, 1, `${path}: one swap script, at the measured 25% margin`);
  }
});

test("renderBotPage takes no arguments and is deterministic", async () => {
  const { renderBotPage } = await import("../src/worker/bot.ts");
  assert.equal(renderBotPage.length, 0, "any parameter is a door for runtime state");
  const a = await renderBotPage().text();
  const b = await renderBotPage().text();
  assert.equal(a, b);
  assert.ok(a.includes("AadharshBot"), "must name the crawler the page exists to explain");
});
