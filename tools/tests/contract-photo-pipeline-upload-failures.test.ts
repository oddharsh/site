import assert from "node:assert/strict";
import test from "node:test";
import { uploadFixture } from "./photo-pipeline-fixture.ts";

test("failed source or HEIF-companion uploads stop before hashing and index writes", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    await put("src/worker/photo-index.json", '{"existing":{"full":"existing.jpg"}}');
    for (const key of ["aadhar-photos/frame.jxl", "aadhar-photos/companion.jxl"]) {
      await put("trace", "");
      await put("uploads", "");
      const failed = ingest(["source"], { FAIL_UPLOAD: key });
      assert.equal(failed.status, 1, failed.stderr + failed.stdout);
      assert.match(failed.stderr, /phase 3 incomplete/);
      assert.match(failed.stderr, new RegExp(key.replaceAll(".", "\\.")));
      assert.doesNotMatch(failed.stdout, /phase 4/);
      assert.doesNotMatch(await read("trace"), /downstream-hash/);
      assert.equal(await read("src/worker/photo-index.json"), '{"existing":{"full":"existing.jpg"}}');
      assert.ok((await uploads()).some((row) => row.key === key && row.failed));
    }
    await put("uploads", "");
    const good = ingest();
    assert.equal(good.status, 23, good.stderr + good.stdout);
    assert.match(await read("trace"), /downstream-hash/);
    const sent = (await uploads()).filter((row) => row.event === "start").map(({ key, body }) => ({ key, body }));
    assert.deepEqual(
      sent.sort((a, b) => a.key.localeCompare(b.key)),
      [
        // Only the JPEG XL goes up, wrapping the prepared JPEG: for a HIF that is
        // zenc's re-encode AFTER jpegtran's DC-first reorder, never the source.
        { key: "aadhar-photos/companion.jxl", body: "jxl:progressive" },
        { key: "aadhar-photos/frame.jxl", body: "jxl:progressive" },
      ],
    );
    assert.equal(await read("source/frame.jpg"), "source fixture");
    assert.equal(await read("source/companion.HIF"), "HEIF original");
  });
});

test("progressive-copy failure uploads the untouched source and removes the rejected copy", async () => {
  await uploadFixture(async ({ ingest, uploads, read }) => {
    const result = ingest(["source/frame.jpg"], { COPY_FAIL: "1" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    const [sent] = (await uploads()).filter((row) => row.event === "start");
    assert.equal(sent.body, "jxl:source fixture");
    assert.match(await read("trace"), /cjxl /, "the probe below only means something if cjxl ran");
    assert.doesNotMatch(await read("trace"), /discarded-copy-exists/);
    assert.equal(await read("source/frame.jpg"), "source fixture");
  });
});

// The HIF branch has no untouched original to fall back to: zenc's own file is
// the one whose luma-first scan order kept 53 archives blank until 66-99% of the
// download, so a failed reorder must fail the photo rather than upload that.
test("a HIF archive whose DC-first reorder fails is never uploaded", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    const result = ingest(["source/companion.HIF"], { COPY_FAIL: "1" });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /phase 2 incomplete/);
    assert.deepEqual(await uploads(), []);
    assert.doesNotMatch(await read("trace"), /downstream-hash/);
    // control: the same source with a working reorder uploads the reordered bytes
    const good = ingest(["source/companion.HIF"]);
    assert.equal(good.status, 23, good.stderr + good.stdout);
    const sent = (await uploads()).filter((row) => row.event === "start");
    assert.deepEqual(
      sent.map(({ key, body }) => ({ key, body })),
      [{ key: "aadhar-photos/companion.jxl", body: "jxl:progressive" }],
    );
  });
});

