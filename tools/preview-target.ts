// Wait for a commit's Workers Builds preview and print its URL:
// `bun run preview:target -- --sha <commit> [--wait 900]`.
//
// Polls the commit's check runs until "Workers Builds: aadhar-sh" completes,
// then prints the VERSION preview URL (tools/lib/preview-target.ts says why that
// one and not the branch alias). Under GitHub Actions it also writes `url` and
// `version` to $GITHUB_OUTPUT.
//
// Exit 0 with a URL; 1 when the build failed; 2 when it never finished inside
// the wait, or finished with a summary this cannot read.

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lookupPreview, WORKERS_BUILDS_CHECK, type CheckRun } from "./lib/preview-target.ts";

const { values } = parseArgs({
  options: {
    sha: { type: "string" },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY || "oddharsh/site" },
    wait: { type: "string", default: "900" },
    every: { type: "string", default: "20" },
  },
});

const sha = values.sha?.toLowerCase() ?? "";
if (!/^[0-9a-f]{40}$/.test(sha)) { console.error(`preview-target: --sha ${JSON.stringify(values.sha)} is not a 40-hex commit`); process.exit(2); }
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const deadline = Date.now() + Number(values.wait) * 1000;
const headers = new Headers({ accept: "application/vnd.github+json" });
// Public repo, so the token is rate-limit headroom rather than access.
if (token) headers.set("authorization", `Bearer ${token}`);
const api = `https://api.github.com/repos/${values.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(WORKERS_BUILDS_CHECK)}&per_page=100`;

for (;;) {
  const r = await fetch(api, { headers });
  if (!r.ok) { console.error(`preview-target: GitHub answered ${r.status} for ${sha.slice(0, 12)}'s check runs`); process.exit(2); }
  const runs = ((await r.json()).check_runs ?? []) as CheckRun[];
  const found = lookupPreview(runs);
  if (found.state === "ready") {
    console.log(`preview-target: ${sha.slice(0, 12)} is version ${found.target.version.slice(0, 8)} at ${found.target.url}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${found.target.url}\nversion=${found.target.version}\n`);
    process.exit(0);
  }
  if (found.state === "failed") { console.error(`preview-target: Workers Builds concluded ${found.conclusion} for ${sha.slice(0, 12)}; there is no preview to check`); process.exit(1); }
  if (found.state === "unreadable") { console.error(`preview-target: Workers Builds finished but its summary names no preview URL this trusts`); process.exit(2); }
  if (Date.now() > deadline) { console.error(`preview-target: no completed Workers Builds check for ${sha.slice(0, 12)} after ${values.wait}s`); process.exit(2); }
  await new Promise((done) => setTimeout(done, Number(values.every) * 1000));
}
