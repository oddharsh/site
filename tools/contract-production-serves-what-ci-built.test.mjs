// ── production serves what CI built, URL for URL ─────────────────────────────
// Shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { bakeBuildInfo, buildInfoFromEnv } from "./lib/build-info.ts";
import {
  SCHEMA, buildManifest, canonicalUrl, changedUrls, checkOrigin, isServedFile, parseAssetsIgnore,
  parseManifest, serializeManifest, sha256,
} from "./lib/served-manifest.ts";
import { buildWhoareyouGroups } from "../src/worker/whoareyou.ts";

// Two builders make every release: ci.yml's `validate` (to test it) and Workers
// Builds (to ship it). ci.yml cuts a manifest of every static URL's sha256 from
// its build and signs it; tools/check-served.ts compares production against it.
// The pieces only mean something together, so this file holds all of them:
// the URL rules, the comparison, the commit production reports, and the CI and
// release wiring that connect them.

const COMMIT = "5fb917b37e5472d0586c97df64c7a72cc68252ec";

// Bun parses the workflows under both runners, the way contract-ci-required-gate does.
const yaml = (rel) => JSON.parse(execFileSync("bun", [
  "-e", "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
  fileURLToPath(new URL(rel, ROOT)),
], { encoding: "utf8" }));

test("served-manifest: canonical URLs are the ones that answer 200 without a redirect", () => {
  // Each pairing measured against production 2026-10-01. The asset layer 307s
  // both /garage/horizon.html and /garage/ to these; the readable twins are the
  // exception, served at their full name because that is what each banner links.
  assert.equal(canonicalUrl("index.html"), "/");
  assert.equal(canonicalUrl("garage/index.html"), "/garage");
  assert.equal(canonicalUrl("garage/horizon.html"), "/garage/horizon");
  assert.equal(canonicalUrl("garage/horizon.src.html"), "/garage/horizon.src.html");
  assert.equal(canonicalUrl("dotfiles/index.src.html"), "/dotfiles/index.src.html");
  assert.equal(canonicalUrl("a/nav.684e58a4.js"), "/a/nav.684e58a4.js");
  assert.equal(canonicalUrl("garage/horizon.md"), "/garage/horizon.md");
});

test("served-manifest: an encoding, a config file or an ignored path is not a URL", () => {
  const ignored = parseAssetsIgnore("# comment\n_worker.js\nmd\n/custom-media.css\n*.tmp\n");
  for (const rel of ["_worker.js/index.js", "md/bot.md", "deep/md/x.md", "custom-media.css", "a/b.tmp", "_headers", "x.html.br", "pd/x.1234.dcz"]) {
    assert.equal(isServedFile(rel, ignored), false, `${rel} must not be listed as a URL`);
  }
  for (const rel of ["bot.md", "garage/custom-media.css", "markdown/x.md", "index.html", "a/luna.0dbcdba1.css"]) {
    assert.equal(isServedFile(rel, ignored), true, `${rel} is served at its own URL`);
  }
  // Regex metacharacters in a rule are literal: "a+b.css" is that file and no other.
  const literal = parseAssetsIgnore("a+b.css\n(x)|y\n");
  assert.equal(literal("a+b.css"), true);
  assert.equal(literal("aab.css"), false);
  assert.equal(literal("a+bxcss"), false);
  assert.equal(literal("(x)|y"), true);
  assert.equal(literal("x"), false);
  // A rule this reader would misread must fail the manifest rather than list a
  // file the upload skips (or skip one it uploads).
  for (const rule of ["!keep.md", "a/**/b", "file?.txt", "[ab].css"]) {
    assert.throws(() => parseAssetsIgnore(rule), /does not implement/, rule);
  }
});

