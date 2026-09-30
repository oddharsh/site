// ── a test that calls worker.fetch() on wrangler's harness runs under NODE ──
//
// Wrap the body of any test that dispatches a request through
// createTestHarness's getWorker().fetch():
//
//   test(NAME, underNode(import.meta.url, NAME, async () => { ... }));
//
// Under node it IS the body. Under bun it re-runs that one test in a node child
// and fails with the child's output if the child did.
//
// WHY, measured 2026-09-30 on the wrangler pin ddaa558 (#1037). miniflare's
// dispatchFetch used to rewrite the request URL onto the runtime's own origin
// itself and hand undici a Dispatcher only to ADD headers. workers-sdk#15906
// ("preserve request body length in dispatchFetch") moved the rewrite INTO that
// Dispatcher, so the request now reaches workerd only if fetch honours
// `{ dispatcher }`. node's undici does; bun's fetch ignores the option
// (oven-sh/bun#39247, the `fetch-honours-dispatcher` watch in
// upstream-watches.ts). On one throwaway Worker, the same three calls:
//
//   | worker.fetch(...)          | node | bun                           |
//   |----------------------------|------|-------------------------------|
//   | "/rel"                     | 200  | 404 No entrypoint worker found |
//   | "http://x.test/abs"        | 200  | ENOTFOUND x.test               |
//   | new URL("/p", listen().url)| 200  | 404 No entrypoint worker found |
//
// So there is no URL a bun test can pass that works: the in-process door
// gotcha 38 describes as bun-safe now needs the same Dispatcher the wire door
// always did. getEnv() and the Workflow introspectors do not go through
// dispatchFetch, which is why cal's suite (it calls handlers directly with the
// harness's env) stayed green on the same pin.
//
// Retire this when that watch flips, or when miniflare rewrites the URL itself
// again. The child has to exit 0 AND print `# pass 1`, because a name
// pattern that matches nothing exits 0 having run nothing.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Body = () => void | Promise<void>;

export function underNode(file: string, name: string, body: Body): Body {
  if (!process.versions.bun) return body;
  return () => {
    const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const run = spawnSync("node", [
      "--import", "./tools/lib/no-network.ts",
      "--test", "--test-isolation=none", "--test-reporter=tap",
      `--test-name-pattern=${pattern}`,
      fileURLToPath(file),
    ], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const count = (label: string) => Number(out.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? NaN);
    if (run.error || run.status !== 0 || count("pass") !== 1 || count("fail") !== 0) {
      throw new Error(`under node, "${name}" did not pass exactly once `
        + `(status ${run.status}${run.error ? `, ${run.error.message}` : ""}):\n${out.slice(-6000)}`);
    }
  };
}
