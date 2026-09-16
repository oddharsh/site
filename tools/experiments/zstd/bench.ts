// bun tools/experiments/zstd/bench.ts BASELINE_ROOT NATIVE_BINARY [pairs]
// The caller builds BASELINE_ROOT with the pinned runtime first. This uses its
// real staged pages and committed dictionaries; nothing is written to the repo.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { zstdCompressDictionaryBatch } from '../../lib/zstd-batch.ts';

const root = resolve(process.argv[2]);
const binary = resolve(process.argv[3]);
const pairs = Number(process.argv[4] || 9);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
const served = resolve(root, '.build/public');
const dictFiles = readdirSync(resolve(served, 'a')).filter(n => /^page-family\.[a-f0-9]+\.dict$/.test(n));
assert.equal(dictFiles.length, 1, 'expected exactly one served family dictionary');
const dictionary = readFileSync(resolve(served, 'a', dictFiles[0]));
const pages = readdirSync(served, { recursive: true }).map(String).filter(p => p.endsWith('.html') && !p.endsWith('.src.html')).sort();
assert.ok(pages.length >= 50, 'built page corpus collapsed');
const family = pages.map(name => ({ name, bytes: readFileSync(resolve(served, name)), dictionary }));
const perPage: typeof family = [];
const snapshots = readdirSync(resolve(root, 'src/dict/p-dict')).sort();
for (const page of family) {
  const slug = page.name.replace(/\.html$/, '').replaceAll('/', '__');
  for (const name of snapshots.filter(n => n.startsWith(`${slug}.`) && n.endsWith('.html.br'))) {
    perPage.push({ ...page, dictionary: brotliDecompressSync(readFileSync(resolve(root, 'src/dict/p-dict', name))) });
  }
}
const workers = Math.min(8, availableParallelism());
for (const malformed of [Buffer.alloc(0), Buffer.alloc(8), Buffer.from([1, 0, 0, 0, 1, 0, 0, 0])]) {
  const refused = spawnSync(binary, ['reuse', '1'], { input: malformed });
  assert.equal(refused.status, 1, 'malformed native input must fail');
  assert.equal(refused.stdout.length, 0, 'malformed input must publish no frames');
}
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
function input(jobs) {
  const dicts = new Map();
  for (const job of jobs) { const key = createHash('sha256').update(job.dictionary).digest('hex'); if (!dicts.has(key)) dicts.set(key, job.dictionary); }
  const keys = [...dicts.keys()];
  return Buffer.concat([u32(dicts.size), u32(jobs.length), ...[...dicts.values()].flatMap(b => [u32(b.length), b]),
    ...jobs.flatMap(job => [u32(keys.indexOf(createHash('sha256').update(job.dictionary).digest('hex'))), u32(job.bytes.length), job.bytes])]);
}
function native(jobs, method) {
  // Serialize INSIDE the timing, including process launch and dictionary setup.
  const run = spawnSync(binary, [method, String(workers)], { input: input(jobs), maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  assert.equal(run.status, 0, String(run.stderr));
  const frames: Buffer[] = []; let offset = 0;
  for (let i = 0; i < jobs.length; i++) {
    assert.ok(offset + 4 <= run.stdout.length, 'missing frame length');
    const length = run.stdout.readUInt32LE(offset); offset += 4;
    assert.ok(offset + length <= run.stdout.length, 'truncated frame');
    const frame = run.stdout.subarray(offset, offset + length); offset += length;
    frames.push(frame);
  }
  assert.equal(offset, run.stdout.length, 'trailing output');
  return frames;
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = {};
for (const [label, jobs] of Object.entries({ family, perPage })) {
  assert.ok(jobs.length > 0);
  const expected = await zstdCompressDictionaryBatch(jobs);
  const checks = {};
  for (const method of ['reuse', 'prepared']) {
    const frames = native(jobs, method);
    for (let i = 0; i < jobs.length; i++) assert.deepEqual(zstdDecompressSync(frames[i], { dictionary: jobs[i].dictionary }), jobs[i].bytes);
    checks[method] = { identical: frames.filter((f, i) => f.equals(expected[i])).length, frames: frames.length,
      baselineBytes: expected.reduce((n, b) => n + b.length, 0), candidateBytes: frames.reduce((n, b) => n + b.length, 0) };
    assert.equal(checks[method].identical, frames.length, `${method} changed compressed output`);
  }
  const samples = { baseline: [], reuse: [], prepared: [] };
  for (let trial = 0; trial < pairs; trial++) {
    for (const method of trial % 2 ? ['prepared', 'reuse', 'baseline'] : ['baseline', 'reuse', 'prepared']) {
      const start = performance.now();
      if (method === 'baseline') await zstdCompressDictionaryBatch(jobs); else native(jobs, method);
      samples[method].push(performance.now() - start);
    }
  }
  results[label] = { jobs: jobs.length, checks, medianMs: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)])), samples };
  console.error(`${label}: ${JSON.stringify(results[label].medianMs)}; ${JSON.stringify(checks)}`);
}
console.log(JSON.stringify({ runtime: process.version, bun: process.versions.bun, runtimeZstd: process.versions.zstd,
  nativeZstd: String(spawnSync(binary, ['--version']).stdout).trim(), workers, pairs, results }, null, 2));
