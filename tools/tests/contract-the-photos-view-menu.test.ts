// ── the /photos View menu ───────────────────────────────────────────────────
// photos.ts renders the menu bar and its three views as static markup, and
// photos-view.js wires them. Two things are easy to break without a browser
// noticing: the markup the script reads (a menu with no checked view, or a
// menu bar on a page that never loads the script, is a View button that does
// nothing), and the ?mv= cache key the script shares with tooltip.ts, where a
// bump in one file and not the other serves a year-cached exif.json to one of
// the two readers.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { ALBUMS, derivePhotoPool, renderAlbumPage, renderPhotosPage } from "./contract-shared.ts";

const pool = async () =>
  derivePhotoPool(
    JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8")),
    JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8")),
  );

test("/photos ships the View menu between caption and address bar, with Thumbnails checked", async () => {
  const page = await renderPhotosPage(await pool(), {}).text();
  assert.equal(page.split('role="menubar"').length - 1, 1, "one menu bar");
  const views = [...page.matchAll(/role="menuitemradio" tabindex="-1" aria-checked="(true|false)" data-view="(\w+)">(\w+)</g)].map((m) => [m[2], m[1], m[3]]);
  assert.deepEqual(views, [
    ["filmstrip", "false", "Filmstrip"],
    ["thumbnails", "true", "Thumbnails"],
    ["details", "false", "Details"],
  ]);
  // Explorer's order: title bar, menu bar, address bar.
  const caption = page.indexOf('class="title-bar'),
    menubar = page.indexOf('class="ph-menubar"'),
    address = page.indexOf('class="axp-address');
  assert.ok(caption > 0 && caption < menubar && menubar < address, `caption ${caption}, menu bar ${menubar}, address ${address}`);
  assert.ok(page.includes('<script src="/photos-view.js" defer></script>'), "the page loads the script that wires its menu");
});

// An album page loads no photos-view.js, so a menu there would be dead. The
// album registry is empty since 2026-10-07; the fixture stands in for one.
test("an album page carries no View menu, since nothing would wire it", async () => {
  const fixture = { slug: "fixture-album", title: "Fixture Album", lede: ["a line"], description: "a test album" };
  const photos = (await pool()).map((p, i) => (i < 3 ? { ...p, album: fixture.slug } : p));
  for (const album of [...Object.values(ALBUMS), fixture]) {
    const page = await renderAlbumPage(album, photos, {}).text();
    assert.ok(page.includes('class="sheet"'), `${album.slug}: renders its sheet`);
    assert.ok(!page.includes("ph-menubar") && !page.includes("photos-view.js"), `${album.slug}: no menu bar and no script`);
  }
});

const cacheKeys = (source: string) => [...new Set([...source.matchAll(/\bmv=(\d+)/g)].map((m) => m[1]))];
const disagreement = (tooltip: string, view: string) => {
  const a = cacheKeys(tooltip),
    b = cacheKeys(view);
  return a.length === 1 && b.length === 1 && a[0] === b[0] ? null : `tooltip.ts says mv=${a.join(",")}, photos-view.ts says mv=${b.join(",")}`;
};

test("photos-view.ts and tooltip.ts fetch exif.json and the meta files under the same ?mv=", async () => {
  const tooltip = await readFile(new URL("src/client/tooltip.ts", ROOT), "utf8");
  const view = await readFile(new URL("src/client/photos-view.ts", ROOT), "utf8");
  assert.equal(disagreement(tooltip, view), null);
});

test("CONTROL: a bump in one file and not the other is reported", () => {
  assert.equal(disagreement('META_V = "mv=7"', 'META_V = "mv=7"'), null);
  assert.equal(disagreement('META_V = "mv=8"', 'META_V = "mv=7"'), "tooltip.ts says mv=8, photos-view.ts says mv=7");
  assert.equal(disagreement('META_V = "mv=7"', "no key at all"), "tooltip.ts says mv=7, photos-view.ts says mv=");
});
