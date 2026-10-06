// Cloudflare's `cf` CLI, for the account work tools do from a workstation:
// reading and moving deployments, querying D1, writing KV, Browser Run
// sessions, Workers Builds triggers. Building, deploying, dev and the tests
// stay on wrangler; gotcha 50 says why.
//
// cf is never a tree dependency, because its CLI pins a second miniflare and
// workerd. `bun x` fetches exactly CF_VERSION into bun's cache on first use, so
// every tool runs the same cf without anyone installing it. Log in once with
// `bun run cf auth login` (tools/cf.ts), or export CLOUDFLARE_API_TOKEN.
//
// Every call runs from a temp directory: cf loads ./cloudflare.config.ts from
// its working directory, and none of these commands need the site's config.
// The account therefore comes from CLOUDFLARE_ACCOUNT_ID, defaulting to the
// accountId in cloudflare.config.ts.
//
// The commands here are thin API wrappers, so their JSON is the Cloudflare API
// response, not wrangler's reshaped output. Callers normalize field names.

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { wranglerErrorLines } from "./wrangler-error.ts";

export const CF_VERSION = "1.0.0-beta.12";
export const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "1c99acdb6141579023fb97d24261ea58";

const exec = promisify(execFile);

/** The argv for one cf call: `bun x cf@<pin> ...args`. */
export function cfCommand(args: string[] = []): [cmd: string, argv: string[]] {
  return ["bun", ["x", `cf@${CF_VERSION}`, ...args]];
}

/** Run cf and return its parsed JSON, unwrapped from an API envelope if one
 *  comes back. Throws with cf's own stderr, never a spawn dump. */
export async function cf(args: string[], { maxBuffer = 64 * 1024 * 1024 } = {}): Promise<any> {
  const [cmd, argv] = cfCommand(args);
  let stdout: string;
  try {
    ({ stdout } = await exec(cmd, argv, {
      cwd: tmpdir(),
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, NO_COLOR: "1" },
      maxBuffer,
    }));
  } catch (e: any) {
    // The same reading wrangler's failures get: stderr's first real lines,
    // colour codes off.
    const said = wranglerErrorLines(e).join("\n    ");
    throw new Error(`cf ${args.slice(0, 3).join(" ")} failed:\n    ${said}`);
  }
  if (!stdout.trim()) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`cf ${args.slice(0, 3).join(" ")} printed something other than JSON:\n${stdout.slice(0, 500)}`);
  }
  // cf prints the API's `result` already; unwrap a whole envelope if one comes.
  return parsed?.result ?? parsed;
}

/** Rows from one D1 statement, by database id. The API answers one result
 *  object per statement, the same shape `wrangler d1 execute --json` printed. */
export async function d1Rows(databaseId: string, sql: string): Promise<any[]> {
  const out = await cf(["d1", "query", databaseId, "--sql", sql]);
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || !Array.isArray(first.results)) throw new Error(`cf d1 query returned no results array for: ${sql.slice(0, 60)}`);
  return first.results;
}

// The D1 databases tools read, from cloudflare.config.ts's bindings. Named here
// because `cf d1 query` takes the id, where wrangler resolved the name.
export const D1 = Object.freeze({
  "aadhar-restore": "88c8daf1-3a36-4f8e-a2ad-dba8a74e1b9f",
  serendipity: "d3aa3215-17c3-4389-b224-cf465ddbb786",
});
