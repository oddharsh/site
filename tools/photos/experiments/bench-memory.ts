// bun tools/photos/experiments/bench-memory.ts BASELINE_ZENC CANDIDATE [pairs] [source-dir]
// Only mkdtemp output is written. Six committed images make the experiment
// reproducible. An optional source directory also measures original decoding.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, parse } from 'node:path';
import { execFileSync } from 'node:child_process';
const baseline = resolve(process.argv[2]), candidate = resolve(process.argv[3]);
const pairs = Number(process.argv[4] || 5);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
const hashes = JSON.parse(readFileSync('public/images/hashes.json', 'utf8'));
// An explicit finite sample lets callers repeat a subset when a baseline
// decode fails. The chosen stems are always printed; failures never skip rows.
const stems = (process.env.PHOTO_BENCH_STEMS || 'L1000069_3,L1009919_2,L1009920,XT500010,XT507831,XT509986').split(',');
for (const stem of stems) assert.ok(Object.hasOwn(hashes, stem), `unknown committed photo ${stem}`);
const inputs = stems.map(stem => resolve(`public/i/${stem}.${hashes[stem].j}.jpg`));
const orientations = stems.map(() => '1');
const decodedFormats = stems.map(() => 'JPEG');
const sourceDir = process.argv[5] ? resolve(process.argv[5]) : null;
const root = mkdtempSync(join(tmpdir(), 'photo-memory-'));
const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function baselineTiers(input, out, orientation) {
  mkdirSync(out, { recursive: true });
  run(baseline, ['square', input, '--orient', orientation, '--filter', 'box', '--size', '600', '--out', join(out, '600.png'),
    '--jpeg-out', join(out, '600.jpg'), '--jpeg-quality', '84', '--size', '400', '--out', join(out, '400.png'), '--size', '200', '--out', join(out, '200.png')]);
  for (const size of [600, 400, 200]) {
    const png = join(out, `${size}.png`);
    const space = String(run('sips', ['-g', 'space', png]));
    const yuv = /space:\s*Gray/.test(space) ? '400' : '420';
    run('avifenc', ['-q', '63', '-d', '10', '--ignore-icc', '--ignore-exif', '--ignore-xmp', '--speed', '2', '--jobs', '4', '--yuv', yuv, png, join(out, `${size}.avif`)]);
  }
}
function candidateTiers(input, out, orientation) { run(candidate, ['tiers', input, out, orientation]); }
const files = ['600.jpg', '600.avif', '400.avif', '200.avif'];
type Samples = { baseline: number[]; candidate: number[] };
const samples: Samples = { baseline: [], candidate: [] };
const qualities = [95, 82, 88, 91, 93];
const jpegSamples: Samples = { baseline: [], candidate: [] };
try {
  if (sourceDir) {
    const sources = readdirSync(sourceDir);
    for (let i = 0; i < stems.length; i++) {
      const matches = sources.filter(name => parse(name).name === stems[i] && /\.(jpe?g|hif|heic|heif)$/i.test(name));
      assert.equal(matches.length, 1, `expected one source for ${stems[i]}`);
      const source = join(sourceDir, matches[0]);
      // The ingest script treats an absent Orientation tag as upright too.
      const orientation = String(run('exif-sooc', ['-s', '-s', '-s', '-n', '-Orientation', source])).trim() || '1';
      assert.match(orientation, /^[1-8]$/, 'source must declare orientation');
      orientations[i] = orientation;
      if (/\.(hif|heic|heif)$/i.test(source)) {
        // A shared, untimed preparation step; both candidates still read and
        // decode the same lossless TIFF through production load_linear.
        inputs[i] = join(root, `${stems[i]}.tiff`);
        decodedFormats[i] = 'TIFF prepared from HEIF';
        run('sips', ['-s', 'format', 'tiff', source, '--out', inputs[i]]);
      } else inputs[i] = source;
    }
  }
  // Correctness is outside the timed region and checks every byte, not quality proxies.
  for (let i = 0; i < inputs.length; i++) {
    const b = join(root, `b${i}`), c = join(root, `c${i}`);
    baselineTiers(inputs[i], b, orientations[i]); candidateTiers(inputs[i], c, orientations[i]);
    for (const file of files) assert.deepEqual(readFileSync(join(c, file)), readFileSync(join(b, file)), `${stems[i]} ${file}`);
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const name of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now();
      for (let i = 0; i < inputs.length; i++) (name === 'baseline' ? baselineTiers : candidateTiers)(inputs[i], join(root, name + i), orientations[i]);
      samples[name].push(performance.now() - start);
    }
    console.error(`tiers pair ${pair + 1}/${pairs}: ${samples.baseline[pair].toFixed(1)} / ${samples.candidate[pair].toFixed(1)} ms`);
  }
  // Isolate reference decode/process reuse across fixed quality trials. This is
  // not an adaptive quality search and excludes SSIMULACRA2/Butteraugli cost.
  for (let pair = 0; pair < pairs; pair++) {
    for (const name of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now();
      for (let i = 0; i < inputs.length; i++) {
        const reference = join(root, `b${i}`, '600.png');
        const out = join(root, `jpeg-${name}${i}`); mkdirSync(out, { recursive: true });
        if (name === 'candidate') run(candidate, ['jpeg-batch', reference, out, ...qualities.map(String)]);
        else for (const q of qualities) run(baseline, [reference, join(out, `${q}.jpg`), '-q', String(q), '--yuv', '420']);
      }
      jpegSamples[name].push(performance.now() - start);
    }
  }
  for (let i = 0; i < inputs.length; i++) for (const q of qualities) {
    assert.deepEqual(readFileSync(join(root, `jpeg-candidate${i}`, `${q}.jpg`)), readFileSync(join(root, `jpeg-baseline${i}`, `${q}.jpg`)));
  }
  const summarize = (rows: Samples) => ({ medianMs: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, median(v)])),
    improvementPercent: 100 * (median(rows.baseline) - median(rows.candidate)) / median(rows.baseline), samples: rows });
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, pairs, inputs: stems, orientations,
    inputKind: sourceDir ? 'full-resolution originals; shared HEIF-to-TIFF preparation excluded' : 'committed JPEG tiles', decodedFormats,
    avifenc: String(run('avifenc', ['--version'])).trim(), parity: { tierFiles: inputs.length * files.length, jpegFiles: inputs.length * qualities.length },
    tiers: summarize(samples), jpegTrials: summarize(jpegSamples) }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