test("served-manifest: a staged tree becomes a stable manifest, and two files cannot claim one URL", () => {
  const root = mkdtempSync(join(tmpdir(), "served-"));
  mkdirSync(join(root, "garage"));
  writeFileSync(join(root, ".assetsignore"), "md\n");
  writeFileSync(join(root, "index.html"), "home");
  writeFileSync(join(root, "index.html.br"), "not a URL");
  writeFileSync(join(root, "_headers"), "/*\n  X: y\n");
  writeFileSync(join(root, "garage", "index.html"), "garage");
  writeFileSync(join(root, "garage", "horizon.src.html"), "readable");
  mkdirSync(join(root, "md"));
  writeFileSync(join(root, "md", "bot.md"), "ignored");

  const m = buildManifest(root, COMMIT);
  assert.equal(m.schema, SCHEMA);
  assert.deepEqual(Object.keys(m.files).sort(), ["/", "/garage", "/garage/horizon.src.html"]);
  assert.equal(m.files["/"], sha256(new TextEncoder().encode("home")));
  assert.deepEqual(parseManifest(serializeManifest(m)), { ...m, files: m.files });
  assert.equal(serializeManifest(m), serializeManifest(buildManifest(root, COMMIT)), "two cuts of one tree must be byte-identical");

  writeFileSync(join(root, "garage.html"), "a second /garage");
  assert.throws(() => buildManifest(root, COMMIT), /two staged files claim \/garage/);
});

test("served-manifest: --since scope is exactly the URLs whose bytes moved or arrived", () => {
  /** @type {import("./lib/served-manifest.ts").ServedManifest} */
  const prev = { schema: SCHEMA, commit: null, files: { "/": "a", "/x": "b", "/gone": "c" } };
  /** @type {import("./lib/served-manifest.ts").ServedManifest} */
  const next = { schema: SCHEMA, commit: null, files: { "/": "a", "/x": "B", "/new": "d" } };
  assert.deepEqual(changedUrls(prev, next), ["/new", "/x"]);
});

test("served-manifest: the comparison decodes, refuses redirects, and has teeth", async () => {
  const body = new TextEncoder().encode("<!doctype html>page");
  /** @type {import("./lib/served-manifest.ts").ServedManifest} */
  const manifest = { schema: SCHEMA, commit: COMMIT, files: {
    "/same": sha256(body), "/byte": sha256(body), "/moved": sha256(body), "/missing": sha256(body),
  } };
  const seen = [];
  const fake = async (url, init) => {
    seen.push(init.redirect);
    const path = new URL(url).pathname;
    if (path === "/same") return new Response(body);
    // The control: one byte different must read as a mismatch, or a comparator
    // that always agrees would pass every release.
    if (path === "/byte") return new Response(new TextEncoder().encode("<!doctype html>pagE"));
    if (path === "/moved") return new Response(null, { status: 307, headers: { location: "/elsewhere" } });
    return new Response("nope", { status: 404 });
  };
  const results = await checkOrigin(manifest, { origin: "https://example.test", urls: [...Object.keys(manifest.files), "/unlisted"], fetch: fake });
  const verdict = Object.fromEntries(results.map((r) => [r.url, r.verdict]));
  assert.deepEqual(verdict, { "/byte": "mismatch", "/missing": "status", "/moved": "redirect", "/same": "match", "/unlisted": "error" });
  assert.ok(seen.every((r) => r === "manual"), "a followed redirect would hash the destination and call the wrong URL a match");
});

test("build-info: only Workers Builds names a commit, and a malformed one fails the build", async () => {
  assert.equal(buildInfoFromEnv({}), null);
  assert.equal(buildInfoFromEnv({ GITHUB_SHA: COMMIT }), null, "a GitHub run's sha must not pass for the commit Workers Builds shipped");
  assert.deepEqual(
    buildInfoFromEnv({ WORKERS_CI_COMMIT_SHA: COMMIT.toUpperCase(), WORKERS_CI_BRANCH: "production", WORKERS_CI_BUILD_UUID: "b-1" }),
    { commit: COMMIT, branch: "production", build: "b-1" },
  );
  assert.throws(() => buildInfoFromEnv({ WORKERS_CI_COMMIT_SHA: "5fb917b" }), /not a 40-hex commit/);

  // The committed module carries the marker build.ts rewrites, and ships null.
  const source = await readFile(new URL("src/worker/lib/build-info.ts", ROOT), "utf8");
  assert.match(source, /^export const BUILD_INFO: BuildInfo \| null = null; \/\/ build:build-info$/m);
  const baked = bakeBuildInfo(source, { commit: COMMIT, branch: "production", build: null });
  assert.ok(baked.includes(`"commit":"${COMMIT}"`));
  assert.throws(() => bakeBuildInfo("export const X = 1;", null), /marker line was not found/);

  // And the commit goes into the WORKER: a commit in public/ would change a
  // served file on every deploy and break the property being verified.
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(build, /bakeBuildInfo\(await readFile\(p, "utf8"\), info\)/);
  assert.match(build, /const p = `\$\{OUT\}\/src\/worker\/lib\/build-info\.ts`;/);
});

