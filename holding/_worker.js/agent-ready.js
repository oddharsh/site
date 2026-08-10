// agent-ready.js — how much of this origin can a machine actually use, and what
// did that cost to build?
//
// ── why this exists ───────────────────────────────────────────────────────
// Every other tool here points OUTWARD. This one points at the host that serves
// it, publishes the result whether or not it flatters, and prints the bill.
//
// The bet this site is testing is that hosting tools for agents is worth doing
// and cheaper than people assume. That is an empirical claim, and nobody has
// published the numbers. Plenty of writing exists about whether sites SHOULD be
// agent-readable; almost none about what it costs in files and lines, which is
// the only figure anyone deciding actually needs.
//
// It grades any origin, not just this one, because a scorecard that can only
// flatter its author is marketing. Point it at a competitor, or at this site.
//
// ── what it does NOT do ───────────────────────────────────────────────────
// No letter grade dressed up as objective. The doors are counted because a door
// is a fact — it opened, it did not, or we could not tell. Weighting those into
// a single number would invent a precision the observation cannot support, and
// this codebase has spent a lot of effort not doing that (see lib/doors.js on
// shut-versus-unread, and lens on absent-versus-zero).
import { COLS, blank, fit, kv, rows, rule, s, table, wrap } from "./lib/tui.js";
import { readDoors } from "./lib/doors.js";

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
/** @type {[name: string, files: number, lines: number, note: string][]} */
export const LIFT = [
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

  const mark = (probe) => (probe.ok ? ["  open ", "ok"] : probe.unreadable ? ["unread ", "warn"] : ["  shut ", "dim"]);
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
