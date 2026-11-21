// vitals-report.ts: `bun run vitals:report`. What real visitors measured.
//
//   bun run vitals:report                 # p75 per page and metric over 28 days
//   bun run vitals:report -- --days 7     # another window
//   bun run vitals:report -- --versions   # split by Worker version, to place a regression
//
// browser:check and act:check read the site in a lab: Chrome and WebKit on a
// CI runner's fonts, a loopback network, a CPU throttle standing in for a
// phone. Each of their passes says "conservative reading", because a lab
// can't say what an iPhone on a train measured. `aadhar_vitals` can, for the
// pages that report to it (src/worker/vitals.ts, VITALS_PATHS), and until
// 2026-11-20 the only way to read it was the curl in docs/MAINTENANCE.md,
// which nothing ran on a schedule and nothing compared to a threshold.
//
// This prints each page's p75 beside Core Web Vitals' own lines (LCP 2.5 s,
// INP 200 ms, CLS 0.1: "good" at or under, "poor" past 4 s, 500 ms, 0.25),
// p75 over 28 days being how Chrome's field data states them. It exits 1 when
// a page with enough views is not "good". Under MIN_VIEWS a p75 is one or two
// visitors, so the row is printed and not judged.
//
// It reads; it changes nothing. The token is CLOUDFLARE_API_TOKEN when set,
// else wrangler's login, and needs Account Analytics: Read.
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { asNumber, asRecord, asText } from "../src/worker/lib/parse.ts";
import { siteConfig } from "./lib/site-config.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

/** Core Web Vitals' published lines: at or under `good`, past `poor`. */
export const LINES = { LCP: { good: 2500, poor: 4000 }, INP: { good: 200, poor: 500 }, CLS: { good: 0.1, poor: 0.25 } } as const;
export type Metric = keyof typeof LINES;
/** Fewer views than this in the window and a p75 is one or two visitors. */
export const MIN_VIEWS = 20;

export type Row = { path: string; metric: Metric; version: string; p75: number; views: number };
export type Verdict = "good" | "needs work" | "poor" | "too few views";

export function judge(row: Pick<Row, "metric" | "p75" | "views">): Verdict {
  if (row.views < MIN_VIEWS) return "too few views";
  const { good, poor } = LINES[row.metric];
  return row.p75 <= good ? "good" : row.p75 <= poor ? "needs work" : "poor";
}

/** Parse the SQL API's JSON once, at the boundary. A row of another shape is dropped. */
export function parseRows(body: unknown): Row[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) throw new Error("vitals:report: the SQL API answered without a data array");
  const rows: Row[] = [];
  for (const raw of data) {
    const r = asRecord(raw);
    const metric = asText(r?.metric);
    const [path, p75, views] = [asText(r?.path), asNumber(r?.p75), asNumber(r?.views)];
    if (metric !== "LCP" && metric !== "INP" && metric !== "CLS") continue;
    if (path === null || p75 === null || views === null) continue;
    rows.push({ path, metric, version: asText(r?.version) ?? "", p75, views });
  }
  return rows;
}

export const show = (row: Pick<Row, "metric" | "p75">) => (row.metric === "CLS" ? row.p75.toFixed(3) : `${Math.round(row.p75)} ms`);

/** The report's lines, and whether any judged row is not good. */
export function report(rows: Row[]): { lines: string[]; failed: boolean } {
  const sorted = rows.toSorted((a, b) => a.path.localeCompare(b.path) || a.metric.localeCompare(b.metric) || a.version.localeCompare(b.version));
  const lines = sorted.map((row) => {
    const verdict = judge(row);
    const where = row.version ? `${row.path} @${row.version}` : row.path;
    return `${verdict === "good" || verdict === "too few views" ? "ok  " : "FAIL"}  ${where.padEnd(28)} ${row.metric}  p75 ${show(row).padStart(8)}  ${String(Math.round(row.views)).padStart(5)} views  ${verdict}`;
  });
  return { lines, failed: sorted.some((row) => judge(row) === "needs work" || judge(row) === "poor") };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: "string", default: "28" }, versions: { type: "boolean", default: false } } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error(`--days takes a whole number from 1 to 90, got ${values.days}`);
  const account = String((await siteConfig()).account_id);
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const { stdout } = await run(...wranglerCommand(["auth", "token", "--json"]), { cwd: ROOT });
    token = asText(asRecord(JSON.parse(stdout))?.token) ?? undefined;
  }
  if (!token) throw new Error("vitals:report: no CLOUDFLARE_API_TOKEN and wrangler's login returned none; run `bun run wrangler login`");
  const by = values.versions ? ", blob3 AS version" : "";
  const sql = `SELECT blob2 AS path, blob1 AS metric${by}, quantileWeighted(0.75)(double1, _sample_interval) AS p75, sum(_sample_interval) AS views FROM aadhar_vitals WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY path, metric${values.versions ? ", version" : ""} FORMAT JSON`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: sql,
  });
  if (!response.ok) throw new Error(`vitals:report: the SQL API answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const rows = parseRows(await response.json());
  const { lines, failed } = report(rows);
  for (const line of lines) console.log(line);
  console.log(
    `vitals:report: ${rows.length} row(s) over ${days} days; p75 against LCP ${LINES.LCP.good} ms, INP ${LINES.INP.good} ms, CLS ${LINES.CLS.good}. CLS comes from Chromium only, so it undercounts iPhones.`,
  );
  process.exit(rows.length === 0 ? 2 : failed ? 1 : 0);
}
