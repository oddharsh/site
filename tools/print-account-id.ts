#!/usr/bin/env node
// Print `CLOUDFLARE_ACCOUNT_ID=<id>` for a GitHub Actions `$GITHUB_ENV` append.
//
// deploy:promote needs the account id in CI as well as the token, and the reason
// is not obvious: this login can see more than one account, and wrangler cannot
// pick one non-interactively. Without it the ramp dies with "More than one
// account available", which reads exactly like a bad credential and is not.
import { siteConfig } from "./lib/site-config.ts";
import { asText } from "../src/worker/lib/parse.ts";

const config = await siteConfig();
const id = config?.account_id;

const account = asText(id);
if (account === null) {
  console.error("print-account-id: cloudflare.config.ts declares no accountId");
  process.exit(1);
}

process.stdout.write(`CLOUDFLARE_ACCOUNT_ID=${account}\n`);
