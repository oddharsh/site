// `bun run cf <command...>`: Cloudflare's cf CLI at the version tools/lib/cf.ts
// pins, on this site's account, run from outside the repository so it never
// loads cloudflare.config.ts. The workstation's one way in:
//
//   bun run cf auth login
//   bun run cf workers deployments list --worker aadhar-sh
//   bun run cf d1 query 88c8daf1-3a36-4f8e-a2ad-dba8a74e1b9f --sql "SELECT 1"
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { CF_ACCOUNT, cfCommand } from "./lib/cf.ts";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: bun run cf <cf command...>");
  process.exit(2);
}
const [cmd, argv] = cfCommand(args);
const result = spawnSync(cmd, argv, {
  stdio: "inherit",
  cwd: tmpdir(),
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT },
});
process.exit(result.status ?? 1);
