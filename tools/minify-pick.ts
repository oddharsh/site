#!/usr/bin/env bun
// minify-pick.ts: `bun run minify:pick`. Re-pick the minifier pipeline for
// every client script whose pick is stale, and write config/minify-picks.json.
//
//   bun run build && bun run minify:pick          # stale picks only
//   bun run minify:pick -- --all                  # every script, e.g. after a spokeshave bump
//
// Reads each script's readable twin from .build (the minifier's input), so run
// a build first. Workstation only: the portfolio takes about 30 s cold, and
// the deploy build replays the result instead (tools/lib/minify-picks.ts says
// why). Before committing a changed pick, run the Chrome differential:
//
//   MINIFY_PICKS=off bun run build && node tools/check-minify-diff.ts record /tmp/A1
//   node tools/check-minify-diff.ts record /tmp/A2 && node tools/check-minify-diff.ts record /tmp/A3
//   bun run build && node tools/check-minify-diff.ts record /tmp/B
//   node tools/check-minify-diff.ts diff /tmp/A1 /tmp/B /tmp/A2 /tmp/A3
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { engineVersions, minify } from "spokeshave";
import { minifiedScripts } from "./lib/client-assets.ts";
import { enginesFor, freshness, PICKS_PATH, readPicks, SITE_PIPELINES, sourceDigest } from "./lib/minify-picks.ts";
import type { Picks } from "./lib/minify-picks.ts";

const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } });
const versions = await engineVersions();
const old = readPicks();
const picks: Picks = {};
let changed = 0;
for (const row of minifiedScripts()) {
  const source = readFileSync(`.build/public${row.twin}`, "utf8");
  const state = freshness(old[row.file], source, versions);
  if (state.kind === "fresh" && !values.all) {
    picks[row.file] = state.pick;
    continue;
  }
  const result = await minify(source, {
    filename: row.file,
    kind: row.module ? "module" : "script",
    toplevel: row.module,
    pipelines: SITE_PIPELINES,
    markers: row.marker ? [row.marker] : [],
  });
  const oxc = result.candidates.find((c) => c.pipeline === "oxc");
  const chosen = result.candidates.find((c) => c.pipeline === result.pipeline);
  if (oxc?.brotli == null || chosen?.brotli == null) throw new Error(`${row.file}: no measured oxc or chosen candidate`);
  const pipeline = result.pipeline.split(">") as Parameters<typeof enginesFor>[0];
  picks[row.file] = {
    pipeline: result.pipeline,
    source_sha256: sourceDigest(source),
    engines: enginesFor(pipeline, versions),
    brotli_oxc: oxc.brotli,
    brotli_pick: chosen.brotli,
  };
  if (old[row.file]?.pipeline !== result.pipeline || old[row.file]?.source_sha256 !== picks[row.file]!.source_sha256) changed++;
  const rejected = result.candidates
    .filter((c) => c.verdict.kind === "different" || c.verdict.kind === "engine-failed")
    .map((c) => `${c.pipeline} (${c.verdict.kind})`);
  console.log(
    `${row.file}: ${result.pipeline}, ${oxc.brotli} -> ${chosen.brotli} B brotli${state.kind === "stale" ? ` [${state.reason}]` : ""}${rejected.length ? `; rejected ${rejected.join(", ")}` : ""}`,
  );
}
const ordered = Object.fromEntries(Object.entries(picks).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(PICKS_PATH, JSON.stringify(ordered, null, 2) + "\n");
const total = (k: "brotli_oxc" | "brotli_pick") => Object.values(picks).reduce((sum, p) => sum + p[k], 0);
console.log(`minify:pick: ${changed} pick(s) changed; ${total("brotli_oxc")} -> ${total("brotli_pick")} B brotli across ${Object.keys(picks).length} scripts`);
