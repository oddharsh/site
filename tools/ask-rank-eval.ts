// Does Clef rank /ask better than the lexical pass? The measurement behind
// src/worker/ask-rank.ts, committed so the next change to the ranking (a
// model bump, a different floor, a longer option text) is scored the same way.
//
//   bun run build            # the corpus is build output (.build/public/search-index.json)
//   bun run ask:eval         # 30 questions, lexical vs Clef, MRR and hit@1
//
// Each question names the page that should answer it. The questions were
// written by the person who built the ranking, after reading the corpus, so a
// win here is a strong signal rather than a benchmark. What keeps it honest is
// the mix: easy keyword questions the ranking must not break, paraphrases, and
// four whose page shares no word with the question at all.
//
// Measured 2026-10-01: lexical MRR 0.777, hit@1 22/30; Clef over the whole
// corpus MRR 0.983, hit@1 29/30, one call per question, median 1.26 s. The
// lexical columns are this script's own run of the real searchSiteRanked.
//
// Workstation-only: it spends Workers AI through the REST API, with
// CLOUDFLARE_API_TOKEN when set and wrangler's own login otherwise. It writes
// nothing.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ASK_MODEL, buildAskRequest } from "../src/worker/ask-rank.ts";
import { _resetSearchIndex, searchSiteRanked } from "../src/worker/search.ts";
import { siteConfig } from "./lib/site-config.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

export const ASK_EVAL: readonly (readonly [string, readonly string[]])[] = [
  ["how do I book time to get coffee with you", ["/coffee"]],
  ["which bots crawled the site recently", ["/ledger"]],
  ["what do post-quantum signatures cost", ["/garage/pqc"]],
  ["why do my shoelaces keep coming untied", ["/lwe/knots"]],
  ["is planar magnetic better than dynamic headphones", ["/lwe/drivers"]],
  ["how does fully homomorphic encryption work", ["/lwe/fhe"]],
  ["explain secure enclaves and the side channels that leak them", ["/lwe/tee"]],
  ["what does the site compress its responses with", ["/garage/compression", "/garage/wire"]],
  ["photos from the endurance race in Austin", ["/cota-wec"]],
  ["how should I downscale images without making them darker", ["/garage/resample"]],
  ["can I see how a website looks to an AI crawler", ["/lens"]],
  ["what events are worth going to", ["/serendipity"]],
  ["what has he been reading lately", ["/reading"]],
  ["who links to this site", ["/inbox"]],
  ["why did the site move off Cloudflare Pages", ["/garage/workers"]],
  ["which macOS settings does he change", ["/dotfiles"]],
  ["test whether my eyes notice compression artifacts", ["/pixel-peeper"]],
  ["how do you crack a Kryptos style cipher", ["/lwe/vigenere"]],
  ["what is the difference between UTF-8 and ASCII", ["/lwe/utf8"]],
  ["is htmx worth adding to a site", ["/garage/htmx"]],
  ["demo of content defined chunking", ["/garage/chunks"]],
  ["why does the site look like Windows XP", ["/writing/colophon"]],
  ["how do formal proofs verify a compiler", ["/lwe/lean"]],
  ["multi-party computation with a dishonest majority", ["/lwe/mpc"]],
  ["how do phones stop you installing old firmware", ["/lwe/fuse"]],
  ["which image format is best for thumbnails", ["/garage/encoding", "/lwe/encoding"]],
  ["does the name in a crawler's user agent change whether it gets blocked", ["/garage/useragent"]],
  ["the codec that comes after AV1", ["/garage/av2"]],
  ["connect to a machine by its public key instead of an IP", ["/garage/iroh"]],
  ["delta-sigma versus R-2R DACs", ["/lwe/dac"]],
];

/** 1/rank of the first acceptable page in `order`'s top 10, or 0. */
export function reciprocalRank(order: readonly string[], want: readonly string[]): number {
  const i = order.slice(0, 10).findIndex((url) => want.includes(url));
  return i < 0 ? 0 : 1 / (i + 1);
}

async function workersAiAuth(): Promise<{ token: string, account: string }> {
  const account = String((await siteConfig()).account_id);
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, account };
  const { stdout } = await run(...wranglerCommand(["auth", "token", "--json"]), { cwd: ROOT });
  const token = JSON.parse(stdout)?.token;
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN and wrangler auth token returned none; run `bun run wrangler login`");
  return { token, account };
}

if (import.meta.main) {
  const corpusPath = join(ROOT, ".build/public/search-index.json");
  const index = await readFile(corpusPath, "utf8").catch(() => {
    console.error(`ask:eval: no ${corpusPath}; run \`bun run build\` first, since the corpus is build output`);
    process.exit(2);
  });
  const records = JSON.parse(index).records;
  _resetSearchIndex();
  const env = { ASSETS: { fetch: async () => new Response(index) } };
  const { token, account } = await workersAiAuth();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${ASK_MODEL}`;

  let lexMrr = 0, clefMrr = 0, lexTop = 0, clefTop = 0, failed = 0;
  const ms: number[] = [];
  for (const [query, want] of ASK_EVAL) {
    const lexical = (await searchSiteRanked(env, query, 10)).results.map((r) => r.url);
    const { request, ids } = buildAskRequest(query, records);
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    const body: any = res ? await res.json().catch(() => null) : null;
    let clef: string[] = [];
    if (body?.success) {
      ms.push(performance.now() - t0);
      const p = body.result.answers?.best?.probabilities || {};
      clef = ids.map((id, i) => ({ url: records[i].url, p: Number(p[id]) || 0 })).sort((a, b) => b.p - a.p).map((x) => x.url);
    } else failed++;
    lexMrr += reciprocalRank(lexical, want); clefMrr += reciprocalRank(clef, want);
    lexTop += want.includes(lexical[0]) ? 1 : 0; clefTop += want.includes(clef[0]) ? 1 : 0;
    const at = (order: string[]) => { const i = order.slice(0, 10).findIndex((u) => want.includes(u)); return i < 0 ? " -" : String(i + 1).padStart(2); };
    console.log(`${at(lexical)} ${at(clef)}  ${query}`);
  }
  const n = ASK_EVAL.length;
  ms.sort((a, b) => a - b);
  console.log("\ncolumns: rank of the right page, lexical then Clef (- is outside the top 10)");
  console.log(`MRR    lexical ${(lexMrr / n).toFixed(3)}   clef ${(clefMrr / n).toFixed(3)}`);
  console.log(`hit@1  lexical ${lexTop}/${n}   clef ${clefTop}/${n}`);
  console.log(`clef calls failed ${failed}; median ${ms.length ? ms[Math.floor(ms.length / 2)].toFixed(0) : "-"} ms`);
}
