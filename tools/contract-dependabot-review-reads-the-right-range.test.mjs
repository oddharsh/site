// `bun run deps:review` reads a Dependabot bump against this tree, and every
// step before the model is a heuristic that can match NOTHING and still hand
// the model a clean-looking read: a body shape it does not parse, a tag spelled
// a way it does not know, a changelog heading it does not find. Each of those
// fails as an absence, which is the shape this repository keeps meeting
// (gotcha 18, gotcha 40), so each is pinned here against the real spelling
// that first tripped it, and the controls are what would have to be true for
// the fetch half to be reading the wrong package.
//
// Nothing here touches the network. The fetch and the model live in the CLI;
// this drives tools/lib/dependency-review.ts, which is the pure half.
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMENT_MARKER,
  REVIEW_SCHEMA,
  bodySectionsFor,
  bumpsFromBody,
  bumpsFromMetadata,
  changelogSlice,
  compareVersions,
  dependencyDocBullets,
  ecosystemFromFiles,
  ecosystemOf,
  escapeMd,
  htmlToText,
  inBumpRange,
  pairsFromComment,
  pairsKey,
  parseReview,
  releaseVersion,
  renderComment,
  renderFallback,
  renderPackage,
  repoLinkFor,
  selectUsage,
  tagCandidates,
  usageRank,
  versionFromReleaseName,
  versionFromTag,
} from "./lib/dependency-review.ts";

// Real shapes, trimmed. #796 (one package), #805 (a group of two in one
// monorepo), #774 (two actions from one repository).
const SINGLE = `Bumps [wrangler](https://github.com/cloudflare/workers-sdk/tree/HEAD/packages/wrangler) from 4.130.0 to 4.131.1.
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/cloudflare/workers-sdk/releases">wrangler's releases</a>.</em></p>
<blockquote>
<h2>wrangler@4.131.1</h2>
<h3>Patch Changes</h3>
<ul>
<li>Wrangler now explains that DNS provisioning may continue after a deploy. <a href="https://redirect.github.com/cloudflare/workers-sdk/pull/15592">#15592</a></li>
</ul>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/cloudflare/workers-sdk/commit/abc"><code>abc1234</code></a> Version Packages</li>
</ul>
</details>
`;

const GROUP = `Bumps the oxlint group with 2 updates: [@oxlint/plugins](https://github.com/oxc-project/oxc/tree/HEAD/npm/oxlint-plugins) and [oxlint](https://github.com/oxc-project/oxc/tree/HEAD/npm/oxlint).

Updates \`@oxlint/plugins\` from 1.82.0 to 1.83.0
<details>
<summary>Release notes</summary>
<blockquote>
<h2>oxlint v1.83.0 &amp; oxfmt v0.68.0</h2>
<h3>&#x1F680; Features</h3>
<ul><li>afe950d linter/react: Update lint rules (<a href="x">#26571</a>)</li></ul>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul><li><code>1111111</code> plugins commit</li></ul>
</details>
<br />

Updates \`oxlint\` from 1.82.0 to 1.83.0
<details>
<summary>Release notes</summary>
<blockquote><p>the same release</p></blockquote>
</details>
<details>
<summary>Changelog</summary>
<blockquote><h1>Changelog</h1></blockquote>
</details>
<details>
<summary>Commits</summary>
<ul><li><code>2222222</code> oxlint commit</li></ul>
</details>
`;

const ACTIONS = `Bumps the actions group with 2 updates in the / directory: [github/codeql-action/init](https://github.com/github/codeql-action) and [github/codeql-action/analyze](https://github.com/github/codeql-action).

Updates \`github/codeql-action/init\` from 4.37.9 to 4.38.0
<details>
<summary>Release notes</summary>
<blockquote><h2>v4.38.0</h2></blockquote>
</details>

Updates \`github/codeql-action/analyze\` from 4.37.9 to 4.38.0
`;

