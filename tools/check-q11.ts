#!/usr/bin/env node
// check-q11.ts — does every brotli q11 twin the build writes reach a client AT
// q11? (bun run q11:check [-- --url <base>] [--concurrency <n>])
//
// build.ts writes a q11 `.br` twin beside 500-odd files (the /a/ shell, every
// page, the static text assets), and the Worker hands one over when a client
// offers br. A twin that is built and never served still returns a correct body
// of the right type, only larger, so every other check here reads it as a pass.
// That is how /garage and /lwe shipped 16% fat for weeks in July 2026, and how
// /llms-full.txt shipped 31.7 KB fat per fetch until 2026-09-26. The route
// oracle's `encoding: br` rows cannot see it either: the local harness
// re-encodes an unencoded text response to br on its own, so a row asserting
// the header passes whether or not the twin was used.
//
// So this measures what arrived. For every twin in .build/public it requests
// the URL the twin stands behind with the Accept-Encoding a browser sends,
// decodes what comes back, re-encodes it at the build's q11 settings, and
// judges the wire on SIZE against that re-encode. The re-encode is what makes
// the verdict independent of which commit this checkout is on, so "is this
// q11" is a question about the response alone. The checkout supplies only the
// list of URLs, and a URL production does not have (an /a/ hash from a newer
// build) reads as absent rather than failed. Run it from the deployed commit
// for a complete list.
//
// SIZE, NOT BYTE IDENTITY, because q11 is not the same stream on every machine.
// The first version demanded identity and failed /writing from a Mac: production
// answered with the Linux-built twin (its ETag is that file's asset hash), 5,841
// B, and macOS arm64 re-encoded the same body to 5,847 B, while on Linux x64
// node 26, the pinned bun and the previous bun pin all reproduce 5,841 exactly.
// q11's cost model is floating point, so an encoder built for a different
// architecture can pick a different stream on an occasional input. That is a
// false alarm about bytes nobody pays for, so the rule is the one a reader cares
// about: at most q11 + max(1%, 8 B). The edge's on-the-fly encoding lands 12-26%
// over on anything real, and drift was 0.1%. The cost is that on six tiny files
// (four per-photo meta JSONs, /writing/posts.json, an 87 B writing .txt) the
// edge's q4 lands within that slack of q11 or under it, so size cannot tell them
// apart; it also cannot matter there, since nothing is over. Those twins are
// still built ON PURPOSE: skipping them (8 B between the six) was tried on
// 2026-09-26 and reverted the same day, owner call, because q11 everywhere keeps
// every file in a directory behaving the same. A stream that passes on size but
// is not byte-identical is still counted and named, because a re-encode
// somewhere is worth seeing.
//
// AGAINST A LOCAL WORKER, PASS `--accept-encoding br`. wrangler's harness puts
// miniflare's asset layer in front of the Worker, and offered the browser's
// `gzip, deflate, br, zstd` it re-encodes every compressible response to gzip,
// including ones the Worker already sent as br: measured 2026-09-26, 464 of 522
// twins arrived as gzip that way, and all 522 arrived as the twin's exact bytes
// with `br` alone. Production passes origin brotli through, which is the claim
// the default header is here to test, so the default stays the browser's.
//
// Raw bytes come through node:http(s), never fetch: undici and bun's fetch both
// decode br on the way in, which hides the one thing this measures. Both
// runtimes leave node:http's body alone (measured 2026-09-26).
//
// Two controls run first, and a failed control is exit 2 with no verdict:
//   offline  a q4 encoding of a real file must read as OVER, and its twin as
//            q11, so the classifier can tell the two apart at all
//   live     /robots.txt has no twin by design (the q11-twin contract test pins
//            it as edge-direct), so it must arrive NOT at q11: 1,505 B at q4
//            against 1,194 B at q11. If it reads q11, something between here and
//            the Worker re-encodes, and every other row is about that instead.
//
// Advisory, like dcz:check: it reads production, so it must never be a required
// check. Exit 0 every twin served at q11, 1 a finding, 2 the instrument.
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseArgs } from "node:util";
import {
  brotliCompressSync, brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync,
  constants as zc,
} from "node:zlib";

const BUILT = ".build/public/";
// What Chrome sends. The edge chooses among these, so offering br alone would
// measure a request no browser makes.
export const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const LIVE_CONTROL = "/robots.txt";

