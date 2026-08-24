// ── the search corpus ────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  existsSync,
  readFileSync,
  test,
} from "./contract-shared.ts";

// The index behind /search and /ask is BUILD OUTPUT (tools/generate-search-index.ts),
// like the RSS feeds and the Markdown twins. It was a COMMITTED file until
// 2026-08-24 and froze twice while it was one: first when the src/pages split
// left the walk scanning a deleted `www` (ENOENT, so it stopped writing), then
// again when the roots were right and nobody ran the script. Both were silent,
// because /search answers out of whatever corpus it is handed and an incomplete
// one is a working page missing three results.
//
// These pin the properties that made those failures invisible. The build's own
// floors catch a COLLAPSE; nothing there can see the index reappearing in the
// source tree, or the step being unwired, which are the two ways the shape
// comes back.

test("no committed copy of the index exists to fall behind", () => {
  assert.ok(
    !existsSync("public/search-index.json"),
    "public/search-index.json is back in the source tree. It is generated into .build/ by build.ts step 1i; " +
    "a committed copy is the exact artifact that froze twice, because nothing diffs it against the source it derives from.",
  );
});

test("the build still generates it, with both floors intact", () => {
  const build = readFileSync("tools/build.ts", "utf8");
  // The IMPORT, not the bare identifier: a control that stubbed the step out as
  // `const buildSearchIndex = async () => ({ records: [] })` left the name in
  // place and sailed past a looser pattern, which is the unwiring this watches for.
  assert.match(
    build,
    /await import\("\.\/generate-search-index\.ts"\)/,
    "build.ts no longer imports the generator — the index would silently stop being staged",
  );
  assert.match(
    build,
    /public\/search-index\.json/,
    "build.ts no longer writes public/search-index.json into the staged tree",
  );
  // A generator wired in with its tripwires deleted is the freeze wearing a
  // different hat: the step runs, writes an empty corpus, and passes.
  assert.match(build, /expected 50\+/, "the record floor is gone from build.ts step 1i");
  assert.match(build, /searchIndex\?/, "the surface-registry floor is gone from build.ts step 1i");
});

test("the corpus covers every static document and every flagged surface", async () => {
  const { buildSearchIndex } = await import("./generate-search-index.ts");
  const index = await buildSearchIndex(".");
  const urls = new Set(index.records.map((r) => r.url));

  // The registry half. A worker-rendered surface has no file for the walk to
  // find, so `searchIndex: true` is its only way in; the 2026-08-18 failure
  // took out the walk alone and left these looking fine.
  const manifest = JSON.parse(readFileSync("config/site-manifest.json", "utf8"));
  for (const surface of manifest.surfaces.filter((s) => s.flags.searchIndex)) {
    assert.ok(urls.has(surface.path), `${surface.path} is flagged searchIndex but is missing from the corpus`);
  }

  // The walk half, stated as the invariant rather than as a count: every HTML
  // document that authors in src/pages is a page an agent should be able to
  // find, and the freeze was precisely a set of documents the corpus omitted.
  // /search is excluded by the generator on purpose (it would index itself).
  const { readdirSync } = await import("node:fs");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  const documents = walk("src/pages")
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice("src/pages".length, -".html".length))
    .map((p) => (p === "/index" ? "/" : p.endsWith("/index") ? p.slice(0, -"/index".length) : p))
    .filter((p) => p !== "/search");
  for (const path of documents) {
    assert.ok(urls.has(path), `${path} authors in src/pages but is missing from the corpus`);
  }
  assert.ok(documents.length >= 40, `only ${documents.length} documents found under src/pages — did the walk break?`);
});

test("every record carries the fields /search ranks and /ask publishes", async () => {
  const { buildSearchIndex } = await import("./generate-search-index.ts");
  const { records } = await buildSearchIndex(".");
  for (const record of records) {
    assert.match(record.url, /^\//, `record url is not a site-absolute path: ${record.url}`);
    assert.ok(record.title, `${record.url} has no title`);
    // /ask publishes `description` inside a schema.org object, so a leftover
    // character reference in one is a wrong value handed to a machine rather
    // than a cosmetic blemish in a snippet.
    assert.ok(record.description, `${record.url} has no description`);
    assert.doesNotMatch(record.description, /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i, `${record.url} description carries an undecoded character reference`);
    assert.doesNotMatch(record.description, /<[a-z/]/i, `${record.url} description carries markup`);
    assert.ok(["page", "writing", "document", "utility"].includes(record.kind), `${record.url} has an unknown kind: ${record.kind}`);
  }
});

// The dev farm is built from symlinks and one of them outlives the file: the
// farm stages .dev-assets/search-index.json -> ../public/search-index.json, and
// that link survives the file being deleted. Writing through it recreates the
// committed copy in the source tree, which is the artifact this whole change
// removes. The first guard written for it MISSED, because it resolved the
// parent directory (real) rather than the file (the symlink), and realpath()
// throws on a dangling link. So the resolution is what gets pinned here.
test("a dangling symlink resolves to the path a write would land on", async () => {
  const { linkTarget } = await import("./generate-search-index.ts");
  const { mkdtemp, symlink, rm, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j, resolve: r } = await import("node:path");

  const dir = await mkdtemp(j(tmpdir(), "search-index-guard-"));
  try {
    // Dangling: the target does not exist, which is the farm's exact state.
    await symlink("../public/search-index.json", j(dir, "dangling"));
    assert.equal(await linkTarget(j(dir, "dangling")), r(dir, "../public/search-index.json"));

    // A chain, since the farm nests directory links above file links.
    await write(j(dir, "real"), "x");
    await symlink("real", j(dir, "hop1"));
    await symlink("hop1", j(dir, "hop2"));
    assert.equal(await linkTarget(j(dir, "hop2")), j(dir, "real"));

    // A plain path is itself, so the guard cannot false-fire on the build's own target.
    assert.equal(await linkTarget(j(dir, "plain")), j(dir, "plain"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
