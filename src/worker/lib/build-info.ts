// Which commit built this Worker, as the BUILDER reported it.
//
// CF_VERSION_METADATA names a Worker VERSION, and a version is an upload: it
// carries no commit, and `wrangler versions view` on a production version shows
// only `workers/triggered_by` (read 2026-10-01). So nothing on the wire could say
// which source a release came from, and "production serves what CI built" had no
// way to name the CI run it meant. This is that link.
//
// build.ts step 5e rewrites the marker line in the STAGED copy from the three
// variables Workers Builds sets on every build: WORKERS_CI_COMMIT_SHA,
// WORKERS_CI_BRANCH and WORKERS_CI_BUILD_UUID. Every other build (bun run dev,
// the contract suite, CI's own dry-run) leaves it null, and /whoareyou.json then
// omits the fields rather than inventing one: a local build of a dirty tree has
// no honest commit to report, and a GitHub run's GITHUB_SHA on a pull request is
// a merge commit nobody deploys.
//
// It lives in the WORKER and never in the static tree on purpose. A commit in a
// served file would change that file on every deploy, which re-mints whatever
// hashes it and breaks the property tools/check-served.ts verifies: that the
// static tree is a pure function of the commit's source, identical from any
// builder.

export interface BuildInfo {
  /** 40-hex commit the builder checked out. */
  commit: string;
  /** Branch the push came from; "production" for a release. */
  branch: string | null;
  /** Workers Builds' own build id, which names its log in the dashboard. */
  build: string | null;
}

export const BUILD_INFO: BuildInfo | null = null; // build:build-info
