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
//
// After the pipeline, spokeshave's compression-aware renamer renames bindings
// to whatever names brotli compresses best, and proves the result is the same
// program (alpha-equivalent). The search takes about 3 minutes across the 26
// own scripts, so a pick stores its result as a rename map and the build
// replays the map, re-checking equivalence as it does. On 2026-11-22 the
// renames took another 511 B off the 26 own scripts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineName, Pipeline } from "spokeshave";
import type { RenameMap } from "spokeshave/rename";

export const PICKS_PATH = "config/minify-picks.json";

export const SITE_PIPELINES: readonly Pipeline[] = [["oxc"], ["swc"], ["terser"], ["oxc", "terser"], ["swc", "oxc"]];

export type Pick = {
  pipeline: string;
  source_sha256: string;
  engines: Partial<Record<EngineName, string>>;
  // [binding ordinal, name] pairs applied to the pipeline's output. A renamed
  // pick also depends on terser, whose scope analysis numbers the bindings,
  // and on the renamer's own code, whose rules decide which bindings count:
  // adding pinAfter on 2026-11-22 shifted every ordinal after a pinned one.
  renames: RenameMap;
  // sha256 of spokeshave's src/rename.ts when the map was searched; set when
  // `renames` is not empty.
  renamer?: string;
  // For the reader of the file; the build ignores them.
  brotli_oxc: number;
  brotli_pick: number;
};

export type Picks = Record<string, Pick>;

export const readPicks = (path = PICKS_PATH): Picks => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

export const sourceDigest = (source: string): string => createHash("sha256").update(source).digest("hex");

export const pipelineOf = (pick: Pick): Pipeline => pick.pipeline.split(">") as Pipeline;

export const renamerDigest = (): string => sourceDigest(readFileSync(fileURLToPath(import.meta.resolve("spokeshave/rename")), "utf8"));

// The engine versions a pick's bytes depend on: the engines it runs, plus
// terser when it renames.
export const enginesFor = (pipeline: Pipeline, versions: Record<EngineName, string>, renames: RenameMap = []): Partial<Record<EngineName, string>> =>
  Object.fromEntries([...new Set<EngineName>([...pipeline, ...(renames.length ? (["terser"] as const) : [])])].map((name) => [name, versions[name]]));

// The renamer's options, shared by the search and the replay so the binding
// ordinals in a map mean the same thing to both. `--` pins a decremented
// variable's name: step 5c reads every `--name` token in the staged tree as a
// taken custom-property name (lib/mangle-custom-properties.ts), and renaming
// md-to-html.js's `--n` to `--e` shifted CSS names on 75 of 77 pages
// (measured 2026-11-22).
export const renameOptions = (module: boolean) => ({ module, toplevel: module, pinAfter: ["--"] });

// The custom-property-shaped tokens step 5c would see in a text.
export const dashTokens = (text: string): Set<string> => new Set(text.match(/--[a-z0-9][a-z0-9-]*/g) ?? []);

// The bytes a fresh pick ships: its pipeline, then its renames. applyRenames
// throws if the map no longer fits or the result is not the same program.
export const replayPick = async (pick: Pick, source: string, script: { filename: string; module: boolean }): Promise<string> => {
  const { runPipeline } = await import("spokeshave");
  const code = await runPipeline(pipelineOf(pick), source, { filename: script.filename, kind: script.module ? "module" : "script", toplevel: script.module });
  if (!pick.renames?.length) return code;
  const { applyRenames } = await import("spokeshave/rename");
  return applyRenames(code, pick.renames, renameOptions(script.module));
};

export type Freshness = { kind: "fresh"; pick: Pick } | { kind: "stale"; reason: string };

export const freshness = (pick: Pick | undefined, source: string, versions: Record<EngineName, string>): Freshness => {
  if (pick === undefined) return { kind: "stale", reason: "no pick" };
  if (pick.source_sha256 !== sourceDigest(source)) return { kind: "stale", reason: "the source changed" };
  if (pick.renames?.length && pick.renamer !== renamerDigest()) return { kind: "stale", reason: "spokeshave's renamer changed" };
  for (const [name, version] of Object.entries(enginesFor(pipelineOf(pick), versions, pick.renames ?? []))) {
    if (pick.engines[name as EngineName] !== version) return { kind: "stale", reason: `${name} is ${version}, picked on ${pick.engines[name as EngineName]}` };
  }
  return { kind: "fresh", pick };
};
