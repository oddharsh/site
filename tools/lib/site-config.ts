// The site Worker's config, projected into wrangler's LEGACY JSON shape.
//
// cloudflare.config.ts + wrangler.config.ts replaced wrangler.jsonc on
// 2026-09-28 and are the only authored config. Wrangler reads them behind
// `--x-new-config`, but only for the commands that BUILD a Worker from config
// (deploy, versions upload, versions deploy, build). Everything else still wants
// the old shape, and three things here cannot do without it:
//
//   - `createTestHarness`, which boots the route oracle, takes a config PATH or
//     an inline object and normalises either as legacy config. It has no
//     new-config door (read in wrangler's cli.js, 2026-09-28).
//   - the commands that REFUSE --x-new-config as an unknown argument:
//     `versions list`, `versions view`, `deployments status`, `versions secret
//     put`, `check startup`, `types`, `d1`, `kv` (measured the same day). With
//     no config they lose the Worker name, the pinned account (this login sees
//     two, so wrangler will not guess) and binding-name lookups.
//   - the contract tests that read a field by its legacy name.
//
// So this module is the ONE translation, and `writeSiteConfigFile()` puts its
// output at .wrangler.site.jsonc, gitignored and regenerated, never edited. It
// was proven against the deleted wrangler.jsonc before that file went: the
// projection deep-equalled the parsed jsonc on every key except the no-op
// `dependencies_instrumentation` (see the note at `project`).
//
// FAIL CLOSED. A binding or export type this does not know throws, because the
// failure it prevents is silent: a harness booted without a binding production
// has reads as a route bug, not a config bug.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asList, asRecord, asText } from "../../src/worker/lib/parse.ts";

export const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SITE_CONFIG_FILES = ["cloudflare.config.ts", "wrangler.config.ts"];
// Beside the TS configs, so every relative path in it (main, assets.directory)
// resolves exactly as it did from wrangler.jsonc. A dotfile, so wrangler's own
// config discovery (wrangler.json / .jsonc / .toml) never picks it up by
// accident; it is only ever read through an explicit `-c`.
export const SITE_CONFIG_JSON = ".wrangler.site.jsonc";

const need = (value: unknown, what: string): Record<string, unknown> => {
  const record = asRecord(value);
  if (!record) throw new Error(`site-config: ${what} is not an object`);
  return record;
};
const text = (value: unknown, what: string): string => {
  const s = asText(value);
  if (s === null) throw new Error(`site-config: ${what} is not a string`);
  return s;
};

// Imported by a file URL keyed on the file's bytes: both runtimes cache a
// module by specifier, so the query is what lets a long-lived process (the
// contract suite, which runs under bun AND node) see an edit without a restart.
async function load(file: string) {
  const key = createHash("sha256").update(readFileSync(join(REPO, file))).digest("hex").slice(0, 12);
  return asRecord((await import(`${pathToFileURL(join(REPO, file)).href}?v=${key}`)).default);
}

// Round-tripped through JSON, so a caller gets exactly what parseJsonc handed
// it when this was a file: plain data, typed the way JSON.parse types it.
export async function siteConfig() {
  const top = need(await load("cloudflare.config.ts"), "cloudflare.config.ts default export");
  const tooling = need(await load("wrangler.config.ts"), "wrangler.config.ts default export");
  return JSON.parse(JSON.stringify(project(top, tooling)));
}