// build.ts's brotliQ11, verbatim. A drift here would read every served twin as
// a finding, which the offline control catches before any row prints.
export function q11(bytes: Buffer): Buffer {
  return brotliCompressSync(bytes, {
    params: {
      [zc.BROTLI_PARAM_QUALITY]: 11,
      [zc.BROTLI_PARAM_LGWIN]: 24,
      [zc.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

/** The request path a twin at `rel` (relative to .build/public) stands behind. */
export function urlForTwin(rel: string): string {
  const plain = rel.slice(0, -3);
  if (plain.endsWith(".html") && !plain.endsWith(".src.html")) {
    // Pages are served at their extensionless path, and a section index at its
    // directory (html_handling: drop-trailing-slash), the root at "/".
    const page = plain.slice(0, -5);
    if (page === "index") return "/";
    return `/${page.endsWith("/index") ? page.slice(0, -6) : page}`;
  }
  return `/${plain}`;
}

export function kindOfTwin(rel: string): "shell" | "page" | "text" {
  if (rel.startsWith("a/")) return "shell";
  return rel.endsWith(".html.br") && !rel.endsWith(".src.html.br") ? "page" : "text";
}

/** How far over a fresh q11 encode a body may land and still count as q11. */
export function q11Slack(q11Bytes: number): number {
  return Math.max(Math.ceil(q11Bytes * 0.01), 8);
}

// `q11` is byte-identical to this machine's re-encode; `q11-size` is a different
// stream within the slack (encoder drift across platforms, or a re-encode that
// cost nothing); `over` is what the edge's on-the-fly encoding looks like.
export type Verdict =
  | { verdict: "q11"; wire: number }
  | { verdict: "q11-size"; encoding: string; wire: number; q11: number }
  | { verdict: "over"; encoding: string; wire: number; q11: number }
  | { verdict: "undecodable"; encoding: string; wire: number };

/**
 * Is `body`, as it arrived with `encoding`, no larger than the q11 encoding of
 * its content? Judged on size against a fresh q11 encode, with byte identity
 * reported separately rather than required (see the header for why).
 */
export function classify(encoding: string | null | undefined, body: Buffer): Verdict {
  const enc = (encoding || "identity").toLowerCase().trim();
  let plain: Buffer;
  try {
    if (enc === "br") plain = brotliDecompressSync(body);
    else if (enc === "gzip" || enc === "x-gzip") plain = gunzipSync(body);
    else if (enc === "deflate") plain = inflateSync(body);
    else if (enc === "zstd") plain = zstdDecompressSync(body);
    else if (enc === "identity") plain = body;
    else return { verdict: "undecodable", encoding: enc, wire: body.length };
  } catch {
    return { verdict: "undecodable", encoding: enc, wire: body.length };
  }
  const want = q11(plain);
  if (enc === "br" && want.equals(body)) return { verdict: "q11", wire: body.length };
  const verdict = body.length <= want.length + q11Slack(want.length) ? "q11-size" : "over";
  return { verdict, encoding: enc, wire: body.length, q11: want.length };
}

/** Did it arrive at q11 size, byte-identical or not? */
export const atQ11 = (v: Verdict) => v.verdict === "q11" || v.verdict === "q11-size";

type Got = { status: number; encoding: string | null; body: Buffer };

function get(base: string, path: string, acceptEncoding: string): Promise<Got> {
  const url = new URL(path, base);
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: { "accept-encoding": acceptEncoding, accept: "*/*", "user-agent": "aadhar.sh q11:check" },
      timeout: 20_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        encoding: (res.headers["content-encoding"] as string) ?? null,
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out: ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "https://aadhar.sh" },
      concurrency: { type: "string", default: "8" },
      "accept-encoding": { type: "string", default: BROWSER_ACCEPT_ENCODING },
    },
  });
  const base = values.url.replace(/\/$/, "");
  const ae = values["accept-encoding"];
  const concurrency = Math.max(1, Number(values.concurrency) || 8);

  if (!existsSync(BUILT)) {
    console.error("q11:check needs a built tree for its URL list: run `bun run build` first (from the deployed commit, for a complete list)");
    process.exit(2);
  }
  const twins = (await readdir(BUILT, { recursive: true })).filter((f) => f.endsWith(".br")).sort();
  // Same floor shape as build.ts: a walk that found nothing would pass silently.
  if (twins.length < 400) {
    console.error(`q11:check found ${twins.length} twins under ${BUILT}, expected 400+ (521 on 2026-09-26); is the build complete?`);
    process.exit(2);
  }

  // ── controls ───────────────────────────────────────────────────────────────
  const probe = twins.find((t) => t === "llms.txt.br") ?? twins[0];
  const probePlain = await readFile(BUILT + probe.slice(0, -3));
  const q4 = brotliCompressSync(probePlain, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } });
  const offlineOk = classify("br", q4).verdict === "over"
    && classify("br", await readFile(BUILT + probe)).verdict === "q11";
  console.log(`CONTROL offline: q4 and q11 encodings of /${probe.slice(0, -3)} ${offlineOk ? "classify apart" : "DO NOT classify apart"}`);
  if (!offlineOk) process.exit(2);

  let live: Got;
  try { live = await get(base, LIVE_CONTROL, ae); }
  catch (e) {
    console.log(`CONTROL live: ${LIVE_CONTROL} unreachable at ${base} (${e instanceof Error ? e.message : e})`);
    process.exit(2);
  }
  const liveV = live.status === 200 ? classify(live.encoding, live.body) : null;
  const liveOk = liveV !== null && liveV.verdict === "over";
  console.log(`CONTROL live: ${LIVE_CONTROL} has no twin and arrived ${live.status} ${live.encoding ?? "identity"} ${live.body.length} B, `
    + (liveOk ? "not at q11, so this run can see an on-the-fly encoding" : "which leaves this run unable to tell an edge encoding from a twin"));
  if (!liveOk) process.exit(2);

  // ── the sweep ─────────────────────────────────────────────────────────────
  type Row = { rel: string; path: string; kind: string; status: number; v?: Verdict; error?: string };
  const rows: Row[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < twins.length) {
      const rel = twins[next++];
      const path = urlForTwin(rel);
      const row: Row = { rel, path, kind: kindOfTwin(rel), status: 0 };
      try {
        const got = await get(base, path, ae);
        row.status = got.status;
        if (got.status === 200) row.v = classify(got.encoding, got.body);
      } catch (e) { row.error = e instanceof Error ? e.message : String(e); }
      rows.push(row);
    }
  }));
  rows.sort((a, b) => a.rel.localeCompare(b.rel));

  const served = rows.filter((r) => r.v);
  if (!served.length) {
    console.log(`no twin URL answered 200 at ${base}; nothing was measured`);
    process.exit(2);
  }
  const findings = served.filter((r) => !atQ11(r.v!));
  const drifted = served.filter((r) => r.v!.verdict === "q11-size");
  const absent = rows.filter((r) => r.status === 404);
  const other = rows.filter((r) => !r.v && r.status !== 404);

  console.log(`\n${base}, Accept-Encoding: ${ae}`);
  for (const kind of ["shell", "page", "text"]) {
    const of = served.filter((r) => r.kind === kind);
    const ok = of.filter((r) => atQ11(r.v!));
    const exact = ok.filter((r) => r.v!.verdict === "q11").length;
    const wire = ok.reduce((t, r) => t + r.v!.wire, 0);
    console.log(`  ${kind.padEnd(5)}  ${ok.length}/${of.length} at q11 (${(wire / 1024).toFixed(1)} KB)`
      + (exact < ok.length ? `, ${exact} byte-identical to this machine's re-encode` : ""));
  }
  if (absent.length) console.log(`  absent  ${absent.length} URL(s) 404 here, so this checkout differs from what ${base} serves: ${absent.slice(0, 4).map((r) => r.path).join(", ")}${absent.length > 4 ? ", ..." : ""}`);
  if (other.length) console.log(`  unread  ${other.length}: ${other.map((r) => `${r.path} (${r.error ?? r.status})`).join(", ")}`);

  // At q11 size but a different stream: not a finding, and still worth a line,
  // since a re-encode somewhere on the path is the other way to land here.
  if (drifted.length) {
    console.log(`\n${drifted.length} at q11 size in a different stream (encoder drift across platforms, or a re-encode that cost nothing):`);
    for (const r of drifted.slice(0, 10)) {
      const v = r.v as Extract<Verdict, { verdict: "q11-size" }>;
      console.log(`  note  ${r.path}  ${v.encoding} ${v.wire} B, q11 here is ${v.q11} B (${v.wire >= v.q11 ? "+" : ""}${v.wire - v.q11})`);
    }
    if (drifted.length > 10) console.log(`  ...and ${drifted.length - 10} more`);
  }

  if (findings.length) {
    let waste = 0;
    console.log(`\n${findings.length} twin(s) served OVER q11:`);
    for (const r of findings) {
      const v = r.v!;
      if (v.verdict === "over") {
        waste += v.wire - v.q11;
        console.log(`  FAIL  ${r.path}  ${v.encoding} ${v.wire} B, q11 is ${v.q11} B (+${v.wire - v.q11})`);
      } else if (v.verdict === "undecodable") {
        console.log(`  FAIL  ${r.path}  ${v.encoding} ${v.wire} B, could not decode`);
      }
    }
    console.log(`  ${(waste / 1024).toFixed(1)} KB over q11 across one fetch of each`);
    process.exit(1);
  }
  console.log(`\nPASS  every twin ${base} served arrived at q11 size or under`);
}

if (import.meta.main) await main();
