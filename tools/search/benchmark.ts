// Local artifact/decode experiment. Does not change staged or served files.
import { buildSearchIndex } from "../generate-search-index.ts";
import { unpackCorpus } from "./reader.ts";
import { execFileSync } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = fileURLToPath(new URL("./Cargo.toml", import.meta.url));
const corpus = await buildSearchIndex(root);
const json = JSON.stringify(corpus);
const packed = execFileSync("cargo", ["run", "--quiet", "--release", "--locked", "--manifest-path", manifest], {
  cwd: root, input: json, timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
});
const sizes = (input: string | Uint8Array) => ({
  raw: Buffer.byteLength(input), gzip: gzipSync(input, { level: 9 }).length,
  brotli: brotliCompressSync(input).length,
});
const trials: Record<string, number>[] = [];
for (let round = 0; round < 9; round++) {
  const times: Record<string, number> = {};
  for (const mode of round % 2 ? ["packed", "json"] : ["json", "packed"]) {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const decoded = mode === "json" ? JSON.parse(json) : unpackCorpus(packed);
      if (decoded.records.length !== corpus.records.length) throw new Error("incomplete decode");
    }
    times[mode] = (performance.now() - start) / 100;
  }
  trials.push(times);
}
console.log(JSON.stringify({ records: corpus.records.length, json: sizes(json),
  pretty: sizes(JSON.stringify(corpus, null, 2) + "\n"), packed: sizes(packed), parseMilliseconds: trials }, null, 2));