export function project(top: Record<string, unknown>, tooling: Record<string, unknown>): Record<string, unknown> {
  const worker = need(top.worker, "config.worker");
  const env = need(worker.env ?? {}, "worker.env");
  const exportsDecl = need(worker.exports ?? {}, "worker.exports");
  const assets = need(worker.assets ?? {}, "worker.assets");
  const obs = asRecord(worker.observability);
  const cache = asRecord(worker.cache);
  const build = asRecord(tooling.build);

  type Row = Record<string, unknown>;
  const kv: Row[] = [], ae: Row[] = [], r2: Row[] = [], d1: Row[] = [];
  const doBindings: Row[] = [], workflows: Row[] = [], ratelimits: Row[] = [];
  const vars: Record<string, string> = {};
  const secrets: string[] = [];
  let assetsBinding: string | undefined, versionBinding: string | undefined;
  let browserBinding: string | undefined, imagesBinding: string | undefined;

  for (const [name, raw] of Object.entries(env)) {
    const b = need(raw, `env.${name}`);
    switch (b.type) {
      case "assets": assetsBinding = name; break;
      case "version-metadata": versionBinding = name; break;
      case "browser": browserBinding = name; break;
      case "images": imagesBinding = name; break;
      case "kv": kv.push({ binding: name, id: text(b.id, `env.${name}.id`) }); break;
      case "analytics-engine-dataset": ae.push({ binding: name, dataset: text(b.name, `env.${name}.name`) }); break;
      case "r2": r2.push({ binding: name, bucket_name: text(b.name, `env.${name}.name`) }); break;
      case "d1": d1.push({ binding: name, database_name: text(b.name, `env.${name}.name`), database_id: text(b.id, `env.${name}.id`) }); break;
      case "durable-object": doBindings.push({ name, class_name: text(b.exportName, `env.${name}.exportName`) }); break;
      case "workflow": workflows.push({ name: text(b.name, `env.${name}.name`), binding: name, class_name: text(b.exportName, `env.${name}.exportName`) }); break;
      case "rate-limit": {
        const simple = need(b.simple, `env.${name}.simple`);
        ratelimits.push({ name, namespace_id: text(b.namespace, `env.${name}.namespace`), simple: { limit: simple.limit, period: simple.period } });
        break;
      }
      case "text": vars[name] = text(b.value, `env.${name}.value`); break;
      case "secret": secrets.push(name); break;
      default: throw new Error(`site-config: env.${name} has binding type ${JSON.stringify(b.type)}, which this projection does not know; teach it rather than dropping the binding`);
    }
  }

  // Worker entrypoints carry their cache switch, and a DO carries its lifecycle
  // state, which is the legacy `exports` form wrangler.jsonc took in #1004 (step
  // 1 of moving Counter to its own Worker). A DO in `exports` cannot sit beside
  // a `migrations` array, so none is emitted. Workflows stay in the legacy
  // shape through `workflows`.
  const entrypoints: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(exportsDecl)) {
    const e = need(raw, `exports.${name}`);
    if (e.type === "worker") entrypoints[name] = { type: "worker", cache: { enabled: need(e.cache, `exports.${name}.cache`).enabled } };
    else if (e.type === "durable-object") {
      if (e.state !== undefined && e.state !== "created") throw new Error(`site-config: exports.${name} is a DO in state ${JSON.stringify(e.state)}; the projection only knows created classes`);
      if (e.storage !== "sqlite") throw new Error(`site-config: exports.${name} is a DO with storage ${JSON.stringify(e.storage)}; the projection only knows sqlite`);
      entrypoints[name] = { type: "durable-object", storage: "sqlite" };
    } else if (e.type !== "workflow") throw new Error(`site-config: exports.${name} has type ${JSON.stringify(e.type)}, which this projection does not know`);
  }

  const triggers = asList(worker.triggers).map((t, i) => need(t, `worker.triggers[${i}]`));
  for (const t of triggers) if (t.type !== "fetch" && t.type !== "scheduled") throw new Error(`site-config: trigger type ${JSON.stringify(t.type)} is not projected`);

  // Assembled key by key, in wrangler.jsonc's order, and a key is added only
  // when the TS config declares it, so an absent setting stays absent rather
  // than arriving as `undefined` beside the ones that are there.
  const out: Record<string, unknown> = {};
  out.name = text(worker.name, "worker.name");
  out.account_id = text(top.accountId, "accountId");
  out.main = text(worker.entrypoint, "worker.entrypoint");
  if (build?.command) out.build = { command: text(build.command, "build.command") };
  out.compatibility_date = text(worker.compatibilityDate, "worker.compatibilityDate");
  out.compatibility_flags = asList(worker.compatibilityFlags);
  if (tooling.minify !== undefined) out.minify = tooling.minify;
  if (tooling.uploadSourceMaps !== undefined) out.upload_source_maps = tooling.uploadSourceMaps;
  if (tooling.keepNames !== undefined) out.keep_names = tooling.keepNames;
  if (cache) out.cache = { enabled: cache.enabled, cross_version_cache: cache.crossVersionCache };
  if (Object.keys(entrypoints).length) out.exports = entrypoints;
  // NOTE, the one key the projection does not reproduce: wrangler.jsonc carried
  // `dependencies_instrumentation: { enabled: true }`, which the new format has
  // no field for. Wrangler reads it as `enabled !== false`, so absent and true
  // behave identically (cf-garage/cloudflare.config.ts has the read).
  out.workers_dev = worker.workersDev;
  out.preview_urls = worker.previewUrls;
  out.routes = triggers.filter((t) => t.type === "fetch").map((t) => ({ pattern: t.pattern, zone_name: t.zone }));
  const assetsOut: Record<string, unknown> = { directory: text(tooling.assetsDirectory, "wrangler.config.ts assetsDirectory") };
  if (assetsBinding) assetsOut.binding = assetsBinding;
  assetsOut.html_handling = assets.htmlHandling;
  assetsOut.run_worker_first = asList(assets.runWorkerFirst);
  out.assets = assetsOut;
  if (obs) {
    const traces = need(obs.traces, "observability.traces");
    out.observability = { enabled: obs.enabled, traces: { enabled: traces.enabled, head_sampling_rate: traces.headSamplingRate } };
  }
  if (versionBinding) out.version_metadata = { binding: versionBinding };
  out.triggers = { crons: triggers.filter((t) => t.type === "scheduled").map((t) => t.schedule) };
  if (kv.length) out.kv_namespaces = kv;
  if (ae.length) out.analytics_engine_datasets = ae;
  if (r2.length) out.r2_buckets = r2;
  if (d1.length) out.d1_databases = d1;
  if (doBindings.length) out.durable_objects = { bindings: doBindings };
  if (workflows.length) out.workflows = workflows;
  if (browserBinding) out.browser = { binding: browserBinding };
  if (imagesBinding) out.images = { binding: imagesBinding };
  if (ratelimits.length) out.ratelimits = ratelimits;
  if (Object.keys(vars).length) out.vars = vars;
  if (secrets.length) out.secrets = { required: secrets };
  return out;
}

