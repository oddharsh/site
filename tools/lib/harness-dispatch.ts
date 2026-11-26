// harness-dispatch.ts: run a test that calls worker.fetch() under node.
//
//   test(NAME, underNode(import.meta.url, NAME, async () => { ... }));
//
// Under node it is the body. Under bun it reruns that one test in a node child.
// miniflare's dispatchFetch needs fetch to honour `{ dispatcher }`
// (workers-sdk#15906), and bun's fetch ignores it (oven-sh/bun#39247), so no
// URL works from a bun test (#1037, measured 2026-09-30; gotcha 38). Retire
// this when the `fetch-honours-dispatcher` watch in upstream-watches.ts flips.
//
// The child must exit 0 and print `# pass 1`, because a name pattern that
// matches nothing also exits 0. It needs the pinned node: a runner's older
// node dies on --test-isolation with exit 9 (#1058, #1061).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Body = () => void | Promise<void>;

let floorChecked = false;
function nodeFloor(): void {
  if (floorChecked) return;
  const want = Number(readFileSync(new URL(".node-version", `file://${ROOT}`), "utf8").trim());
  const run = spawnSync("node", ["--version"], { encoding: "utf8" });
  const have = Number(/^v(\d+)\./.exec(run.stdout ?? "")?.[1] ?? NaN);
  if (!(have >= want)) {
    throw new Error(
      `underNode needs node ${want} (.node-version) on PATH and found ` +
        `${run.error ? run.error.message : (run.stdout || "nothing").trim()}. In CI, add a ` +
        "setup-node step with node-version-file: .node-version to the job running the suite.",
    );
  }
  floorChecked = true;
}

export function underNode(file: string, name: string, body: Body): Body {
  if (!process.versions.bun) return body;
  return () => {
    nodeFloor();
    const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const run = spawnSync(
      "node",
      [
        "--import",
        "./tools/lib/no-network.ts",
        "--test",
        "--test-isolation=none",
        "--test-reporter=tap",
        `--test-name-pattern=${pattern}`,
        fileURLToPath(file),
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
    );
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const count = (label: string) => Number(out.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? NaN);
    if (run.error || run.status !== 0 || count("pass") !== 1 || count("fail") !== 0) {
      // A failed deepEqual on a Buffer prints one byte per line (467 KB for a
      // 17,600-byte page), so lift each failure's first error line above the tail.
      const reasons = [...out.matchAll(/^\s+error: (?:\|-\n\s+(\S.*|[^\S\n\r\u2028\u2029])|(.+))$/gm)].map((m) => `  ${m[1] ?? m[2]}\n`).join("");
      throw new Error(
        `under node, "${name}" did not pass exactly once ` +
          `(status ${run.status}${run.error ? `, ${run.error.message}` : ""}):\n${reasons}${out.slice(-6000)}`,
      );
    }
  };
}
