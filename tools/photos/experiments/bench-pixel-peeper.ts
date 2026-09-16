// bun tools/photos/experiments/bench-pixel-peeper.ts BASELINE_REPO CANDIDATE_REPO [PAIRS=3]
// The actual generator's full eight-original tradeoff pass: source decode, crop
// selection, encoding, search, scoring, ranking and temporary contact sheets.
// --only implies --dry-run; published assets stay put. Do not benchmark in parallel.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [baseline,candidate] = process.argv.slice(2,4).map(p => resolve(p));
const pairs = Number(process.argv[4] || 3);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
type Kind = "baseline" | "candidate";
const samples: Record<Kind, number[]> = { baseline:[], candidate:[] };
let expected: { tileSha256: Record<string,string>; report:string } | undefined;
const root = mkdtempSync(join(tmpdir(),"site-peeper-batch-"));
try {
  for (let pair=0; pair<pairs; pair++) {
    const order: Kind[] = pair%2 ? ["candidate","baseline"] : ["baseline","candidate"];
    for (const kind of order) {
      const repo = kind === "baseline" ? baseline : candidate;
      const sheet = join(root,`${kind}-${pair}.html`);
      // Redirect only this child's stderr into its own temporary log: the
      // generator reports there, and execFileSync's return is stdout alone.
      const logPath = join(root,`${kind}-${pair}.log`);
      const fd = openSync(logPath,"w");
      const start = performance.now();
      try { execFileSync(process.execPath,["tools/photos/gen-pixel-peeper.ts","--only","tradeoff","--sheet",sheet], {cwd:repo,stdio:["ignore","pipe",fd]}); }
      finally { closeSync(fd); }
      samples[kind].push(performance.now()-start);
      const log = readFileSync(logPath,"utf8");
      assert.ok(!log.includes("source:") && !log.includes("Error:"),log);
      assert.ok(log.includes("--dry-run: no tiles or manifest written"),log);
      const files = readdirSync(`${sheet}.tiles`).filter(p => p.endsWith(".jpg")).sort();
      assert.equal(files.length,6,log);
      const tileSha256 = Object.fromEntries(files.map(p => [p,createHash("sha256").update(readFileSync(join(`${sheet}.tiles`,p))).digest("hex")]));
      const report = log.split(/\r?\n/).filter(line => !line.startsWith("contact sheet:")).join("\n").trim();
      const actual = {tileSha256,report};
      if (expected === undefined) expected = actual;
      else assert.deepEqual(actual,expected,`${kind} pair ${pair+1}`);
    }
    console.error(`Generator pair ${pair+1}/${pairs}: ${samples.baseline[pair].toFixed(1)} / ${samples.candidate[pair].toFixed(1)} ms`);
  }
  const median = (v:number[]) => { const s = [...v].sort((a,b)=>a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2; };
  const medians = {baseline:median(samples.baseline),candidate:median(samples.candidate)};
  console.log(JSON.stringify({pairs,axis:"tradeoff",configuredOriginals:8,retainedTrials:3,samplesMs:samples,medianMs:medians,
    improvementPercent:100*(1-medians.candidate/medians.baseline),parity:expected},null,2));
} finally { rmSync(root,{recursive:true,force:true}); }