const HEADER = "// GENERATED by tools/lib/site-config.ts from cloudflare.config.ts + wrangler.config.ts.\n// Do not edit: edit those two files. Gitignored, and rewritten whenever it is stale.\n";

// Writes .wrangler.site.jsonc and returns its path relative to the repo, for a
// `-c`. Writes only when the bytes would change, so a caller in a hot loop does
// not churn wrangler's config watcher.
export async function writeSiteConfigFile(): Promise<string> {
  const body = HEADER + JSON.stringify(await siteConfig(), null, 2) + "\n";
  const path = join(REPO, SITE_CONFIG_JSON);
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* first write */ }
  if (current !== body) writeFileSync(path, body);
  return SITE_CONFIG_JSON;
}

// The config arguments for a wrangler command run against the SITE Worker from
// the repository root, which is the one decision every caller used to get for
// free from wrangler.jsonc's auto-discovery.
//
// A command that BUILDS the Worker (deploy, build, versions upload) reads the
// TypeScript config itself, so it measures exactly what Workers Builds ships;
// .github/deploy-wrangler.sh makes the same split for the release path. Every
// other command refuses --x-new-config, so it gets the generated legacy file,
// which carries the name, the pinned account and the binding names (`d1 execute
// RESTORE_DB`) those commands resolve through a config.
const BUILDS = [["deploy"], ["build"], ["versions", "upload"]];
export async function siteWranglerArgs(args: string[]): Promise<string[]> {
  // Keyed on the FILE, like .github/deploy-wrangler.sh, never on an assumption
  // about which tree this runs in. perf-diff.yml runs HEAD's copy of this module
  // against the merge base too, and a base from before 2026-09-28 has no
  // cloudflare.config.ts; its wrangler.jsonc is found by wrangler unaided, so
  // the arguments pass through unchanged. Measured on #999's first CI run,
  // where the base died on "cloudflare.config.ts is required when
  // --experimental-new-config is enabled".
  if (!existsSync(join(REPO, "cloudflare.config.ts"))) return args;
  if (BUILDS.some((prefix) => prefix.every((word, i) => args[i] === word))) return [...args, "--x-new-config"];
  // Absolute, so a caller running from another directory (the ramp checks out
  // `production`) still resolves main and assets from the repository root.
  return [...args, "-c", join(REPO, await writeSiteConfigFile())];
}

if (import.meta.main) console.log(await writeSiteConfigFile());
