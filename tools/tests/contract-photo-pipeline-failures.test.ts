import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fixture } from "./photo-pipeline-fixture.ts";

const cases = [
  { file: "gen-encoding-samples.sh", args: [], status: 0 },
  { file: "gen-encoding-grids.sh", args: [], status: 0 },
  { file: "reencode-thumbnails.sh", args: ["source"], status: 0 },
  { file: "add-photos.sh", args: ["source/frame.jpg"], status: 23 },
  { file: "export-for-instagram.sh", args: ["--max", "--out", "exports", "source/frame.jpg"], status: 0 },
  { file: "export-for-instagram.sh", args: ["--max", "--keep-exif", "--out", "exports", "source/frame.jpg"], status: 0 },
];

for (const { file, args, status } of cases) {
  test(`${file} ${args.includes("--keep-exif") ? "copy" : "strip"} refuses unsafe metadata work`, async () => {
    await fixture(async ({ put, read, shell }) => {
      const refused = shell(file, args, { SOOC_VERSION: "exif-sooc 0.1.0" });
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /older than 0\.4\.0/);
      assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|downstream|upload/);
      assert.equal(await read("public/garage/enc/c-png.png"), "published color fixture");

      await put("trace", "");
      const broken = shell(file, args, { FAIL_METADATA: "1" });
      assert.equal(broken.status, file === "add-photos.sh" || file === "reencode-thumbnails.sh" ? 1 : 7, broken.stderr + broken.stdout);
      assert.match(await read("trace"), /metadata/);
      assert.doesNotMatch(await read("trace"), /downstream|upload/);
      assert.doesNotMatch(broken.stdout, /done —|next: re-run hash/);
      if (file === "export-for-instagram.sh") assert.equal(await read("exports/frame.jpg"), "previous export");

      await put("trace", "");
      const good = shell(file, args);
      assert.equal(good.status, status, good.stderr + good.stdout);
      assert.match(await read("trace"), /metadata/);
      if (file === "add-photos.sh") assert.match(await read("trace"), /downstream-hash/);
      // fixture() fails any jpegtran call but -revert, the rotation tripwire (gotcha 3).
      if (file === "gen-encoding-samples.sh") assert.match(await read("trace"), /jpegtran -revert .*-optimize[\s\S]*jpegtran -revert .*-progressive/);
      if (file === "export-for-instagram.sh") assert.equal(await read("exports/frame.jpg"), "encoded");
    });
  });
}

test("encoding sample measurements stop when temporary JPEG metadata editing fails", async () => {
  await fixture(async ({ shell }) => {
    const result = shell("gen-encoding-samples.sh", [], { FAIL_METADATA: "resolution" });
    assert.equal(result.status, 7, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /800x533|1200x800|done —/);
  });
});

test("ingest stops before later phases when any thumbnail tier fails", async () => {
  for (const failure of [{ FAIL_TIER: "sq" }, { FAIL_TIER: "sm" }, { FAIL_TIER: "xs" }, { OMIT_TIER: "xs" }, { EMPTY_TIER: "sm" }])
    await fixture(async ({ read, shell }) => {
      const result = shell("add-photos.sh", ["source/frame.jpg"], failure);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.match(result.stderr, /phase 1 incomplete/);
      assert.doesNotMatch(result.stdout, /phase 2|phase 3|phase 4/);
      assert.doesNotMatch(await read("trace"), /downstream|upload/);
    });
});

