// Which minifier pipeline each client script ships with, decided once on a
// workstation and replayed by every build.
//
// spokeshave (github.com/oddharsh/spokeshave) runs oxc, SWC and terser, plus
// two chains of them, on a file and keeps the smallest brotli output that its
// effect-trace oracle says behaves like the source. On 2026-11-21 that was
// 2,040 B (1.55%) under oxc alone across the 27 scripts, and Chrome found the
// picks matched oxc on all 77 pages (tools/check-minify-diff.ts).
//
// The build does not run the portfolio itself, for two measured reasons. It is
// slow cold (26 s for pretext.lib.js alone), and CI and Workers Builds run with
// the build cache off. And the oracle bounds each run with a 500 ms timeout, so
// a slower machine could reject a candidate a faster one accepted and mint
// different /a/ bytes from the same commit. A pick is a record of a decision,
// so it lives in config/minify-picks.json, keyed by the bytes it was made for.
//
// A pick is fresh while its source digest and the versions of the engines in
// its pipeline match. A stale pick ships oxc output (what the site shipped
// before spokeshave) and the build says so; `bun run minify:pick` re-picks.
//
// Bun is left out of the site's pipelines. It won one file by 5 B, and its
// output depends on the Bun pin, which the nightly bumper moves, so that pick
// would go stale every night.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { EngineName, Pipeline } from "spokeshave";

export const PICKS_PATH = "config/minify-picks.json";

export const SITE_PIPELINES: readonly Pipeline[] = [["oxc"], ["swc"], ["terser"], ["oxc", "terser"], ["swc", "oxc"]];

export type Pick = {
  pipeline: string;
  source_sha256: string;
  engines: Partial<Record<EngineName, string>>;
  // For the reader of the file; the build ignores them.
  brotli_oxc: number;
  brotli_pick: number;
};

export type Picks = Record<string, Pick>;

export const readPicks = (path = PICKS_PATH): Picks => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

export const sourceDigest = (source: string): string => createHash("sha256").update(source).digest("hex");

export const pipelineOf = (pick: Pick): Pipeline => pick.pipeline.split(">") as Pipeline;

// The engine versions a pick's bytes depend on: only the engines it runs.
export const enginesFor = (pipeline: Pipeline, versions: Record<EngineName, string>): Partial<Record<EngineName, string>> =>
  Object.fromEntries(pipeline.map((name) => [name, versions[name]]));

export type Freshness = { kind: "fresh"; pick: Pick } | { kind: "stale"; reason: string };

export const freshness = (pick: Pick | undefined, source: string, versions: Record<EngineName, string>): Freshness => {
  if (pick === undefined) return { kind: "stale", reason: "no pick" };
  if (pick.source_sha256 !== sourceDigest(source)) return { kind: "stale", reason: "the source changed" };
  for (const [name, version] of Object.entries(enginesFor(pipelineOf(pick), versions))) {
    if (pick.engines[name as EngineName] !== version) return { kind: "stale", reason: `${name} is ${version}, picked on ${pick.engines[name as EngineName]}` };
  }
  return { kind: "fresh", pick };
};
