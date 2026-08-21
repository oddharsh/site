#!/usr/bin/env node
// build-corpus.mjs — regenerate the worker's RAG corpus from per-concept files.
//
//   node pipelines/lwe/build-corpus.mjs
//
// Reads lwe-ask/corpus/<concept>.json (each: [{ text, source, title }]) and injects
// the passages into lwe-ask/src/passages.js between the generated:corpus markers,
// tagged by concept with their own source/title. The hand-written essay passages
// (fhe/mpc/tee) above the markers are left untouched.
//
// COPYRIGHT RULE: a corpus file may hold the author's own writing, the site's own
// AI-authored explanations, or republishable sources (Wikipedia with attribution,
// public-domain). NEVER third-party copyrighted text. That can only inform the
// AI-authored page copy, never the retrieval corpus.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");   // pipelines/<name>/ -> repo root
const CORPUS_DIR = join(ROOT, "lwe-ask", "corpus");
const PASSAGES_FILE = join(ROOT, "lwe-ask", "src", "passages.js");
const START = "// generated:corpus:start";
const END = "// generated:corpus:end";

const files = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json")).sort()
  : [];

let block = "";
let total = 0;
for (const file of files) {
  const concept = basename(file, ".json");
  const passages = JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8"));
  if (!Array.isArray(passages) || !passages.length) continue;
  block += `\n  // ${concept} (${passages.length})\n`;
  passages.forEach((p, i) => {
    const id = `${concept}-${i + 1}`;
    const source = p.source ? `, source: ${JSON.stringify(p.source)}` : "";
    const title = p.title ? `, title: ${JSON.stringify(p.title)}` : "";
    block += `  { id: ${JSON.stringify(id)}, concept: ${JSON.stringify(concept)}, text:\n    ${JSON.stringify(p.text)}${source}${title} },\n`;
    total++;
  });
}

const src = readFileSync(PASSAGES_FILE, "utf8");
const i = src.indexOf(START), j = src.indexOf(END);
if (i === -1 || j === -1) {
  console.error("build-corpus: markers not found in passages.js — add the generated:corpus markers first");
  process.exit(1);
}
const injected = src.slice(0, i + START.length) + "\n" + block + "  " + src.slice(j);
// recompute CORPUS_VERSION: a content hash of the corpus (excluding the version value
// itself), so any passage change bumps it and busts the ask cache on the next reindex.
const verRe = /(export const CORPUS_VERSION = ")[^"]*(";)/;
const version = createHash("sha256").update(injected.replace(verRe, "$1$2")).digest("hex").slice(0, 10);
const next = injected.replace(verRe, `$1${version}$2`);
writeFileSync(PASSAGES_FILE, next);
console.log(`build-corpus: injected ${total} passage(s) from ${files.length} concept file(s): ${files.map((f) => basename(f, ".json")).join(", ") || "(none)"}`);
console.log(`build-corpus: corpus version -> ${version}`);
console.log("  next: cd lwe-ask && bun run deploy, then embed the new passages with");
console.log('        curl -X POST https://aadhar.sh/lwe/ask/reindex -H "x-reindex-secret: $REINDEX_SECRET"');
