// Which CI failures keep coming back, and which the push gate already stops.
//
// Reads the failed CI runs of the last N days, names each failing job by the
// first test that failed in it (or its first ::error title, or the step), and
// groups runs by that name. A name that failed on main, or on two or more
// branches, is a suspect: a flaky test or merge skew, since a branch's own bug
// rarely shows up on a second branch. That's how the coffee race test in #1492
// turned up: 3 failures on main, none of them from a change to cal.
//
//   bun run ci:census              last 30 days
//   bun run ci:census --days 7

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GATES } from "./push-gate.ts";

const run = promisify(execFile);
const gh = async (args: string[]) => (await run("gh", args, { maxBuffer: 64 << 20 })).stdout;

type Failure = { id: number; branch: string; date: string; signature: string; step: string };

/**
 * The name a failed job's log goes by: its first failing test, else its first
 * error annotation, else the step. Both anchor on the timestamp a log line
 * starts with, because a step's own script is echoed into the log, and one
 * that prints an ::error made 24 unrelated runs share its title.
 */
export function signature(log: string, step: string): string {
  const test = /\dZ (?:\S+ test: )?\(fail\) (.+?) \[[\d.]+m?s\]/.exec(log);
  if (test) return test[1];
  const error = /\dZ (?:\S+ test: )?::error[^:]*title=(.+?)::/.exec(log);
  if (!error) return step;
  try {
    return decodeURIComponent(error[1]);
  } catch {
    return error[1];
  }
}

/** Steps the push gate runs: their failures reproduce locally in about 7 s. */
export function gated(step: string): boolean {
  const names: Record<string, RegExp> = {
    "format:check": /^Format/,
    typecheck: /^Typecheck/,
    lint: /^Lint/,
    "pages:check": /^Check page contracts/,
    "derive:check": /^Check derived artifacts/,
  };
  return GATES.some((g) => names[g]?.test(step));
}

/**
 * Signatures that failed on main or on two or more branches, most runs first.
 * A gated step on branches alone is each branch's own bug, so it needs main.
 */
export function suspects(failures: Failure[]) {
  const by = new Map<string, Failure[]>();
  for (const f of failures) by.set(f.signature, [...(by.get(f.signature) ?? []), f]);
  return [...by]
    .map(([sig, fs]) => ({ sig, runs: fs.length, branches: new Set(fs.map((f) => f.branch)), step: fs[0].step }))
    .filter((s) => s.branches.has("main") || (s.branches.size >= 2 && !gated(s.step)))
    .sort((a, b) => b.runs - a.runs);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

if (import.meta.main) {
  const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const runs: { databaseId: number; headBranch: string; createdAt: string }[] = JSON.parse(
    await gh([
      "run",
      "list",
      "--workflow",
      "CI",
      "--status",
      "failure",
      "--created",
      `>=${since}`,
      "--limit",
      "500",
      "--json",
      "databaseId,headBranch,createdAt",
    ]),
  );
  const failures = (
    await pool(runs, 8, async (r) => {
      const jobs = JSON.parse(await gh(["api", `repos/{owner}/{repo}/actions/runs/${r.databaseId}/jobs`])).jobs.filter((j) => j.conclusion === "failure");
      const log = await gh(["run", "view", String(r.databaseId), "--log-failed"]).catch(() => "");
      return jobs.map((j): Failure => {
        const step = j.steps.find((s) => s.conclusion === "failure" && !/^(Wait for|Require every)/.test(s.name))?.name ?? j.name;
        const own = log
          .split("\n")
          .filter((line) => line.startsWith(j.name + "\t"))
          .join("\n");
        return { id: r.databaseId, branch: r.headBranch, date: r.createdAt.slice(0, 10), step, signature: signature(own, step) };
      });
    })
  ).flat();

  const caught = failures.filter((f) => gated(f.step)).length;
  console.log(`${runs.length} failed CI runs since ${since}; ${caught} of ${failures.length} failing jobs are steps the push gate runs.\n`);
  console.log("Suspects (failed on main, or on 2+ branches):");
  for (const s of suspects(failures))
    console.log(
      `  ${String(s.runs).padStart(3)}  ${s.branches.has("main") ? "main " : "     "}${String(s.branches.size).padStart(2)} br  ${s.sig}  [${s.step}]`,
    );
}
