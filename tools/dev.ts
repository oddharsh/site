// dev.ts: `bun run dev`. Local dev on the TypeScript config, through `cf dev`.
//
//   bun run dev                 # stage the farm, boot Counter, then cf dev
//   bun run dev -- --port 8790  # anything after -- goes to cf dev
//
// TWO PROCESSES, ONE REGISTRY. The site Worker binds COUNTER to a class in
// ANOTHER Worker (aadhar-counter), so dev has to run that Worker too. Wrangler
// did it in one process with `-c .wrangler.dev.jsonc -c counter/wrangler.jsonc`,
// which needed config/dev/ projected to JSON first, because a TypeScript config
// refuses `-c`. `cf dev` refuses it as well: its delegate (wrangler's
// cf-wrangler.js) parses only --mode, --host, --port and --local, and runs with
// MULTIWORKER off. What both DO support is the dev registry: a Worker in one
// `wrangler dev` process binds a Durable Object served by another, and the
// binding table reads `[connected]`. Measured 2026-10-05 (cf 1.0.0-beta.5,
// wrangler f025bbf): COUNTER connected and /hit?peek=1 answered digits.
//
// THE REGISTRY IS PINNED HERE, for two reasons. cf points its delegate at its
// own registry directory (CLOUDFLARE_REGISTRY_PATH) while plain `wrangler dev`
// uses ~/.wrangler/registry, so by default the two never meet and COUNTER stays
// `[not connected]`. And a shared registry would let another checkout's dev
// server answer for aadhar-counter. One directory under this checkout's
// .wrangler/ (gitignored) fixes both.
//
// cf is a GLOBAL tool here (`bun add -g cf`), never a tree dependency:
// docs/DEPENDENCIES.md has why (it pins a second workerd). It finds the dev
// server through config/dev/package.json, which names the root's exact wrangler
// so check-wrangler holds the two byte for byte.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FARM, stage } from "./dev-stage.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = resolve(ROOT, ".wrangler", "dev-registry");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const READY_MS = 90_000;

const cf = spawnSync("cf", ["--version"], { encoding: "utf8" });
if (cf.error || cf.status !== 0) {
  console.error("dev: `cf` is not on PATH. Install it once with `bun add -g cf`; docs/MAINTENANCE.md (Local dev) has the rest.");
  process.exit(2);
}

const freePort = () => new Promise<number>((done, fail) => {
  const s = createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

const { links, dirs, skipped } = await stage();
console.log(`dev: ${FARM}/ ready, ${links} links across ${dirs} merged director${dirs === 1 ? "y" : "ies"}`);
for (const path of skipped) console.warn(`dev: left out ${path} (the build derives it; this copy is a local leftover)`);
mkdirSync(REGISTRY, { recursive: true });

// Counter first, so the site boots with COUNTER already [connected]. Its own
// ports are free ones, since the site takes wrangler's defaults (gotcha 39:
// another checkout's dev server can own the port you meant).
const [port, inspector] = [await freePort(), await freePort()];
const counter = spawn(process.execPath, [
  WRANGLER, "dev", "-c", "counter/wrangler.jsonc",
  "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_REGISTRY_PATH: REGISTRY } });

let site: ChildProcess | null = null;
const stopAll = (code: number) => {
  counter.kill("SIGTERM");
  site?.kill("SIGTERM");
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stopAll(130));

const ready = await new Promise<boolean>((done) => {
  const timer = setTimeout(() => done(false), READY_MS);
  const relay = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      console.log(`[counter] ${line}`);
      if (line.includes("Ready on")) { clearTimeout(timer); done(true); }
    }
  };
  counter.stdout?.on("data", relay);
  counter.stderr?.on("data", relay);
  counter.once("exit", () => { clearTimeout(timer); done(false); });
});
if (!ready) {
  console.error(`dev: aadhar-counter did not come up within ${READY_MS / 1000}s; the site would boot with COUNTER [not connected]`);
  stopAll(1);
}

site = spawn("cf", ["dev", ...process.argv.slice(2)], {
  cwd: join(ROOT, "config", "dev"),
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_REGISTRY_PATH: REGISTRY },
});
site.once("exit", (code) => stopAll(code ?? 1));
counter.once("exit", (code) => {
  console.error(`dev: aadhar-counter exited (${code}); COUNTER is no longer connected, stopping`);
  stopAll(code ?? 1);
});
