// photo-metrics.ts: SSIMULACRA2 and butteraugli for the photo probes and page
// generators, from the in-tree tools/photos/photo-metrics crate (fast-ssim2 and
// imazen's butteraugli, exact pins) in one call per pair.
//
// It replaced libjxl's `ssimulacra2` and `butteraugli_main` CLIs here on
// 2026-10-31, after the callers' own outputs came back the same both ways; each
// caller names its own number beside its call. hif-archive.ts moved first
// (2026-10-14) and keeps its async copy of the build below, with a test stub.
// photo-metrics-parity.ts still runs libjxl on purpose: it is the oracle.
//
// Inputs are PNG or PNM, 8 or 16 bits. A JPEG goes through djpeg first, the
// libjpeg-turbo decode libjxl's tools read JPEG with (export-for-instagram.sh).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CRATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "photo-metrics");
let bin: string | undefined;

/** The binary, built once per process like zenc. The build runs even when a
 *  binary exists, because cargo is what checks it against the sources and lock. */
export function photoMetricsBin(): string {
  if (bin) return bin;
  const r = spawnSync("cargo", ["build", "--release", "--locked", "--quiet", "--manifest-path", path.join(CRATE, "Cargo.toml")], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) throw new Error(`cargo build of photo-metrics exited ${r.status}`);
  bin = path.join(CRATE, "target/release/photo-metrics");
  return bin;
}

/** s2 is SSIMULACRA2; ba is butteraugli's max norm, what `butteraugli_main`
 *  prints first; ba3 is its 3-norm, what `--pnorm 3` prints second. */
export type PhotoScores = { s2: number; ba: number; ba3: number };

export function photoMetrics(ref: string, img: string): PhotoScores {
  const r = spawnSync(photoMetricsBin(), [ref, img], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`photo-metrics exited ${r.status}: ${r.stderr.trim()}`);
  const scores = JSON.parse(r.stdout) as PhotoScores;
  if (![scores.s2, scores.ba, scores.ba3].every(Number.isFinite)) throw new Error(`photo-metrics printed ${r.stdout.trim()}`);
  return scores;
}
