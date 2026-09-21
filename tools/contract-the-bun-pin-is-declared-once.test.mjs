// ── the bun pin is declared once ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { channelOf, compareVersions, interpretZstdProbe, minimumReleaseAgeSeconds, newestSeasonedCanary, npmPlatform, npmTarballUrl, npmVersion, parseVersion, readPin, releaseAsset, releaseUrl, runningMatchesPin, writePin } from "./lib/bun-pin.ts";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(ROOT);

// config/bun-pin.json is the one dependency version here that no updater owns, and
// the one that compiles the site: wrangler.jsonc builds with `bun
// tools/build.ts`, so it decides every content-addressed /a/ and /i/ URL. Three
// readers share it and none may carry a copy.

test("the pin lib reads the same string config/bun-pin.json holds, and package.json declares none", async () => {
  const declared = JSON.parse(await readFile(new URL("config/bun-pin.json", ROOT), "utf8"));
  const pin = readPin(root);
  assert.equal(pin.version, declared.bun);
  assert.equal(pin.raw, `bun@${declared.bun}`);
  // A release or a DATED canary with its build sha, and nothing looser: both are
  // exact and both are immutable on npm, which is what makes either one a pin.
  assert.match(pin.version, /^\d+\.\d+\.\d+(-canary\.\d{8}\.\d+\+[0-9a-f]{7,40})?$/);
  if (channelOf(pin.version) === "canary") assert.ok(parseVersion(pin.version).sha, "a canary pin must carry the build sha the running bun proves itself by");

  // NO packageManager, on purpose. Cloudflare's build image reads that field
  // and cannot resolve a canary in it (measured 2026-09-15, three probes), so
  // a second declaration there is a production build waiting to stop.
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.packageManager, undefined, "package.json must not carry packageManager; config/bun-pin.json is the declaration and the build image reads that field");
});

