import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { photoInputs } from "../photos/photo-inputs.ts";
import { fixture, uploadFixture } from "./photo-pipeline-fixture.ts";

test("photo selection pairs a requested HEIF with its camera JPEG without overriding an explicit JPEG", async () => {
  await fixture(async ({ root, put }) => {
    await put("source/frame.hIf", "HEIF original");
    const jpg = path.join(root, "source/frame.jpg");
    const hif = path.join(root, "source/frame.hIf");
    const pair = [{ stem: "frame", source: hif, original: jpg, full: "frame.jpg" }];
    assert.deepEqual(await photoInputs([hif]), pair);
    assert.deepEqual(await photoInputs([hif, jpg, path.join(root, "source/../source/frame.jpg")]), pair);
    assert.deepEqual(await photoInputs([path.join(root, "source")]), pair);
    assert.deepEqual(await photoInputs([jpg]), [{ stem: "frame", source: jpg, original: jpg, full: "frame.jpg" }]);
  });
});

test("ingest and rerender both use one HEIF pixel source and one JPEG click object", async () => {
  await uploadFixture(async ({ root, put, read, ingest, shell, uploads }) => {
    await put("source/frame.hIf", "HEIF original");
    for (const input of ["source/frame.hIf", "source"]) {
      await put("uploads", "");
      await put("trace", "");
      const result = ingest([input]);
      assert.equal(result.status, 23, result.stderr + result.stdout);
      const sent = (await uploads()).filter((row) => row.event === "start");
      assert.deepEqual(
        sent.map(({ key, body }) => [key, body]),
        [["aadhar-photos/frame.jxl", "jxl:progressive"]],
      );
      if (input.endsWith("hIf")) {
        assert.ok((await read("trace")).includes(`-Orientation ${root}/source/frame.hIf`));
        assert.doesNotMatch(await read("trace"), /-Orientation .*frame\.jpg/);
      }
    }
    await put("trace", "");
    const rerender = shell("reencode-thumbnails.sh", ["source"]);
    assert.equal(rerender.status, 0, rerender.stderr + rerender.stdout);
    assert.ok((await read("trace")).includes(`-Orientation ${root}/source/frame.hIf`));
    assert.doesNotMatch(await read("trace"), /-Orientation .*frame\.jpg/);
    assert.equal(await read("source/frame.hIf"), "HEIF original");
    assert.equal(await read("source/frame.jpg"), "source fixture");
  });
});

test("ambiguous stems fail before encoding, uploading, hashing, or replacing existing tiers", async () => {
  for (const duplicate of ["source/frame.JPEG", "other/frame.JPG"]) {
    await uploadFixture(async ({ put, read, ingest, shell }) => {
      await put(duplicate, "different original");
      await put("public/images/frame.jpg", "previous tier");
      const result = ingest(["source/frame.jpg", duplicate]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ambiguous photo stem frame/);
      assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|upload|downstream/);
      assert.equal(await read("public/images/frame.jpg"), "previous tier");
      if (duplicate.startsWith("source/")) {
        const rerender = shell("reencode-thumbnails.sh", ["source"]);
        assert.equal(rerender.status, 1, rerender.stderr);
        assert.match(rerender.stderr, /ambiguous photo stem frame/);
        assert.equal(await read("public/images/frame.jpg"), "previous tier");
      }
    });
  }
});

test("remote ingest preserves the existing JPEG key and refuses a HEIF that would need an upload", async () => {
  await uploadFixture(async ({ root, put, read, ingest, uploads }) => {
    await put("source/Remote.JPEG", "remote bytes");
    const source = path.join(root, "source/Remote.JPEG");
    assert.deepEqual(await photoInputs([source], { remote: true }), [{ stem: "Remote", source, original: source, full: "Remote.JPEG" }]);
    assert.equal(ingest([source], { REMOTE_RENDER_ONLY: "1" }).status, 23);
    assert.equal(await read("progressive-paths"), "");
    assert.deepEqual(await uploads(), []);
    await put("source/frame.HIF", "HEIF original");
    await put("trace", "");
    const failed = ingest(["source/frame.HIF"], { REMOTE_RENDER_ONLY: "1" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /remote ingest needs the existing JPEG object/);
    assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|upload|downstream/);
  });
});

