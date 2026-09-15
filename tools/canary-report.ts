#!/usr/bin/env bun
// bun run canary:report -- --leg <bun|wrangler|browsers> --json <report> --exit <n>
//
// Turns one canary leg's JSON into AT MOST ONE open issue per leg, and keeps
// that issue quiet.
//
// THE POLICY, which is the whole file:
//
//   red or changed, no open issue      create it, with the table and a signature
//   red or changed, issue already open comment ONLY if the signature is new
//   green, issue open                  comment "green again" and close it
//   green, nothing open                nothing
//   instrument (exit 2)                no issue; the JOB goes red instead
//
// The signature is WHAT failed (the gate names, or the flipped probes), never
// which build failed it. So a fresh canary carrying yesterday's broken gate
// adds nothing, and a second gate failing adds one comment. That is the
// difference between a tripwire and a daily digest nobody reads, and it is
// borrowed from node-support-window.yml, which dedupes on the phase rather
// than the date for the same reason.
//
// An instrument failure files nothing on purpose. "the runner had no unzip"
// is not a finding about bun, and an issue that says so trains the reader to
// close canary issues unread. The workflow step exits 2 and the run is red,
// which is the right place for a broken instrument to be visible.
//
// `plan()` is the decision and is pure, so a test can run every row of the
// table above without a token. The gh calls are the only side effects.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Gate = { name: string; ok: boolean; detail: string; notes?: string[]; hard?: boolean };
type Report = {
  leg: string;
  verdict: "green" | "changed" | "red" | "instrument";
  subject: Record<string, unknown>;
  signature: string;
  gates?: Gate[];
  flips?: { cap: string; stable: boolean; prerelease: boolean; pair: string }[];
  belowBar?: { cap: string; trueIn: string[] }[];
  reason?: string;
  ms: number;
};

export type Open = { number: number; text: string } | null;
export type Action = { kind: "none" } | { kind: "create" } | { kind: "comment"; number: number } | { kind: "close"; number: number };

export const title = (leg: string) => `canary tripwire: ${leg}`;
export const marker = (leg: string, signature: string) => `<!-- canary:${leg} signature:${signature} -->`;

/** The decision table, with no side effects. `open` is the one open issue for the leg, if any. */
export function plan(report: Pick<Report, "leg" | "verdict" | "signature">, open: Open): Action {
  if (report.verdict === "instrument") return { kind: "none" };
  if (report.verdict === "green") return open ? { kind: "close", number: open.number } : { kind: "none" };
  if (!open) return { kind: "create" };
  if (open.text.includes(marker(report.leg, report.signature))) return { kind: "none" };
  return { kind: "comment", number: open.number };
}

/** The issue body or comment: what was tested, what it answered, how to reproduce. */
export function render(report: Report, runUrl: string | undefined): string {
  const lines: string[] = [];
  // `engines` is the one structured field and gets its own table below.
  const subject = Object.entries(report.subject)
    .filter(([k]) => k !== "engines")
    .map(([k, v]) => `- **${k}**: \`${String(v)}\``);
  lines.push(`**${report.verdict.toUpperCase()}** on the ${report.leg} leg.`, "", ...subject, "");

  if (report.gates?.length) {
    lines.push("| gate | result | detail |", "|---|---|---|");
    for (const g of report.gates) {
      // GFM splits cells before unescaping inline text. Preserve literal
      // backslashes first, then protect pipes and keep each detail on one row.
      const detail = g.detail.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
      lines.push(`| ${g.name} | ${g.ok ? "ok" : g.hard === false ? "DIFF" : "FAIL"} | ${detail} |`);
    }
    for (const g of report.gates) for (const n of g.notes ?? []) lines.push(`    ${n}`);
    lines.push("");
  }
  if (report.flips?.length) {
    lines.push("| probe | pair | stable | prerelease |", "|---|---|---|---|");
    for (const f of report.flips) lines.push(`| \`${f.cap}\` | ${f.pair} | ${f.stable} | ${f.prerelease}${f.prerelease ? "" : " (gone)"} |`);
    lines.push("");
  }
  if (report.belowBar?.length) {
    lines.push("Cards marked shipped that no longer clear the two-engine bar in stable engines:", "");
    for (const b of report.belowBar) lines.push(`- \`${b.cap}\`: true in ${b.trueIn.length ? b.trueIn.join(", ") : "no stable engine"}`);
    lines.push("");
  }
  const engines = (report.subject as { engines?: { name: string; version: string; probes: number; true: number }[] }).engines;
  if (engines?.length) {
    lines.push("| engine | version | probes true |", "|---|---|---|");
    for (const e of engines) lines.push(`| ${e.name} | ${e.version} | ${e.true} / ${e.probes} |`);
    lines.push("");
  }
  if (report.reason) lines.push(`Reason: ${report.reason}`, "");
  lines.push(
    `Reproduce with \`bun run canary:${report.leg}\`. Filed by [\`canary.yml\`](.github/workflows/canary.yml)${runUrl ? ` from [this run](${runUrl})` : ""}; it proposes nothing and holds no Cloudflare credential.`,
    "",
    marker(report.leg, report.signature),
  );
  return lines.join("\n");
}

