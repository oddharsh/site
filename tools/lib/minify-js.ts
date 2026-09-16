// minifyJavaScript: the one door every served client script and every inline
// <script> goes through. It runs FOUR candidate pipelines and ships the one
// that is smallest after brotli q11, which is the wire metric for a shell
// asset (q11 twins, gotcha 14). The same move zenc makes with its 64-candidate
// progressive scan search, one layer up.
//
// WHY TWO ENGINES. Measured 2026-09-15 across the 19 client assets: oxc-minify
// alone trails SWC's minifier by 0.84% brotli, and the whole gap is three of
// SWC's compressor passes (guard-clause inversion into nested ifs, hoisting a
// scope's `var`s into one declaration, inlining or reordering inner function
// declarations). None of those is a source edit anyone should make, and #823
// took the one transform that WAS (function expressions to arrows) for 82 B.
// So SWC's compressor runs as a PRE-PASS and oxc stays the last engine on
// three of the four candidates: oxc is the mangler and the printer this repo
// reasons about (`mangle.toplevel: false`, no property mangling, the `??` and
// template-literal lowering that SWC lacks), and every setting in
// lib/oxc-minify-options.ts keeps meaning what it meant.
//
// WHY A PICK RATHER THAN ONE PIPELINE. No single arrangement is smallest on
// every file: the two printers differ by a few bytes per file in both
// directions, so a fixed order was 14 B under SWC in total while 10 files sat
// 3-24 B over. The pick is per file and by measurement, so the shipped byte
// count is at most the smallest candidate's BY CONSTRUCTION, and SWC alone is
// one of the candidates, which is what makes "parity with SWC" a property of
// this function rather than a number that rots. Cost: four brotli q11 passes
// per script, about a second across the whole build.
//
// THE SWC HALF IS A BRIDGE, and its retirement trigger is already committed.
// `oxc-minifier-reaches-swc-parity` in lib/upstream-watches.ts measures oxc
// ALONE on two frozen fixtures against SWC's recorded size; the night it reads
// `landed`, this module should drop to one candidate and @swc/core should
// leave package.json. Until then the winners are counted in the build log so
// a bump to either engine shows what it moved.
//
// SWC's compressor is handed `module: "unknown"` because seven client files
// are ES modules and SWC REFUSES `import` under `module: false` where oxc
// parses it either way (measured 2026-09-15). `ecma: 2022` because SWC's
// default is 5, which forbids modern syntax in the OUTPUT even when the input
// already carries it; 2024 changes no byte.
import { brotliCompressSync, constants } from "node:zlib";
import { minifySync as oxcMinifySync } from "oxc-minify";
import { minifySync as swcMinifySync } from "@swc/core";

import { OXC_MINIFY_OPTIONS } from "./oxc-minify-options.ts";

export const SWC_COMPRESS_OPTIONS = {
  compress: { ecma: 2022, toplevel: false },
  mangle: false,
  module: "unknown",
} as const;

export const SWC_FULL_OPTIONS = {
  compress: { ecma: 2022, toplevel: false },
  mangle: { toplevel: false },
  module: "unknown",
} as const;

export type MinifyWinner = "oxc" | "swc>oxc" | "oxc>swc>oxc" | "swc";

export interface MinifyResult {
  code: string;
  winner: MinifyWinner;
  /** brotli q11 bytes of every candidate, so a caller can log what the pick cost or saved */
  sizes: Record<MinifyWinner, number>;
}

const brotli = (code: string) => brotliCompressSync(Buffer.from(code), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

const oxc = (filename: string, code: string) => {
  const r = oxcMinifySync(filename, code, OXC_MINIFY_OPTIONS);
  if (r.errors.length) throw new Error(`${filename}: Oxc parse/minify failed: ${r.errors.map((e) => e.message).join("; ")}`);
  return r.code;
};
const swcCompress = (code: string) => swcMinifySync(code, SWC_COMPRESS_OPTIONS).code;
const swcFull = (code: string) => swcMinifySync(code, SWC_FULL_OPTIONS).code;

// Candidate order is the tie-break: on equal brotli bytes the earlier wins, so
// oxc alone is preferred, then the arrangements that keep oxc last, and SWC
// alone only when it is strictly smaller than all three.
export const ORDER: MinifyWinner[] = ["oxc", "swc>oxc", "oxc>swc>oxc", "swc"];

export function minifyJavaScript(filename: string, sourceText: string): MinifyResult {
  const oxcAlone = oxc(filename, sourceText);
  const candidates: Record<MinifyWinner, string> = {
    "oxc": oxcAlone,
    "swc>oxc": oxc(filename, swcCompress(sourceText)),
    "oxc>swc>oxc": oxc(filename, swcCompress(oxcAlone)),
    "swc": swcFull(sourceText),
  };
  const sizes = Object.fromEntries(ORDER.map((k) => [k, brotli(candidates[k])])) as Record<MinifyWinner, number>;
  let winner: MinifyWinner = ORDER[0];
  for (const k of ORDER) if (sizes[k] < sizes[winner]) winner = k;
  return { code: candidates[winner], winner, sizes };
}