// The remote pipeline gets a migrated original as its .jxl plus the JPEG djxl
// rebuilt beside it. The JPEG feeds the encoders; the index has to keep naming
// the .jxl and its size, or a rerender would point every link at a key R2 no
// longer holds.
test("remote ingest of a JPEG XL original records the .jxl key and size, not the rebuilt JPEG", async () => {
  await uploadFixture(async ({ root, put, command, ingest, read, uploads }) => {
    await put("moved/Moved.jpg", "rebuilt JPEG bytes");
    await put("moved/Moved.jxl", "jxl:x");
    const jpg = path.join(root, "moved/Moved.jpg");
    const jxl = path.join(root, "moved/Moved.jxl");
    assert.deepEqual(await photoInputs([path.join(root, "moved")], { remote: true }), [{ stem: "Moved", source: jpg, original: jxl, full: "Moved.jxl" }]);
    // Control: a local ingest of the same folder ignores the .jxl entirely.
    assert.deepEqual(await photoInputs([path.join(root, "moved")]), [{ stem: "Moved", source: jpg, original: jpg, full: "Moved.jpg" }]);
    await put("src/worker/photo-index.json", '{"Moved":{"full":"Moved.jxl","jpeg":"Moved.JPG","size":5,"uploaded":"2026-07-27T00:00:00.000Z"}}');
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    await command("tools/photos/extract-photo-metadata.sh", "exit 31");
    const result = ingest(["moved"], { REMOTE_RENDER_ONLY: "1" });
    assert.equal(result.status, 31, result.stderr + result.stdout);
    assert.deepEqual(await uploads(), []);
    assert.deepEqual(JSON.parse(await read("src/worker/photo-index.json")).Moved, {
      full: "Moved.jxl",
      jpeg: "Moved.JPG",
      size: 5,
      uploaded: "2026-07-27T00:00:00.000Z",
    });
  });
});

