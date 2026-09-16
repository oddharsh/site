import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

const SHA = "1234567" + "8".repeat(33);

test("one scheduled Wrangler evaluation feeds the pin and canary report", () => {
  const read = (name) => JSON.parse(execFileSync("bun", ["-e",
    "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
    fileURLToPath(new URL(`.github/workflows/${name}.yml`, ROOT)),
  ], { encoding: "utf8" }));
  const canary = read("canary");
  const pin = read("wrangler-pin");
  assert.equal(canary.jobs.wrangler.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(pin.on.schedule.length, 1);
  const evaluate = pin.jobs.pin.steps.find((step) => step.id === "pin");
  assert.match(evaluate.run, /args=\(--ref "\$REF" --json canary.json\)/);
  assert.equal(evaluate.env.PROPOSE, "${{ github.ref == 'refs/heads/main' }}");
  const report = pin.jobs.pin.steps.find((step) => step.run?.includes("timbrado report --target wrangler"));
  assert.match(report.run, /--json canary.json/);
  assert.match(report.if, /github.ref == 'refs\/heads\/main'/);
});

const cases = [
  { name: "unchanged default remains a cheap no-op", pin: SHA, json: false, count: 0, status: 0 },
  { name: "unchanged nightly runs once without rewriting the pin", pin: SHA, write: true, status: 0 },
  { name: "new green candidate is observed without writing", verdict: "green", status: 0 },
  { name: "changed candidate keeps its original report", verdict: "changed", status: 0 },
  { name: "red candidate never writes a pin", verdict: "red", write: true, status: 1 },
  { name: "instrument failure remains exit two", verdict: "instrument", write: true, status: 2 },
  { name: "wrong candidate report is rejected", mode: "wrong-sha", status: 2, output: false },
  { name: "wrong baseline report is rejected", mode: "wrong-pin", status: 2, output: false },
  { name: "empty gates cannot propose a pin", mode: "empty-gates", write: true, status: 2, output: false },
  { name: "unnamed gate is rejected", mode: "unnamed-gate", write: true, status: 2, output: false },
  { name: "string boolean cannot pass a gate", mode: "string-boolean", write: true, status: 2, output: false },
  { name: "green cannot conceal a hard failure", mode: "hard-failure", write: true, status: 2, output: false },
  { name: "unknown verdict is rejected", verdict: "unknown", status: 2, output: false },
  { name: "process/report disagreement is rejected", mode: "exit-mismatch", status: 2, output: false },
  { name: "resolver failure clears stale evidence", mode: "resolve-failure", count: 0, status: 2, output: false },
];

for (const scenario of cases) {
  test(`shared Wrangler evaluation: ${scenario.name}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrangler shared ")));
    try {
      mkdirSync(join(root, "tools"));
      mkdirSync(join(root, "temp"));
      mkdirSync(join(root, "src/worker/lib"), { recursive: true });
      copyFileSync(new URL("src/worker/lib/parse.ts", ROOT), join(root, "src/worker/lib/parse.ts"));
      copyFileSync(new URL("tools/bump-wrangler-pin.ts", ROOT), join(root, "tools", "bump-wrangler-pin.ts"));
      const original = JSON.stringify({ devDependencies: { wrangler: `https://pkg.pr.new/cloudflare/workers-sdk/wrangler@${(scenario.pin ?? "abcdef0").slice(0, 7)}` } });
      writeFileSync(join(root, "package.json"), original);
      writeFileSync(join(root, "fetch.ts"), `
        globalThis.fetch = async () => {
          if (process.env.MODE === "resolve-failure") throw new Error("offline control");
          return new Response(null, {headers: {"x-commit-key": "cloudflare:workers-sdk:${SHA}"}});
        };
      `);
      writeFileSync(join(root, "tools", "canary-wrangler.ts"), `
        import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
        appendFileSync("calls", "evaluate\\n");
        const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
        if (arg("--ref") !== "${SHA}") throw new Error("candidate must be the full resolved SHA");
        const verdict = process.env.VERDICT || "green";
        const report = {
          leg: "wrangler", verdict, signature: verdict, watches: [], ms: 1,
          subject: {ref: process.env.MODE === "wrong-sha" ? "wrong" : arg("--ref"), pin: process.env.MODE === "wrong-pin" ? "wrong" : JSON.parse(readFileSync("package.json", "utf8")).devDependencies.wrangler, wrangler: "candidate", miniflare: "candidate", workerd: "candidate"},
          gates: process.env.MODE === "empty-gates" ? [] : [{name: "contracts", ok: verdict !== "red" && process.env.MODE !== "hard-failure", hard: true, detail: "control"}]
        };
        if (process.env.MODE === "unnamed-gate") report.gates[0].name = "";
        if (process.env.MODE === "string-boolean") report.gates[0].ok = "true";
        const text = JSON.stringify(report, null, 2) + "\\n";
        writeFileSync(arg("--json"), text);
        writeFileSync("original-report", text);
        process.exit(process.env.MODE === "exit-mismatch" ? 1 : verdict === "green" ? 0 : verdict === "instrument" ? 2 : 1);
      `);
      const args = ["--preload", "./fetch.ts", "tools/bump-wrangler-pin.ts"];
      if (scenario.json !== false) {
        args.push("--json", "out.json");
        writeFileSync(join(root, "out.json"), "stale report");
      }
      if (scenario.write) args.push("--write");
      const result = spawnSync("bun", args, {
        cwd: root, encoding: "utf8", timeout: 10000,
        env: { ...process.env, TMPDIR: join(root, "temp"), MODE: scenario.mode ?? "", VERDICT: scenario.verdict ?? "green" },
      });
      assert.equal(result.status, scenario.status, result.stdout + result.stderr);
      const calls = existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").length : 0;
      assert.equal(calls, scenario.count ?? 1);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), original);
      assert.ok(!existsSync(join(root, "bun.lock")), "no scenario may relock");
      if (scenario.json !== false && scenario.output !== false) {
        assert.equal(readFileSync(join(root, "out.json"), "utf8"), readFileSync(join(root, "original-report"), "utf8"));
      } else {
        assert.ok(!existsSync(join(root, "out.json")));
      }
      assert.deepEqual(readdirSync(join(root, "temp")).filter((name) => name.startsWith("wrangler-pin-")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