const gh = (args: string[]) => {
  const out = spawnSync("gh", args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(out.stderr || out.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
  return out.stdout;
};

/** The open issue for a leg, with its body and every comment folded into one searchable text. */
function findOpen(leg: string): Open {
  const want = title(leg);
  const list = JSON.parse(gh(["issue", "list", "--state", "open", "--search", `"${want}" in:title`, "--json", "number,title"])) as { number: number; title: string }[];
  const hit = list.find((i) => i.title === want);
  if (!hit) return null;
  const view = JSON.parse(gh(["issue", "view", String(hit.number), "--json", "body,comments"])) as { body: string; comments: { body: string }[] };
  return { number: hit.number, text: [view.body, ...view.comments.map((c) => c.body)].join("\n") };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const leg = flag("--leg");
  const jsonPath = flag("--json");
  const exit = Number(flag("--exit") ?? "0");
  if (!leg || !jsonPath) {
    console.error("usage: canary-report --leg <name> --json <report.json> --exit <n>");
    process.exit(2);
  }

  let report: Report;
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    // No JSON means the leg died before writing one, which is an instrument
    // failure by definition: the script is what writes the file.
    console.error(`::error title=canary ${leg} wrote no report::exit ${exit}`);
    process.exit(2);
  }
  if (report.leg !== leg) {
    console.error(`::error title=report is for ${report.leg}::asked to file for ${leg}`);
    process.exit(2);
  }
  if (report.verdict === "instrument" || (exit !== 0 && exit !== 1)) {
    console.error(`::error title=canary ${leg} could not run::${report.reason ?? `exit ${exit}`}`);
    process.exit(2);
  }

  const open = findOpen(leg);
  const action = plan(report, open);
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const body = render(report, runUrl);

  switch (action.kind) {
    case "none":
      console.log(`canary:report: ${leg} is ${report.verdict}; ${open ? "the open issue already carries this signature" : "nothing to file"}.`);
      break;
    case "create": {
      // Both labels are declared in config/infra.json; `gh issue create
      // --label` fails outright on an unknown one, which is the right failure.
      const url = gh(["issue", "create", "--assignee", "oddharsh", "--label", "type: ci", "--label", "area: ci", "--title", title(leg), "--body", body]).trim();
      console.log(`canary:report: filed ${url}`);
      break;
    }
    case "comment":
      gh(["issue", "comment", String(action.number), "--body", body]);
      console.log(`canary:report: new signature, commented on #${action.number}`);
      break;
    case "close":
      gh(["issue", "close", String(action.number), "--comment", `Green again.\n\n${body}`]);
      console.log(`canary:report: green again, closed #${action.number}`);
      break;
  }
}
