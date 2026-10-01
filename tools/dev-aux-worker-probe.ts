#!/usr/bin/env node
// node tools/dev-aux-worker-probe.ts [wrangler entry]
//
// Can wrangler's TypeScript config boot LOCAL DEV the way `bun run dev` needs:
// the site Worker from config/dev/ with counter/wrangler.jsonc beside it in
// the same process, so COUNTER is bound? It prints one JSON line,
// `{ refused, booted, counterBound, detail }`, and `interpretDevAuxProbe` in
// lib/upstream-watches.ts reads it for the `new-config-dev-boots-auxiliary-workers`
// watch.
//
// WHY IT EXISTS. Local dev is authored as a native-shaped pair in config/dev/
// since 2026-10-01, and today a projection turns it into .wrangler.dev.jsonc
// for `wrangler dev -c`. The one thing keeping dev off the TS loader itself is
// this: under --x-new-config wrangler refuses `-c` outright ("--config is not
// supported with --experimental-new-config", measured on 4.146.0), and the
// site's COUNTER binding names a class in ANOTHER Worker, which dev can only
// bind if that Worker boots too. When this reads landed, `cd config/dev &&
// wrangler dev --x-new-config` can replace the projection step.
//
// It tries the `-c` door because that is the one wrangler has for every other
// config. If Cloudflare ships multi-worker dev through a different door (a
// field in wrangler.config.ts, say), this keeps reading `refused` while the
// need is met, and the retired `wrangler-types-accepts-x-new-config` watch is
// the precedent for that failure: extend the probe with the new door then.
//
// It boots on a free port it picks itself (gotcha 39: another checkout's dev
// server can own the port you meant), and the only thing it may create is an
// EMPTY .dev-assets when none exists, since wrangler refuses a missing assets
// directory and /hit is a Worker route that needs no asset. It never rebuilds
// the farm, which would pull files out from under a running dev server.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2] || join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

const report = (r: { refused: boolean; booted: boolean; counterBound: boolean; detail: string }) => console.log(JSON.stringify(r));

if (!existsSync(join(ROOT, ".dev-assets"))) mkdirSync(join(ROOT, ".dev-assets"));
const port = await freePort(), inspector = await freePort();
const child = spawn(process.execPath, [
  entry, "dev", "--x-new-config", "-c", join(ROOT, "counter", "wrangler.jsonc"),
  "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
], { cwd: join(ROOT, "config", "dev"), detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });

let output = "";
const ready = new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 90_000);
  const scan = (chunk: Buffer) => {
    output += chunk.toString();
    if (/Ready on http/.test(output)) { clearTimeout(timer); resolve(true); }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.once("exit", () => { clearTimeout(timer); resolve(false); });
});

try {
  if (!(await ready)) {
    const refused = /--config is not supported with --experimental-new-config/.test(output);
    const last = output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "no output";
    report({ refused, booted: false, counterBound: false, detail: refused ? "refuses -c under --x-new-config" : `did not boot: ${last.slice(0, 160)}` });
  } else {
    // The homepage odometer reads COUNTER: six dashes when the binding is not
    // connected, digits when it is (measured 2026-10-01, both states).
    const body = await (await fetch(`http://127.0.0.1:${port}/hit?peek=1`)).text();
    const digits = body.match(/visitor (\d{6})/)?.[1];
    report({ refused: false, booted: true, counterBound: !!digits, detail: digits ? `booted with COUNTER bound (visitor ${digits})` : "booted, but COUNTER is not bound" });
  }
} finally {
  // wrangler forks workerd; signalling the process GROUP takes both down.
  try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
}