test("whoareyou: the Server group names the commit beside the version, and omits what it does not know", () => {
  const data = new Proxy({}, { get: () => "x" });
  const ua = { browser: "b", os: "o", device: "d" };
  const server = (groups) => groups.find((g) => g.title === "Server")?.fields ?? [];
  const both = server(buildWhoareyouGroups(data, ua, null, "v-1", { commit: COMMIT, branch: "production", build: null }));
  assert.deepEqual(both.map((f) => [f.k, f.v]), [["Serving version", "v-1"], ["Built from commit", COMMIT]]);
  assert.deepEqual(server(buildWhoareyouGroups(data, ua, null, "v-1", null)).map((f) => f.k), ["Serving version"]);
  assert.equal(buildWhoareyouGroups(data, ua, null, undefined, null).some((g) => g.title === "Server"), false);
});

test("served-manifest: CI cuts and signs it, and every release checks it", async () => {
  const ci = yaml(".github/workflows/ci.yml");
  const steps = ci.jobs.validate.steps;
  const build = steps.findIndex((s) => s.run === "bun run perf-budget");
  const cut = steps.findIndex((s) => s.name === "Cut the served manifest");
  assert.ok(build >= 0 && cut === build + 1, "the manifest must be cut straight after the build, before any later step touches .build/");
  assert.equal(steps[cut].if, "github.event_name == 'push'", "only a push to main builds the commit Workers Builds ships");
  assert.match(steps[cut].run, /served:manifest --commit "\$\{\{ github\.sha \}\}"/);

  const attest = ci.jobs.attest;
  assert.equal(attest.needs, "validate");
  assert.equal(attest["continue-on-error"], true, "an attestation outage must not block the run promote-production waits for");
  assert.equal(attest.permissions["id-token"], "write");
  assert.ok(!attest.steps.some((s) => String(s.uses ?? "").startsWith("actions/checkout")), "the job holding an OIDC token runs no repository code");
  assert.ok(attest.steps.some((s) => String(s.uses).startsWith("actions/attest@") && s.with["subject-path"] === "served-manifest.json"));
  assert.deepEqual(Object.keys(ci.jobs), ["validate", "attest"], "a third job would need its own reason; validate stays the one required check");

  const checker = await readFile(new URL("tools/check-served.ts", ROOT), "utf8");
  assert.match(checker, /SIGNER = `\$\{values\.repo\}\/\.github\/workflows\/ci\.yml`/, "the signature must be pinned to ci.yml");
  assert.match(checker, /"--source-ref", "refs\/heads\/main"/);
  // An empty scope verified the commit and signature and compared no bytes, and
  // must say so rather than print "0 of 0 URLs" under a passing headline.
  assert.match(checker, /if \(!results\.length\) \{\n  console\.log\(`served:check: nothing to compare/);

  const promote = await readFile(new URL(".github/workflows/promote-production.yml", ROOT), "utf8");
  assert.match(promote, /run: bun run served:check \$\{SINCE:\+--since "\$SINCE"\}/, "each release checks the URLs it changed");

  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts["served:manifest"], "bun tools/served-manifest.ts");
  assert.equal(pkg.scripts["served:check"], "bun tools/check-served.ts");
});