test("a single bump, a grouped bump and an actions group each parse to the right members", () => {
  const one = bumpsFromBody(SINGLE, "npm");
  assert.deepEqual(
    one.map((b) => [b.name, b.prev, b.next, b.repo, b.directory]),
    [["wrangler", "4.130.0", "4.131.1", "cloudflare/workers-sdk", "packages/wrangler"]],
  );

  const group = bumpsFromBody(GROUP, "npm");
  assert.deepEqual(
    group.map((b) => [b.name, b.prev, b.next, b.repo, b.directory]),
    [
      ["@oxlint/plugins", "1.82.0", "1.83.0", "oxc-project/oxc", "npm/oxlint-plugins"],
      ["oxlint", "1.82.0", "1.83.0", "oxc-project/oxc", "npm/oxlint"],
    ],
  );

  const actions = bumpsFromBody(ACTIONS, "actions");
  assert.deepEqual(
    actions.map((b) => [b.name, b.repo, b.directory]),
    [
      ["github/codeql-action/init", "github/codeql-action", null],
      ["github/codeql-action/analyze", "github/codeql-action", null],
    ],
  );

  // CONTROL: a body that is not Dependabot's yields nothing rather than a
  // guess, because a guessed package would be reviewed and reported clean.
  assert.deepEqual(bumpsFromBody("Fixes the thing.\n\nUpdates nothing.", "npm"), []);
});

test("fetch-metadata's JSON is preferred and carries what the body cannot say", () => {
  const json = JSON.stringify([
    { dependencyName: "wrangler", prevVersion: "4.130.0", newVersion: "4.131.1", packageEcosystem: "npm_and_yarn", dependencyGroup: "cloudflare-toolchain", ghsaId: "" },
    { dependencyName: "left-pad", newVersion: "2.0.0", packageEcosystem: "npm_and_yarn", ghsaId: "GHSA-xxxx-yyyy-zzzz" },
  ]);
  const bumps = bumpsFromMetadata(json, SINGLE);
  assert.equal(bumps.length, 2);
  assert.equal(bumps[0].ecosystem, "npm");
  assert.equal(bumps[0].group, "cloudflare-toolchain");
  assert.equal(bumps[0].repo, "cloudflare/workers-sdk", "the repo link is still read from the body");
  assert.equal(bumps[1].prev, "", "an unreadable prev is empty, never invented");
  assert.equal(bumps[1].ghsaId, "GHSA-xxxx-yyyy-zzzz");
  assert.equal(bumps[1].repo, null, "no link in the body, so the CLI's registry lookup owns it");

  assert.equal(ecosystemOf("github_actions"), "actions");
  assert.equal(ecosystemOf("cargo"), "rust");
  assert.equal(ecosystemOf("something-new"), "unknown", "an unknown ecosystem skips the advisory read rather than 422-ing on a guessed name");
  assert.equal(ecosystemFromFiles([".github/workflows/ci.yml"]), "actions");
  assert.equal(ecosystemFromFiles(["tools/photos/zenc/Cargo.toml", "tools/photos/zenc/Cargo.lock"]), "rust");
  assert.equal(ecosystemFromFiles(["lens-reader/package.json", "lens-reader/bun.lock"]), "npm");
});

