// ── a robots.txt Disallow is a census row, never a retried failure ─────────
//
// THE BUG THIS PINS. /lens/census showed 14 of its 16 roster sites. reddit.com
// and wsj.com answer AadharshBot with `Disallow: /`, so censusScanOne threw,
// recorded `failed`, and the Workflow retried twice, every Sunday from
// 2026-07-16 to 2026-11-15 (lastSweep: written 14, failed 2, both
// "AadharshBot: Disallow: /, not fetched"). No row ever landed, so the page
// dropped the two sites without a word. On origin/main the first test below
// rejects with that BotPolicyError.
import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { BotPolicyError } from "../lib/botauth.ts";
import * as census from "../census.ts";

const SITE = { url: "https://walled.example/", label: "walled.example" };
const TS = 1_763_000_000_000;
const YMD = "2026-11-15";

/** A D1 stand-in that keeps each batch of bound statements. */
function recordingD1() {
  const batches: { sql: string; args: unknown[] }[][] = [];
  return {
    batches,
    prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args, run: async () => ({ success: true }) }) }),
    batch: async (statements) => {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

/** An env whose only network is a fake that serves `robots` and counts the rest. */
async function walledEnv(robots: string) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const content: string[] = [];
  const db = recordingD1();
  const env = {
    RESTORE_DB: db,
    RN_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    OUTBOUND_TRANSPORT: async (url: string) => {
      if (new URL(url).pathname === "/robots.txt") return new Response(robots);
      content.push(url);
      return new Response("<html><title>walled</title></html>", { headers: { "content-type": "text/html" } });
    },
  };
  return { env, db, content };
}

test("a robots.txt Disallow writes a refused row and its record, and does not throw", async () => {
  const { env, db, content } = await walledEnv("User-agent: *\nDisallow: /\n");
  const result = await census.censusScanOne(env, SITE, TS, YMD);
  assert.deepEqual(result, { ok: true, host: "walled.example", refused: "Disallow: /" });
  assert.deepEqual(content, [], "nothing past robots.txt is fetched");
  assert.equal(db.batches.length, 1, "the row and its record land in one batch");
  const [row, run] = db.batches[0];
  assert.match(row.sql, /^INSERT INTO lens_census \(/);
  assert.deepEqual(row.args, [TS, YMD, "walled.example", "https://walled.example/", "refused", null, null, null, "refused", "{}"]);
  assert.match(run.sql, /^INSERT INTO lens_census_runs /);
  assert.deepEqual(run.args.slice(0, 2), [YMD, "walled.example"]);
  assert.deepEqual(run.args.slice(3), ["scan", "refused", "AadharshBot: Disallow: /, not fetched"]);
});

test("CONTROL: a Crawl-delay skip is our choice, so it still fails and retries", async () => {
  const { env, db } = await walledEnv("User-agent: *\nCrawl-delay: 10\n");
  await assert.rejects(census.censusScanOne(env, SITE, TS, YMD), BotPolicyError);
  assert.equal(db.batches.length, 0, "no row is published for a skip");
});

test("a refused outcome is done, never a problem or unfinished", () => {
  const last = census.summarizeCensusRuns([
    { ymd: YMD, host: "a.example", stage: "scan", outcome: "written", detail: null },
    { ymd: YMD, host: "walled.example", stage: "scan", outcome: "refused", detail: "AadharshBot: Disallow: /, not fetched" },
  ]);
  assert.ok(last);
  assert.deepEqual(last.outcomes, { written: 1, refused: 1 });
  assert.deepEqual(last.unfinished, []);
  assert.deepEqual(last.problems, []);
});

test("the table names a refused site and draws no number for it", () => {
  const refusedRow = { ymd: YMD, tier: "refused", score: null, level: null, doors: null, verdict: "refused", surfaces: "{}" };
  const html = census.censusExhibitHtml({
    snapshots: 2,
    firstYmd: "2026-11-08",
    lastYmd: YMD,
    hosts: [
      {
        host: "walled.example",
        url: SITE.url,
        last: refusedRow,
        delta: 0,
        series: [refusedRow, refusedRow],
        scoreSeries: [],
      },
    ],
  });
  const row = html.match(/<tbody>(.*)<\/tbody>/)?.[1] ?? "";
  assert.equal(
    row,
    '<tr><td class="cx-site"><a href="/lens?url=https%3A%2F%2Fwalled.example%2F">walled.example</a></td>' +
      '<td><span class="lx-badge warn">refused</span></td>' +
      '<td class="cx-num"><b>—</b> </td><td class="cx-num">—</td><td class="cx-num">—</td>' +
      '<td class="cx-spark" title=""></td>' +
      '<td class="cx-surfs"><span class="cx-none">robots.txt refuses AadharshBot</span></td></tr>',
  );
});
