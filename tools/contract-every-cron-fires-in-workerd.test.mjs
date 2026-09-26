// ── every configured cron, fired once in the pinned workerd ──────────────────
// wrangler.jsonc declares Cron Triggers and nothing in this repo ever invoked
// `scheduled()`. The route oracle sweeps fetch routes, lib/cron.ts's matcher is
// pinned in isolation, and every job behind the dispatcher is written to swallow
// its own failures, because "a cron has no response, no status, and no visitor to
// complain". So a cron could be misrouted, or route correctly into a job that
// quietly did nothing, and every check stayed green. This file boots the real
// Worker through wrangler's createTestHarness, fires each configured cron once
// through `worker.scheduled()`, and asks each job to show its work.
//
// THE CRON LIST IS READ FROM wrangler.jsonc, never copied here, so a fifth cron
// is fired by existing. A cron that reaches a job with no entry in JOB_EVIDENCE
// fails by name, which is how the fifth one gets an observable written for it.
// The floor of 4 stops a config reader that stops matching from passing over
// zero crons.
//
// WHY A FIXTURE WORKER RATHER THAN wrangler.jsonc ITSELF. Three things have to
// be in the isolate before the first cron runs, and none of them can be done
// from outside it:
//   1. OUTBOUND fetch is replaced by a stub that answers every request locally
//      and RECORDS it. The harness exposes no outbound service, and workerd
//      reaches the real internet by default, so the stub has to be
//      globalThis.fetch inside the isolate. Installed at module scope, it also
//      covers anything a cron leaves running (Workflow instances, waitUntil).
//   2. A RECORDING TRACER is handed to lib/trace.ts's installTracing, after
//      index.ts has installed the runtime's (which is inert locally). Every job
//      opens named spans with attributes, so the spans ARE the per-job evidence
//      a quiet job cannot fake: a job that did nothing opens nothing.
//   3. The Analytics Engine bindings are swapped for recorders and BROWSER for a
//      tripwire on the env handed to scheduled(), so the probe's data point is
//      readable and a cron that reaches for a real browser fails loudly.
// The fixture imports the real src/worker/index.ts (and re-exports its classes,
// so the Durable Object and both Workflows bind), which is why gotcha 16 holds:
// `cloudflare:workers` is still imported by index.ts alone. The generated config
// is wrangler.jsonc with main, assets and the build step swapped, so bindings,
// crons, flags and compatibility date stay production's.
//
// NOTHING LEAVES THE MACHINE. Bindings are the harness's local ones (KV, D1, the
// Workflow engine), the config lives in a temp directory with no .dev.vars, and
// the only secret is an Ed25519 key minted here for the signer. Every outbound
// request is attributed to a job allowed to make it, and a request no job
// accounts for, or one aimed back at this site's own origin, fails the test.
//
// WHAT THIS DOES NOT COVER, on purpose:
//   - The census's per-host scan. Each Workflow instance's `scan <label>` step is
//     MOCKED, so this proves the sweep creates one runnable instance per roster
//     host, and not what censusScanOne does inside one. That is a scan of 16
//     third-party origins, and census.ts's own contract tests own its logic.
//   - Any job's success path against a real upstream. The stub serves a fixed
//     HTML page, so Spotify's embed parse and Luma's JSON parse fail, and the
//     test asserts they fail COUNTED (rn.track_failed, the serendipity summary
//     line) rather than silently. What a real payload does needs a real payload.
//   - Webmention POSTs. The stub page advertises no endpoint, so discovery ends
//     at "none", which is the common production outcome too.
//
// It found a real bug on its first run: every census instance id carried the
// dot from its host label, the Workflows binding refused all 16, and the sweep
// reported `partial` on a span nobody reads. See censusInstanceId.
//
// THE CONTROL, run before this was committed: deleting the `41 5` arm from
// lib/cron.ts's cronJob() sends that cron to `cron.unmatched`, and this test
// fails naming the cron and the unmatched span; restoring the arm goes green.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";
import { CENSUS_ROSTER } from "../src/worker/census.ts";
import { NEIGHBORS } from "../src/worker/around.ts";
import { citationsIn } from "../src/worker/webmention-send.ts";
import { privateHostBlocked } from "../src/worker/lib/public-fetch.ts";
import { ROOT, assert, readFileSync, test } from "./contract-shared.ts";

const at = (rel) => fileURLToPath(new URL(rel, ROOT));
const ORIGIN = "https://aadhar.sh";
// A path no document or route claims, so the asset layer misses and the
// fixture Worker answers it.
const RECORD_PATH = "/__cron-harness";

