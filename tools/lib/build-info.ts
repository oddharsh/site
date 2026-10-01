// The commit a Workers Builds build checked out, read from the variables it sets
// (https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), and
// the marker-line rewrite that bakes it into the staged Worker. build.ts step 5e
// is the only caller; src/worker/lib/build-info.ts says why the commit lives in
// the Worker and nowhere in the static tree.
//
// Pure and node-safe so the contract suite can drive it without running a build.

export interface BuildInfo {
  commit: string;
  branch: string | null;
  build: string | null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const MARKER = /^export const BUILD_INFO: BuildInfo \| null = .*; \/\/ build:build-info$/m;

/**
 * null outside Workers Builds. A malformed commit THROWS rather than reading as
 * absent, because the one builder that sets it is the one that ships, and a
 * release reporting no commit is exactly the silent gap this exists to close.
 */
export function buildInfoFromEnv(env: Record<string, string | undefined>): BuildInfo | null {
  const raw = env.WORKERS_CI_COMMIT_SHA;
  if (raw === undefined || raw === "") return null;
  const commit = raw.trim().toLowerCase();
  if (!COMMIT.test(commit)) throw new Error(`build-info: WORKERS_CI_COMMIT_SHA is ${JSON.stringify(raw)}, not a 40-hex commit`);
  return {
    commit,
    branch: env.WORKERS_CI_BRANCH?.trim() || null,
    build: env.WORKERS_CI_BUILD_UUID?.trim() || null,
  };
}

/** Rewrite the marker line; throws if it is missing, so a renamed export fails the build. */
export function bakeBuildInfo(source: string, info: BuildInfo | null): string {
  if (!MARKER.test(source)) throw new Error("build-info: the `// build:build-info` marker line was not found in lib/build-info.ts");
  return source.replace(MARKER, `export const BUILD_INFO: BuildInfo | null = ${JSON.stringify(info)}; // build:build-info`);
}
