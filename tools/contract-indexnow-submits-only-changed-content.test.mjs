// ── IndexNow submits the pages whose CONTENT a release changed ───────────────
// Shared imports live in contract-shared.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { changedPages, contentUrl, INDEXNOW_KEY, readStatus, sitemapPaths, submission } from "./lib/indexnow.ts";
import { SCHEMA } from "./lib/served-manifest.ts";

// After each release, tools/indexnow.ts diffs the two signed served manifests
// and submits the sitemap pages whose content moved. "Content" is the page's
// Markdown twin (or a writing post's .txt, or the file itself), because HTML
// bytes move on every shell re-mint: measured across #1063, 53 of 56 sitemap
// pages changed bytes and 0 changed content.

/** @param {Record<string, string>} files @returns {import("./lib/served-manifest.ts").ServedManifest} */
const manifest = (files) => ({ schema: SCHEMA, commit: null, files });

test("indexnow: the key is served at /<key>.txt, as the protocol requires", async () => {
  assert.match(INDEXNOW_KEY, /^[a-zA-Z0-9-]{8,128}$/);
  const served = await readFile(new URL(`public/${INDEXNOW_KEY}.txt`, ROOT), "utf8");
  assert.equal(served.trim(), INDEXNOW_KEY, "the engines compare the file body with the submitted key");
  assert.deepEqual(submission("aadhar.sh", ["https://aadhar.sh/x"]), {
    host: "aadhar.sh", key: INDEXNOW_KEY, keyLocation: `https://aadhar.sh/${INDEXNOW_KEY}.txt`, urlList: ["https://aadhar.sh/x"],
  });
  const oracle = await readFile(new URL("tools/verify-routes.ts", ROOT), "utf8");
  assert.ok(oracle.includes(`path: "/${INDEXNOW_KEY}.txt", status: 200`), "the route oracle must hold the key file at 200");
});

test("indexnow: a page's content is its twin, else its .txt source, else itself", () => {
  const files = { "/index.md": "a", "/garage/x.md": "b", "/garage/x": "c", "/writing/post": "d", "/writing/post.txt": "e", "/resume.pdf": "f" };
  assert.equal(contentUrl("/", files), "/index.md");
  assert.equal(contentUrl("/garage/x", files), "/garage/x.md", "the twin outranks the HTML, which moves on every re-mint");
  assert.equal(contentUrl("/writing/post", files), "/writing/post.txt");
  assert.equal(contentUrl("/resume.pdf", files), "/resume.pdf");
  assert.equal(contentUrl("/missing", files), null);
});

test("indexnow: a shell re-mint submits nothing, a prose edit or a new page submits that page", () => {
  const paths = ["/", "/garage/x", "/garage/new", "/gone"];
  const prev = manifest({ "/": "h1", "/index.md": "m1", "/garage/x": "h2", "/garage/x.md": "m2", "/gone": "h9" });
  // Every HTML hash moves (a new /a/nav.<hash8>.js ref), no twin does.
  const remint = manifest({ "/": "H1", "/index.md": "m1", "/garage/x": "H2", "/garage/x.md": "m2" });
  assert.deepEqual(changedPages(prev, remint, paths, "aadhar.sh"), []);

  const edited = manifest({ "/": "H1", "/index.md": "m1", "/garage/x": "H2", "/garage/x.md": "M2", "/garage/new": "h3", "/garage/new.md": "m3" });
  assert.deepEqual(changedPages(prev, edited, paths, "aadhar.sh"), ["https://aadhar.sh/garage/x", "https://aadhar.sh/garage/new"]);
});

test("indexnow: the real sitemap parses to every page", async () => {
  const xml = await readFile(new URL("public/sitemap.xml", ROOT), "utf8");
  const paths = sitemapPaths(xml, "aadhar.sh");
  assert.equal(paths.length, (xml.match(/<loc>/g) ?? []).length, "every <loc> is on aadhar.sh, so every one must parse");
  assert.ok(paths.includes("/"));
});

test("indexnow: the sitemap parse and every protocol status", () => {
  const xml = "<urlset><url><loc>https://aadhar.sh</loc></url><url><loc>https://aadhar.sh/garage</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>";
  assert.deepEqual(sitemapPaths(xml, "aadhar.sh"), ["/", "/garage"]);
  // Hosts are compared parsed and exact, never pattern-matched.
  const tricky = "<loc>https://aadhar.sh.evil.test/x</loc><loc>https://aadharXsh/y</loc><loc>http://aadhar.sh/z</loc><loc>not a url</loc><loc> https://aadhar.sh/ok </loc>";
  assert.deepEqual(sitemapPaths(tricky, "aadhar.sh"), ["/ok"]);
  assert.equal(readStatus(200).ok, true);
  assert.equal(readStatus(202).ok, true, "202 is accepted with key validation still pending");
  for (const s of [400, 403, 422, 429, 500]) assert.equal(readStatus(s).ok, false, String(s));
});

test("indexnow: the release job submits after it checks, and never blocks on it", async () => {
  const wf = await readFile(new URL(".github/workflows/promote-production.yml", ROOT), "utf8");
  const served = wf.indexOf("run: bun run served:check");
  const submit = wf.indexOf("run: bun run indexnow ${SINCE:+--since \"$SINCE\"}");
  assert.ok(served > 0 && submit > served, "submit after the served check, so a release that fails it is still visible first");
  const step = wf.slice(wf.lastIndexOf("- name:", submit), submit);
  assert.match(step, /continue-on-error: true/, "a search engine's answer must never fail a release job");

  const tool = await readFile(new URL("tools/indexnow.ts", ROOT), "utf8");
  assert.match(tool, /submitted nothing/, "with no previous manifest it must submit nothing, never the whole site");
});
