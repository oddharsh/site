// ── /encode — read the container, decode nothing ─────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── /encode — read the container, decode nothing ─────────────────────────
// These parse the repo's OWN committed encodes, which is the strongest test
// available: 474 files this site's pipeline produced, with known properties.

test("the JPEG parser agrees with the pipeline that made the files", async () => {
  const { parseJpeg, sniff, estimateQuality } = await import("../src/worker/encode.ts");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync("public/i").filter((f) => f.endsWith(".jpg")).slice(0, 12);
  assert.ok(files.length > 4, "expected committed thumbnails to test against");

  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(`public/i/${f}`));
    assert.equal(sniff(bytes), "jpeg", `${f} should sniff as jpeg`);
    const info = parseJpeg(bytes);
    // add-photos.sh emits 600px squares through zenc at 4:2:0, progressive.
    assert.equal(info.width, 600, `${f} width`);
    assert.equal(info.height, 600, `${f} height`);
    assert.equal(info.subsampling, "4:2:0", `${f} is the delivery tier, so 4:2:0`);
    assert.equal(info.progressive, true, `${f} should be progressive — zenc searches scan scripts`);
    assert.ok(info.scans > 1, `${f} progressive means multiple scans, got ${info.scans}`);

    // zenjpeg ships tuned tables, so they must NOT read as scaled Annex K.
    // If this ever flips, the encoder changed underneath the pipeline.
    const luma = info.tables.find((t) => t.id === 0);
    assert.ok(luma, `${f} must carry a luma quantization table`);
    assert.equal(estimateQuality(luma.values).standard, false,
      `${f} should read as a CUSTOM table — zenjpeg does not use scaled Annex K`);
  }
});

test("the AVIF parser reads bit depth and subsampling, and monochrome is real", async () => {
  // 10-bit is this site's documented choice (~6% smaller at equal quality).
  // The monochrome flag is the one I nearly "fixed" while it was correct: the
  // first files sampled were the two Leica black-and-white frames, so a broken
  // parser and a right one looked identical until the sample got bigger.
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
    assert.ok(["4:2:0", "grayscale"].includes(info.subsampling), `${f} unexpected subsampling ${info.subsampling}`);
  }
  // A parser that always answered "monochrome" would still pass every assertion
  // above on a small enough sample. This is the one that catches it.
  assert.ok(colour > mono, `most frames are colour; parsed ${colour} colour vs ${mono} mono`);
});

test("encode sniffs the container from magic bytes, not content-type", async () => {
  // A mislabelled response is common, and the parse has to match the actual
  // bytes or it reads garbage confidently.
  const { sniff } = await import("../src/worker/encode.ts");
  assert.equal(sniff(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), "jpeg");
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0])), "png");
  assert.equal(sniff(new Uint8Array(4)), null);
});

