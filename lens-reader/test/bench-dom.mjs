// node lens-reader/test/bench-dom.mjs /absolute/path/to/baseline [pairs]
// Offline parse -> control census -> Readability -> Markdown, alternating order.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Readability from '@mozilla/readability/Readability.js';
import { parseHTML } from '../src/dom.ts';
import { toMarkdown, collectControlLabels } from '../src/reader.ts';

const baselineRoot = resolve(process.argv[2]);
const pairs = Number(process.argv[3] || 15);
assert.ok(Number.isInteger(pairs) && pairs >= 3);
const candidateRoot = fileURLToPath(new URL('../../', import.meta.url));
const baseDom = await import(pathToFileURL(resolve(baselineRoot, 'lens-reader/src/dom.ts')).href);
const baseReader = await import(pathToFileURL(resolve(baselineRoot, 'lens-reader/src/reader.ts')).href);
const corpus = readdirSync(new URL('./corpus/', import.meta.url)).filter(n => n.endsWith('.html.br')).sort()
  .map(name => ({ name, html: brotliDecompressSync(readFileSync(new URL(`./corpus/${name}`, import.meta.url))).toString() }));
const sides = {
  baseline: { parse: baseDom.parseHTML, markdown: baseReader.toMarkdown, controls: baseReader.collectControlLabels },
  candidate: { parse: parseHTML, markdown: toMarkdown, controls: collectControlLabels },
};
function sweep(side) {
  return corpus.map(({ html }) => {
    const { document } = side.parse(html);
    const labels = side.controls(document);
    let node;
    const article = new Readability(document, { charThreshold: 500, serializer(el) { node = el; return el.innerHTML; } }).parse() || {};
    return { ...article, markdown: side.markdown(node || String(article.content || '')), controls: labels === null ? null : [...labels].sort() };
  });
}
assert.deepEqual(sweep(sides.candidate), sweep(sides.baseline));
for (let i = 0; i < 4; i++) { sweep(sides.baseline); sweep(sides.candidate); }
const samples = { baseline: [], candidate: [] };
for (let i = 0; i < pairs; i++) {
  for (const name of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const start = performance.now(); sweep(sides[name]); samples[name].push(performance.now() - start);
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const base = median(samples.baseline), candidate = median(samples.candidate);
const revision = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceHash = root => createHash('sha256').update(readFileSync(resolve(root, 'lens-reader/src/dom.ts'))).digest('hex');
console.log(JSON.stringify({ runtime: process.version, baseline: revision(baselineRoot), candidate: revision(candidateRoot), documents: corpus.length,
  domSha256: { baseline: sourceHash(baselineRoot), candidate: sourceHash(candidateRoot) },
  bytes: corpus.reduce((n, x) => n + Buffer.byteLength(x.html), 0), pairs, parity: 'all article fields, Markdown, controls',
  medianMs: { baseline: base, candidate }, improvementPercent: 100 * (base - candidate) / base, samples }, null, 2));
