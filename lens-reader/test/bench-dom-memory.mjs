// node --expose-gc lens-reader/test/bench-dom-memory.mjs WORKTREE_ROOT
// Run baseline and candidate in separate, alternating processes. Each sample
// includes fifteen sweeps; report the median of five samples for each side.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const gc = global.gc;
assert.ok(gc, 'run Node with --expose-gc');
const root = resolve(process.argv[2]);
const { default: Readability } = await import(pathToFileURL(resolve(root, 'lens-reader/node_modules/@mozilla/readability/Readability.js')).href);
const { parseHTML } = await import(pathToFileURL(resolve(root, 'lens-reader/src/dom.ts')).href);
const { collectControlLabels, toMarkdown } = await import(pathToFileURL(resolve(root, 'lens-reader/src/reader.ts')).href);
const directory = resolve(root, 'lens-reader/test/corpus');
const corpus = readdirSync(directory).filter(name => name.endsWith('.html.br')).sort()
  .map(name => brotliDecompressSync(readFileSync(resolve(directory, name))).toString());
let checksum = 0;
for (let sweep = 0; sweep < 15; sweep++) for (const html of corpus) {
  const { document } = parseHTML(html);
  collectControlLabels(document);
  let node;
  const article = new Readability(document, { charThreshold: 500, serializer(el) { node = el; return el.innerHTML; } }).parse() || {};
  checksum += toMarkdown(node || String(article.content || '')).length;
}
gc();
console.log(JSON.stringify({ runtime: process.version, documents: corpus.length, sweeps: 15, checksum,
  maxRSSKiB: process.resourceUsage().maxRSS, heapUsedBytes: process.memoryUsage().heapUsed }));