test("encode judges chroma and depth against this site's own measurements", async () => {
  // The verdicts are where the site's encoding work stops being prose. 4:4:4 at
  // delivery size and 8-bit AVIF are the two it should always flag.
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

test("the ramp never double-parses wrangler's already-parsed JSON", async () => {
  // A ramp writes its changelog row exactly once, at 100%, and a failure there
  // is caught and downgraded to a printed note on purpose — traffic has already
  // moved, and unwinding a good release over a missing log row would be worse.
  //
  // That tolerance is what made this bug invisible for three releases. The D1
  // read was written as JSON.parse(await wrangler(..., { json: true })), but the
  // helper ALREADY parses when json is set, so the second parse received an
  // object, stringified it to "[object Object]", and threw. Every ramp then
  // reported that D1 was unreachable and skipped its own write. D1 was answering
  // the whole time; `bun run checkpoints:check` queried it fine minutes later.
  //
  // Asserted as source text because the alternative is spawning wrangler against
  // production D1 from the test suite, which no contract test should ever do.
  const src = await readFile(new URL("./tools/deploy-promote.mjs", ROOT), "utf8");

  assert.ok(/const rows = \(await wrangler\(/.test(src),
    "the D1 read must consume wrangler's parsed result directly");
  assert.equal(/JSON\.parse\(\s*await wrangler\(/.test(src), false,
    "wrangler(..., { json: true }) already returns parsed JSON — a second JSON.parse throws on the object");

  // The helper's contract is the other half: if it ever stops parsing, the call
  // site above silently starts handing a string to [0].results instead.
  assert.ok(/return json \? JSON\.parse\(stdout\) : stdout;/.test(src),
    "wrangler() must keep parsing when { json: true } — the call site depends on it");

  // FRESHNESS. Workers Builds uploads a couple of minutes after a merge, and a
  // ramp inside that window targets the PREVIOUS release while every downstream
  // check passes. It happened twice on 2026-08-10. The check compares the
  // target's created_on against HEAD's commit time, and the ONE thing worth
  // pinning is WHERE it is called: before the --dry-run exit, so it prints on
  // both paths. A warning that only appears in --dry-run is worth nothing on the
  // run that skips it, and skipping it is exactly what a hurry looks like.
  const freshnessAt = src.indexOf("await reportTargetFreshness(");
  const dryRunExitAt = src.indexOf('if (has("dry-run"))');
  assert.ok(freshnessAt > 0, "the ramp must report target freshness");
  assert.ok(dryRunExitAt > 0, "the --dry-run early exit must still exist");
  assert.ok(freshnessAt < dryRunExitAt,
    "reportTargetFreshness must run BEFORE the --dry-run exit, or a real ramp loses the warning");

  // It warns and does not refuse, on purpose: ramping something older than HEAD
  // is legitimate for a rollback and for re-ramping the serving version to write
  // a missed changelog row (gotcha 24). A die() there would block that repair.
  assert.equal(/STALE TARGET[\s\S]{0,700}?\bdie\(/.test(src), false,
    "a stale target must warn, never die — that would block the gotcha-24 repair path");

  // And the diagnostic must not name a cause. It covers a file read, a spawn and
  // a shape check; blaming D1 sent the reader to check a healthy database.
  assert.equal(/when D1 is reachable/.test(src), false,
    "the catch-all note must not assert D1 is the cause — it cannot know that");
});

test("no ramp sample can hang, and a stall is never reported as an origin error", async () => {
  // SECOND TIME the D1 changelog write has been silently skipped, by a different
  // mechanism than the double-parse above. The v177 ramp moved traffic through
  // 10/50/100 and then exited mid-sample with `Detected unsettled top-level
  // await`, before the write that runs after sampling. `fetch` has no default
  // request timeout, so one stalled socket wedges the step; the repair (`--to
  // 100`, which moves nothing and logs) is documented, and needing it is the bug.
  //
  // Source text for the same reason as the test above: the alternative is
  // spawning wrangler against production from the suite.
  const src = await readFile(new URL("./tools/deploy-promote.mjs", ROOT), "utf8");

  // Counted rather than matched once, so a SECOND fetch added later without a
  // timeout fails this instead of riding the first one's signal.
  const fetches = (src.match(/await fetch\(/g) || []).length;
  const timeouts = (src.match(/signal: AbortSignal\.timeout\(/g) || []).length;
  assert.ok(fetches > 0, "the ramp samples over the network — if this hits zero the test is measuring nothing");
  assert.equal(timeouts, fetches,
    `every network call in the ramp needs a request timeout: ${fetches} fetch(es), ${timeouts} with a signal`);

  // A timeout is only safe to add because a stall is classified apart from an
  // origin error. Conflated, a laptop's flaky wifi would trigger the ramp's
  // roll-back advice against a healthy release.
  assert.ok(/stalls\+\+/.test(src), "a failed request must count as a stall, not an error");
  assert.ok(/errorVersions\.push/.test(src) && /stallReasons\.push/.test(src),
    "errors and stalls must be reported through separate channels");
  assert.ok(/not an origin fault/.test(src),
    "the stall note must say whose fault it is not");

  // And a step nobody could measure must not pass as a step that succeeded —
  // at 100% that is what stops an unverified run from writing the changelog.
  assert.ok(/if \(!s\.answered\)/.test(src),
    "a sample where nothing answered must stop the ramp rather than be read as success");
});
