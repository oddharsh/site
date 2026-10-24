// ── the Photos job tests zenc against the libavif the owner records ──────────
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// zenc's parity test compares its AVIF bytes with the avifenc on PATH, so it's
// only as right as that CLI. The job used to take libavif from apt, and when
// ubuntu-latest moved to 26.04 on 2026-10-21 that became 1.3.0, whose avifenc
// writes gray PNGs ~4x dark (gotcha 84). The job now builds the version
// config/tools.json records, statically, so neither the image nor the loader
// picks the oracle. This fails if the tag and the record part, or if the
// distro's libavif comes back.

/** `libavif X.Y.Z` from a tools.json `recorded` string, or null. */
export function recordedLibavif(recorded: string): string | null {
  return /\blibavif (\d+\.\d+\.\d+)\b/.exec(recorded)?.[1] ?? null;
}

/** The `LIBAVIF_TAG: vX.Y.Z` a workflow pins, without the `v`, or null. */
export function workflowLibavif(yml: string): string | null {
  return /^\s+LIBAVIF_TAG: v(\d+\.\d+\.\d+)\s*$/m.exec(yml)?.[1] ?? null;
}

test("photos: the job builds the libavif config/tools.json records for zenc", async () => {
  const tools = JSON.parse(await readFile(new URL("config/tools.json", ROOT), "utf8"));
  const zencAvif = tools.tools.find((t: { bin: string }) => t.bin === "zenc-avif");
  assert.ok(zencAvif, "config/tools.json no longer declares zenc-avif");
  const recorded = recordedLibavif(zencAvif.recorded);
  assert.ok(recorded, `could not read a libavif version from zenc-avif's recorded "${zencAvif.recorded}"`);

  const job = await readFile(new URL(".github/workflows/photos.yml", ROOT), "utf8");
  assert.equal(
    workflowLibavif(job),
    recorded,
    "photos.yml's LIBAVIF_TAG must match the libavif config/tools.json records for zenc-avif; move both, and LIBAVIF_COMMIT with them",
  );
  assert.match(job, /^\s+LIBAVIF_COMMIT: [0-9a-f]{40}\s*$/m, "a tag can move; pin the commit it should resolve to");

  // The distro's package is the trap itself, not a fallback.
  assert.doesNotMatch(job, /apt-get install[^\n]*\blibavif-(dev|bin)\b/, "the job installs the distro's libavif again (gotcha 84)");
  // A shared build loses to the image's libavif.so.16 in the loader cache.
  assert.match(job, /-DBUILD_SHARED_LIBS=OFF/, "libavif must build static so the image's shared library can't load instead");
  assert.match(job, /LIBAVIF_STATIC=1/, "zenc must link the static libavif");
  // Both binaries prove which library they run, so a silent swap fails here.
  assert.match(job, /avifenc" --version \| grep -F "Version: \$\{LIBAVIF_TAG#v\} "/, "the job no longer checks avifenc's libavif version");
  assert.match(job, /-- --avif-version \| grep -F "libavif \$\{LIBAVIF_TAG#v\} "/, "the job no longer checks zenc's libavif version");
});

test("photos: the version readers see a mismatch and a missing value", () => {
  assert.equal(recordedLibavif("libavif 1.4.2, aom 3.15.1"), "1.4.2");
  assert.equal(recordedLibavif("aom 3.15.1"), null);
  assert.equal(workflowLibavif("    env:\n      LIBAVIF_TAG: v1.4.2\n"), "1.4.2");
  assert.equal(workflowLibavif("    env:\n      LIBAVIF_TAG: main\n"), null);
  assert.notEqual(workflowLibavif("      LIBAVIF_TAG: v1.3.0\n"), recordedLibavif("libavif 1.4.2, aom 3.15.1"));
});
