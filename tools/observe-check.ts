// observe-check.ts — has each production observability signal fired at all in
// the last N days? `bun run observe:check [--days N]`, default 7, max 30.
// Read-only: it runs SELECTs and GETs, and exits 1 when a verdict is BROKEN.
// The verdicts and why each rule exists are in lib/observe-signals.ts; the
// planted-fault half and the cost of each link are in docs/OBSERVABILITY-DRILL.md.
//
// CREDENTIAL. CLOUDFLARE_API_TOKEN when set, otherwise the wrangler OAuth login
// (`wrangler auth token`). Measured 2026-10-29 with that login: GraphQL
// (invocations) and the SQL API's Analytics Engine datasets answer; the SQL
// API's logs.workersLogs, logs.traces and logs.issues answer 403
// "Authorization error", because no wrangler OAuth scope grants observability
// reads. Those rows print UNREADABLE with the reason rather than SILENT, so a
// missing scope never reads as a quiet week. CI's site-ci-read token carries
// neither Analytics nor observability read (config/infra.json), which is why
// this is a workstation tool and not a validate step.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CF_ACCOUNT } from "./lib/cf.ts";
import { redactCredentials } from "./lib/redact.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { utcIso, verdicts, type Reading } from "./lib/observe-signals.ts";

const exec = promisify(execFile);
const SCRIPT = "aadhar-sh";
const REPO = "oddharsh/site";
const API = "https://api.cloudflare.com/client/v4";

const flag = process.argv.indexOf("--days");
const days = flag === -1 ? 7 : Number(process.argv[flag + 1]);
// GraphQL and Workers Logs both keep 30 days at most on this plan, and the
// value is inlined into SQL below, so it must be a small integer.
if (!Number.isInteger(days) || days < 1 || days > 30) {
  console.error("observe-check: --days takes an integer from 1 to 30");
  process.exit(2);
}
const now = new Date();
const since = new Date(now.getTime() - days * 86400_000);

async function token(): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const { stdout } = await exec(...wranglerCommand(["auth", "token", "--json"]));
  return JSON.parse(stdout).token;
}

const unreadable = (e: unknown): Reading => ({ kind: "unreadable", reason: redactCredentials(e instanceof Error ? e.message : String(e)) });

async function post(bearer: string, path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160).trim()}`);
  return JSON.parse(text);
}

// One count and newest timestamp from the SQL API. Account scope goes in the
// request, never the SQL (the API refuses both at once). A sampled dataset
// (every one here but logs.issues) refuses MAX and asks for APPROX_MAX; COUNT
// is weighted for sampling by the API itself.
async function sqlCount(bearer: string, from: string, time: string, where = "", sampled = true): Promise<Reading> {
  try {
    const query = `SELECT COUNT(*) AS n, ${sampled ? "APPROX_MAX" : "MAX"}(${time}) AS last FROM ${from} WHERE ${time} >= NOW() - INTERVAL '${days}' DAY${where ? ` AND ${where}` : ""}`;
    const { data } = await post(bearer, "/analytics/sql", { query, scope: { accountTag: CF_ACCOUNT } });
    const n = Number(data?.[0]?.n ?? 0);
    return { kind: "read", count: n, last: n > 0 ? utcIso(data[0].last) : null };
  } catch (e) {
    return unreadable(e);
  }
}

// Invocations and exceptions in one GraphQL read, grouped by day and status.
async function invocations(bearer: string): Promise<{ invocations: Reading; exceptions: Reading }> {
  try {
    const query = `{viewer{accounts(filter:{accountTag:"${CF_ACCOUNT}"}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:"${since.toISOString()}",datetime_leq:"${now.toISOString()}",scriptName:"${SCRIPT}"}){sum{requests} dimensions{date status}}}}}`;
    const body = await post(bearer, "/graphql", { query });
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    const groups: { sum: { requests: number }; dimensions: { date: string; status: string } }[] = body.data.viewer.accounts[0].workersInvocationsAdaptive;
    let total = 0;
    let thrown = 0;
    let lastThrown: string | null = null;
    for (const g of groups) {
      total += g.sum.requests;
      if (g.dimensions.status !== "scriptThrewException") continue;
      thrown += g.sum.requests;
      if (lastThrown === null || g.dimensions.date > lastThrown) lastThrown = g.dimensions.date;
    }
    return { invocations: { kind: "read", count: total, last: null }, exceptions: { kind: "read", count: thrown, last: lastThrown } };
  } catch (e) {
    const r = unreadable(e);
    return { invocations: r, exceptions: r };
  }
}

async function github(): Promise<Reading> {
  try {
    const day = since.toISOString().slice(0, 10);
    const args = [
      "issue",
      "list",
      "-R",
      REPO,
      "--label",
      "workers-issue",
      "--state",
      "all",
      "--search",
      `updated:>=${day}`,
      "--json",
      "updatedAt",
      "--limit",
      "100",
    ];
    const issues: { updatedAt: string }[] = JSON.parse((await exec("gh", args)).stdout);
    const last =
      issues
        .map((i) => i.updatedAt)
        .sort()
        .at(-1) ?? null;
    return { kind: "read", count: issues.length, last };
  } catch (e) {
    return unreadable(e);
  }
}

const bearer = await token();
const [inv, logs, issues, spans, perfProbe, botLedger, gh] = await Promise.all([
  invocations(bearer),
  sqlCount(bearer, "logs.workersLogs", "timestamp", `scriptName = '${SCRIPT}'`),
  sqlCount(bearer, "logs.issues", "timestamp", `scriptName = '${SCRIPT}'`, false),
  sqlCount(bearer, "logs.traces", "startTime", `serviceName = '${SCRIPT}' AND spanName = 'cron.home_probe'`),
  sqlCount(bearer, "events.analyticsEngine.aadhar_perf_probe", "timestamp"),
  sqlCount(bearer, "events.analyticsEngine.aadhar_bot_ledger", "timestamp"),
  github(),
]);

const rows = verdicts({ days, now, ...inv, logs, issues, github: gh, spans, perfProbe, botLedger });
const width = Math.max(...rows.map((r) => r.signal.length));
console.log(`observe:check, last ${days} days to ${now.toISOString()}`);
for (const r of rows) console.log(`  ${r.verdict.padEnd(10)} ${r.signal.padEnd(width)}  ${r.detail}`);
process.exit(rows.some((r) => r.verdict === "BROKEN") ? 1 : 0);