const workerSource = (index, trace) => `
import site from ${JSON.stringify(index)};
import { installTracing } from ${JSON.stringify(trace)};
export * from ${JSON.stringify(index)};

const spans = [], outbound = [], points = [], tripped = [];
let cron = null;

installTracing({
  enterSpan(name, fn) {
    const rec = { cron, name, attrs: {}, status: "open" };
    spans.push(rec);
    const span = { setAttribute(k, v) { rec.attrs[k] = v; }, end() {}, isTraced: true };
    const fail = (e) => { rec.status = "error"; rec.error = String((e && e.message) || e); throw e; };
    let out;
    try { out = fn(span); } catch (e) { fail(e); }
    if (out && typeof out.then === "function") return out.then((v) => { rec.status = "ok"; return v; }, fail);
    rec.status = "ok";
    return out;
  },
});

const ROBOTS = "User-agent: *\\nAllow: /\\n";
const PAGE = "<!doctype html><html><head><title>stub</title></head><body><p>stub</p></body></html>";
globalThis.fetch = async function outboundStub(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  outbound.push({ cron, method: request.method, url: request.url, host: url.hostname, cookie: request.headers.has("cookie") });
  if (url.pathname === "/robots.txt") return new Response(ROBOTS, { headers: { "content-type": "text/plain" } });
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
};

const dataset = (binding) => ({ writeDataPoint(point) { points.push({ cron, binding, point }); } });
const tripwire = (binding) => new Proxy({}, {
  get(_, prop) {
    tripped.push({ cron, binding, prop: String(prop) });
    throw new Error(binding + " is off limits to a cron under test");
  },
});

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === ${JSON.stringify(RECORD_PATH)}) {
      if (request.method === "DELETE") {
        spans.length = 0; outbound.length = 0; points.length = 0; tripped.length = 0; cron = null;
        return new Response(null, { status: 204 });
      }
      return Response.json({ spans, outbound, points, tripped });
    }
    return site.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    cron = event.cron;
    return site.scheduled(event, {
      ...env,
      PERF_PROBE: dataset("PERF_PROBE"),
      BOT_LEDGER: dataset("BOT_LEDGER"),
      SPECULATION: dataset("SPECULATION"),
      BROWSER: tripwire("BROWSER"),
    }, ctx);
  },
};
`;

// Seeds, so the jobs that start from stored state have some to start from. None
// of them is a credential: the playlist and track ids are shaped like Spotify's
// and name nothing, and the Luma "session" is a label the stub never checks.
const PLAYLIST = "0123456789abcdefABCDEF";
const TRACKS = ["1111111111aaaaaaaaaaAA", "2222222222bbbbbbbbbbBB"];
// Hand-kept on purpose, like every host rule below: an allowlist derived from
// the code under test would grow with it and could never catch a new host.
const LUMA_HOST = "api2.luma.com";
const SPOTIFY_HOST = "open.spotify.com";
const NEIGHBOR_HOSTS = new Set(NEIGHBORS.map((n) => new URL(n.url).hostname));

/** What the fixture Worker hands back from RECORD_PATH for one fired cron.
 * @typedef {{ cron: string, name: string, attrs: Record<string, any>, status: string, error?: string }} RecordedSpan
 * @typedef {{ cron: string, method: string, url: string, host: string, cookie: boolean }} RecordedFetch
 * @typedef {{ spans: RecordedSpan[], outbound: RecordedFetch[], points: { cron: string, binding: string, point: any }[], tripped: { cron: string, binding: string, prop: string }[] }} Recording
 */

const only = (spans, name) => {
  const hits = spans.filter((s) => s.name === name);
  assert.equal(hits.length, 1, `expected exactly one ${name} span, got ${hits.length}`);
  assert.equal(hits[0].status, "ok", `${name} ${hits[0].status}: ${hits[0].error ?? ""}`);
  return hits[0].attrs;
};

