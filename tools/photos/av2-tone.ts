// av2-tone.ts: where the site finds its AV2 encoder and decoder builds.
//
// The AV2 tooling (the pinned libavif + AVM build, the tuned encoder patches,
// the WebAssembly decoder, GDF on Metal) lives in github.com/oddharsh/av2-tone,
// which package.json pins by full commit the way it pins timbrado. bun installs
// it under node_modules/.bun/av2-tone@…+<sha>/, a directory per commit, so a
// pin bump gets a fresh build without anyone clearing a cache. The builds are
// local and on demand: `bun run av2:build` makes encoder/build (pristine) and
// encoder/build/tuned (the patched encoder) inside the installed package.
//
// What stays in this repository is this repository's: the probes that score
// AV2 against the shipped AVIF, gen-pixel-peeper's format axis, and av2-wasm's
// samples.ts and expect.ts, which read and write public/garage/av2.
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");

/** The installed av2-tone checkout. */
export const AV2_TONE = path.join(REPO, "node_modules", "av2-tone");
/** Pristine libavif + AVM 1.0.0: avifenc, avifdec, and the AVM source under _deps. */
export const AV2_BUILD = path.join(AV2_TONE, "encoder", "build");
/** The tuned encoder: av2-tone's encoder patches plus AVM's AVX2 kernels through SIMDe. */
export const AV2_TUNED_BUILD = path.join(AV2_BUILD, "tuned");
/** What to run when a build is missing. */
export const AV2_BUILD_COMMAND = "bun run av2:build";
