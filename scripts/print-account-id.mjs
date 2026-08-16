#!/usr/bin/env node
// Print `CLOUDFLARE_ACCOUNT_ID=<id>` for a GitHub Actions `$GITHUB_ENV` append.
//
// deploy:promote needs the account id in CI as well as the token, and the reason
// is not obvious: this login can see more than one account, and wrangler cannot
// pick one non-interactively. Without it the ramp dies with "More than one
// account available", which reads exactly like a bad credential and is not.
//
// The id is NOT a secret — it is committed in wrangler.jsonc and again in
// config/infra.json — so the only question is where CI should read it from. A
// repo variable would be dashboard state that no config here can derive and that
// infra:check cannot see, which is the same argument that keeps the Workers
// Builds commands declared. So this reads the deploy config itself: the account
// CI authenticates against cannot drift from the account the deploy targets,
// because they are one string.
import { readFile } from "node:fs/promises";
import { parseJsonc } from "./lib/jsonc.mjs";
import { asText } from "../src/worker/lib/parse.js";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);

const config = parseJsonc(await readFile(CONFIG, "utf8"));
const id = config?.account_id;

if (asText(id) === null) {
  console.error("print-account-id: wrangler.jsonc declares no account_id");
  process.exit(1);
}

process.stdout.write(`CLOUDFLARE_ACCOUNT_ID=${id}\n`);
