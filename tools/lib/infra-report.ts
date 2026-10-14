// infra-report.ts — the one store `bun run infra:check` prints from.
import { redactCredentials } from "./redact.ts";
import type { Finding } from "./infra-compare.ts";

export type Rendered = { stdout: string[]; stderr: string[]; exitCode: number };

export function createReport(env: Record<string, string | undefined> = process.env) {
  const hard: string[] = [];
  const advisory: string[] = [];
  const ok: string[] = [];

  const fail = (m: string) => { hard.push(redactCredentials(m, env)); };
  const warn = (m: string) => { advisory.push(redactCredentials(m, env)); };
  const pass = (m: string) => { ok.push(redactCredentials(m, env)); };

  const add = (findings: Finding[]) => {
    for (const f of findings) (f.level === "fail" ? fail : f.level === "warn" ? warn : pass)(f.message);
  };

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
