#!/usr/bin/env node
// check-q11.ts — does every brotli q11 twin the build writes reach a client AT
// q11? (bun run q11:check [-- --url <base>] [--concurrency <n>]) Gotcha 14 says
// plain responses are brotli q11; this is what checks that they arrive that way.
//
// Raw bytes come through node:http(s), never fetch: undici and bun's fetch both
// decode br on the way in, which hides the one thing this measures. Both
// runtimes leave node:http's body alone (measured 2026-09-26).
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
export const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const LIVE_CONTROL = "/robots.txt";

export function q11(bytes: Buffer): Buffer {
  return brotliCompressSync(bytes, {
    params: {
      [zc.BROTLI_PARAM_QUALITY]: 11,
      [zc.BROTLI_PARAM_LGWIN]: 24,
      [zc.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

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

export function q11Slack(q11Bytes: number): number {
  return Math.max(Math.ceil(q11Bytes * 0.01), 8);
}

export type Verdict =
  | { verdict: "q11"; wire: number }
  | { verdict: "q11-size"; encoding: string; wire: number; q11: number }
  | { verdict: "over"; encoding: string; wire: number; q11: number }
  | { verdict: "undecodable"; encoding: string; wire: number };

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
  if (twins.length < 400) {
    console.error(`q11:check found ${twins.length} twins under ${BUILT}, expected 400+ (521 on 2026-09-26); is the build complete?`);
    process.exit(2);
  }

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
