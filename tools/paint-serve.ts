#!/usr/bin/env node
// paint-serve.ts: boot this checkout's Worker in-process, print its URL as one
// JSON line, and serve until stdin closes. tools/paint-diff.ts copies it into
// the base checkout and runs it in both, so each side is built and served by
// its own code and the same boot.
import { createTestHarness } from "wrangler";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = new URL("..", import.meta.url).pathname;
const server = createTestHarness({
  workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${root}counter/wrangler.jsonc` }],
});
const { url } = await server.listen();
console.log(JSON.stringify({ url: String(url).replace(/\/$/, "") }));
process.stdin.resume();
// workerd holds the process open until the harness closes.
process.stdin.on("end", () => void server.close().then(() => process.exit(0)));