// The .jxl is the only copy R2 will hold, so one whose rebuild differs from the
// prepared JPEG by a byte must never reach R2, and the photo fails the way a
// failed HEIF upload does: before hashing, with the index untouched.
test("a JPEG XL original that does not rebuild the prepared JPEG is never uploaded", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("src/worker/photo-index.json", '{"existing":{"full":"existing.jpg"}}');
    const bad = ingest(["source/frame.jpg"], { BAD_REBUILD: "1" });
    assert.equal(bad.status, 1, bad.stderr + bad.stdout);
    assert.match(bad.stderr, /phase 3 incomplete/);
    assert.match(bad.stderr, /JPEG XL original failed .*aadhar-photos\/frame\.jxl/);
    assert.deepEqual(await uploads(), [], "nothing went up, the JPEG included");
    assert.doesNotMatch(await read("trace"), /downstream-hash/);
    assert.equal(await read("src/worker/photo-index.json"), '{"existing":{"full":"existing.jpg"}}');
    // Control: an exact rebuild uploads it, with its own content type.
    await put("uploads", "");
    const good = ingest(["source/frame.jpg"]);
    assert.equal(good.status, 23, good.stderr + good.stdout);
    assert.deepEqual(
      (await uploads()).filter((row) => row.event === "start").map((row) => row.key),
      ["aadhar-photos/frame.jxl"],
    );
  });
});

// A HIF photo's archive is encoded from the HIF's own pixels when that beats
// the JPEG ingest prepared on both metrics, with the HIF's EXIF copied on
// (sips drops every Fujifilm maker note), and is that JPEG repacked when it
// does not. A JPEG photo is always the repack: it has no better source.
test("a HIF photo's archive is its own pixels when they beat the JPEG bar, and the repacked JPEG when not", async () => {
  await uploadFixture(async ({ root, put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    const win = { CAND_S2: "96", CAND_BA: "0.4" };
    const direct = ingest(["source"], win);
    assert.equal(direct.status, 23, direct.stderr + direct.stdout);
    const sent = Object.fromEntries((await uploads()).filter((r) => r.event === "start").map((r) => [r.key, r.body]));
    // sips's PNG of the HIF ("encoded") went through jixel-enc, not the JPEG bar
    assert.equal(sent["aadhar-photos/companion.jxl"], "jxl:encoded");
    assert.match(await read("trace"), /^jixel-enc \S+\/raw\.png \S+\.jxl 0\.5$/m, "the final file is encoded from the unstripped PNG at the chosen distance");
    assert.equal(sent["aadhar-photos/frame.jxl"], "jxl:progressive", "a JPEG source is repacked whatever the metrics say");
    // the HIF's EXIF goes onto the .jxl (phase 2 also copies it onto the JPEG bar)
    assert.match(await read("trace"), new RegExp(`metadata -TagsFromFile ${root}/source/companion\\.HIF -all:all -overwrite_original \\S+\\.jxl`));
    // Control: a candidate that wins only one metric is no win, so the HIF
    // photo falls back to the repack.
    for (const half of [{ CAND_S2: "96" }, { CAND_BA: "0.4" }]) {
      await put("uploads", "");
      await put("trace", "");
      const lost = ingest(["source/companion.HIF"], half);
      assert.equal(lost.status, 23, lost.stderr + lost.stdout);
      assert.deepEqual(
        (await uploads()).filter((r) => r.event === "start").map((r) => [r.key, r.body]),
        [["aadhar-photos/companion.jxl", "jxl:progressive"]],
        JSON.stringify(half),
      );
      assert.doesNotMatch(await read("trace"), /-overwrite_original \S+\.jxl/);
    }
  });
});

test("upload batching stays at four regardless of encoder concurrency", async () => {
  await uploadFixture(async ({ put, ingest, uploads }) => {
    for (let i = 0; i < 8; i++) await put(`source/extra ${i}.JPG`, `source ${i}`);
    const result = ingest(["source"], { JOBS: "8", UPLOAD_BARRIER: "1" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    let active = 0,
      maximum = 0;
    const keys: any[] = [];
    for (const event of await uploads()) {
      active += event.event === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
      if (event.event === "start") keys.push(event.key);
    }
    assert.equal(maximum, 4);
    assert.equal(active, 0);
    // nine photos, one JPEG XL original each
    assert.equal(keys.length, 9);
    assert.equal(new Set(keys).size, 9);
    assert.ok(keys.includes("aadhar-photos/extra 0.jxl"));
  });
});

test("remote-render-only mode performs no uploads even if the upload CLI would fail", async () => {
  await uploadFixture(async ({ ingest, uploads }) => {
    const result = ingest(["source/frame.jpg"], { REMOTE_RENDER_ONLY: "1", FAIL_UPLOAD: "all" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    assert.deepEqual(await uploads(), []);
  });
});
