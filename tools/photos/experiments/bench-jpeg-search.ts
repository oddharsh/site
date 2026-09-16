// bun tools/photos/experiments/bench-jpeg-search.ts BASELINE_ZENC CANDIDATE_ZENC [PAIRS=5]
// Six committed photographs -> 320px PNG references, three chroma layouts.
// Adaptive search plus unchanged decode + SSIMULACRA2 + Butteraugli scoring.
// Temporary outputs only; no network or concurrently running benchmarks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [baseline,candidate] = process.argv.slice(2,4).map(p=>resolve(p));
const pairs = Number(process.argv[4] || 5);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
const stems = ["L1000069_3","L1009919_2","L1009920","XT500010","XT507831","XT509986"];
const hashes = JSON.parse(readFileSync("public/images/hashes.json","utf8")) as Record<string,{j:string}>;
const run = (args:(string|number)[]) => execFileSync(String(args[0]),args.slice(1).map(String),{stdio:["ignore","pipe","pipe"]});
const root = mkdtempSync(join(tmpdir(),"site-jpeg-search-"));
type Kind = "baseline" | "candidate";
type Best = {result:{q:number;bytes:number}; data:Buffer};
function search(kind:Kind,png:string,chroma:string,target:number,lo=5,hi=100): Best {
  const out = join(root,`${kind}.jpg`);
  if (kind === "candidate") {
    const result = JSON.parse(run([candidate,"jpeg-search",png,out,target,chroma,lo,hi]).toString()) as Best["result"];
    assert.equal(result.bytes,statSync(out).size);
    copyFileSync(out,join(root,`cand-candidate-${result.q}.jpg`));
    return {result,data:readFileSync(out)};
  }
  let best:Best|null = null;
  while (lo<=hi) {
    const mid = Math.floor((lo+hi)/2);
    run([baseline,png,out,"-q",mid,"--yuv",chroma]);
    const size = statSync(out).size;
    copyFileSync(out,join(root,`cand-baseline-${mid}.jpg`));
    if (best === null || Math.abs(size-target)<Math.abs(best.result.bytes-target)) best = {result:{q:mid,bytes:size},data:readFileSync(out)};
    if (size>target) hi=mid-1;
    else if (size<target) lo=mid+1;
    else break;
  }
  assert.ok(best);
  // The real caller scores the saved winner. This normalization adds one small
  // baseline write so both arms can use the same scoring path below.
  writeFileSync(out,best.data);
  return best;
}
function score(kind:Kind,png:string): number[] {
  const decoded = join(root,`${kind}-decoded.png`);
  run([baseline,"frame",join(root,`${kind}.jpg`),"--out",decoded]);
  return ["ssimulacra2","butteraugli_main"].map(tool => {
    const output = run([tool,png,decoded]).toString();
    const match = /-?\d+\.\d+/.exec(output);
    assert.ok(match,`${tool}: ${output}`);
    return Number(match[0]);
  });
}
try {
  const cases: {stem:string;png:string;chroma:string;target:number}[] = [];
  for (const stem of stems) {
    const png = join(root,`${stem}.png`);
    run([baseline,"frame",resolve(`public/i/${stem}.${hashes[stem].j}.jpg`),"--fit",320,"--out",png]);
    for (const chroma of ["420","422","444"]) {
      const jpg = join(root,"budget.jpg");
      run([baseline,png,jpg,"-q",78,"--yuv",chroma]);
      cases.push({stem,png,chroma,target:statSync(jpg).size+17});
    }
  }
  const expected:Best[] = [];
  for (const {stem,png,chroma,target} of cases) {
    const a = search("baseline",png,chroma,target), b = search("candidate",png,chroma,target);
    assert.deepEqual(a,b,`${stem} ${chroma}`);
    assert.deepEqual(score("baseline",png),score("candidate",png));
    expected.push(a);
  }
  for (const [target,lo,hi] of [[1,5,100],[1000000,5,100],[1,1,1],[1000000,100,100],[2000,30,60]]) {
    assert.deepEqual(search("baseline",cases[0].png,"420",target,lo,hi),search("candidate",cases[0].png,"420",target,lo,hi));
  }
  type Parts = {search:number[];scoring:number[];total:number[]};
  const samples:Record<Kind,Parts> = {baseline:{search:[],scoring:[],total:[]},candidate:{search:[],scoring:[],total:[]}};
  for (let pair=0; pair<pairs; pair++) {
    const order:Kind[] = pair%2 ? ["candidate","baseline"] : ["baseline","candidate"];
    for (const kind of order) {
      let searchMs=0,scoringMs=0;
      const start=performance.now();
      for (const [index,{png,chroma,target}] of cases.entries()) {
        let t=performance.now();
        const actual=search(kind,png,chroma,target);
        searchMs+=performance.now()-t;
        assert.deepEqual(actual,expected[index],`${kind} ${pair} ${index}`);
        t=performance.now(); score(kind,png); scoringMs+=performance.now()-t;
      }
      samples[kind].total.push(performance.now()-start);
      samples[kind].search.push(searchMs); samples[kind].scoring.push(scoringMs);
    }
    console.error(`JPEG pair ${pair+1}/${pairs}: ${samples.baseline.total[pair].toFixed(1)} / ${samples.candidate.total[pair].toFixed(1)} ms`);
  }
  const median=(v:number[])=>{ const s=[...v].sort((a,b)=>a-b); return (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2; };
  const medians=Object.fromEntries(Object.entries(samples).map(([kind,parts])=>[kind,{search:median(parts.search),scoring:median(parts.scoring),total:median(parts.total)}])) as Record<Kind,{search:number;scoring:number;total:number}>;
  console.log(JSON.stringify({pairs,inputs:stems,chroma:["420","422","444"],referenceSize:320,equalSearches:cases.length,boundaryControls:5,
    samplesMs:samples,medianMs:medians,improvementPercent:{search:100*(1-medians.candidate.search/medians.baseline.search),total:100*(1-medians.candidate.total/medians.baseline.total)}},null,2));
} finally { rmSync(root,{recursive:true,force:true}); }
