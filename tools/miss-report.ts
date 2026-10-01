// Where do this site's 404s go, and who hits them? Read from the EDGE, which
// sees every request, through the zone's httpRequestsAdaptiveGroups dataset.
//
//   bun run misses              # the last 3 days
//   bun run misses -- --days 1
//
// It classifies with the same missBucket and callerClass the Worker's miss
// ledger writes (src/worker/lib/not-found.ts), so this report and the ledger
// can be read side by side. It is the before/after for that module: the first
// run, 2026-10-01 over three days, put 57% of 3,237 404s on superseded /a/
// hashes and 22% on vulnerability probes.
//
// Two limits worth knowing before reading a number. The dataset is ADAPTIVE,
// so counts are sampled estimates. And it caps a query at 10,000 groups of
// (status, path, user-agent): the report says when a window hit the cap, since
// a capped window under-counts the long tail. A user-agent is self-reported.
//
// A redirect the module answers shows here as a 301 rather than a 404, so a
// fix reads as the 404 share falling, with the 301s listed beside it.
//
// Workstation-only: wrangler's own login reads zone analytics, or
// CLOUDFLARE_API_TOKEN. It writes nothing.

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { callerClass, missBucket } from "../src/worker/lib/not-found.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
const CAP = 10_000;

async function token(): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const { stdout } = await run(...wranglerCommand(["auth", "token", "--json"]), { cwd: ROOT });
  const t = JSON.parse(stdout)?.token;
  if (!t) throw new Error("no CLOUDFLARE_API_TOKEN and wrangler auth token returned none; run `bun run wrangler login`");
  return t;
}

async function api(tok: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const QUERY = `query($z: String!, $s: Time!, $e: Time!) { viewer { zones(filter: { zoneTag: $z }) {
  httpRequestsAdaptiveGroups(limit: ${CAP}, filter: { datetime_geq: $s, datetime_lt: $e }, orderBy: [count_DESC]) {
    count dimensions { edgeResponseStatus clientRequestPath userAgent } } } } }`;

if (import.meta.main) {
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Number(process.argv[i + 1]) : 3;
  if (!(days > 0 && days <= 7)) throw new Error("--days takes 1 to 7");
  const tok = await token();
  const zone = (await api(tok, "/zones?name=aadhar.sh")).result?.[0]?.id;
  if (!zone) throw new Error("could not resolve the aadhar.sh zone with this credential");
  const e = new Date(), s = new Date(e.getTime() - days * 86_400_000);
  const res = await api(tok, "/graphql", { query: QUERY, variables: { z: zone, s: s.toISOString(), e: e.toISOString() } });
  if (res.errors?.length) throw new Error(`zone analytics refused the query: ${res.errors[0].message}`);
  const rows: any[] = res.data.viewer.zones[0].httpRequestsAdaptiveGroups;

  let all = 0, nf = 0;
  const byCaller: Record<string, { all: number, nf: number }> = {};
  const byBucket: Record<string, number> = {};
  const redirects: Record<string, number> = {};
  for (const r of rows) {
    const c = callerClass(r.dimensions.userAgent);
    (byCaller[c] ??= { all: 0, nf: 0 }).all += r.count;
    all += r.count;
    if (r.dimensions.edgeResponseStatus === 404) {
      nf += r.count;
      byCaller[c].nf += r.count;
      const b = missBucket(r.dimensions.clientRequestPath);
      byBucket[b] = (byBucket[b] || 0) + r.count;
    } else if (r.dimensions.edgeResponseStatus === 301) {
      const b = missBucket(r.dimensions.clientRequestPath);
      redirects[b] = (redirects[b] || 0) + r.count;
    }
  }
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
  console.log(`last ${days} day(s): ${all} requests, ${nf} 404 (${pct(nf, all)})${rows.length >= CAP ? `  [hit the ${CAP}-group cap: the tail is under-counted]` : ""}\n`);
  console.log("caller          requests    404   404 rate");
  for (const [c, t] of Object.entries(byCaller).sort((a, b) => b[1].all - a[1].all)) {
    console.log(`${c.padEnd(14)}${String(t.all).padStart(10)}${String(t.nf).padStart(7)}   ${pct(t.nf, t.all)}`);
  }
  console.log("\n404s by bucket      count   share   (301s answered in that bucket)");
  for (const [b, n] of Object.entries(byBucket).sort((a, b) => b[1] - a[1])) {
    console.log(`${b.padEnd(18)}${String(n).padStart(7)}   ${pct(n, nf).padStart(6)}   ${redirects[b] ? `(${redirects[b]})` : ""}`);
  }
}
