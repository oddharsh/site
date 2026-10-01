// Local dev is production plus an OVERLAY, since 2026-10-01. config/dev/
// spreads cloudflare.config.ts and overrides what dev means to change: it runs
// the readable Worker source over the .dev-assets farm, with no build, no
// minification and no Workers Cache, and reaches the three bindings that have no
// local simulation remotely. Everything else is production's by construction.
//
// This replaced contract-the-dev-twin-matches-production, which held a
// hand-kept wrangler.dev.jsonc to the production config on four comparisons.
// That file drifted anyway (the "41 5 * * *" cron for two weeks, #876's
// "/dotfiles" for a day), because a copy of 165 values only agrees with its
// source while somebody remembers to copy. A spread cannot disagree, so the
// question left is narrower: does the overlay stay an overlay? Somebody could
// fork a binding, a route or a cron inside config/dev/ and dev would quietly
// stop being production, which is the drift the old test caught, arriving
// through the new door. So every leaf the two projections disagree on must be
// one of the keys below, and the floor stops a projection that lost a block
// from agreeing vacuously.
import { existsSync, readFileSync } from "node:fs";
import { assert, configText, test } from "./contract-shared.ts";
import { parseJsonc } from "./lib/jsonc.ts";

// The overlay's whole vocabulary. A key outside this list that differs between
// the two projections is dev forking production, and it fails by name.
const OVERLAY = [
  /^main$/,                          // readable source, not the build-staged copy
  /^build\./,                        // no build in the dev loop
  /^minify$/, /^upload_source_maps$/, /^keep_names$/,
  /^assets\.directory$/,             // the .dev-assets farm
  /^cache\.enabled$/,                // Workers Cache off ...
  /^exports\.[^.]+\.cache\.enabled$/, // ... on every entrypoint
  /^(browser|images|ai)\.remote$/,   // dev: { remote: true } on the binding
];

// Leaves as dotted paths. Arrays of named records (ratelimits, d1_databases,
// workflows, ...) are keyed by name rather than position, so a reorder is not a
// difference and a renamed binding is.
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
  // 260 leaves on 2026-10-01; most of them are the 96 run_worker_first rows.
  assert.ok(compared >= 200, `compared only ${compared} leaves; a projection has lost a block`);
  assert.deepEqual(forked, [], "config/dev/ overrides keys outside the overlay, so local dev is no longer production; move the change to cloudflare.config.ts or add the key to OVERLAY with its reason");
  // run_worker_first is ORDER-sensitive (first match wins), which the leaf walk
  // only sees by index; say it in its own words.
  assert.deepEqual(dev.assets.run_worker_first, prod.assets.run_worker_first);
});

test("the fork check can see dev forking production, which is what it exists for", async () => {
  // The controls. A `forks` that always returned [] would pass the test above.
  // Each control reports only what ITS perturbation added, so a real fork in
  // config/dev/ fails the test above by name and leaves this one green.
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
    // The production projection also boots the credential-free route oracle,
    // which a remote binding would make need a token.
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

test("the generated config is what `bun run dev` boots, and it is never committed", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const script of ["dev", "dev:remote"]) assert.match(pkg.scripts[script], /\.wrangler\.dev\.jsonc/, `${script} must boot the generated dev config`);
  assert.match(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /^\.wrangler\.dev\.jsonc$/m);
  assert.ok(!existsSync(new URL("../wrangler.dev.jsonc", import.meta.url)), "the hand-kept twin is retired; config/dev/ is local dev's source");
  assert.match(readFileSync(new URL("./dev-stage.ts", import.meta.url), "utf8"), /writeDevConfigFile\(\)/, "dev-stage must write the dev config before wrangler boots");
});
