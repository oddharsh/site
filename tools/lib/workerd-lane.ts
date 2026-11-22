// ── which contract tests must also pass in workerd, and what a miss means ──
//
// The contract suite runs under bun. Production runs in workerd. A test that
// exercises code the Worker ships (anything reachable from a Worker entry) is
// run a second time inside workerd by tools/test-workerd.ts, and these pure
// functions decide what each result means:
//
//   - membership: a test is in the lane when one of its own imports, or one of
//     the names it takes from contract-shared.ts, comes from a module the Worker
//     bundle contains. A test that reads build output (the quiz answer-key check
//     reads .build/public) is not, because workerd only serves those bytes.
//   - verdict: in the lane, a test that passes under bun and not in workerd is
//     "host" when it touched a host-only package or a node API workerd stubs
//     (it needs a process, so it stays a bun test), and otherwise a "finding".
//     A finding is either a listed gap in config/workerd-gaps.json or new.
//     A listed gap that no longer reproduces is "stale", so the list can't rot.
//
// Decided 2026-11-21: classify host-ness by recorded touches and workerd's own
// "not implemented" errors, never by the failure's message alone. Matching
// messages sorted 208 failures as host and left about 30 wrangler-config reads
// (whose stub returned a value, then failed later as "config.worker is not an
// object") posing as findings.

export type Status = "pass" | "fail" | "skip";

export interface WorkerdResult {
  name: string;
  status: Status;
  error?: string;
  touched: string[];
}

export interface Gap {
  /** `<file> :: <test name>`, or `<file> :: <load>` for a file that won't load. */
  test: string;
  /** Where the difference lives. */
  cause: "workerd" | "lane" | "test-code";
  why: string;
  /** Upstream issue or PR, when there is one. */
  link?: string;
}

export type Verdict = { kind: "agree" } | { kind: "host"; via: string } | { kind: "known"; gap: Gap } | { kind: "new"; status: Status; error: string };

/** Errors workerd raises for node APIs it stubs, which only a host process has. */
const WORKERD_HOST_ERROR =
  /method is not implemented|Dynamic require of "node:(child_process|vm|worker_threads)"|Module not found: file:\/\/\/tmp\/|createRequire\(\.\.\.\)\.resolve is not a function|at new DatabaseSync \(node:sqlite/;

export const LOAD = "<load>";
export const testKey = (file: string, name: string) => `${file} :: ${name}`;

/** Every module reachable from the entries in an esbuild-style import graph. */
export function reachable(graph: Record<string, string[]>, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    if (seen.has(m)) continue;
    seen.add(m);
    for (const next of graph[m] ?? []) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

/** Local name to source module, for each name a file imports with `import { ... } from`. */
export function namedImports(source: string, resolve: (spec: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const from = resolve(m[2]);
    for (const part of m[1].split(",")) {
      const words = part
        .replace(/^\s*type\s+/, "")
        .trim()
        .split(/\s+as\s+/);
      const local = words.at(-1)?.trim();
      if (local) out.set(local, from);
    }
  }
  return out;
}

export function inLane(input: { directImports: string[]; sharedNames: string[]; sharedSource: Map<string, string>; workerModules: Set<string> }): boolean {
  if (input.directImports.some((m) => input.workerModules.has(m))) return true;
  return input.sharedNames.some((n) => input.workerModules.has(input.sharedSource.get(n) ?? ""));
}

export function verdict(input: { key: string; workerd: WorkerdResult; bun: Status | undefined; fileTouched: string[]; gaps: Map<string, Gap> }): Verdict {
  const { workerd, bun } = input;
  if (workerd.status === "pass") return { kind: "agree" };
  // Only a test bun passes can show a workerd difference; one bun also skips or
  // fails says nothing about workerd.
  if (bun !== "pass") return { kind: "agree" };
  const touched = [...workerd.touched, ...input.fileTouched];
  if (touched.length > 0) return { kind: "host", via: touched[0] };
  const error = workerd.error ?? "";
  if (WORKERD_HOST_ERROR.test(error)) return { kind: "host", via: WORKERD_HOST_ERROR.exec(error)?.[0] ?? "" };
  const gap = input.gaps.get(input.key);
  if (gap) return { kind: "known", gap };
  return { kind: "new", status: workerd.status, error: error.split("\n")[0] };
}

/** Listed gaps whose test now agrees, or no longer exists in the lane. */
export function staleGaps(gaps: Map<string, Gap>, stillDiffering: Set<string>): Gap[] {
  return [...gaps.values()].filter((g) => !stillDiffering.has(g.test));
}