test("ingest preserves previous tiers on failure and rebuilds an incomplete cached set", async () => {
  await fixture(async ({ root, put, read, shell }) => {
    const files = ["frame.jpg", "frame.avif", "frame-400.avif", "frame-200.avif"].map((f) => `public/images/${f}`);
    for (const file of files) {
      await put(file, "previous tier");
      await utimes(path.join(root, file), 1, 1);
    }
    for (const failure of [{ FAIL_METADATA: "1" }, { FAIL_TIER: "xs" }]) {
      const result = shell("add-photos.sh", ["source/frame.jpg"], failure);
      assert.equal(result.status, 1, result.stderr);
      for (const file of files) assert.equal(await read(file), "previous tier");
    }
    assert.equal(shell("add-photos.sh", ["source/frame.jpg"]).status, 23);
    for (const file of files) assert.equal(await read(file), "encoded");
    // A complete current set skips encoding; a missing or empty smallest tier
    // must invalidate it even though the JPEG remains newer than the source.
    await put("trace", "");
    assert.equal(shell("add-photos.sh", ["source/frame.jpg"]).status, 23);
    assert.doesNotMatch(await read("trace"), /zenc|metadata|avifenc/);
    for (const empty of [false, true]) {
      if (empty) await put(files[3], "");
      else await rm(path.join(root, files[3]));
      const result = shell("add-photos.sh", ["source/frame.jpg"]);
      assert.equal(result.status, 23, result.stderr);
      assert.equal(await read(files[3]), "encoded");
    }
  });
});

test("the shared EXIF guard requires a successful, exact version report", async () => {
  await fixture(async ({ shell }) => {
    for (const version of ["exif-sooc 0.4.0", "exif-sooc 0.10.0", "exif-sooc 1.0.0"]) {
      const result = shell("require-exif-sooc.sh", [], { SOOC_VERSION: version });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const [version, status] of [
      ["exif-sooc 0.1.9", "0"],
      ["exif-sooc 0.2.0", "0"],
      ["exif-sooc 0.2.9", "0"],
      ["exif-sooc 0.3.0", "0"],
      ["exif-sooc 0.3.9", "0"],
      ["exif-sooc 0.4.0", "9"],
      ["exif-sooc 1..0", "0"],
      ["exif-sooc 2", "0"],
      ["exif-sooc 2.0.0.0", "0"],
      ["unknown 2.0.0", "0"],
      ["exif-sooc 2.0.0\nwarning", "0"],
      ["garbled", "0"],
    ]) {
      const result = shell("require-exif-sooc.sh", [], { SOOC_VERSION: version, SOOC_STATUS: status });
      assert.equal(result.status, 1, `${version} / ${status}: ${result.stderr}`);
      assert.match(result.stderr, /refusing metadata writes/);
    }
  });
});

test("tools:check still refuses missing or contradictory minimum-version guards", async () => {
  await fixture(async ({ root, put, read }) => {
    const declaration = JSON.parse(await readFile(new URL("../../config/tools.json", import.meta.url), "utf8"));
    for (const tool of declaration.tools) tool.path = `absent/${tool.bin}`;
    await put("config/tools.json", JSON.stringify(declaration));
    await put("CLAUDE.md", declaration.tools.map((t) => t.bin).join("\n"));
    await put("docs/MAINTENANCE.md", "fixture");
    await put("tools/check-tools.ts", await readFile(new URL("../check-tools.ts", import.meta.url), "utf8"));
    await put("tools/lib/repo-files.ts", await readFile(new URL("../lib/repo-files.ts", import.meta.url), "utf8"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
    const cli = () =>
      spawnSync(process.execPath, [path.join(root, "tools/check-tools.ts")], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
        timeout: 10_000,
      });
    const good = cli();
    assert.equal(good.status, 0, good.stderr);
    const file = "tools/photos/require-exif-sooc.sh";
    const guard = await read(file);
    await put(file, guard.replace("EXIF_SOOC_MIN=0.4.0", "EXIF_SOOC_MIN=0.1.0"));
    const mismatch = cli();
    assert.equal(mismatch.status, 1, mismatch.stderr);
    assert.match(mismatch.stderr, /floors exif-sooc at 0\.1\.0 while config\/tools.json declares 0\.4\.0/);
    await put(file, guard.replace("EXIF_SOOC_MIN=0.4.0", ""));
    const missing = cli();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /minimum-version scanner matched 0 guards/);
    assert.match(missing.stderr, /no script enforces it/);
  });
});
