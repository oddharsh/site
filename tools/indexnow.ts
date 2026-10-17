// Submit the pages a release changed to IndexNow: `bun run indexnow`.
//
//   bun run indexnow -- --since <previous release commit>            # submit
//   bun run indexnow -- --since <commit> --commit <commit> --dry-run # just list
//
// Reads the commit production reports, downloads the served manifests ci.yml
// cut for it and for --since, and submits every sitemap page whose CONTENT
// changed between them (tools/lib/indexnow.ts says what that means). The
// after-release job in promote-production.yml runs it once per release.
//
// It never submits the whole site: with no --since, or no manifest for it, it
// submits nothing and says why. Exit 0 when it submitted or had nothing to
// submit; 1 when IndexNow refused; 2 when it could not tell what changed.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { downloadManifest, originBuild } from "./lib/ci-manifest.ts";
import { changedPages, INDEXNOW_ENDPOINT, INDEXNOW_KEY, readStatus, sitemapPaths, submission } from "./lib/indexnow.ts";
import { parseManifest } from "./lib/served-manifest.ts";

const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "https://aadhar.sh" },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY || "oddharsh/site" },
    since: { type: "string" },
    commit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const host = new URL(values.origin).host;
const say = (msg: string) => console.log(`indexnow: ${msg}`);
function instrument(msg: string): never { console.error(`indexnow: ${msg}`); process.exit(2); }

if (!values.since) { say("no --since, so there is no previous release to diff against; submitted nothing"); process.exit(0); }
const commit = (values.commit ?? (await originBuild(values.origin)).commit)?.toLowerCase();
if (!commit) instrument(`${values.origin} reports no build commit and no --commit was given`);

const nextPath = downloadManifest(values.repo, commit) ?? instrument(`no served-manifest for ${commit.slice(0, 12)}`);
const prevPath = downloadManifest(values.repo, values.since.toLowerCase());
if (!prevPath) { say(`no served-manifest for ${values.since.slice(0, 12)} (it predates #1073), so nothing to diff; submitted nothing`); process.exit(0); }
const next = parseManifest(readFileSync(nextPath, "utf8"));
const prev = parseManifest(readFileSync(prevPath, "utf8"));

// The live sitemap, not the checkout's: what is indexable is what production says.
const sm = await fetch(new URL("/sitemap.xml", values.origin));
if (!sm.ok) instrument(`${values.origin}/sitemap.xml answered ${sm.status}`);
const paths = sitemapPaths(await sm.text(), host);
if (paths.length < 30) instrument(`the sitemap lists ${paths.length} pages (expected 30+); did its shape change?`);

const urls = changedPages(prev, next, paths, host);
say(`${values.since.slice(0, 12)} -> ${commit.slice(0, 12)}: ${urls.length} of ${paths.length} sitemap pages changed content`);
for (const u of urls) say(`  ${u}`);
if (!urls.length) process.exit(0);
if (values["dry-run"]) { say("dry run, submitted nothing"); process.exit(0); }

// The engines fetch the key file to verify ownership, so a key the origin does
// not serve turns every submission into a 403. Check it first and say so.
const keyFile = await fetch(new URL(`/${INDEXNOW_KEY}.txt`, values.origin));
if (!keyFile.ok || (await keyFile.text()).trim() !== INDEXNOW_KEY) instrument(`${values.origin}/${INDEXNOW_KEY}.txt does not serve the key`);

const r = await fetch(INDEXNOW_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(submission(host, urls)),
});
const verdict = readStatus(r.status);
say(`IndexNow answered ${r.status}: ${verdict.meaning}`);
process.exit(verdict.ok ? 0 : 1);
