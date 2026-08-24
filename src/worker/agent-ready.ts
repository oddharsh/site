import { COLS, blank, fit, kv, rows, rule, s, table, wrap } from "./lib/tui.ts";
import { readDoors } from "./lib/doors.ts";

const INNER = COLS - 4;

// ── the bill ──────────────────────────────────────────────────────────────
// HAND-MAINTAINED with a checked date, the same contract lens's census runs on
// (lens.js: "Hand-maintained; each fact carries a 'checked' date and a source").
// A generator would drift less but would mean extending build.mjs, which this
// repo does not do without the owner saying so. A stale number with an honest
// date beats a fresh number nobody sanctioned.
//
// Recount with: the groups below map to real paths; `wc -l` them.
export const LIFT_CHECKED = "2026-08-05";
// Typed as a TUPLE rather than left to inference. Without it tsc widens the
// element type to (string | number)[], every `lines` reads as string | number,
// and the sum below stops type-checking for a reason that has nothing to do
// with the arithmetic.
export const LIFT: Array<[name: string, files: number, lines: number, what: string]> = [
  // [capability, files, lines, what it buys]
  ["MCP server", 3, 574, "tools/list + tools/call, stateless 2026-07-28"],
  ["llms.txt", 1, 208, "a readable map, hand-written"],
  ["agent discovery", 1, 113, "agent-card, api-catalog, anonymous auth"],
  ["markdown twins", 2, 918, "every prose page, generated so it cannot drift"],
  ["surface registry", 3, 792, "one source for nav, sitemap, agent catalog"],
  ["bot identity", 2, 319, "RFC 9421 signing on every outbound fetch"],
  ["x402 paywall", 1, 140, "machine payment for the full corpus"],
  ["frame renderer", 1, 307, "the 80-column TUI representation"],
  ["the tools", 5, 1932, "finger, lens, dict, cache, radar"],
  ["console client", 1, 458, "the PowerShell MCP client at /terminal"],
];

// The honest decomposition, and the point of publishing any of this: BASELINE
// compatibility is a weekend. The rest is differentiation and drift-proofing,
// which is where the real cost hides and where nobody budgets.
export const BASELINE = ["MCP server", "llms.txt", "agent discovery"];

export const liftTotals = () => LIFT.reduce(
  (acc, [name, files, lines]) => ({
    files: acc.files + files,
    lines: acc.lines + lines,
    baseline: acc.baseline + (BASELINE.includes(name) ? lines : 0),
  }),
  { files: 0, lines: 0, baseline: 0 },
);

// ── the audit ─────────────────────────────────────────────────────────────
// Counted, never scored. Each door is one of three states and the third is the
// one most graders get wrong: a check that could not run is not a failure.
export function scoreDoors(doors) {
  const checks = [
    ["llms.txt", doors.llms],
    ["markdown twin", doors.markdown],
    ["agent card", doors.agentCard],
    ["api catalog", doors.apiCatalog],
    ["MCP server", doors.mcp],
  ];
  return {
    checks,
    open: checks.filter(([, d]) => d.ok).length,
    unread: checks.filter(([, d]) => d.unreadable).length,
    total: checks.length,
  };
}

const detailOf = (probe, whenOpen) =>
  (probe.ok ? whenOpen : probe.unreadable ? (probe.why || probe.detail || "could not check")
    : (probe.why || probe.detail || probe.wrongType || "not served"));

export async function agentReadyFrame(target, env, { self = false } = {}) {
  const doors = await readDoors(target, env).catch(() => null);
  if (!doors) {
    return { title: "agent-ready — unreadable", body: [[s("that origin could not be read.", "bad")]], status: [] };
  }
  const score = scoreDoors(doors);
  const totals = liftTotals();

  // The return is a TUPLE because it is spread into s(text, style); an array
  // type would make the spread a rest-argument error.
  const mark = (probe): [string, string] => (probe.ok ? ["  open ", "ok"] : probe.unreadable ? ["unread ", "warn"] : ["  shut ", "dim"]);
  const doorRows = score.checks.map(([label, probe]) => [
    s(...mark(probe)),
    ...fit([s(label)], 22),
    s(detailOf(probe, probe === doors.mcp ? `${doors.mcp.count} tools` : `${probe.bytes ?? "present"}${probe.bytes ? " bytes" : ""}`), "dim"),
  ]);

  const body = rows(
    kv("origin", doors.origin, INNER, { gutter: 10 }),
    blank(),
    rule(INNER, "doors a machine can walk through"),
    ...doorRows,
    blank(),
    [s(`  ${score.open} of ${score.total} open`, score.open === score.total ? "ok" : "warn"),
      s(score.unread ? `, ${score.unread} unreadable from here` : "", "dim")],
  );

  // The bill only makes sense for the origin that has the source tree.
  const bill = self ? rows(
    blank(),
    rule(INNER, `what this cost to build (counted ${LIFT_CHECKED})`),
    table({
      cols: [{ title: "capability", width: 20 }, { title: "files", width: 5, align: "right" },
        { title: "lines", width: 6, align: "right" }, { title: "buys" }],
      rows: LIFT.map(([name, files, lines, buys]) => [name, String(files), String(lines), buys]),
      width: INNER,
    }),
    [s(`${"total".padEnd(20)} ${String(totals.files).padStart(5)} ${String(totals.lines).padStart(6)}`, "strong")],
    blank(),
    ...wrap(`Baseline agent compatibility — an MCP server, an llms.txt, and the discovery files — is ${totals.baseline} lines of the ${totals.lines}. That part is a weekend. The rest is drift-proofing and the tools themselves, which is where the cost actually hides and where nobody budgets.`, INNER).map((row) => [s(row)]),
    blank(),
    ...wrap("The harder half is not in this table at all: it is the discipline of not lying to a caller. Every genuinely difficult problem here was an honesty problem, not a protocol one — a door that could not be checked reported as shut, a score computed without its inputs, a delta that was really plain zstd, an ETag that can never match. A site can be perfectly conformant and still mislead every agent that visits.", INNER).map((row) => [s(row, "dim")]),
  ) : rows(
    blank(),
    [s("  add no url to see what this origin cost to build.", "dim")],
  );

  return {
    title: `agent-ready — ${doors.origin}`,
    body: rows(body, bill),
    status: [
      [s("doors ", "label"), s(`${score.open}/${score.total}`, score.open === score.total ? "ok" : "warn"),
        s("  counted, never scored — a check that could not run is not a failure", "dim")],
    ],
  };
}
