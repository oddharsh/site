// src/worker/routes.ts is the one route list, since 2026-10-02. The dispatcher's
// tables, the run_worker_first allowlist, Workers Cache's path set and prefixes,
// the preview and early-data write guards, and build.ts's link resolver all
// derive from it, where they were five hand-kept lists joined by regexes over
// index.ts that matched nothing twice.
//
// What stays to assert is what derivation cannot give: that the allowlist still
// covers every route under wrangler's cap, that each consumer really reads the
// derived value rather than a copy, that the order-sensitive prefixes are in
// the order their comments promise, and that every registered surface lands on
// a route. Each has a control, because a check that cannot fail is decoration.
import { readFileSync } from "node:fs";
import { assert, configText, test } from "./contract-shared.ts";
import { parseJsonc } from "./lib/jsonc.ts";
import * as routes from "../src/worker/routes.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const firstPrefix = (path) => routes.PREFIX_ROUTES.find((r) => r.match(path))?.label ?? null;

test("the allowlist covers every route, under wrangler's cap of 100 rows", () => {
  const rows = routes.RUN_WORKER_FIRST;
  // 96 on 2026-10-02; a list that lost its claims would cover nothing and agree
  assert.ok(rows.length >= 60, `only ${rows.length} rows derived`);
  assert.ok(rows.length <= 100, `${rows.length} rows: wrangler refuses to boot past 100 (gotcha 26); fold before adding`);
  assert.equal(new Set(rows).size, rows.length, "the cap counts RAW rows, so a duplicate costs one");
  assert.deepEqual(routes.uncoveredRoutes(), [], "a route no row claims serves static");
});

test("the coverage check sees a route whose claim went missing", () => {
  // The control: drop the /lens fold and every /lens sub-route is uncovered.
  const without = routes.RUN_WORKER_FIRST.filter((r) => r !== "/lens/*");
  const lost = routes.uncoveredRoutes(without);
  assert.ok(lost.includes("/lens/fetch") && lost.includes("/lens/census.json"), `expected the /lens routes, got ${lost}`);
});

test("every prefix route's probe is a path that route answers, and ids are unique", () => {
  for (const r of routes.PREFIX_ROUTES) assert.ok(r.match(r.probe), `${r.label}: probe ${r.probe} does not match its own route`);
  const exact = routes.EXACT_PATHS;
  assert.equal(new Set(exact).size, exact.length, "an exact path is declared twice");
  const labels = routes.PREFIX_ROUTES.map((r) => r.label);
  assert.equal(new Set(labels).size, labels.length, "a prefix label is declared twice");
  assert.ok(exact.length >= 100, `only ${exact.length} exact routes`);
});

test("the order-sensitive prefixes are in the order their comments promise", () => {
  // first match wins, so these are claims about ORDER, each against a path two
  // routes both match
  assert.equal(firstPrefix("/serendipity/app.src.js"), "/serendipity/<path>", "serendipity's own twins reach serendipity");
  assert.equal(firstPrefix("/coffee/index.src.html"), "/coffee/<path>", "coffee's own twins reach cal");
  assert.equal(firstPrefix("/garage/horizon.src.html"), "/<path>.src.<ext>", "a section's readable twin is answered as a text twin");
  assert.equal(firstPrefix("/images/meta/XT500010.json"), "/images/meta/<stem>.json", "per-photo meta wins over the data-index row");
  // and exact routes are consulted before any prefix, which is index.ts's route()
  const route = read("src/worker/index.ts");
  const exactAt = route.indexOf("const exact = ROUTES.get(url.pathname);");
  const prefixAt = route.indexOf("for (const r of PREFIX) {");
  assert.ok(exactAt > 0 && prefixAt > exactAt, "route() must try the exact table before the prefixes");
  assert.equal(firstPrefix("/garage/dyno"), "/garage/<page>", "the control: /garage/dyno only reaches its own handler because exact wins");
});

test("each consumer reads the derived value rather than a copy of it", async () => {
  // the deployed config: its projection carries exactly the derived rows
  const projected = parseJsonc(await configText("cloudflare.config.ts")).assets.run_worker_first;
  assert.deepEqual(projected, [...routes.RUN_WORKER_FIRST]);
  assert.match(read("cloudflare.config.ts"), /runWorkerFirst: \[\.\.\.RUN_WORKER_FIRST\]/);
  // the preview and early-data guards
  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  assert.equal(PREVIEW_GET_WRITES, routes.GET_WRITES);
  assert.ok(routes.GET_WRITES.has("/hit") && routes.GET_WRITES.has("/coffee/approve"), "the write list lost its routes");
  // Workers Cache: a prefix declared on a route admits a path under it
  const { shouldUseWorkersCache } = await import("../src/worker/lib/cache.ts");
  const get = (path) => new Request(`https://aadhar.sh${path}`, { headers: { accept: "text/html" } });
  assert.equal(shouldUseWorkersCache(get("/writing/big-screens-and-small-screens"), new Set()), true);
  assert.equal(shouldUseWorkersCache(get("/lens/fetch"), new Set()), false, "the control: an undeclared path stays out");
  assert.match(read("src/worker/index.ts"), /const WORKERS_CACHEABLE_PATHS = CACHEABLE_PATHS;/);
});

test("the island URLs are routing facts the feature modules import", async () => {
  const pairs = [
    ["whoareyou", "VALUES_URL", routes.WHOAREYOU_VALUES_URL], ["reading", "LIST_URL", routes.READING_LIST_URL],
    ["dyno", "PULLS_URL", routes.DYNO_PULLS_URL], ["census", "TABLE_URL", routes.CENSUS_TABLE_URL],
    ["ledger", "LINES_URL", routes.LEDGER_LINES_URL], ["inbox", "MAIL_URL", routes.INBOX_MAIL_URL],
    ["around", "SNAPSHOT_URL", routes.AROUND_SNAPSHOT_URL],
  ];
  for (const [mod, local, url] of pairs) {
    const m = await import(`../src/worker/${mod}.ts`);
    assert.equal(m[local], url, `${mod}.ts's ${local}`);
    assert.ok(routes.EXACT_PATHS.includes(url), `${url} must be a route`);
    assert.doesNotMatch(read(`src/worker/${mod}.ts`), new RegExp(`export const ${local} = "`), `${mod}.ts must not restate the URL`);
  }
});

test("every registered surface lands on a route", () => {
  // site-manifest.json describes PAGES and stays its own file; this is the
  // join, so a registered page whose route went missing fails here by name.
  const surfaces = JSON.parse(read("config/site-manifest.json")).surfaces;
  assert.ok(surfaces.length >= 50, `only ${surfaces.length} surfaces read`);
  const routed = (p) => routes.EXACT_PATHS.includes(p) || routes.PREFIX_ROUTES.some((r) => r.match(p));
  const orphans = surfaces.map((s) => s.path).filter((p) => !routed(p));
  assert.deepEqual(orphans, [], "registered surfaces no route answers");
  assert.equal(routed("/not-a-surface-or-route"), false, "the control: an unknown path is not routed");
});
