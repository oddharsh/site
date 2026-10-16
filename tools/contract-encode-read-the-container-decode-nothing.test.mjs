// ── /encode — read the container, decode nothing ─────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readFileSync,
  test,
} from "./contract-shared.ts";

test("the JPEG parser agrees with the pipeline that made the files", async () => {
  const { parseJpeg, sniff, estimateQuality } = await import("../src/worker/encode.ts");
  const { readdirSync } = await import("node:fs");
  // SORTED before slicing, because readdir order is filesystem-arbitrary: the
  // unsorted slice sampled different files on APFS and ext4, which is how this
  // test failed in CI while passing locally. Sorted, the L-prefixed Monochrom
  // stems land in the window and both layout arms below are exercised.
  const files = readdirSync("public/i").filter((f) => f.endsWith(".jpg")).sort().slice(0, 12);
  assert.ok(files.length > 4, "expected committed thumbnails to test against");

  let gray = 0, colour = 0;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(`public/i/${f}`));
    assert.equal(sniff(bytes), "jpeg", `${f} should sniff as jpeg`);
    const info = parseJpeg(bytes);
    assert.equal(info.width, 600, `${f} width`);
    assert.equal(info.height, 600, `${f} height`);
    if (info.components === 1) {
      gray += 1;
      assert.equal(info.subsampling, "grayscale", `${f} is 1-component, so grayscale`);
    } else {
      colour += 1;
      assert.equal(info.subsampling, "4:2:0", `${f} is the colour delivery tier, so 4:2:0`);
    }
    assert.equal(info.progressive, true, `${f} should be progressive — zenc searches scan scripts`);
    assert.ok(info.scans > 1, `${f} progressive means multiple scans, got ${info.scans}`);

    const luma = info.tables.find((t) => t.id === 0);
    assert.ok(luma, `${f} must carry a luma quantization table`);
    assert.equal(estimateQuality(luma.values).standard, false,
      `${f} should read as a CUSTOM table — zenjpeg does not use scaled Annex K`);
  }
  assert.ok(gray >= 1, "the sample lost its grayscale tiles; the 1-component arm is unexercised");
  assert.ok(colour >= 1, "the sample lost its colour tiles; the 4:2:0 arm is unexercised");
});

test("the AVIF parser reads bit depth and subsampling, and monochrome is real", async () => {
  const { parseAvif, sniff } = await import("../src/worker/encode.ts");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync("public/i").filter((f) => f.endsWith(".avif")).slice(0, 30);
  let mono = 0, colour = 0;

  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(`public/i/${f}`));
    assert.equal(sniff(bytes), "avif", `${f} should sniff as avif`);
    const info = parseAvif(bytes);
    assert.ok(info, `${f} should parse`);
    assert.equal(info.bitDepth, 10, `${f} should be 10-bit — the measured free win`);
    if (info.monochrome) mono += 1; else colour += 1;
    assert.ok(["4:4:4", "grayscale"].includes(info.subsampling), `${f} unexpected subsampling ${info.subsampling}`);
  }
  assert.ok(colour > mono, `most frames are colour; parsed ${colour} colour vs ${mono} mono`);
});

test("encode sniffs the container from magic bytes, not content-type", async () => {
  const { sniff } = await import("../src/worker/encode.ts");
  assert.equal(sniff(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), "jpeg");
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0])), "png");
  assert.equal(sniff(new Uint8Array(4)), null);
});

