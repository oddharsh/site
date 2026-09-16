// bun tools/photos/experiments/bench-heif.ts BASELINE_ZENC HEIF_EXAMPLE SOURCE_DIR [PAIRS=5]
// macOS workstation experiment. Only temporary outputs; normal ImageIO execution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [baseline, candidate, sources] = process.argv.slice(2, 5).map(p => resolve(p));
const pairs = Number(process.argv[5] || 5);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
const inputs = [["XT500010.HIF", "8"], ["XT509986.HIF", "1"]] as const;
const files = ["600.jpg", "600.avif", "400.avif", "200.avif"];
const root = mkdtempSync(join(tmpdir(), "site-heif-"));
const run = (args: (string | number)[]) => execFileSync(String(args[0]), args.slice(1).map(String), { stdio: ["ignore", "pipe", "pipe"] });
const median = (v: number[]) => [...v].sort((a,b) => a-b)[Math.floor(v.length / 2)];
type Kind = "baseline" | "candidate";
function tiers(kind: Kind, name: string, orient: string) {
  const out = join(root, kind, name);
  mkdirSync(out, { recursive: true });
  const source = join(sources, name);
  if (kind === "candidate") run([candidate, "tiers", source, out, orient]);
  else {
    const tiff = join(out, "lossless.tif");
    run(["sips", "-s", "format", "tiff", source, "--out", tiff]);
    // sips can exit zero with an empty TIFF in an App Sandbox. A failed real
    // decode below is an error, never a timing win.
    const command: (string | number)[] = [baseline, "square", tiff, "--orient", orient, "--filter", "box"];
    for (const size of [600,400,200]) {
      command.push("--size", size, "--avif-out", join(out, `${size}.avif`));
      if (size === 600) command.push("--jpeg-out", join(out, "600.jpg"), "--jpeg-quality", 84);
    }
    run(command);
    unlinkSync(tiff);
  }
}
function parity() {
  for (const [name] of inputs) for (const file of files) {
    assert.deepEqual(readFileSync(join(root,"baseline",name,file)), readFileSync(join(root,"candidate",name,file)), `${name} ${file}`);
  }
}
try {
  const decoded: Record<string, unknown>[] = [];
  for (const [name, orient] of inputs) {
    const tiff = join(root, `${name}.tif`);
    run(["sips", "-s", "format", "tiff", join(sources,name), "--out", tiff]);
    const result = JSON.parse(run([candidate,"compare",join(sources,name),tiff]).toString()) as Record<string, unknown>;
    assert.equal(result.rgba16Equal, true);
    decoded.push({ input:name, tiffBytes:statSync(tiff).size, ...result });
    unlinkSync(tiff);
    tiers("baseline",name,orient); tiers("candidate",name,orient);
  }
  parity();
  const samples: Record<Kind, number[]> = { baseline:[], candidate:[] };
  for (let pair=0; pair<pairs; pair++) {
    const order: Kind[] = pair % 2 ? ["candidate","baseline"] : ["baseline","candidate"];
    for (const kind of order) {
      const start = performance.now();
      for (const [name,orient] of inputs) tiers(kind,name,orient);
      samples[kind].push(performance.now()-start);
    }
    console.error(`HEIF pair ${pair+1}/${pairs}: ${samples.baseline[pair].toFixed(1)} / ${samples.candidate[pair].toFixed(1)} ms`);
    parity();
  }
  const medians = { baseline:median(samples.baseline), candidate:median(samples.candidate) };
  console.log(JSON.stringify({ pairs, decoded, orientations:Object.fromEntries(inputs), tierFilesEqual:inputs.length*files.length,
    samplesMs:samples, medianMs:medians, improvementPercent:100*(1-medians.candidate/medians.baseline) },null,2));
} finally { rmSync(root,{recursive:true,force:true}); }
