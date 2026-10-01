// ── a PR's preview against a build of the same commit ───────────────────────
// Shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { lookupPreview, previewFromSummary, WORKERS_BUILDS_APP, WORKERS_BUILDS_CHECK } from "./lib/preview-target.ts";

// preview-check.yml reads the preview URL off the check run Workers Builds posts
// on the commit, builds the same commit, and runs served:check against the
// preview. This holds the parser to the text Cloudflare actually writes, and the
// workflow to the shape that makes its verdict mean something.

// Verbatim from #1073's head (dbab7596), 2026-10-01, minus the dashboard links.
const SUMMARY = `
Build ID: 15b435bb-5051-43b4-8a07-4b9643165579
Script: aadhar-sh
Version ID: 29ac7243-ce36-4946-9cbf-49835976e8e5
Preview URL: https://29ac7243-aadhar-sh.aadharsh2010.workers.dev
Preview Alias URL: https://claude-served-check-aadhar-sh.aadharsh2010.workers.dev
`;

test("preview-target: the VERSION URL is read from Workers Builds' own summary", () => {
  assert.deepEqual(previewFromSummary(SUMMARY), {
    url: "https://29ac7243-aadhar-sh.aadharsh2010.workers.dev",
    version: "29ac7243-ce36-4946-9cbf-49835976e8e5",
  });
});

test("preview-target: a summary naming anything else is refused, never loosened", () => {
  // The alias moves with the branch; only the version URL names this upload.
  assert.equal(previewFromSummary(SUMMARY.replace(/^Preview URL: .*$/m, "")), null, "the alias alone must not stand in for the version URL");
  // Third-party text reaches a shell through this value, so the host is exact.
  for (const url of [
    "https://29ac7243-aadhar-sh.aadharsh2010.workers.dev.evil.test",
    "https://29ac7243-aadhar-sh.other.workers.dev",
    "https://29ac7243-aadhar-sh.aadharsh2010.workers.dev/$(id)",
    "http://29ac7243-aadhar-sh.aadharsh2010.workers.dev",
  ]) {
    assert.equal(previewFromSummary(SUMMARY.replace(/^Preview URL: .*$/m, `Preview URL: ${url}`)), null, url);
  }
  // The URL's prefix is the version id's: two lines that disagree were not
  // written by Workers Builds about one upload.
  assert.equal(previewFromSummary(SUMMARY.replace("29ac7243-ce36", "deadbeef-ce36")), null);
  assert.equal(previewFromSummary(null), null);
});

test("preview-target: pending, failed, unreadable and ready are four different answers", () => {
  const run = (over) => ({ name: WORKERS_BUILDS_CHECK, app: { slug: WORKERS_BUILDS_APP }, status: "completed", conclusion: "success", output: { summary: SUMMARY }, ...over });
  assert.deepEqual(lookupPreview([]), { state: "pending" });
  assert.deepEqual(lookupPreview([run({ status: "in_progress", conclusion: null })]), { state: "pending" });
  assert.deepEqual(lookupPreview([run({ conclusion: "failure" })]), { state: "failed", conclusion: "failure" });
  assert.deepEqual(lookupPreview([run({ output: { summary: "Build ID: x" } })]), { state: "unreadable" });
  assert.equal(lookupPreview([run()]).state, "ready");
  // A check run with the right NAME from another app is not Workers Builds.
  assert.deepEqual(lookupPreview([run({ app: { slug: "someone-else" } })]), { state: "pending" });
});

const yaml = (rel) => JSON.parse(execFileSync("bun", [
  "-e", "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
  fileURLToPath(new URL(rel, ROOT)),
], { encoding: "utf8" }));

test("preview-check.yml: it builds the HEAD commit and compares the preview of that commit", async () => {
  const wf = yaml(".github/workflows/preview-check.yml");
  const job = wf.jobs.served;
  assert.match(job.if, /head\.repo\.full_name == github\.repository/, "a fork has no preview and a read-only token");
  const checkout = job.steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha }}", "pull_request checks out a merge commit nobody previews");
  assert.equal(checkout.with["persist-credentials"], false);

  // Shell line continuations folded, so a wrapped command reads as one line.
  const runs = job.steps.map((s) => s.run ?? "").join("\n").replace(/\\\n\s*/g, "");
  assert.match(runs, /bun run build\b/);
  assert.match(runs, /served:manifest --commit "\$HEAD_SHA"/);
  assert.match(runs, /preview:target --sha "\$HEAD_SHA"/);
  assert.match(runs, /served:check --origin "\$PREVIEW" --manifest .* --commit "\$HEAD_SHA" --no-attest \$\{prod:\+--since "\$prod"\}/);
  // Expressions reach the shell through env only (gotcha 27's last paragraph).
  for (const step of job.steps) assert.ok(!/\$\{\{/.test(step.run ?? ""), `${step.name} interpolates an expression into run:`);
  // Advisory, and the comment lands before a finding reds the run.
  const names = job.steps.map((s) => s.name);
  assert.ok(names.indexOf("Comment the report on the pull request") < names.indexOf("Fail on a finding"));
  assert.equal(job.steps.at(-1).if, "steps.check.outputs.code == '1'", "only a finding fails the run; exit 2 means nothing was measured");

  const ci = yaml(".github/workflows/ci.yml");
  assert.ok(!Object.keys(ci.jobs).includes("preview"), "the preview check stays out of ci.yml, so validate stays the one required check");
});
