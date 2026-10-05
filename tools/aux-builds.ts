#!/usr/bin/env bun
// Connect the auxiliary Workers to Workers Builds with Cloudflare's `cf` CLI,
// using the settings docs/MAINTENANCE.md declares ("Auxiliary Workers deploy
// themselves"). Workstation only, like infra:apply: it needs a credential that
// can write Workers Builds configuration, and CI's token must stay read-only.
//
//   bun tools/aux-builds.ts            plan: print what would be created
//   bun tools/aux-builds.ts --apply    create the missing triggers
//
// Log in first (`bunx cf auth login`) or export a token with
// "Workers Builds Configuration: Edit" as CLOUDFLARE_API_TOKEN. Each Worker
// borrows the repository connection and build token from aadhar-sh's existing
// production trigger, so the repo connection the site already uses is reused.
// A Worker that already has a trigger is skipped, so a re-run is safe.

import { tmpdir } from "node:os";

const CF = ["bunx", "cf@1.0.0-beta.12"];
// The account every Worker here lives on (also in lwe-ask/cloudflare.config.ts).
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "1c99acdb6141579023fb97d24261ea58";
const APPLY = process.argv.includes("--apply");

const DEPLOY = "bash .github/deploy-wrangler.sh deploy --x-provision=false --x-auto-create=false";
const SHARED = ["src/worker/lib/*"];
const WORKERS = [
  { name: "cf-garage", dir: "cf-garage", paths: ["cf-garage/*", ...SHARED] },
  { name: "lwe-ask", dir: "lwe-ask", paths: ["lwe-ask/*", ...SHARED] },
  { name: "lens-reader", dir: "lens-reader", paths: ["lens-reader/*", ...SHARED] },
  { name: "aadhar-counter", dir: "counter", paths: ["counter/*", "cal/src/reservation.ts", ...SHARED] },
];

async function cf(args: string[]): Promise<any> {
  // Run outside the repo: cf loads ./cloudflare.config.ts from its working
  // directory, and nothing here needs the site's config. That also means the
  // account comes from ACCOUNT rather than from a config file.
  const proc = Bun.spawn([...CF, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`cf ${args.slice(0, 3).join(" ")} failed`);
  let parsed: any = null;
  try {
    parsed = out.trim() ? JSON.parse(out) : null;
  } catch {
    throw new Error(`cf ${args.slice(0, 3).join(" ")} printed something other than JSON:\n${out.slice(0, 500)}`);
  }
  return parsed?.result ?? parsed;
}

async function tagOf(name: string): Promise<string> {
  const found: any[] = (await cf(["workers", "scripts", "search", "--name", name])) ?? [];
  const hit = found.find((s) => (s.script_name ?? s.name) === name);
  if (!hit) throw new Error(`no Worker named ${name} on this account`);
  return hit.id ?? hit.tag;
}

const triggersOf = async (tag: string): Promise<any[]> =>
  (await cf(["builds", "triggers", "list", "--external-script-id", tag])) ?? [];

const site = (await triggersOf(await tagOf("aadhar-sh"))).find((t) => t.branch_includes?.includes("production"));
const repoConnection = site?.repo_connection_uuid ?? site?.repo_connection?.repo_connection_uuid;
const buildToken = site?.build_token_uuid ?? site?.build_token?.build_token_uuid;
if (!repoConnection || !buildToken) {
  throw new Error("could not read the repo connection and build token from aadhar-sh's production trigger");
}

for (const w of WORKERS) {
  const tag = await tagOf(w.name);
  if ((await triggersOf(tag)).length) {
    console.log(`${w.name}: already has a trigger, skipping`);
    continue;
  }
  const create = [
    "builds", "triggers", "create",
    "--trigger-name", `${w.name} production`,
    "--external-script-id", tag,
    "--repo-connection-uuid", repoConnection,
    "--build-token-uuid", buildToken,
    "--root-directory", ".",
    "--build-command", "",
    "--deploy-command", DEPLOY,
    "--branch-includes", "production",
    "--branch-excludes",
    "--path-includes", ...w.paths,
    "--path-excludes",
  ];
  const vars = JSON.stringify({
    SKIP_DEPENDENCY_INSTALL: { value: "true", is_secret: false },
    WRANGLER_CWD: { value: w.dir, is_secret: false },
  });
  if (!APPLY) {
    console.log(`${w.name}: would create a production trigger watching ${w.paths.join(", ")} with WRANGLER_CWD=${w.dir}`);
    continue;
  }
  const trigger = await cf(create);
  const uuid = trigger?.trigger_uuid ?? trigger?.uuid;
  if (!uuid) throw new Error(`${w.name}: trigger created but no uuid came back; set its variables in the dashboard`);
  await cf(["builds", "triggers", "environment-variables", "upsert", uuid, "--body", vars]);
  console.log(`${w.name}: created trigger ${uuid}`);
}
if (!APPLY) console.log("\nPlan only. Re-run with --apply to create these.");
