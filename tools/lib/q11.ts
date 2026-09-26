// q11.ts — the one threshold both halves of the q11 twin tier agree on.
//
// build.ts writes a brotli q11 twin beside a static text asset only when that
// twin beats what the edge would serve anyway, and `bun run q11:check` passes a
// served response when it lands no further over q11 than this. Both used to
// carry their own idea of "close enough", and a pair of thresholds that can
// drift is how a twin gets built that the checker cannot tell apart from the
// edge's own encoding. One function, imported by both, makes that impossible.
//
// 1% with an 8 B floor, measured 2026-09-26. q11 is not the same stream on
// every machine: macOS arm64 re-encoded /writing to 5,847 B against the 5,841 B
// Linux twin production serves, a 0.1% drift. The edge's on-the-fly encoding
// (local q4 reproduces its wire size almost byte for byte) lands 12-26% over
// on anything real. The floor keeps a 1 B drift on an 87 B file from counting.
import { brotliCompressSync, constants as zc } from "node:zlib";

/** How far over a q11 encode a body may land and still count as q11. */
export function q11Slack(q11Bytes: number): number {
  return Math.max(Math.ceil(q11Bytes * 0.01), 8);
}

/**
 * The edge's on-the-fly encoding, as measured: brotli q4. A proxy rather than
 * the edge itself, which is why it only ever decides whether a twin is WORTH
 * writing and never what a visitor is said to have received.
 */
export function edgeEstimate(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 4, [zc.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  }).length;
}

/** Does a q11 twin of `q11Bytes` save more than the slack over the edge's own `edgeBytes`? */
export function twinEarnsItsPlace(q11Bytes: number, edgeBytes: number): boolean {
  return edgeBytes - q11Bytes > q11Slack(q11Bytes);
}