// What each job must show for itself, keyed by the cron span the dispatcher
// opens. `explains` claims outbound requests: every request a cron made has to
// be claimed by one of the jobs that ran on that tick, or the test fails.
const JOB_EVIDENCE = {
  "cron.home_probe": {
    async check({ run }) {
      const probe = run.points.filter((p) => p.binding === "PERF_PROBE");
      assert.equal(probe.length, 1, "the home probe wrote no PERF_PROBE data point, which is its whole output");
      assert.deepEqual(probe[0].point.indexes, ["home"]);
      assert.ok(probe[0].point.doubles[1] >= 0, "the probe recorded the tracks fragment as thrown");
      assert.equal(only(run.spans, "home.grid.render")["home.grid.served"], true, "the grid fragment did not render");
    },
    explains: () => false,
  },
  "cron.rn_enrich": {
    async check({ run }) {
      const rn = only(run.spans, "rn.enrich");
      assert.equal(rn["rn.tracks_total"], TRACKS.length, "enrich never reached the seeded playlist");
      // The stub page has no __NEXT_DATA__, so every embed fails, and it has to
      // fail COUNTED rather than as a cap or as nothing.
      assert.equal(rn["rn.track_failed"], TRACKS.length, "a failed embed was not counted as one");
      assert.equal(rn["rn.capped"], false);
      for (const id of TRACKS) {
        assert.ok(run.outbound.some((o) => o.url.startsWith(`https://${SPOTIFY_HOST}/embed/track/${id}`)),
          `enrich never asked for track ${id}'s embed`);
      }
    },
    explains: (o) => o.host === SPOTIFY_HOST,
  },
  "cron.census": {
    async check({ run, census }) {
      const sweep = only(run.spans, "census.sweep");
      assert.equal(sweep["census.roster"], CENSUS_ROSTER.length);
      assert.equal(sweep["census.failed"], 0, `the sweep failed to create instances: ${sweep["census.error"]}`);
      assert.equal(sweep["census.created"], CENSUS_ROSTER.length, "the sweep did not create one instance per roster host");
      assert.equal(sweep["census.outcome"], "dispatched");
      const instances = await census.get();
      assert.equal(instances.length, CENSUS_ROSTER.length, "the Workflow binding does not hold one instance per host");
      await Promise.all(instances.map((i) => i.waitForStatus("complete")));
    },
    explains: () => false,
  },
  "cron.webmention_send": {
    async check({ run, worker, env }) {
      const send = only(run.spans, "webmention.send");
      assert.ok(send["webmention.pages_read"] >= 1, "the sender read none of this site's own pages");
      // A marker row is written per page swept, so the table is the job's own
      // record of what it read, independent of the span.
      const markers = await env.SOCIAL_DB.prepare("SELECT source FROM webmentions_sent WHERE source = target").all();
      assert.equal(markers.results.length, send["webmention.pages_read"], "a page read left no marker row");
      // Re-read every page it swept through the same Worker, and hold each
      // discovery it made to a citation on one of them.
      const cited = new Set();
      for (const { source } of markers.results) {
        const page = await worker.fetch(new URL(source).pathname);
        for (const target of citationsIn(await page.text(), ORIGIN)) cited.add(target);
      }
      const discoveries = run.spans.filter((s) => s.name === "webmention.discover").length;
      assert.ok(discoveries >= 1, "the sender discovered nothing on the pages it read");
      assert.equal(run.outbound.filter((o) => cited.has(o.url)).length, discoveries,
        "a discovery went somewhere other than a citation on a page it read");
      return { cited };
    },
    explains: (o, { cited }) => cited.has(o.url),
  },
  "cron.around": {
    async check({ run }) {
      const crawl = only(run.spans, "around.crawl");
      assert.equal(crawl["around.neighbors"], NEIGHBORS.length);
      assert.equal(crawl["around.crawled"], NEIGHBORS.length, `around crawled ${crawl["around.crawled"]} of ${NEIGHBORS.length}`);
      only(run.spans, "around.publish");
      const asked = new Set(run.outbound.filter((o) => NEIGHBOR_HOSTS.has(o.host)).map((o) => o.host));
      assert.equal(asked.size, NEIGHBOR_HOSTS.size, "a neighbor was never asked");
    },
    explains: (o) => NEIGHBOR_HOSTS.has(o.host),
  },
  "cron.serendipity": {
    async check({ run, logs }) {
      const luma = run.outbound.filter((o) => o.host === LUMA_HOST);
      assert.ok(luma.length >= 1 && luma.every((o) => o.cookie), "the sync never asked Luma with the seeded session");
      // The summary line is the LAST thing cronSerendipity does, so it proves
      // the sweep ran to the end rather than stopping at the first fetch.
      const summary = logs
        .map((l) => { try { return JSON.parse(l.message); } catch { return null; } })
        .find((m) => m && m.cron === "serendipity");
      assert.ok(summary, "the serendipity sweep never logged its summary");
      assert.equal(summary.events[0]?.label, "cron-test", "the sweep did not read the seeded cookie set");
      assert.ok(summary.events[0]?.error, "the stub answers HTML, so the event sync should report an error");
    },
    explains: (o) => o.host === LUMA_HOST,
  },
};