test("writePin edits one field and reflows nothing else", async () => {
  const before = await readFile(new URL("config/bun-pin.json", ROOT), "utf8");
  const pin = readPin(root);
  const dir = await mkdtemp(join(tmpdir(), "bun-pin-"));
  try {
    await mkdir(join(dir, "config"));
    await writeFile(join(dir, "config", "bun-pin.json"), before);
    writePin(dir, "9.9.9");
    const after = await readFile(join(dir, "config", "bun-pin.json"), "utf8");
    assert.equal(readPin(dir).version, "9.9.9");
    assert.equal(
      after.replace('"bun": "9.9.9"', `"bun": "${pin.version}"`),
      before,
      "writePin changed something other than the version",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(await readFile(new URL("config/bun-pin.json", ROOT), "utf8"), before, "the live pin file was modified");
});

test("the zstd capability probe is declared once", async () => {
  // Two copies of one measurement agree on the day they are written and rot
  // separately after, which is the argument lib/mcp-protocol.ts already won for
  // MCP_SUPPORTED. This probe is worse than most to duplicate, because what it
  // detects is SILENT: a runtime that accepts `dictionary` and ignores it emits
  // plain zstd that still decodes, so a stale copy reports a pass.
  const lib = await readFile(new URL("tools/lib/bun-pin.ts", ROOT), "utf8");
  assert.match(lib, /zstdCompressSync/, "lib/bun-pin.ts is supposed to be the one that holds the probe");

  // ONE consumer today, and the list stays a list. check-bun.ts was the second
  // until it was retired on 2026-08-24, and the next runtime control to want
  // this probe should join this array rather than paste the three compressions.
  for (const file of ["tools/bump-bun-pin.ts"]) {
    const body = await readFile(new URL(file, ROOT), "utf8");
    // CODE, not mention. These files EXPLAIN the probe in prose, and the first
    // draft of this assertion read `zstdCompressSync({ dictionary })` out of a
    // header comment and failed on it. Same shape as the
    // workflow test stripping `echo` lines, and as every other naive scanner
    // this repo has had to sharpen: searching source text for a token finds the
    // paragraph describing it too.
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(
      !/const\s+PROBE\s*=|zstdCompressSync\(/.test(code),
      `${file} re-declares the zstd probe instead of importing ZSTD_DICTIONARY_PROBE`,
    );
    assert.match(body, /from "\.\/lib\/bun-pin\.ts"/, `${file} must import the shared pin lib`);
  }

  // The teeth: the stripper must not be so eager that it would miss a real
  // re-declaration sitting in code.
  const sample = ['// zstdCompressSync({ dictionary }) in prose', 'const PROBE = zstdCompressSync(x);'].join("\n");
  const stripped = sample.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(stripped, /const\s+PROBE\s*=/, "the comment stripper ate a real declaration");
});

test("the probe reader calls the silent case correctly", async () => {
  // The teeth. A reader that returned `honoured: true` for the collapsed shape
  // would pass every real run and wave through exactly the runtime this exists
  // to refuse, so both shapes are asserted rather than only the good one.
  assert.equal(interpretZstdProbe('{"none":73,"good":24,"wrong":73}').honoured, true);
  assert.equal(interpretZstdProbe('{"none":73,"good":73,"wrong":73}').honoured, false, "the collapse must read as NOT honoured");
  assert.equal(interpretZstdProbe("not json").honoured, null, "a probe that never ran is neither honoured nor refused");
});

test("versions compare numerically, so 1.10 is newer than 1.4, and canaries order by date under their release", () => {
  // The one comparison a string sort gets wrong, and bun will reach 1.10.
  assert.equal(compareVersions("1.10.0", "1.4.0"), 1);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(compareVersions("1.3.14", "1.4.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  // npm names the canaries of the unreleased 1.4.3 `1.4.2-canary.<date>`, so a
  // release outranks its own canaries and two canaries compare by date, then build.
  assert.equal(compareVersions("1.4.2-canary.20260914.1", "1.4.2-canary.20260913.1"), 1);
  assert.equal(compareVersions("1.4.2-canary.20260913.2", "1.4.2-canary.20260913.1"), 1);
  assert.equal(compareVersions("1.4.2-canary.20260913.1", "1.4.2-canary.20260913.1"), 0);
  assert.equal(compareVersions("1.4.2-canary.20260914.1", "1.4.2"), -1);
  assert.equal(compareVersions("1.4.3-canary.20260920.1", "1.4.2-canary.20260914.1"), 1);
  assert.throws(() => compareVersions("1.4", "1.4.0"), /not a bun version/);
  assert.throws(() => compareVersions("1.4.2-beta.1", "1.4.2"), /not a bun version/, "only dated canaries are a channel here");
});

test("the channel is the pin's own shape, and the npm tarball names the platform package", () => {
  assert.equal(channelOf("1.4.2"), "stable");
  assert.equal(channelOf("1.4.2-canary.20260913.1"), "canary");
  assert.equal(channelOf("1.4.2-canary.20260913.1+09bb546"), "canary");
  assert.deepEqual(parseVersion("1.4.2-canary.20260913.1").canary, [20260913, 1]);
  assert.equal(parseVersion("1.4.2-canary.20260913.1+09bb546").sha, "09bb546");
  assert.equal(parseVersion("1.4.2").canary, null);
  assert.equal(npmVersion("1.4.2-canary.20260913.1+09bb546"), "1.4.2-canary.20260913.1");
  assert.equal(compareVersions("1.4.2-canary.20260913.1+09bb546", "1.4.2-canary.20260913.1"), 0, "the sha is identity, never order");
  // The baseline guard: a release by version, a canary by revision, because a
  // canary binary reports the NEXT release as its version (1.4.3 for a
  // 1.4.2-canary tarball, measured 2026-09-14).
  assert.equal(runningMatchesPin("1.4.2", { version: "1.4.2", revision: "744846f8" }).ok, true);
  assert.equal(runningMatchesPin("1.4.2", { version: "1.4.3", revision: "09bb5463" }).ok, false);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1+09bb546", { version: "1.4.3", revision: "09bb5463058074ef" }).ok, true);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1+09bb546", { version: "1.4.3", revision: "5fce36e1" }).ok, false);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1", { version: "1.4.3", revision: "09bb5463" }).ok, false, "a canary pin without its sha proves nothing");
  assert.equal(npmPlatform("linux", "x64"), "bun-linux-x64");
  assert.equal(npmPlatform("darwin", "arm64"), "bun-darwin-aarch64");
  assert.equal(
    npmTarballUrl("1.4.2-canary.20260913.1", "bun-linux-x64"),
    "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.2-canary.20260913.1.tgz",
  );
  // ONE installer, shared by the CI action and the Workers Builds wrapper, so
  // the two cannot name different tarballs or verify different things for one
  // pin. Two copies is how the CI side grew canary support the deploy side
  // never saw (2026-09-15).
  return Promise.all([
    readFile(new URL(".github/install-bun.sh", ROOT), "utf8"),
    readFile(new URL(".github/actions/setup-bun/action.yml", ROOT), "utf8"),
    readFile(new URL(".github/deploy-wrangler.sh", ROOT), "utf8"),
  ]).then(([installer, action, wrapper]) => {
    assert.match(installer, /config\/bun-pin\.json/, "the installer must read the pin from config/bun-pin.json");
    assert.doesNotMatch(installer.replace(/^\s*#.*$/gm, ""), /packageManager/, "the installer must not read packageManager, which the build image also reads and cannot resolve a canary in");
    assert.match(installer, /registry\.npmjs\.org\/@oven\/\$\{platform\}\//, "the installer must fetch from the npm platform package");
    assert.match(installer, /integrity/, "the installer must verify the registry's sha512");
    assert.match(installer, /package\/package\.json/, "the installer must read the tarball's own version, since a canary binary reports the next release");
    assert.match(installer, /--revision/, "the installer must check the binary's revision against the pin's sha");
    for (const [name, body] of [["setup-bun", action], ["deploy-wrangler.sh", wrapper]]) {
      assert.match(body, /bash \.github\/install-bun\.sh /, `${name} must install through the shared installer`);
      assert.doesNotMatch(body, /registry\.npmjs\.org|releases\/download/, `${name} must not carry its own download path`);
    }
    assert.match(wrapper, /bun install --frozen-lockfile/, "the wrapper must lay out node_modules itself, since SKIP_DEPENDENCY_INSTALL turns the image's install off");
  });
});

test("the release-age window is read from bunfig rather than restated", async () => {
  const bunfig = await readFile(new URL("bunfig.toml", ROOT), "utf8");
  const match = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(bunfig);
  assert.ok(match, "bunfig.toml declares no minimumReleaseAge");
  const declared = Number(match[1]);
  assert.equal(minimumReleaseAgeSeconds(root), declared);

  // UNIT TRAP, and the reason this is asserted at all: pnpm counted MINUTES and
  // bun counts SECONDS, so a faithful-looking port of the same number cuts a
  // 24-hour window to 24 minutes. Anything under an hour is that mistake.
  assert.ok(declared >= 3600, `minimumReleaseAge is ${declared}s, which is the minutes-versus-seconds trap`);

  const bumper = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  assert.ok(
    !new RegExp(`\\b${declared}\\b`).test(bumper),
    "bump-bun-pin.ts hardcodes the window instead of reading bunfig.toml",
  );
});

test("the bumper walks the pin's channel and never crosses it", async () => {
  const body = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  // STABLE: `releases/latest` skips drafts and prereleases, so the rolling
  // `canary` tag can never become a release-channel target.
  assert.match(body, /releases\/latest/, "the stable target must come from releases/latest, which excludes prereleases");
  assert.match(body, /\^bun-v\(\\d\+\\\.\\d\+\\\.\\d\+\)\$/, "the tag must be matched as a plain bun-vX.Y.Z");
  // CANARY: the candidate is the newest DATED canary already past gate 2's
  // window, chosen by the resolver. It was npm's `canary` dist-tag until
  // 2026-09-21, and that tag names the newest daily publish by definition, so
  // gate 2 refused it every night for six nights while the job exited green.
  // Re-reading the tag is how that deadlock comes back.
  assert.match(body, /newestSeasonedCanary\(npmMeta, window\)/, "the canary target must come from the seasoned resolver, handed bunfig's window");
  assert.doesNotMatch(body, /dist-tags"?\]?\??\.?\[?"?canary/, "the bumper must not read npm's canary dist-tag; it names a version the window refuses by construction");
  assert.match(body, /channelOf\(target\) !== channel/, "a target on the other channel must be refused");
  assert.match(body, /npmBunDist\(npmVersion\(target\)\)/, "a canary must be fetched with the registry's integrity, by the version npm names");

  // The baseline guard. Without it a stale bun on PATH compares the candidate
  // against a third runtime and reports a byte-identical build that says nothing
  // about what production ships. check-bun.ts refused the mirror image of this
  // (being invoked through bun, which would have compared bun with bun) and the
  // assertion moved here when it was retired.
  assert.match(body, /baselineVersion !== pin\.version/, "the bumper must refuse a baseline that is not the pin");
});

test("the canary resolver picks the newest dated canary already past the window, never the newest publish", () => {
  // bun publishes at ~14:20 UTC daily. Freeze "now" at 16:00 UTC on the 21st,
  // which is the shape every one of the six deadlocked runs saw.
  const now = Date.parse("2026-09-21T16:00:00Z");
  const H = 3600;
  const meta = {
    "dist-tags": { canary: "1.4.2-canary.20260921.1", latest: "1.4.2" },
    versions: {
      "1.4.2": {},
      "1.4.2-canary.20260919.1": {},
      "1.4.2-canary.20260920.1": {},
      "1.4.2-canary.20260921.1": {},
      "1.4.1": {},
    },
    time: {
      created: "2021-01-01T00:00:00Z",
      modified: "2026-09-21T14:20:33Z",
      "1.4.2": "2026-09-05T05:55:48Z",
      "1.4.2-canary.20260919.1": "2026-09-19T14:15:36Z",
      "1.4.2-canary.20260920.1": "2026-09-20T14:20:00Z",
      "1.4.2-canary.20260921.1": "2026-09-21T14:20:33Z",
      "1.4.1": "2026-09-04T08:33:19Z",
    },
  };
  const picked = newestSeasonedCanary(meta, 24 * H, now);
  assert.ok(picked, "a daily publish always has a seasoned canary behind the newest one");
  assert.equal(picked.version, "1.4.2-canary.20260920.1", "the 20th is 25.7 h old and the 21st is 1.7 h old; the tag names the 21st");
  assert.notEqual(picked.version, meta["dist-tags"].canary, "the control: the dist-tag's answer is exactly the one the window refuses");
  assert.equal(picked.publishedAt, Date.parse("2026-09-20T14:20:00Z"));
  assert.deepEqual(picked.skipped, [{ version: "1.4.2-canary.20260921.1", ageSeconds: Math.floor((now - Date.parse("2026-09-21T14:20:33Z")) / 1000) }]);
  // Gate 2 then agrees with the choice by construction, which is the property
  // the old shape lacked: the candidate it handed gate 2 could never pass it.
  assert.ok((now - picked.publishedAt) / 1000 >= 24 * H);

  // A wider window walks further back; a window nothing clears is null, not
  // the newest thing on the list.
  assert.equal(newestSeasonedCanary(meta, 40 * H, now)?.version, "1.4.2-canary.20260919.1");
  assert.equal(newestSeasonedCanary(meta, 100 * H, now), null);
  assert.equal(newestSeasonedCanary(null, 24 * H, now), null, "no registry document is no candidate");

  // Releases are never a canary candidate, however old.
  assert.equal(newestSeasonedCanary({ versions: { "1.4.2": {} }, time: meta.time }, 1, now), null);

  // The next release line outranks the current one once its canary is seasoned:
  // after 1.4.3 ships, npm names canaries 1.4.3-canary.<date>.
  const next = { versions: { ...meta.versions, "1.4.3-canary.20260918.1": {} }, time: { ...meta.time, "1.4.3-canary.20260918.1": "2026-09-18T14:20:00Z" } };
  assert.equal(newestSeasonedCanary(next, 24 * H, now)?.version, "1.4.3-canary.20260918.1");

  // A canary with no publish time is skipped and named, never read as old.
  const { "1.4.2-canary.20260920.1": _dropped, ...timeWithoutThe20th } = meta.time;
  const untimed = { versions: meta.versions, time: timeWithoutThe20th };
  const p2 = newestSeasonedCanary(untimed, 24 * H, now);
  assert.ok(p2);
  assert.equal(p2.version, "1.4.2-canary.20260919.1");
  assert.deepEqual(p2.skipped.map((s) => [npmVersion(s.version), s.ageSeconds === null]), [["1.4.2-canary.20260921.1", false], ["1.4.2-canary.20260920.1", true]]);
});

test("the release asset names match what oven-sh/bun tags", () => {
  assert.equal(releaseAsset("linux", "x64"), "bun-linux-x64.zip");
  assert.equal(releaseAsset("darwin", "arm64"), "bun-darwin-aarch64.zip");
  assert.throws(() => releaseAsset("sunos", "sparc"), /no bun release asset known/); // a platform pair bun has no asset for
  assert.equal(
    releaseUrl("1.4.0", "bun-linux-x64.zip"),
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip",
  );
});
