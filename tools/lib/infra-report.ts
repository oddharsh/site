// infra-report.ts — the one store `bun run infra:check` prints from.
//
// Every message goes through the redaction barrier on the way IN, so the three
// arrays never hold a credential and nothing that renders them can leak one.
// check-infra.ts holds CLOUDFLARE_API_TOKEN and GITHUB_TOKEN and prints into
// Actions logs on a PUBLIC repository. The comparers return findings as plain
// data and the adapters put upstream error text into them, so this is the
// single place a token-shaped string in an adapter error is stopped.
// tools/lib/redact.ts argues the rest.
//
// `render` returns lines rather than printing, so the contract suite can read
// exactly what a run would have written without running one.
import { redactCredentials } from "./redact.ts";
import type { Finding } from "./infra-compare.ts";

export type Rendered = { stdout: string[]; stderr: string[]; exitCode: number };

export function createReport(env: Record<string, string | undefined> = process.env) {
  // Typed because a bare `[]` infers `never[]`.
  const hard: string[] = [];
  const advisory: string[] = [];
  const ok: string[] = [];

  const fail = (m: string) => { hard.push(redactCredentials(m, env)); };
  const warn = (m: string) => { advisory.push(redactCredentials(m, env)); };
  const pass = (m: string) => { ok.push(redactCredentials(m, env)); };

  /** Take a comparer's findings, in the order it produced them. */
  const add = (findings: Finding[]) => {
    for (const f of findings) (f.level === "fail" ? fail : f.level === "warn" ? warn : pass)(f.message);
  };

  // Hard failures are "we checked and it is wrong". Advisories are "we could
  // not check" and never fail the run unless --strict asks them to.
  const render = (opts: { strict?: boolean } = {}): Rendered => {
    const stdout = [...ok.map((line) => `  ok    ${line}`), ...advisory.map((line) => `  note  ${line}`)];
    if (hard.length) {
      return { stdout, stderr: [`\ninfra drift detected (${hard.length}):`, ...hard.map((line) => `  - ${line}`)], exitCode: 1 };
    }
    if (opts.strict && advisory.length) {
      return { stdout, stderr: [`\n--strict: ${advisory.length} advisor${advisory.length === 1 ? "y" : "ies"} treated as failures`], exitCode: 1 };
    }
    stdout.push(`\ninfra ok: ${ok.length} checks passed, ${advisory.length} skipped or advisory`);
    return { stdout, stderr: [], exitCode: 0 };
  };

  return { hard, advisory, ok, fail, warn, pass, add, render };
}