test("every configured cron reaches its job, completes, and makes no request no job accounts for", async () => {
  const site = parseJsonc(readFileSync(new URL("wrangler.jsonc", ROOT), "utf8"));
  const crons = site.triggers?.crons ?? [];
  assert.ok(crons.length >= 4, `read ${crons.length} crons from wrangler.jsonc; the reader has stopped matching`);

  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crons-")));
  // The served tree for SELF_FETCH, which is how the webmention sender reads
  // this site's pages. A handful of symlinks rather than dev-stage's farm,
  // because that one writes .dev-assets into the repository a dev server may be
  // serving from.
  const assets = join(dir, "assets");
  mkdirSync(assets);
  for (const root of ["src/pages", "src/content"]) {
    for (const name of readdirSync(at(root))) symlinkSync(join(at(root), name), join(assets, name));
  }
  symlinkSync(at("public/images"), join(assets, "images"));

  writeFileSync(join(dir, "worker.js"), workerSource(at("src/worker/index.ts"), at("src/worker/lib/trace.ts")));
  const config = {
    ...site,
    main: "worker.js",
    minify: false,
    assets: { ...site.assets, directory: "assets" },
    // The serendipity schema is applied by hand in production; the harness
    // needs its migrations named to apply them.
    d1_databases: site.d1_databases.map((d) =>
      d.binding === "SERENDIPITY_DB" ? { ...d, migrations_dir: at("serendipity/migrations") } : d),
  };
  delete config.build;
  delete config.secrets;
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(config));

  // workerd refuses the `alg: "Ed25519"` a current WebCrypto exports ("does not
  // match requested Ed25519 curve"), and the signer hands the JWK straight to
  // importKey, so the member goes. Without a usable key every signed read throws
  // before it reaches fetch, which reads as a crawl that ran and found nothing.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const { alg: _alg, ...jwk } = await crypto.subtle.exportKey("jwk", pair.privateKey);

  const server = createTestHarness({
    workers: [{ configPath: join(dir, "wrangler.jsonc"), secrets: { RN_SIGNING_KEY_JWK: JSON.stringify(jwk) } }],
  });
  try {
    await server.listen();
    const worker = server.getWorker();
    await worker.applyD1Migrations("SERENDIPITY_DB");
    const env = await worker.getEnv();
    await env.RN_KV.put("playlist-id", PLAYLIST);
    await env.RN_KV.put(`tracks:${PLAYLIST}`, JSON.stringify({ tracks: TRACKS.map((id) => ({ id, name: id, artists: [] })) }));
    await env.SERENDIPITY_DB.prepare("INSERT INTO user_cookies (user_key, cookies_json, label, enabled) VALUES (?, ?, ?, 1)")
      .bind("cron-test", JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "cron-test" }] }), "cron-test").run();
    // Created before any cron fires, since it only sees instances created after
    // it. Each instance's one step is mocked (see the header).
    const census = await worker.introspectWorkflow("CENSUS_WORKFLOW");
    await census.modifyAll(async (m) => {
      for (const s of CENSUS_ROSTER) await m.mockStepResult({ name: `scan ${s.label}` }, { ok: true, host: s.label, mocked: true });
    });

    const reached = new Set();
    try {
      for (const cron of crons) {
        await worker.fetch(RECORD_PATH, { method: "DELETE" });
        server.clearLogs();
        const result = await worker.scheduled({ cron, scheduledTime: new Date() });
        const run = /** @type {Recording} */ (await (await worker.fetch(RECORD_PATH)).json());
        const logs = server.getLogs();
        const label = `cron "${cron}"`;

        assert.equal(result.outcome, "ok", `${label} threw out of scheduled()`);
        assert.deepEqual(run.tripped, [], `${label} reached for a binding that leaves the machine`);

        const jobs = run.spans.filter((s) => s.name.startsWith("cron."));
        assert.ok(jobs.length >= 1, `${label} opened no cron span, so scheduled() never dispatched it`);
        for (const job of jobs) {
          assert.notEqual(job.name, "cron.unmatched", `${label} matched no job in lib/cron.ts`);
          assert.equal(job.attrs["cron.schedule"], cron, `${job.name} ran under the wrong schedule`);
          assert.equal(job.status, "ok", `${label} ${job.name} threw: ${job.error}`);
          assert.ok(JOB_EVIDENCE[job.name], `${label} reached ${job.name}, which has no evidence check here; add one`);
          reached.add(job.name);
        }

        const context = {};
        for (const job of jobs) {
          Object.assign(context, await JOB_EVIDENCE[job.name].check({ run, worker, env, census, logs }));
        }
        for (const o of run.outbound) {
          assert.ok(o.host !== new URL(ORIGIN).hostname && !privateHostBlocked(o.host),
            `${label} fetched ${o.url}, which is this site or a private host`);
          assert.ok(jobs.some((job) => JOB_EVIDENCE[job.name].explains(o, context)),
            `${label} fetched ${o.url}, which no job on that tick accounts for`);
        }
      }
    } catch (error) {
      server.debug();
      throw error;
    }
    // A job the table expects and no cron reached means a cron was routed
    // somewhere else, or a trigger was deleted without its job.
    assert.deepEqual([...reached].sort(), Object.keys(JOB_EVIDENCE).sort(),
      "the configured crons did not reach exactly the jobs this test knows");
    await census.dispose();
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
