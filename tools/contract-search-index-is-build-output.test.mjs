// ── the search corpus ────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  existsSync,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { execFileSync } from "node:child_process";

// The production cache lives for the isolate. Bun shares modules across test
// files (and ignores import query strings), so each cache scenario needs a new
// process rather than a reset hook in production code.
function isolatedSearch(check) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { searchSite, searchSiteRanked } from ${JSON.stringify(new URL("../src/worker/search.ts", import.meta.url).href)};
    import { buildSearchIndex } from ${JSON.stringify(new URL("./generate-search-index.ts", import.meta.url).href)};
    await (${check.toString()})({ searchSite, searchSiteRanked, buildSearchIndex });
  `], { stdio: "pipe", timeout: 5000 });
}

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

test("search retains late article text and uses authored metadata without indexing the window chrome", async () => {
  const { buildSearchIndex } = await import("./generate-search-index.ts");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "search-corpus-"));
  try {
    for (const dir of ["src/pages", "src/content/writing", "public", "config"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, "config/site-manifest.json"), JSON.stringify({ surfaces: [] }));
    await writeFile(join(root, "src/pages/deep.html"), `<html><head>
      <title>Deep article</title><meta content='An authored &amp; precise description' name=description>
      </head><body><div class=title-bar>WINDOWCHROME</div><main>
      <h1>Deep article</h1><p>${"Opening prose. ".repeat(200)}</p>
      <h2>Late discovery</h2><p>A micro<em>scope</em> finds raretailword. <code>x &lt; y</code></p>
      <script>ANSWERKEY</script ><style>STYLELEAK</style/>
      <button>CONTROLLEAK</button><span aria-hidden=true>ORNAMENT</span>
      <img src=x alt='A lunar crater'><p>Last paragraph.</p></main></body></html>`);
    await writeFile(join(root, "src/content/writing/long.txt"), `${"Opening prose. ".repeat(200)}writingtailword`);
    const { records } = await buildSearchIndex(root);
    const article = records.find((r) => r.url === "/deep");
    assert.ok(article);
    assert.equal(article.title, "Deep article");
    assert.equal(article.description, "An authored & precise description");
    assert.match(article.text, /Late discovery A microscope finds raretailword\. x < y/);
    assert.match(article.text, /A lunar crater Last paragraph\.$/);
    assert.doesNotMatch(article.text, /WINDOWCHROME|ANSWERKEY|STYLELEAK|CONTROLLEAK|ORNAMENT/);
    const writing = records.find((r) => r.url === "/writing/long");
    assert.ok(writing);
    assert.match(writing.text, /writingtailword$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the corpus retains documented topics beyond Horizon's opening screen", () => isolatedSearch(async ({ buildSearchIndex, searchSite }) => {
  const { records } = await buildSearchIndex(".");
  const env = { ASSETS: { fetch: async () => Response.json({ records }) } };
  const horizon = records.find((r) => r.url === "/garage/horizon");
  assert.ok(horizon);
  for (const topic of ["scheduler.yield", "field-sizing", "text-box-trim"]) {
    assert.ok(horizon.text.includes(topic), `Horizon documents ${topic}, but search cannot retrieve it`);
    const result = await searchSite(env, topic, 5);
    assert.ok(result.results.some((r) => r.url === horizon.url), `${topic} must retrieve Horizon in its first five results`);
  }
}));

test("prepared search preserves weights, ties, excerpt normalization, and limits", () => isolatedSearch(async ({ searchSiteRanked }) => {
  const records = [
    { url: "/title", title: "Needle", description: "Title match", text: "", kind: "page" },
    { url: "/description", title: "Description", description: "Needle", text: "", kind: "page" },
    ...Array.from({ length: 60 }, (_, i) => ({ url: `/body-${String(i).padStart(2, "0")}`,
      title: "Body", description: "Body match", text: "Prefix  NEEDLE\n\t tail", kind: "page" })),
  ];
  let reads = 0;
  const env = { ASSETS: { fetch: async () => { reads++; return Response.json({ records }); } } };
  const first = await searchSiteRanked(env, "needle", 3);
  assert.equal(first.total, 62);
  assert.equal(first.returned, 3);
  assert.deepEqual(first.results.map((r) => [r.url, r.score]), [["/title", 8], ["/description", 4], ["/body-00", 1]]);
  assert.equal(first.results[1].snippet, "Needle", "a metadata-only record uses its description");
  assert.equal(first.results[2].snippet, "Prefix NEEDLE tail");
  assert.equal((await searchSiteRanked(env, "needle", 100)).returned, 50);
  assert.equal((await searchSiteRanked(env, "missingword")).total, 0);
  assert.equal(reads, 1, "completed corpus data is reused across queries");
}));

test("a failed corpus load can recover on the next request", () => isolatedSearch(async ({ searchSite }) => {
  let reads = 0;
  const env = { ASSETS: { fetch: async () => {
    reads++;
    if (reads === 1) throw new Error("temporary asset failure");
    if (reads === 2) return new Response("invalid JSON");
    if (reads === 3) return Response.json({ records: null });
    if (reads === 4) return new Response("unavailable", { status: 503 });
    return Response.json({ records: [{ url: "/recovered", title: "Recovered", description: "", text: "", kind: "page" }] });
  } } };
  for (let i = 0; i < 4; i++) assert.equal((await searchSite(env, "recovered")).total, 0);
  assert.equal((await searchSite(env, "recovered")).results[0].url, "/recovered");
  assert.equal(reads, 5);
}));

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
