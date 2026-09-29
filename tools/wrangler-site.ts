// `bun run wrangler:site <command...>`: wrangler, pointed at the SITE Worker's
// config the way that command can read it.
//
// This is what `bun run wrangler <command> -c wrangler.jsonc` was until
// 2026-09-28, when cloudflare.config.ts replaced that file. No single flag
// works for every command any more: the ones that build a Worker (deploy,
// build, versions upload) read the TypeScript config behind --x-new-config, and
// every other command refuses that flag as unknown and needs the generated
// legacy file instead. siteWranglerArgs() in lib/site-config.ts makes the
// split, so a runbook can say one thing:
//
//   bun run wrangler:site versions secret put ICAL_URL
//   bun run wrangler:site versions list
//   bun run wrangler:site d1 execute RESTORE_DB --remote --command "SELECT 1"
import { spawnSync } from "node:child_process";
import { siteWranglerArgs } from "./lib/site-config.ts";
import { wranglerCommand } from "./lib/wrangler-bin.ts";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: bun run wrangler:site <wrangler command...>");
  process.exit(2);
}
const [cmd, argv] = wranglerCommand(await siteWranglerArgs(args));
const result = spawnSync(cmd, argv, { stdio: "inherit" });
process.exit(result.status ?? 1);