test("encode judges chroma and depth against this site's own measurements", async () => {
  const { judgeEncode } = await import("../src/worker/encode.ts");
  const fat = judgeEncode({ format: "jpeg", subsampling: "4:4:4", progressive: false, scans: 1, tables: [], width: 600, height: 600, icc: true }, 90000);
  const ids = fat.warns.map((w) => w.id);
  assert.ok(ids.includes("chroma"), "4:4:4 at delivery size must be flagged");
  assert.ok(ids.includes("scan"), "baseline must be flagged — progressive is free bytes");
  assert.ok(ids.includes("metadata"), "ICC riding along on a thumbnail must be flagged");

  const lean = judgeEncode({ format: "jpeg", subsampling: "4:2:0", progressive: true, scans: 8, tables: [], width: 600, height: 600 }, 40000);
  assert.equal(lean.warns.length, 0, "a well-made delivery JPEG should draw no warnings");

  assert.ok(judgeEncode({ format: "avif", bitDepth: 8, subsampling: "4:2:0" }, 30000).warns.some((w) => w.id === "depth"),
    "8-bit AVIF must be flagged — 10-bit is free");
  assert.equal(judgeEncode({ format: "avif", bitDepth: 10, subsampling: "4:2:0" }, 30000).warns.length, 0);
});

test("the ramp never double-parses the D1 helper's already-parsed rows", async () => {
  const src = await readFile(new URL("./tools/deploy-promote.ts", ROOT), "utf8");
  const helper = await readFile(new URL("./tools/lib/cf.ts", ROOT), "utf8");

  assert.ok(/const rows = await d1Rows\(/.test(src),
    "the D1 read must consume d1Rows()'s parsed rows directly");
  assert.equal(/JSON\.parse\(\s*await (d1Rows|cf)\(/.test(src), false,
    "d1Rows() and cf() already return parsed JSON — a second JSON.parse throws on the object");

  assert.ok(/parsed = JSON\.parse\(stdout\);/.test(helper) && /return first\.results;/.test(helper),
    "cf() must keep parsing and d1Rows() must keep returning the results array — the call site depends on it");

  const freshnessAt = src.indexOf("await reportTargetFreshness(");
  const dryRunExitAt = src.indexOf('if (has("dry-run"))');
  assert.ok(freshnessAt > 0, "the ramp must report target freshness");
  assert.ok(dryRunExitAt > 0, "the --dry-run early exit must still exist");
  assert.ok(freshnessAt < dryRunExitAt,
    "reportTargetFreshness must run BEFORE the --dry-run exit, or a real ramp loses the warning");

  // It warns and does not refuse, on purpose: ramping something older than HEAD
  // is legitimate for a rollback and for re-ramping the serving version to write
  // a missed changelog row (gotcha 24). A die() there would block that repair.
  // The warning has to be there for its absence of die() to mean anything.
  assert.match(src, /STALE TARGET/, "the ramp lost its stale-target warning");
  assert.equal(/STALE TARGET[\s\S]{0,700}?\bdie\(/.test(src), false,
    "a stale target must warn, never die — that would block the gotcha-24 repair path");

  assert.equal(/when D1 is reachable/.test(src), false,
    "the catch-all note must not assert D1 is the cause — it cannot know that");
});

test("no ramp sample can hang, and a stall is never reported as an origin error", async () => {
  const src = [
    await readFile(new URL("./tools/deploy-promote.ts", ROOT), "utf8"),
    await readFile(new URL("./tools/lib/version-probe.ts", ROOT), "utf8"),
  ].join("\n");

  const fetches = (src.match(/await fetch\(/g) || []).length;
  const timeouts = (src.match(/signal: AbortSignal\.timeout\(/g) || []).length;
  assert.ok(fetches > 0, "the ramp samples over the network — if this hits zero the test is measuring nothing");
  assert.equal(timeouts, fetches,
    `every network call in the ramp needs a request timeout: ${fetches} fetch(es), ${timeouts} with a signal`);

  assert.ok(/stalls\+\+/.test(src), "a failed request must count as a stall, not an error");
  assert.ok(/errorVersions\.push/.test(src) && /stallReasons\.push/.test(src),
    "errors and stalls must be reported through separate channels");
  assert.ok(/not an origin fault/.test(src),
    "the stall note must say whose fault it is not");

  assert.ok(/if \(!s\.answered\)/.test(src),
    "a sample where nothing answered must stop the ramp rather than be read as success");
});
