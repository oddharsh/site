// Does production serve what CI built? `bun run served:check`.
//
//   bun run served:check                          # every URL, production's own commit
//   bun run served:check -- --since <commit>      # only URLs that changed since that commit
//   bun run served:check -- --manifest m.json     # a manifest in hand (skips the download)
//   bun run served:check -- --commit <sha>        # expect this commit (stands in when the origin cannot say)
//   bun run served:check -- --origin <preview URL> --manifest m.json --no-attest   # a PR preview
//
// 1. Read the commit production reports (/whoareyou.json `build.commit`, baked in
//    by build.ts step 5e from Workers Builds' WORKERS_CI_COMMIT_SHA).
// 2. Fetch the served manifest CI cut and signed for that commit (the
//    `served-manifest` artifact of ci.yml's push run), and verify the signature
//    with `gh attestation verify`, pinned to ci.yml as the signer.
// 3. GET every URL in it from production and compare decoded sha256.
//
// Exit 0 when every URL matches and the manifest is attested; 1 on a finding (a
// mismatch, a non-200, a redirect, a commit disagreement, an unattested
// manifest); 2 when the instrument could not run (no commit, no manifest, too few
// URLs to mean anything). Same convention as the canary legs.
//
// COST. 716 of the 1850 URLs reach the Worker (2026-10-01); the rest are served
// by the asset layer and cost nothing on the 200K/day observability quota. A full
// run is therefore about 716 Worker invocations, which is why the per-release
// check passes --since and the full one runs nightly.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { downloadManifest as fetchManifest, originBuild } from "./lib/ci-manifest.ts";
import { changedUrls, checkOrigin, parseManifest, type ServedManifest, type UrlResult } from "./lib/served-manifest.ts";

const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "https://aadhar.sh" },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY || "oddharsh/site" },
    commit: { type: "string" },
    manifest: { type: "string" },
    since: { type: "string" },
    concurrency: { type: "string", default: "8" },
    "no-attest": { type: "boolean", default: false },
  },
});

const SIGNER = `${values.repo}/.github/workflows/ci.yml`;
function instrument(msg: string): never { console.error(`served:check: ${msg}`); process.exit(2); }
const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function productionCommit(): Promise<{ commit: string | null; version: string | null }> {
  try { return await originBuild(values.origin); } catch (e) { instrument((e as Error).message); }
}

const downloadManifest = (commit: string) => fetchManifest(values.repo, commit);

function attested(path: string): boolean {
  try {
    // Signed by ci.yml, and by a run on main: a pull_request run of the same
    // workflow builds a merge commit nobody ships, and it never cuts a manifest.
    gh(["attestation", "verify", path, "--repo", values.repo, "--signer-workflow", SIGNER, "--source-ref", "refs/heads/main"]);
    return true;
  } catch (e) {
    const err = (e as { stderr?: string }).stderr?.trim().split("\n").slice(-1)[0];
    console.log(`  attestation: NOT verified (${err || "gh attestation verify failed"})`);
    return false;
  }
}

const live = await productionCommit();
const commit = (values.commit ?? live.commit)?.toLowerCase() ?? null;
if (!commit) instrument(`${values.origin} reports no build commit and no --commit was given (production predates build-info, or this is not a Workers Builds build)`);

const path = values.manifest ?? downloadManifest(commit) ?? instrument(`no served-manifest artifact for ${commit.slice(0, 12)} in ${values.repo}'s ci.yml push runs`);
const manifest: ServedManifest = parseManifest(readFileSync(path, "utf8"));
console.log(`served:check: ${values.origin} version ${live.version?.slice(0, 8) ?? "?"}, commit ${commit.slice(0, 12)}, ${Object.keys(manifest.files).length} URLs in the manifest`);

const findings: string[] = [];
// --commit is an EXPECTATION when the origin names a commit of its own: a
// preview that already moved to a newer push, or a release that never landed,
// would otherwise be compared against the wrong manifest and every changed URL
// would read as a mismatch. It only stands in for the origin when that is silent.
if (values.commit && live.commit && live.commit !== commit) findings.push(`${values.origin} serves ${live.commit.slice(0, 12)}, not the expected ${commit.slice(0, 12)}`);
if (manifest.commit && manifest.commit !== commit) findings.push(`the manifest is for ${manifest.commit.slice(0, 12)}, not the ${commit.slice(0, 12)} being checked`);
if (!values["no-attest"]) {
  if (attested(path)) console.log(`  attestation: verified, signed by ${SIGNER}`);
  else findings.push("the manifest is not attested by ci.yml");
}

let urls = Object.keys(manifest.files);
if (values.since) {
  const prevPath = downloadManifest(values.since.toLowerCase());
  if (prevPath) {
    urls = changedUrls(parseManifest(readFileSync(prevPath, "utf8")), manifest);
    console.log(`  scope: ${urls.length} URLs changed since ${values.since.slice(0, 12)}`);
  } else {
    console.log(`  scope: no manifest for ${values.since.slice(0, 12)}, so checking every URL`);
  }
} else if (urls.length < 1000) {
  instrument(`a full check over ${urls.length} URLs (expected 1000+) would verify a collapsed manifest`);
}

const results: UrlResult[] = await checkOrigin(manifest, { origin: values.origin, urls, concurrency: Number(values.concurrency) });
const by = new Map<string, UrlResult[]>();
for (const r of results) by.set(r.verdict, [...(by.get(r.verdict) ?? []), r]);
for (const [verdict, rs] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${verdict}: ${rs.length}`);
  if (verdict === "match") continue;
  for (const r of rs.slice(0, 20)) console.log(`    ${r.url}${r.detail ? `  (${r.detail})` : ""}`);
  if (rs.length > 20) console.log(`    … and ${rs.length - 20} more`);
  findings.push(`${rs.length} URL(s) ${verdict}`);
}

if (findings.length) {
  console.log(`served:check: FINDING: ${findings.join("; ")}`);
  process.exit(1);
}
console.log(`served:check: ${values.origin} serves what CI built, ${results.length} of ${results.length} URLs`);
