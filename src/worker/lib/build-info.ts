// Which commit built this Worker, as the BUILDER reported it.
//
// CF_VERSION_METADATA names a Worker VERSION, and a version is an upload: it
// carries no commit, and `wrangler versions view` on a production version shows
// only `workers/triggered_by` (read 2026-10-01). So nothing on the wire could say
// which source a release came from, and "production serves what CI built" had no
// way to name the CI run it meant. This is that link.

export interface BuildInfo {
  commit: string;
  branch: string | null;
  build: string | null;
}

export const BUILD_INFO: BuildInfo | null = null; // build:build-info
