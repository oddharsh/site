// `bun run wrangler:site <command...>`: wrangler, pointed at the SITE Worker's
// config the way that command can read it.
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
