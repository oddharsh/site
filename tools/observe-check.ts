// observe-check.ts — has each production observability signal fired at all in
// the last N days? `bun run observe:check [--days N]`, default 7, max 30.
// Read-only: it runs SELECTs and GETs, and exits 1 when a verdict is BROKEN.
// The verdicts and why each rule exists are in lib/observe-signals.ts; the
// planted-fault half and the cost of each link are in docs/OBSERVABILITY-DRILL.md.
//
// CREDENTIALS. Two logins, because neither reads everything (measured
// 2026-10-30). The cf CLI's login (`bun run cf auth login`, lib/cf.ts) reads
// the SQL API's logs.workersLogs, logs.traces and Analytics Engine datasets,
// the Issues list and the Issues automations. The wrangler login answers 403
// "Authorization error" on every logs.* dataset, since no wrangler OAuth scope
// grants observability reads. cf has no GraphQL command, so invocations still
// come from GraphQL with CLOUDFLARE_API_TOKEN, or the wrangler login when that
// is unset. A refused read prints UNREADABLE with the reason rather than
// SILENT, so a missing scope never reads as a quiet week. CI's site-ci-read
// token carries no Analytics or observability read (config/infra.json), which
// is why this is a workstation tool and not a validate step.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CF_ACCOUNT, cf } from "./lib/cf.ts";
import { redactCredentials } from "./lib/redact.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";
import { CADENCE_FRESH_HOURS, LEDGER_FRESH_HOURS, verdicts, type Reading } from "./lib/observe-signals.ts";

const exec = promisify(execFile);
const SCRIPT = "aadhar-sh";
const REPO = "oddharsh/site";
const API = "https://api.cloudflare.com/client/v4";

const flag = process.argv.indexOf("--days");
const days = flag === -1 ? 7 : Number(process.argv[flag + 1]);
// GraphQL keeps 30 days; Workers Logs and Traces keep 7, so a longer window
// reads 7 days of them. The value is inlined into SQL below, so it must be a
// small integer.
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

// A row count from the SQL API over the window, plus one over the last
// `recentHours` when a freshness rule judges it (lib/observe-signals.ts says
// why freshness is a count and never a newest timestamp). Account scope goes
// in the request, never the SQL (the API refuses both at once). COUNT is
// weighted for sampling by the API itself.
async function sqlCount(from: string, time: string, where: string, recentHours?: number): Promise<Reading> {
  const count = async (interval: string) => {
    const query = `SELECT COUNT(*) AS n FROM ${from} WHERE ${time} >= NOW() - INTERVAL ${interval}${where ? ` AND ${where}` : ""}`;
    const { data } = await cf(["analytics", "sql", "post", "--scope-account-tag", CF_ACCOUNT, "--query", query]);
    return Number(data?.[0]?.n ?? 0);
  };
  try {
    const [n, recent] = await Promise.all([count(`'${days}' DAY`), recentHours === undefined ? undefined : count(`'${recentHours}' HOUR`)]);
    return { kind: "read", count: n, last: null, recent };
  } catch (e) {
    return unreadable(e);
  }
}

// Exception Issues seen in the window: what an automation would hand the
// routine. The Issues list rather than logs.issues, because Issues also
// groups vulnerability scans (type "security", 12 of 15 issues on 2026-10-30),
// and logs.issues has no type column to drop them by. `count` on an issue is
// lifetime, so this counts issues, and `last` is the newest occurrence.
async function exceptionIssues(): Promise<Reading> {
  try {
    const list: { lastObserved: number }[] = await cf(["observability", "issues", "list", "--service", SCRIPT, "--type", "exception", "--per-page", "100"]);
    const seen = list.filter((i) => i.lastObserved >= since.getTime());
    const newest = Math.max(...seen.map((i) => i.lastObserved));
    return { kind: "read", count: seen.length, last: seen.length ? new Date(newest).toISOString() : null };
  } catch (e) {
    return unreadable(e);
  }
}

// Account and service automations together: either kind would route an
// aadhar-sh issue. A routine is the only destination this repo uses
// (docs/MAINTENANCE.md, "Route Workers Issues to GitHub").
async function automations(): Promise<Reading> {
  try {
    const { automations: list }: { automations: unknown[] } = await cf(["observability", "issues", "automations", "list"]);
    return { kind: "read", count: list.length, last: null };
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

const [inv, logs, issues, routes, spans, perfProbe, botLedger, gh] = await Promise.all([
  token().then(invocations, (e) => ({ invocations: unreadable(e), exceptions: unreadable(e) })),
  sqlCount("logs.workersLogs", "timestamp", `scriptName = '${SCRIPT}'`),
  exceptionIssues(),
  automations(),
  sqlCount("logs.traces", "startTime", `serviceName = '${SCRIPT}' AND spanName = 'cron.home_probe'`, CADENCE_FRESH_HOURS),
  sqlCount("events.analyticsEngine.aadhar_perf_probe", "timestamp", "", CADENCE_FRESH_HOURS),
  sqlCount("events.analyticsEngine.aadhar_bot_ledger", "timestamp", "", LEDGER_FRESH_HOURS),
  github(),
]);

const rows = verdicts({ days, ...inv, logs, issues, automations: routes, github: gh, spans, perfProbe, botLedger });
const width = Math.max(...rows.map((r) => r.signal.length));
console.log(`observe:check, last ${days} days to ${now.toISOString()}`);
for (const r of rows) console.log(`  ${r.verdict.padEnd(10)} ${r.signal.padEnd(width)}  ${r.detail}`);
process.exit(rows.some((r) => r.verdict === "BROKEN") ? 1 : 0);
