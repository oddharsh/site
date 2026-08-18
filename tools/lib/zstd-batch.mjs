// zstd-batch.mjs — every dictionary-compressed frame the build ships.
//
// THE RUNTIME SPLIT, and it is the whole reason this file has two paths.
// `zstdCompressSync`'s `dictionary` option is the ONE api on this branch that
// bun 1.4 has and released bun does not. Measured: under bun 1.3.14 the build
// runs staging, minification, the /a/ hashing, precompression and the CSP scan,
// and dies here. Everything else it needs, released bun already has.
//
// So this delegates rather than demanding the canary. When the running runtime
// ignores the option, the batch goes to `node`, which honours it from 26 (this
// repo's .node-version, and what Cloudflare's build image resolves it to,
// measured 2026-08-17 in a real Workers Builds run: "Installing nodejs 26.7.0"
// succeeded while "Installing bun 1.4.0-canary.1" failed, because there is no
// release tagged that and the image templates a semver).
//
// The bar is the usual one: the delegated path must produce BYTE-IDENTICAL
// frames, since /a/ is content-addressed and a moved byte re-mints a URL and
// orphans every committed dictionary. ZSTD_FORCE_NODE_DELEGATE=1 forces this
// path on a runtime that does not need it, which is how that gets tested rather
// than assumed.
//
// The failure being defended against is SILENT in both directions: a runtime
// that ignores the option still returns a valid frame, and that frame still
// decodes against the dictionary. The only signal is a byte count that never
// shrank, which is why the probe below compares sizes rather than trusting an
// api.
import { execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const LEVEL = 19;

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

/** Compressing a buffer against ITSELF must collapse if the dictionary is real. */
export function dictionaryHonoured() {
  const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
  const at = (options) => zstdCompressSync(probe, { ...options, params: { [zlibConstants.ZSTD_c_compressionLevel]: LEVEL } }).length;
  return at({ dictionary: probe }) < at({}) * 0.5;
}

let hostCapable = null;
const hostHonoursDictionary = () => {
  if (process.env.ZSTD_FORCE_NODE_DELEGATE === "1") return false;
  if (hostCapable === null) hostCapable = dictionaryHonoured();
  return hostCapable;
};

function runWorker(jobs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: jobs });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`zstd worker exited with code ${code}`));
    });
  });
}

async function inProcess(jobs) {
  // Eight workers reached the flat part of the curve on a 14-core workstation
  // (12 was within run-to-run noise) without taking every core from the host.
  const workerCount = Math.min(8, availableParallelism(), jobs.length);
  const chunks = Array.from({ length: workerCount }, () => []);
  jobs.forEach((job, index) => chunks[index % workerCount].push({ index, ...job }));
  const results = (await Promise.all(chunks.map(runWorker))).flat();
  results.sort((a, b) => a.index - b.index);
  return results.map(({ frame }) => Buffer.from(frame));
}

// ONE spawn for the whole batch, not one per frame. Dictionaries are deduped by
// identity because the page tier hands the same 64KB family dictionary to 48
// jobs, and sending it 48 times would be 3MB down a pipe for no reason.
function viaNode(jobs) {
  const dictionaries = [];
  const indexOf = new Map();
  const payload = {
    dictionaries,
    jobs: jobs.map(({ bytes, dictionary }) => {
      if (!indexOf.has(dictionary)) {
        indexOf.set(dictionary, dictionaries.length);
        dictionaries.push(Buffer.from(dictionary).toString("base64"));
      }
      return { bytes: Buffer.from(bytes).toString("base64"), dictionary: indexOf.get(dictionary) };
    }),
  };

  let stdout;
  try {
    stdout = execFileSync(process.env.ZSTD_DELEGATE_NODE || "node", [new URL(import.meta.url).pathname, "--stdin-batch"], {
      input: JSON.stringify(payload),
      maxBuffer: 512 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(
      `zstd dictionary compression is unavailable: this runtime ignores the \`dictionary\` option and the node delegate failed (${detail}). ` +
      "Deltas would ship as silent no-ops, so the build stops here.",
    );
  }
  return JSON.parse(stdout).frames.map((frame) => Buffer.from(frame, "base64"));
}

export async function zstdCompressDictionaryBatch(jobs) {
  if (!jobs.length) return [];
  return hostHonoursDictionary() ? inProcess(jobs) : viaNode(jobs);
}

/**
 * Can this build produce dictionary frames at all, here or through node? Called
 * once at the top of the delta step so a capability failure is one named error
 * rather than 144 confusing ones.
 */
export function assertDictionaryCapable() {
  if (hostHonoursDictionary()) return "in-process";
  const node = process.env.ZSTD_DELEGATE_NODE || "node";
  let version;
  try {
    version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "zstd dictionary compression is unavailable: this runtime ignores the `dictionary` option and no `node` is on PATH. " +
      "Run the build on bun 1.4+, or make node 26+ reachable. Deltas would ship as silent no-ops.",
    );
  }
  const [, probe] = execFileSync(node, ["-e",
    "const {constants,zstdCompressSync}=require('node:zlib');" +
    "const p=Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(200));" +
    "const at=(o)=>zstdCompressSync(p,{...o,params:{[constants.ZSTD_c_compressionLevel]:19}}).length;" +
    "process.stdout.write('probe:'+(at({dictionary:p})<at({})*0.5?'ok':'ignored'))",
  ], { encoding: "utf8" }).split(":");
  if (probe !== "ok") {
    throw new Error(
      `zstd dictionary compression is unavailable: this runtime ignores the \`dictionary\` option and ${node} ${version} ignores it too. ` +
      "Node 26 is the floor (see .node-version). Deltas would ship as silent no-ops.",
    );
  }
  return `delegated to ${node} ${version}`;
}

// CLI mode, the delegate. Guarded on the flag rather than on being the entry
// module, so importing this file can never trip it.
if (isMainThread && process.argv[2] === "--stdin-batch") {
  if (!dictionaryHonoured()) {
    process.stderr.write(`${process.version} accepts the dictionary option and ignores it; node 26+ is required\n`);
    process.exit(2);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { dictionaries, jobs } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const dicts = dictionaries.map((d) => Buffer.from(d, "base64"));
  const frames = await inProcess(jobs.map((job) => ({ bytes: Buffer.from(job.bytes, "base64"), dictionary: dicts[job.dictionary] })));
  process.stdout.write(JSON.stringify({ frames: frames.map((frame) => frame.toString("base64")) }));
}
