// bake.ts: record each clip that ships and encode it at its measured knobs
// into public/og/video/, the files lib/og-video.ts hands to preview bots.
//
//   bun tools/photos/og-video/bake.ts [clip-id,...]
//
// Records against PRODUCTION (OG_BASE overrides), like gen-og-cards.ts, so the
// clip is the live demo. macOS only: HEVC comes from VideoToolbox through
// encode.swift, which is also what an iPhone decodes it with. AV1 is aomenc.
// To re-pick the knobs, record with record.ts and run compare.ts.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLIPS } from "./clips.ts";
import { av1Flags } from "./encoders.ts";
import { recordClips } from "./record.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(HERE, "../../../public/og/video");
const CARDS = path.resolve(HERE, "../../../public/og");
// The cards' own encoder and settings (gen-og-cards.ts writeCard has the
// measurement behind q92 at 4:4:4).
const ZENC = path.resolve(HERE, "../zenc/target/release/zenc");
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const ship = CLIPS.flatMap((c) => (c.ship && (!only || only.has(c.id)) ? [{ ...c, ship: c.ship }] : []));
if (!ship.length) throw new Error("no shipping clip matched");

const tmp = mkdtempSync(path.join(tmpdir(), "og-video-"));
try {
  await $`swiftc -O -suppress-warnings ${path.join(HERE, "encode.swift")} -o ${path.join(tmp, "encode")}`;
  await $`swiftc -O -suppress-warnings ${path.join(HERE, "y4m.swift")} -o ${path.join(tmp, "y4m")}`;
  const recorded = new Set(await recordClips(tmp, new Set(ship.map((c) => c.id))));
  await $`mkdir -p ${OUT}`;
  for (const c of ship) {
    if (!recorded.has(c.id)) throw new Error(`${c.id} did not record; nothing written for it`);
    const frames = path.join(tmp, c.id, "frames");
    const hevc = path.join(OUT, `${c.ship.card}.hevc.mp4`);
    const av1 = path.join(OUT, `${c.ship.card}.av1.webm`);
    // Encoded in tmp and copied out: shouldOptimizeForNetworkUse leaves its
    // pre-rewrite copy beside the output as <name>.sb-<hex>, and it stays.
    const staged = path.join(tmp, `${c.ship.card}.hevc.mp4`);
    await $`${path.join(tmp, "encode")} ${frames} ${staged} hevc 30 ${c.ship.hevc}`.quiet();
    copyFileSync(staged, hevc);
    await $`${path.join(tmp, "y4m")} ${frames} 30 > ${path.join(tmp, "clip.y4m")}`.quiet();
    await $`aomenc ${av1Flags(c.ship.av1)} -o ${av1} ${path.join(tmp, "clip.y4m")}`.quiet();
    const kb = (f: string) => `${Math.round(statSync(f).size / 1024)} KB`;
    let poster = "";
    if (c.ship.poster) {
      if (!existsSync(ZENC)) throw new Error("zenc is not built: cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml");
      const jpg = path.join(CARDS, `${c.ship.card}.jpg`);
      await $`${ZENC} ${path.join(frames, "f0000.png")} ${jpg} -q 92 --yuv 444`.quiet();
      poster = `  poster ${kb(jpg)}`;
    }
    console.log(`  ${c.ship.card}  hevc ${kb(hevc)}  av1 ${kb(av1)}${poster}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
