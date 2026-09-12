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

// ── the deploy-time page renderers ──────────────────────────────────
// build.ts step 1e runs these in Node and writes photos.html / bot.html, which
// step 8 then turns into the q11 twin and the dcz deltas. The whole scheme rests on
// one property: the renderer is PURE over build-time artifacts, so Node and the
// Worker produce identical bytes. If it ever reaches for runtime state the twin
// stops matching what a visitor gets, and nothing else in the tree would notice —
// the page would just quietly serve stale-but-plausible HTML.
test("renderPhotosPage is pure over the committed pool", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const alt = JSON.parse(await readFile(new URL("public/images/alt.json", ROOT), "utf8"));
  const pool = derivePhotoPool(index, hashes);

  // no env, no ctx, no bindings: the signature cannot smuggle in runtime state
  const a = await renderPhotosPage(pool, alt).text();
  const b = await renderPhotosPage(pool, alt).text();
  assert.equal(a, b, "same inputs must give byte-identical output");
  // One tile per CURATED photo: album members are listed at their own page and
  // named in the lede by count, never tiled here.
  assert.equal(a.split('class="ph"').length - 1, curatedPool(pool).length, "one tile per curated photo");
  for (const album of Object.values(ALBUMS)) {
    const n = albumPool(pool, album).length;
    if (n) assert.ok(a.includes(`href="${albumPath(album)}">${album.title}</a> (${n})`), `${album.slug}: the lede must link the album with its count`);
    for (const p of albumPool(pool, album)) assert.ok(!a.includes(`>${p.stem}</span>`), `${p.stem} is in album ${album.slug} and must not be tiled on /photos`);
  }
  assert.ok(a.includes("<!DOCTYPE html>") || a.includes("<!doctype html>"), "must be a whole document");

  // an empty pool is a failed build, not a blank contact sheet
  const empty = renderPhotosPage([], alt);
  assert.equal(empty.status, 503, "an empty pool must refuse rather than ship bare frames");
  // and so is a pool holding ONLY album photos: /photos would be a page of links
  const albumOnly = renderPhotosPage([{ ...pool[0], album: "cota-wec" }], alt);
  assert.equal(albumOnly.status, 503, "a pool with no curated photo must refuse too");
});

// Same contract, per album. The renderer takes the WHOLE pool and selects the
// album's members itself, so the build and the live handler cannot pick two
// different sets; and every format link on a tile names a key the index
// actually records, since a link to an original that was never uploaded is
// the one thing this page must not do.
test("renderAlbumPage is pure over the committed pool and never invents a format", async () => {
  const index = JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8"));
  const alt = JSON.parse(await readFile(new URL("public/images/alt.json", ROOT), "utf8"));
  const pool = derivePhotoPool(index, hashes);
  assert.ok(Object.keys(ALBUMS).length >= 1, "at least one album is registered");

  for (const album of Object.values(ALBUMS)) {
    const members = albumPool(pool, album);
    // build.ts step 1e refuses an empty album for the same reason
    assert.ok(members.length > 0, `${album.slug}: registered in albums.ts but no photo-index.json entry carries it; run add-photos.sh with ALBUM=${album.slug}`);
    const a = await renderAlbumPage(album, pool, alt).text();
    const b = await renderAlbumPage(album, pool, alt).text();
    assert.equal(a, b, `${album.slug}: same inputs must give byte-identical output`);
    assert.equal(a.split('class="ph"').length - 1, members.length, `${album.slug}: one tile per member`);
    assert.equal(a.split(">JPEG</a>").length - 1, members.length, `${album.slug}: every tile downloads its JPEG`);
    assert.equal(a.split(">HEIF</a>").length - 1, members.filter((p) => p.heif).length, `${album.slug}: a HEIF link only where the index records one`);
    for (const p of members) {
      if (p.heif) assert.ok(a.includes(`href="/images/full/${p.heif}" download>HEIF</a>`), `${p.stem}: the HEIF link names its own key`);
      assert.ok(!a.includes(`/images/full/undefined`), "no tile may link a missing key");
    }
    assert.ok(a.includes(album.title), `${album.slug}: the page carries its title`);
    for (const line of album.lede) assert.ok(a.includes(line.replace(/'/g, "&#39;")), `${album.slug}: the lede line "${line}" reaches the page`);
  }

  // a fabricated album with no members refuses, and a pool of curated photos
  // contributes nothing to any album
  const none = renderAlbumPage({ slug: "nope", title: "Nope", lede: [], description: "" }, pool, alt);
  assert.equal(none.status, 503, "an album nobody ran the pipeline for must refuse rather than ship an empty sheet");
  assert.equal(albumPool(curatedPool(pool), Object.values(ALBUMS)[0]).length, 0, "curated and album pools are disjoint");
});

test("renderBotPage takes no arguments and is deterministic", async () => {
  const { renderBotPage } = await import("../src/worker/bot.ts");
  assert.equal(renderBotPage.length, 0, "any parameter is a door for runtime state");
  const a = await renderBotPage().text();
  const b = await renderBotPage().text();
  assert.equal(a, b);
  assert.ok(a.includes("AadharshBot"), "must name the crawler the page exists to explain");
});