test("each member of a grouped body gets its OWN sections, not its neighbour's", () => {
  const plugins = bodySectionsFor(GROUP, "@oxlint/plugins");
  const oxlint = bodySectionsFor(GROUP, "oxlint");
  assert.deepEqual(plugins.map((s) => s.title), ["Release notes", "Commits"]);
  assert.deepEqual(oxlint.map((s) => s.title), ["Release notes", "Changelog", "Commits"]);
  assert.match(plugins[1].text, /1111111/);
  assert.doesNotMatch(plugins[1].text, /2222222/, "the plugins block must stop before oxlint's");
  assert.match(oxlint[2].text, /2222222/);
  assert.match(plugins[0].text, /## oxlint v1.83.0 & oxfmt v0.68.0/, "entities decode and headings survive the HTML pass");
  assert.match(plugins[0].text, /- afe950d linter\/react: Update lint rules \(#26571\)/, "links keep their text and lose Dependabot's rewritten href");
  assert.equal(bodySectionsFor(SINGLE, "wrangler").length, 2);
  assert.deepEqual(bodySectionsFor(SINGLE, "not-in-this-pr"), []);
  assert.equal(htmlToText("<p>a&#39;b<br>c</p>"), "a'b\nc");
});

test("release-note entities decode once, including numeric and nested references", () => {
  assert.equal(htmlToText("<p>&amp;lt; &amp;gt; &amp;quot; &amp;#39; &amp;amp;</p>"), "&lt; &gt; &quot; &#39; &amp;");
  assert.equal(htmlToText("<p>&#x1F680; &#128640; &copy; &#39; &quot;</p>"), "🚀 🚀 © ' \"");
});

test("release-note parsing handles mixed case, quoted delimiters and raw-text elements", () => {
  const html = '<H2 title="a > b">Changes</H2><P>before<BR/>after</P>' +
    '<UL><LI><A title=">" href="https://example.com"><CODE>a&amp;b</CODE></A></LI></UL>' +
    '<SCRIPT>discard me</SCRIPT extra><STYLE>also discard</STYLE><p>end</p>';
  assert.equal(htmlToText(html), "## Changes\n\nbefore\nafter\n\n- `a&b`\n\nend");
  assert.equal(htmlToText("<script/>discard through the close</script><p>kept</p>"), "kept");
  assert.equal(htmlToText("<p>kept</p><script>unclosed"), "kept");
});

test("release-note comments are parsed and decoded tag examples remain inert text", () => {
  assert.equal(htmlToText("<p>before</p><!-- hidden --!><p>after</p>"), "before\n\nafter");
  assert.equal(htmlToText("<p>kept</p><!-- unclosed"), "kept");
  const text = htmlToText("<code>&lt;SCRIPT&gt;example&lt;/SCRIPT&gt;</code>");
  assert.equal(text, "`<SCRIPT>example</SCRIPT>`", "decoded text is never reparsed as markup");
  assert.equal(escapeMd(text), "`&lt;SCRIPT&gt;example&lt;/SCRIPT&gt;`", "the comment renderer owns output escaping");
});

test("a version is read off a tag in every spelling this repository's dependencies use", () => {
  // single-package repos
  assert.equal(versionFromTag("v4.38.0", "github/codeql-action/init"), "4.38.0");
  assert.equal(versionFromTag("12.0.0", "htmlparser2"), "12.0.0");
  assert.equal(versionFromTag("v1.63.0", "playwright-core"), "1.63.0");
  // monorepos
  assert.equal(versionFromTag("wrangler@4.131.1", "wrangler"), "4.131.1");
  assert.equal(versionFromTag("@cloudflare/vitest-pool-workers@0.20.3", "@cloudflare/vitest-pool-workers"), "0.20.3");
  assert.equal(versionFromTag("oxlint_v1.82.0", "oxlint"), "1.82.0");
  assert.equal(versionFromTag("oxlint_v1.82.0", "@oxlint/plugins"), "1.82.0", "a token of the scoped name is enough");
  assert.equal(versionFromTag("lightningcss-v1.33.0", "lightningcss"), "1.33.0");
  assert.equal(versionFromTag("release-3.1.0", "smol-toml"), "3.1.0");
  // CONTROLS: a sibling package's tag in the same monorepo is NOT this package's
  assert.equal(versionFromTag("miniflare@5.20260911.0-alpha", "wrangler"), null);
  assert.equal(versionFromTag("oxfmt_v0.68.0", "oxlint"), null);
  assert.equal(versionFromTag("crates_v0.150.0", "oxlint"), null);
  assert.equal(versionFromTag("apps_v1.83.0", "oxlint"), null, "oxc's tag prefix names no package, so the TITLE has to carry it");
  assert.equal(versionFromTag("not-a-version", "x"), null);
});

test("oxc's release title carries the version its tag does not", () => {
  const title = "oxlint v1.83.0 & oxfmt v0.68.0";
  assert.equal(versionFromReleaseName(title, "oxlint"), "1.83.0");
  assert.equal(versionFromReleaseName(title, "@oxlint/plugins"), "1.83.0");
  assert.equal(versionFromReleaseName(title, "oxfmt"), "0.68.0", "and reads the other package's number when asked about that package");
  assert.equal(versionFromReleaseName("oxc crates_v0.150.0", "oxlint"), null);
  assert.equal(releaseVersion("apps_v1.83.0", title, "oxlint"), "1.83.0");
  assert.equal(releaseVersion("wrangler@4.131.1", "wrangler@4.131.1", "wrangler"), "4.131.1");
  // CONTROL: a title mentioning the package with no version beside it says nothing
  assert.equal(versionFromReleaseName("oxlint is faster now", "oxlint"), null);
});

test("the range is (prev, next], compared numerically", () => {
  assert.ok(compareVersions("4.131.1", "4.130.0") > 0);
  assert.ok(compareVersions("5.20260901.1", "5.20260830.1") > 0, "date-shaped segments compare as numbers, not strings");
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0, "a pre-release sits below its release");
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(inBumpRange("4.131.0", "4.130.0", "4.131.1"), true);
  assert.equal(inBumpRange("4.131.1", "4.130.0", "4.131.1"), true, "next is included");
  assert.equal(inBumpRange("4.130.0", "4.130.0", "4.131.1"), false, "prev is excluded");
  assert.equal(inBumpRange("4.132.0", "4.130.0", "4.131.1"), false);
  assert.equal(inBumpRange("4.0.0", "", "4.131.1"), true, "an unknown prev admits rather than reads nothing");
  assert.ok(tagCandidates("@oxlint/plugins", "1.83.0").includes("plugins_v1.83.0"));
  assert.ok(tagCandidates("github/codeql-action/init", "4.38.0")[0] === "v4.38.0");
  assert.equal(new Set(tagCandidates("wrangler", "1.0.0")).size, tagCandidates("wrangler", "1.0.0").length, "no duplicate spellings, each is a request");
});

test("the changelog slice runs from next's heading to prev's, whatever the heading spells around the number", () => {
  const changesets = `# wrangler

## 4.131.1

### Patch Changes

- a

## 4.131.0

### Minor Changes

- b

## 4.130.0

- old
`;
  const slice = changelogSlice(changesets, "4.130.0", "4.131.1") ?? "";
  assert.match(slice, /^## 4\.131\.1/);
  assert.match(slice, /- a[\s\S]*- b/);
  assert.doesNotMatch(slice, /- old/, "prev's own entry is excluded");
  assert.doesNotMatch(slice, /## 4\.130\.0/);

  const dated = `# CodeQL Action Changelog

## [UNRELEASED]

No user facing changes.

## 4.38.0 - 09 Sept 2026

- arm64

## 4.37.9 - 26 Aug 2026

- earlier
`;
  const s2 = changelogSlice(dated, "4.37.9", "4.38.0") ?? "";
  assert.match(s2, /arm64/);
  assert.doesNotMatch(s2, /earlier|UNRELEASED/);

  // CONTROLS. A file with no heading for next reports null, which the CLI reads
  // as "no changelog" rather than shipping the whole file as the slice; and a
  // number that merely appears inside another (4.38.0 inside 14.38.0) is not it.
  assert.equal(changelogSlice(dated, "4.37.9", "4.39.0"), null);
  assert.equal(changelogSlice("## 14.38.0\n- no\n## 4.37.9\n- x", "4.37.9", "4.38.0"), null);
  // Without a prev the slice is one release, bounded by the next same-level heading.
  const s3 = changelogSlice(changesets, "", "4.131.1") ?? "";
  assert.match(s3, /- a/);
  assert.doesNotMatch(s3, /- b/);
});

test("usage is ranked so the model sees the contract before the commentary", () => {
  assert.equal(usageRank("package.json", '"wrangler": "4.131.1",'), 0);
  assert.equal(usageRank(".github/workflows/ci.yml", "uses: github/codeql-action/init@sha"), 0);
  assert.equal(usageRank("cal/test/harness.ts", 'import { createTestHarness } from "wrangler";'), 1);
  assert.equal(usageRank("tools/lib/wrangler-bin.ts", 'import { existsSync } from "node:fs";'), 1);
  assert.equal(usageRank("wrangler.jsonc", '"main": ".build/src/worker/index.ts",'), 2);
  assert.equal(usageRank("docs/DEPENDENCIES.md", "- Wrangler is pinned"), 3);
  assert.equal(usageRank("tools/build.ts", "// wrangler bundles the same tree"), 4);
  assert.equal(usageRank("CLAUDE.md", "wrangler refuses bun"), 5);
  assert.equal(usageRank("src/worker/lib/trace.ts", "// Bundled by wrangler at deploy; a comment saying `from`"), 4, "prose containing the word from is not an import site");

  const lines = [];
  for (let i = 0; i < 200; i++) lines.push({ path: "CLAUDE.md", line: i + 1, text: `wrangler mention ${i}` });
  lines.push({ path: "cal/test/harness.ts", line: 37, text: 'import { createTestHarness } from "wrangler";' });
  lines.push({ path: "package.json", line: 95, text: '    "wrangler": "4.131.1",'.padEnd(400, "x") });
  const { shown, tally } = selectUsage(lines);
  assert.equal(shown[0].path, "package.json");
  assert.equal(shown[1].path, "cal/test/harness.ts");
  assert.ok(shown[0].text.length <= 240, "a line is capped");
  assert.equal(shown.filter((l) => l.path === "CLAUDE.md").length, 8, "a file that mentions it 200 times contributes its per-file cap");
  assert.equal(tally["CLAUDE.md"], 200, "and the tally still says 200");
});

test("the DEPENDENCIES.md bullet for a package comes across whole, from the baseline down", () => {
  const doc = `# Deps

- Oxc Minify, Lightning CSS and Wrangler are the review policy in one line.

## Current baseline

- Oxlint 1.82.0 and oxlint-tsgolint 7.0.2001 are exact root pins for
  \`bun run lint\`. Dependabot should review oxlint releases for NEW rules.
- smol-toml 1.8.0 parses Cargo manifests.

## Outside the root manifest

- lens-reader pins htmlparser2 12.0.0.
`;
  const bullets = dependencyDocBullets(doc, "oxlint");
  assert.equal(bullets.length, 1);
  assert.match(bullets[0], /review oxlint releases for NEW rules/);
  assert.match(bullets[0], /^- Oxlint 1\.82\.0[\s\S]*NEW rules\.$/, "the wrapped continuation line is part of the bullet");
  assert.deepEqual(dependencyDocBullets(doc, "htmlparser2").length, 1, "sections after the baseline count too");
  assert.deepEqual(dependencyDocBullets(doc, "wrangler"), [], "the intro's policy list is not the package's bullet");
});

test("the model's answer is parsed against the schema it was asked for, and refused otherwise", () => {
  const good = {
    verdict: "read-first",
    summary: "A minor with one behaviour change on the deploy path.",
    security: [],
    perf: [{ claim: "install 4.6s to 3.0s", source: "wrangler@4.131.0", why_us: "ci.yml install step" }],
    features: [],
    breaking: [{ claim: "preview settings commands removed", source: "#15493", why_us: "" }],
    not_covered: "",
    instructions_in_material: false,
  };
  const r = parseReview(JSON.stringify(good));
  assert.equal(r.verdict, "read-first");
  assert.equal(r.perf[0].why_us, "ci.yml install step");
  assert.throws(() => parseReview(JSON.stringify({ ...good, verdict: "ship it" })), /verdict/);
  assert.throws(() => parseReview(JSON.stringify({ ...good, security: "none" })), /security/);
  assert.throws(() => parseReview("not json"));
  // The schema itself is closed at every level, which the API requires.
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  assert.equal(REVIEW_SCHEMA.properties.perf.items.additionalProperties, false);
  assert.deepEqual([...REVIEW_SCHEMA.required].sort(), Object.keys(REVIEW_SCHEMA.properties).sort());
});

test("the comment carries its marker, its pairs key, and no live markup from the model", () => {
  const bumps = bumpsFromBody(GROUP, "npm");
  const key = pairsKey(bumps);
  assert.equal(key, "@oxlint/plugins@1.82.0>1.83.0;oxlint@1.82.0>1.83.0");
  assert.equal(pairsKey([...bumps].reverse()), key, "order-independent, so a re-run compares equal");

  const review = parseReview(
    JSON.stringify({
      verdict: "routine",
      summary: 'Nothing here <script>alert(1)</script><SCRIPT src="x">example</SCRIPT>',
      security: [],
      perf: [{ claim: "faster <b>x</b>", source: "apps_v1.83.0", why_us: ".oxlintrc.json" }],
      features: [],
      breaking: [],
      not_covered: "commits only",
      instructions_in_material: true,
    }),
  );
  const section = renderPackage(bumps[1], review, { releases: 1, commits: 2, commitsTruncated: false, changelog: false, advisories: 0, bodySections: [] });
  assert.match(section, /^### oxlint 1\.82\.0 → 1\.83\.0, routine/);
  assert.equal(section.split("\n\n")[1], 'Nothing here &lt;script&gt;alert(1)&lt;/script&gt;&lt;SCRIPT src="x"&gt;example&lt;/SCRIPT&gt;', "the complete model summary is escaped, regardless of tag casing or attributes");
  assert.match(section, /\*\*Security:\*\* nothing found\./);
  assert.match(section, /- faster &lt;b&gt;x&lt;\/b&gt; \(apps_v1\.83\.0\) Here: \.oxlintrc\.json/);
  assert.match(section, /Read: 1 release; 2 commits under npm\/oxlint; no CHANGELOG slice; 0 advisories against 1\.82\.0\./);
  assert.match(section, /Not covered: commits only/);
  assert.match(section, /instructions addressed to a reader/, "the injection flag renders as a visible line");

  const comment = renderComment({ bumps, sections: [section], model: "claude-opus-5", usage: { input: 31234, output: 812 } });
  assert.ok(comment.startsWith(COMMENT_MARKER), "the marker the upsert finds is first");
  assert.equal(pairsFromComment(comment), key);
  assert.match(comment, /31,234 input and 812 output tokens/);
  assert.match(comment, /bun run deps:review <pr>/);

  const fallback = renderFallback(bumps, "No model ran: the claude CLI is not logged in.");
  assert.ok(fallback.startsWith(COMMENT_MARKER));
  assert.equal(pairsFromComment(fallback), key, "the fallback carries the key too, so a re-run after the secret lands still re-reads");
  assert.match(fallback, /\*\*Not read\.\*\*/);
  assert.match(fallback, /- oxlint 1\.82\.0 → 1\.83\.0/);
  assert.equal(pairsFromComment("<!-- perf-snapshot-diff -->\n## Wire-size"), null);
});

test("the repo link resolves the same way from the header line and the group intro", () => {
  assert.deepEqual(repoLinkFor(SINGLE, "wrangler"), { repo: "cloudflare/workers-sdk", directory: "packages/wrangler" });
  assert.deepEqual(repoLinkFor(GROUP, "oxlint"), { repo: "oxc-project/oxc", directory: "npm/oxlint" });
  assert.deepEqual(repoLinkFor(ACTIONS, "github/codeql-action/analyze"), { repo: "github/codeql-action", directory: null });
  assert.equal(repoLinkFor(GROUP, "oxlint-plugins"), null, "a name that is only a substring of a linked one does not borrow its link");
});
