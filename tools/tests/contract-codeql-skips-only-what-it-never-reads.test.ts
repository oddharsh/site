import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoFiles } from "../lib/repo-files.ts";
import { ROOT, assert, test } from "./contract-shared.ts";

// codeql.yml skips a push to main when every changed path matches its
// paths-ignore. That is only safe for a path CodeQL would never analyze, or
// one the init step drops from the analysis itself. A glob like `tools/**`
// here would turn the security scan off for real code and nothing would go
// red, so each glob is read against the repo files it matches.
const workflow = JSON.parse(
  execFileSync(
    "bun",
    [
      "-e",
      // The init step's `config` is YAML inside YAML, so it is parsed here too.
      "const w = Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); for (const s of w.jobs.analyze.steps) if (s.with?.config) s.with.config = Bun.YAML.parse(s.with.config); console.log(JSON.stringify(w))",
      fileURLToPath(new URL(".github/workflows/codeql.yml", ROOT)),
    ],
    { encoding: "utf8" },
  ),
);

/**
 * What the extraction log of run 44145367917 (2026-11-17) shows CodeQL
 * reading, across both languages: script and page sources, YAML, and JSON
 * only as package.json, tsconfig*.json and a web manifest.
 */
function analyzed(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  if (/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|html?|xhtml|vue|hbs|ejs|njk|ya?ml|raml|xml)$/.test(name)) return true;
  return name === "package.json" || /^tsconfig.*\.json$/.test(name) || name.endsWith("manifest.json");
}

/** GitHub's paths filter glob: `**` crosses directories, `*` stays in one. */
function globToRegExp(glob: string): RegExp {
  const parts = glob.split(/\*\*\/?/).map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
  return new RegExp(`^${parts.join(".*")}$`);
}

test("analyzed() and globToRegExp() read paths the way the skip rule needs", () => {
  assert.equal(analyzed("src/worker/index.ts"), true);
  assert.equal(analyzed("cal/package.json"), true);
  assert.equal(analyzed("config/tsconfig.tools.json"), true);
  assert.equal(analyzed("config/bun-pin.json"), false);
  assert.equal(analyzed("bun.lock"), false);
  assert.equal(analyzed("public/i/a.avif"), false);
  assert.equal(globToRegExp("**.md").test("docs/GOTCHAS.md"), true);
  assert.equal(globToRegExp("**/bun.lock").test("lens-reader/bun.lock"), true);
  assert.equal(globToRegExp("bun.lock").test("lens-reader/bun.lock"), false);
  assert.equal(globToRegExp("src/dict/**").test("src/dict/a-dict/ask.4be67f7c.js"), true);
  assert.equal(globToRegExp("src/dict/**").test("src/dictionary.ts"), false);
});

test("CodeQL skips a push only for paths it never analyzes", () => {
  const ignored: string[] = workflow.on.push["paths-ignore"];
  assert.ok(ignored.length > 0, "the push trigger names what it skips");
  const init = workflow.jobs.analyze.steps.find((step: { uses?: string }) => String(step.uses ?? "").startsWith("github/codeql-action/init@"));
  const dropped: string[] = init.with.config["paths-ignore"];
  const files = repoFiles();
  for (const glob of ignored) {
    const re = globToRegExp(glob);
    const matched = files.filter((f) => re.test(f));
    assert.ok(matched.length > 0, `${glob} matches no repo file, so it is stale or misspelled`);
    const read = matched.filter((f) => analyzed(f) && !dropped.some((d) => f.startsWith(`${d}/`)));
    assert.deepEqual(read, [], `${glob} would skip a push that changes code CodeQL analyzes`);
  }
});

test("the weekly schedule re-reads everything the push trigger skips", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.schedule.length, 1);
});
