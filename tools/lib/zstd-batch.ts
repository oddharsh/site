import { availableParallelism } from "node:os";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DCZ_ZSTD_LEVEL } from "../../src/worker/lib/dictionary-names.ts";

const LEVEL = DCZ_ZSTD_LEVEL;

if (!isMainThread) {
  const results = workerData.map(({ index, bytes, dictionary }) => ({
    index,
    frame: zstdCompressSync(bytes, {
      dictionary,
      params: { [zlibConstants.ZSTD_c_compressionLevel]: LEVEL },
    }),
  }));
  parentPort.postMessage(results);
}

type Framed = { index: number; frame: Uint8Array };

function runWorker(jobs): Promise<Framed[]> {
  return new Promise<Framed[]>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: jobs });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`zstd worker exited with code ${code}`));
    });
  });
}

export async function zstdCompressDictionaryBatch(jobs) {
  if (!jobs.length) return [];
  const workerCount = Math.min(8, availableParallelism(), jobs.length);
  const chunks = Array.from({ length: workerCount }, () => []);
  jobs.forEach((job, index) => chunks[index % workerCount].push({ index, ...job }));
  const results = (await Promise.all(chunks.map(runWorker))).flat();
  results.sort((a, b) => a.index - b.index);
  return results.map(({ frame }) => Buffer.from(frame));
}
