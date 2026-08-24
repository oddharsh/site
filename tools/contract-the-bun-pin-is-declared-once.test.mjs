// ── the bun pin is declared once ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { compareVersions, interpretZstdProbe, minimumReleaseAgeSeconds, readPin, releaseAsset, releaseUrl, writePin } from "./lib/bun-pin.ts";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(ROOT);

// `packageManager` is the one dependency version here that no updater owns, and
// the one that compiles the site: wrangler.jsonc builds with `bun
// tools/build.ts`, so it decides every content-addressed /a/ and /i/ URL. Three
// readers share it and none may carry a copy.

test("the pin lib reads the same string package.json holds", async () => {
  const text = await readFile(new URL("package.json", ROOT), "utf8");
  const pkg = JSON.parse(text);
  const pin = readPin(root);
  assert.equal(pin.raw, pkg.packageManager);
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
});

test("writePin edits one field and reflows nothing else", async () => {
  // A JSON round trip would pass this test's letter and destroy the file: five
  // `comment:` keys in package.json carry paragraphs that re-serializing folds
  // into one line each. So the assertion is on the BYTES either side of the pin
  // rather than on a parsed object.
  const before = await readFile(new URL("package.json", ROOT), "utf8");
  const pin = readPin(root);
  try {
    writePin(root, "9.9.9");
    const after = await readFile(new URL("package.json", ROOT), "utf8");
    assert.equal(readPin(root).version, "9.9.9");
    assert.equal(
      after.replace('"packageManager": "bun@9.9.9"', `"packageManager": "${pin.raw}"`),
      before,
      "writePin changed something other than the version",
    );
  } finally {
    writePin(root, pin.version);
  }
  assert.equal(await readFile(new URL("package.json", ROOT), "utf8"), before, "the restore did not restore");
});

test("the zstd capability probe is declared once", async () => {
  // Two copies of one measurement agree on the day they are written and rot
  // separately after, which is the argument lib/mcp-protocol.ts already won for
  // MCP_SUPPORTED. This probe is worse than most to duplicate, because what it
  // detects is SILENT: a runtime that accepts `dictionary` and ignores it emits
  // plain zstd that still decodes, so a stale copy reports a pass.
  const lib = await readFile(new URL("tools/lib/bun-pin.ts", ROOT), "utf8");
  assert.match(lib, /zstdCompressSync/, "lib/bun-pin.ts is supposed to be the one that holds the probe");

  for (const file of ["tools/check-bun.ts", "tools/bump-bun-pin.ts"]) {
    const body = await readFile(new URL(file, ROOT), "utf8");
    // CODE, not mention. Both files EXPLAIN the probe in prose, and the first
    // draft of this assertion read `zstdCompressSync({ dictionary })` inside
    // check-bun.ts's own header comment and failed on it. Same shape as the
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

test("versions compare numerically, so 1.10 is newer than 1.4", () => {
  // The one comparison a string sort gets wrong, and bun will reach 1.10.
  assert.equal(compareVersions("1.10.0", "1.4.0"), 1);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(compareVersions("1.3.14", "1.4.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
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

test("only a stable release can ever be proposed", async () => {
  const body = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  // `releases/latest` is what skips drafts and prereleases, which is what keeps
  // the rolling `canary` tag out. A canary is not pinnable: setup-bun dropped
  // its SHA-256 precisely because a RELEASED tag is immutable and canary was not.
  assert.match(body, /releases\/latest/, "the target must come from releases/latest, which excludes prereleases");
  assert.match(body, /\^bun-v\(\\d\+\\\.\\d\+\\\.\\d\+\)\$/, "the tag must be matched as a plain bun-vX.Y.Z");

  // The baseline guard. Without it a stale bun on PATH compares the candidate
  // against a third runtime and reports a byte-identical build that says nothing
  // about what production ships, which is the trap check-bun.ts refuses by
  // declining to be invoked through bun at all.
  assert.match(body, /baselineVersion !== pin\.version/, "the bumper must refuse a baseline that is not the pin");
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
