#!/usr/bin/env node
// served-pages.ts: what this checkout's Worker serves for each page, as one hash
// per page. browser:check runs it in a checkout of the base and in HEAD, and
// reads only the pages whose hash moved.
//
//   node tools/served-pages.ts <out.json> /path /other/path ...
//
// A page's hash covers its status, its headers and its decoded body. Its
// subresources need no hash of their own: every /a/ URL names its bytes, so a
// changed stylesheet or script changes the document that links it. Replayed
// over 60 merges on 2026-11-17, hashing the document alone and hashing it with
// every same-origin URL it names picked the same pages every time.
//
// The page list comes from the caller, so both checkouts hash the same paths;
// a page HEAD adds answers 404 on the base and counts as changed.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createTestHarness } from "wrangler";
import { writeSiteConfigFile } from "./lib/site-config.ts";

/**
 * Headers that differ between two runs on one commit. The harness rebuilds
 * .build/ on every boot, and the local asset server's ETag moves with the file,
 * not its bytes: 71 of 77 pages differed on etag alone across two boots on
 * 2026-11-17. Neither header changes what a browser renders.
 */
const VOLATILE = new Set(["date", "etag"]);

const [out, ...pages] = process.argv.slice(2);
if (!out || pages.length === 0) throw new Error("usage: served-pages.ts <out.json> /path ...");
const root = new URL("..", import.meta.url).pathname;
const server = createTestHarness({
  workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${root}counter/wrangler.jsonc` }],
});
try {
  const base = String((await server.listen()).url).replace(/\/$/, "");
  const hashes: Record<string, string> = {};
  for (const path of pages) {
    const res = await fetch(base + path, { headers: { "sec-fetch-dest": "document" }, redirect: "manual" });
    const headers = [...res.headers].filter(([name]) => !VOLATILE.has(name)).sort(([a], [b]) => a.localeCompare(b));
    hashes[path] = createHash("sha256")
      .update(`${res.status}\n${headers.map(([n, v]) => `${n}: ${v}`).join("\n")}\n\n`)
      .update(Buffer.from(await res.arrayBuffer()))
      .digest("hex")
      .slice(0, 16);
  }
  writeFileSync(out, JSON.stringify(hashes, null, 1));
} finally {
  // workerd holds the process open; close() before exiting.
  await server.close();
}
process.exit(0);
