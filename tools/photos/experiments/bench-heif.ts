// bun tools/photos/experiments/bench-heif.ts BASELINE_ZENC HEIF_EXAMPLE SOURCE_DIR [PAIRS=5] [TIFF_CANDIDATE]
// macOS workstation experiment. Only temporary outputs; normal ImageIO execution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.argv.length >= 5 && process.argv.length <= 7, "expected BASELINE_ZENC HEIF_EXAMPLE SOURCE_DIR [PAIRS=5] [TIFF_CANDIDATE]");
const [baseline, candidate, sources] = process.argv.slice(2, 5).map(p => resolve(p));
const tiffCandidate = process.argv[6] ? resolve(process.argv[6]) : undefined;
const pairs = Number(process.argv[5] || 5);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
if (tiffCandidate) assert.equal(pairs % 6, 0, "three-path runs need a multiple of six pairs to balance every order");
const inputs = [["XT500010.HIF", "8"], ["XT509986.HIF", "1"]] as const;
const files = ["600.jpg", "600.avif", "400.avif", "200.avif"];
const root = mkdtempSync(join(tmpdir(), "site-heif-"));
const run = (args: (string | number)[]) => execFileSync(String(args[0]), args.slice(1).map(String), { stdio: ["ignore", "pipe", "pipe"] });
const median = (v: number[]) => { const s = [...v].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2; };
type Kind = "baseline" | "candidate" | "tiffCandidate";
const kinds: Kind[] = tiffCandidate ? ["baseline", "candidate", "tiffCandidate"] : ["baseline", "candidate"];
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
    const command: (string | number)[] = [kind === "tiffCandidate" ? tiffCandidate! : baseline, "square", tiff, "--orient", orient, "--filter", "box"];
    for (const size of [600,400,200]) {
      command.push("--size", size, "--avif-out", join(out, `${size}.avif`));
      if (size === 600) command.push("--jpeg-out", join(out, "600.jpg"), "--jpeg-quality", 84);
    }
    run(command);
    unlinkSync(tiff);
  }
}
function parity() {
  for (const [name] of inputs) for (const file of files) for (const kind of kinds.slice(1)) {
    assert.deepEqual(readFileSync(join(root,"baseline",name,file)), readFileSync(join(root,kind,name,file)), `${kind} ${name} ${file}`);
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
    for (const kind of kinds) tiers(kind,name,orient);
  }
  parity();
  const samples: Record<Kind, number[]> = { baseline:[], candidate:[], tiffCandidate:[] };
  const orders: Kind[][] = tiffCandidate ? [
    ["baseline","candidate","tiffCandidate"], ["tiffCandidate","candidate","baseline"],
    ["candidate","tiffCandidate","baseline"], ["baseline","tiffCandidate","candidate"],
    ["tiffCandidate","baseline","candidate"], ["candidate","baseline","tiffCandidate"],
  ] : [["baseline","candidate"],["candidate","baseline"]];
  for (let pair=0; pair<pairs; pair++) {
    const order = orders[pair % orders.length];
    for (const kind of order) {
      const start = performance.now();
      for (const [name,orient] of inputs) tiers(kind,name,orient);
      samples[kind].push(performance.now()-start);
    }
    console.error(`HEIF pair ${pair+1}/${pairs}: ${kinds.map(kind => `${kind}=${samples[kind][pair].toFixed(1)}`).join(" / ")} ms`);
    parity();
  }
  const medians: { baseline:number; candidate:number; tiffCandidate?:number } = { baseline:median(samples.baseline), candidate:median(samples.candidate) };
  const comparisons: Record<string,number> = { improvementPercent:100*(1-medians.candidate/medians.baseline) };
  if (tiffCandidate) {
    medians.tiffCandidate = median(samples.tiffCandidate);
    comparisons.tiffImprovementPercent = 100*(1-medians.tiffCandidate/medians.baseline);
    comparisons.nativeVsOptimizedTiffPercent = 100*(1-medians.candidate/medians.tiffCandidate);
  }
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  console.log(JSON.stringify({ pairs, decoded, orientations:Object.fromEntries(inputs), tierFilesEqual:inputs.length*files.length,
    provenance: {
      bun: Bun.revision, macOS:run(["sw_vers","-productVersion"]).toString().trim(),
      build:run(["sw_vers","-buildVersion"]).toString().trim(), arch:process.arch,
      binaries: Object.fromEntries(kinds.map(kind => [kind, sha256(kind === "baseline" ? baseline : kind === "candidate" ? candidate : tiffCandidate!)])),
      inputs: Object.fromEntries(inputs.map(([name]) => [name,sha256(join(sources,name))])),
    },
    orders, samplesMs:Object.fromEntries(kinds.map(kind => [kind,samples[kind]])),
    medianMs:medians, ...comparisons,
  },null,2));
} finally { rmSync(root,{recursive:true,force:true}); }