// The remote downloader meets two kinds of JPEG XL original. A transcode
// rebuilds its JPEG, and the .jxl must leave the scanned folder: its metadata
// is Brotli-compressed, and exif-sooc 0.4.0 reads .jxl, so beside the JPEG it
// would be a second, failing read of the same photo. A HIF photo's direct
// encode has no JPEG inside: it decodes to a 16-bit PNG and the .jxl stays,
// as the only copy of the HIF's EXIF.
test("the remote downloader rebuilds a transcode's JPEG and decodes a direct archive, keeping only the latter's .jxl in the folder", async () => {
  await fixture(async ({ root, put, command, shell, read }) => {
    const box = (kind, body) => {
      const b = Buffer.alloc(8);
      b.writeUInt32BE(body.length + 8);
      b.write(kind, 4, "latin1");
      return Buffer.concat([b, Buffer.from(body)]);
    };
    const jxl = (...boxes: any[]) =>
      Buffer.concat([Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), box("ftyp", "jxl \0\0\0\0jxl "), ...boxes]);
    await mkdir(path.join(root, "r2"), { recursive: true });
    await writeFile(path.join(root, "r2/Old.jxl"), jxl(box("jbrd", "x"), box("jxlc", "jpeg inside")));
    await writeFile(path.join(root, "r2/New.jxl"), jxl(box("Exif", "\0\0\0\0MM"), box("jxlc", "hif pixels")));
    await command(
      "bin/curl",
      'for a in "$@"; do case "$a" in */images/full/*) key="${a##*/}" ;; esac; prev="$a"; done\nwhile [ "$1" != --output ]; do shift; done\ncp "$FIXTURE_ROOT/r2/$key" "$2"',
    );
    await command("bin/djxl", 'printf "decoded %s" "$*" > "$2"');
    await command("bin/exif-sooc", "echo 400");
    await put("keys", "Old.jxl\nNew.jxl\n");
    const r = shell("download-remote-photos.sh", ["keys", "dest"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const exists = (p) =>
      readFile(path.join(root, p)).then(
        () => true,
        () => false,
      );
    assert.equal(await exists("dest/Old.jpg"), true, "the transcode's JPEG");
    assert.equal(await exists("dest/Old.jxl"), false, "a transcode's .jxl must not stay where exif-sooc scans");
    assert.equal(await exists("dest.r2/Old.jxl"), true);
    assert.match(await read("dest/New.png"), /--bits_per_sample=16/, "a direct archive decodes to 16-bit PNG");
    assert.equal(await exists("dest/New.jxl"), true, "a direct archive's .jxl stays, as its metadata source");
    assert.equal(await exists("dest/New.jpg"), false, "djxl must not be asked for a JPEG it would invent");
    // Remote ingest finds the transcode's key in its new home and refuses the
    // direct archive by name rather than dropping it from the plan.
    await assert.rejects(photoInputs([path.join(root, "dest")], { remote: true }), /cannot re-ingest New/);
    await rm(path.join(root, "dest/New.jxl"));
    await rm(path.join(root, "dest/New.png"));
    assert.deepEqual(await photoInputs([path.join(root, "dest")], { remote: true }), [
      { stem: "Old", source: path.join(root, "dest/Old.jpg"), original: path.join(root, "dest.r2/Old.jxl"), full: "Old.jxl" },
    ]);
  });
});

test("input selection keeps published-only rerenders and rejects unsupported or conflicting sources", async () => {
  await fixture(async ({ root, put }) => {
    await put("source/png.png", "PNG fixture");
    await put("source/private.hif", "private HEIF");
    await put("source/private.heic", "conflicting private HEIF");
    const dir = path.join(root, "source");
    const png = path.join(dir, "png.png");
    const plan = await photoInputs([dir], { published: new Set(["png", "missing"]) });
    assert.deepEqual(plan, [
      { stem: "missing", source: "", original: null, full: "" },
      { stem: "png", source: png, original: null, full: "png.jpg" },
    ]);
    await assert.rejects(photoInputs([png]), /unsupported photo input/);
    await assert.rejects(photoInputs([dir]), /ambiguous photo stem private/);
    await assert.rejects(photoInputs([path.join(root, "absent")]), /ENOENT/);
  });
});

test("the shell input plan preserves filename whitespace and JPEG companion extensions", async () => {
  await uploadFixture(async ({ put, ingest, uploads }) => {
    const stem = "name with\ttab\nand newline";
    await put(`source/${stem}.JpEg`, "camera JPEG");
    await put(`source/${stem}.hEiC`, "HEIF original");
    const result = ingest([`source/${stem}.hEiC`]);
    assert.equal(result.status, 23, result.stderr + result.stdout);
    const sent = (await uploads()).filter((row) => row.event === "start");
    // the key is the companion JPEG's, tab and newline intact, with .jxl
    assert.deepEqual(
      sent.map(({ key, body }) => [key, body]),
      [[`aadhar-photos/${stem}.jxl`, "jxl:progressive"]],
    );
  });
});

test("ingest forwards exactly the selected metadata sources across folders as a merge", async () => {
  await uploadFixture(async ({ root, put, command, ingest, read }) => {
    await put("source/frame.HIF", "HEIF original");
    await put("other/second photo.jpeg", "second original");
    await put("src/worker/photo-index.json", "{}");
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    // The index writer is pipeline-json.ts under the fixture's real node, so
    // it runs here rather than being stubbed: this fixture used to stand in a
    // constant `bin/jaq` because installing a JSON CLI in contract CI was the
    // alternative, and that alternative is gone.
    await command("tools/photos/extract-photo-metadata.sh", `printf '%s\\0' "$@" > "$FIXTURE_ROOT/metadata-args"; exit 31`);
    const result = ingest(["source", "other/second photo.jpeg"]);
    assert.equal(result.status, 31, result.stderr + result.stdout);
    assert.deepEqual((await read("metadata-args")).split("\0"), ["--merge", `${root}/source/frame.HIF`, `${root}/other/second photo.jpeg`, ""]);
  });
});

test("metadata extraction passes multiple file arguments intact and preserves the prior record on read failure", async () => {
  await fixture(async ({ root, put, command, shell, read }) => {
    await put("other/second photo.jpeg", "second original");
    await put("public/images/metadata.json", '{"previous":{"camera":"kept"}}');
    await command("bin/exif-sooc", `printf '%s\\0' "$@" > "$FIXTURE_ROOT/metadata-args"; exit 29`);
    const files = [`${root}/source/frame.jpg`, `${root}/other/second photo.jpeg`];
    const result = shell("extract-photo-metadata.sh", ["--merge", ...files]);
    assert.equal(result.status, 29, result.stderr);
    assert.deepEqual((await read("metadata-args")).split("\0"), ["--keyed", "--merge-into", `${root}/public/images/metadata.json`, "-q", "-r", ...files, ""]);
    assert.equal(await read("public/images/metadata.json"), '{"previous":{"camera":"kept"}}');
  });
});

test("an index write failure stops ingest before metadata can advance", async () => {
  await uploadFixture(async ({ put, command, ingest, read }) => {
    const previous = '{"held":{"full":"held.jpg","size":9}}';
    await put("src/worker/photo-index.json", previous);
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    // A REAL write failure rather than a stub exiting 17: the writer lands its
    // output at <index>.tmp and renames, so a directory squatting on that path
    // fails the write with EISDIR after the merge has been computed, which is
    // the latest point a failure can land and the one that must leave the
    // committed bytes alone.
    await put("src/worker/photo-index.json.tmp/squatter", "");
    await command("tools/photos/extract-photo-metadata.sh", 'echo unexpected-metadata >> "$TRACE"; exit 31');
    const result = ingest(["source/frame.jpg"]);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /pipeline-json: /, "the writer names itself in the failure");
    assert.equal(await read("src/worker/photo-index.json"), previous);
    assert.doesNotMatch(await read("trace"), /unexpected-metadata/);
  });
});
