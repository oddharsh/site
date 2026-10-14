// Local dev is production plus an OVERLAY, since 2026-10-01. config/dev/
// spreads cloudflare.config.ts and overrides what dev means to change: it runs
// the readable Worker source over the .dev-assets farm, with no build, no
// minification and no Workers Cache, and reaches the three bindings that have no
// local simulation remotely. Everything else is production's by construction.
import { existsSync, readFileSync } from "node:fs";
import { assert, configText, test } from "./contract-shared.ts";
import { parseJsonc } from "./lib/jsonc.ts";

const OVERLAY = [
  /^main$/,
  /^build\./,
  /^minify$/, /^upload_source_maps$/, /^keep_names$/,
  /^assets\.directory$/,
  /^cache\.enabled$/,
  /^exports\.[^.]+\.cache\.enabled$/,
  /^(browser|images|ai)\.remote$/,
];

const leaves = (config) => {
  const keyed = JSON.parse(JSON.stringify(config, (_, v) =>
    Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && (x.binding || x.name))
      ? Object.fromEntries(v.map((x) => [x.binding || x.name, x]))
      : v));
  const out = new Map();
  const walk = (v, path) => {
    if (v && typeof v === "object") for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k);
    else out.set(path, JSON.stringify(v));
  };
  walk(keyed, "");
  return out;
};

const forks = (prod, dev) => {
  const p = leaves(prod), d = leaves(dev);
  const paths = new Set([...p.keys(), ...d.keys()]);
  return { compared: paths.size, forked: [...paths].filter((k) => p.get(k) !== d.get(k) && !OVERLAY.some((re) => re.test(k))).sort() };
};

const load = async () => ({
  prod: parseJsonc(await configText("cloudflare.config.ts")),
  dev: parseJsonc(await configText("config/dev")),
});

test("the dev config differs from production only in the overlay's keys", async () => {
  const { prod, dev } = await load();
  const { compared, forked } = forks(prod, dev);
  assert.ok(compared >= 200, `compared only ${compared} leaves; a projection has lost a block`);
  assert.deepEqual(forked, [], "config/dev/ overrides keys outside the overlay, so local dev is no longer production; move the change to cloudflare.config.ts or add the key to OVERLAY with its reason");
  // run_worker_first is ORDER-sensitive (first match wins), which the leaf walk
  // only sees by index; say it in its own words.
  assert.deepEqual(dev.assets.run_worker_first, prod.assets.run_worker_first);
});

test("the fork check can see dev forking production, which is what it exists for", async () => {
  const { prod, dev } = await load();
  const baseline = new Set(forks(prod, dev).forked);
  const added = (config) => forks(prod, config).forked.filter((k) => !baseline.has(k));
  const crons = structuredClone(dev);
  crons.triggers.crons = crons.triggers.crons.slice(1);
  assert.ok(added(crons).some((k) => k.startsWith("triggers.crons")), "dropping a cron must read as a fork");
  const limit = structuredClone(dev);
  limit.ratelimits.find((r) => r.name === "LENS_RL_SHOT").simple.limit = 99;
  assert.deepEqual(added(limit), ["ratelimits.LENS_RL_SHOT.simple.limit"]);
  const kv = structuredClone(dev);
  kv.kv_namespaces[0].remote = true;
  assert.equal(added(kv).length, 1, "a remote KV in dev is a fork, not overlay");
});

test("the overlay holds what dev means by it", async () => {
  const { prod, dev } = await load();
  assert.equal(dev.main, prod.main.replace(/^\.build\//, ""), "dev runs the source path build.ts stages the Worker from");
  assert.ok(existsSync(dev.main), `${dev.main} does not exist`);
  assert.equal(dev.build, undefined, "dev must not run the production build");
  assert.equal(dev.cache?.enabled, false);
  for (const [name, e] of Object.entries(dev.exports ?? {})) {
    if (e.type === "worker") assert.equal(e.cache.enabled, false, `entrypoint ${name} must be uncached in dev`);
  }
  for (const key of ["browser", "images", "ai"]) {
    assert.equal(dev[key]?.remote, true, `dev must reach ${key} remotely; it has no local simulation`);
    assert.equal(prod[key]?.remote, undefined, `the production projection must not carry ${key}.remote`);
  }
});

test("the dev pair is native-shaped, so TS-native dev is a file move rather than a rewrite", async () => {
  // Wrangler's TS loader reads cloudflare.config.ts from the WORKING DIRECTORY
  // and resolves paths against it. Read the authored value, not the projection,
  // and resolve it from config/dev the way `wrangler dev --x-new-config` would.
  const { default: raw } = await import("../config/dev/cloudflare.config.ts");
  const fromDev = new URL(`../config/dev/${raw.worker.entrypoint}`, import.meta.url);
  assert.ok(existsSync(fromDev), `config/dev's entrypoint ${raw.worker.entrypoint} does not resolve from config/dev`);
});

test("`bun run dev` reads config/dev natively through cf, and only dev:remote boots the generated config", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["dev:remote"], /site-config\.ts --dev/, "dev:remote must write the projection it boots");
  assert.match(pkg.scripts["dev:remote"], /\.wrangler\.dev\.jsonc/, "dev:remote must boot the generated dev config");
  assert.doesNotMatch(pkg.scripts.dev, /\.wrangler\.dev\.jsonc/, "dev reads config/dev/ natively since 2026-10-05");
  assert.match(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /^\.wrangler\.dev\.jsonc$/m);
  assert.ok(!existsSync(new URL("../wrangler.dev.jsonc", import.meta.url)), "the hand-kept twin is retired; config/dev/ is local dev's source");

  // cf finds a dev server through the manifest in ITS cwd, and refuses a
  // workspace root, so config/dev/ is a workspace that names the root's wrangler
  // byte for byte (check-wrangler holds the equality and the shared install).
  assert.ok(pkg.workspaces.includes("config/dev"), "config/dev must be a workspace so bun links wrangler beside its manifest");
  const devPkg = JSON.parse(readFileSync(new URL("../config/dev/package.json", import.meta.url), "utf8"));
  assert.equal(devPkg.devDependencies?.wrangler, pkg.devDependencies.wrangler);

  // THE REGISTRY PAIR. cf sends its delegate to CLOUDFLARE_REGISTRY_PATH and
  // plain wrangler dev to WRANGLER_REGISTRY_PATH; by default they differ, and
  // then COUNTER reads [not connected] (measured 2026-10-05). Both must be set,
  // to the same value, on the two processes dev.ts starts.
  const launcher = readFileSync(new URL("./dev.ts", import.meta.url), "utf8");
  assert.match(launcher, /spawn\("cf", \["dev"/, "dev.ts must run cf dev");
  assert.match(launcher, /cwd: join\(ROOT, "config", "dev"\)/, "cf dev must run in config/dev/");
  assert.match(launcher, /WRANGLER_REGISTRY_PATH: REGISTRY/, "Counter must register in the pinned registry");
  assert.match(launcher, /CLOUDFLARE_REGISTRY_PATH: REGISTRY/, "cf dev must read the same registry Counter writes");
});
