// The ONE CSS parser this repo checks against, and the one place the tolerated
// warning family is written down.
//
// Two callers with the same question ("does this stylesheet parse, and did the
// parser damage it") used to use two different engines: build.ts ran Lightning
// CSS over every served document, and check-page-contracts.mjs ran esbuild's CSS
// loader over the Garage scaffold. That cost a 20MB Go binary for a single call,
// and it was worse than the size: THE TWO PARSERS DISAGREE IN BOTH DIRECTIONS.
// Measured 2026-08-14 on the same four inputs —
//
//   input                     esbuild        Lightning CSS
//   ".a{color:red}}"          warn=1         THROWS
//   ".a{color:red;"           warn=1         warn=0   (the spec allows recovery)
//   "@nonsense (x) {...}"     warn=0         warn=1
//   "::scroll-marker-group"   warn=0         warn=1   (the family below)
//
// esbuild is stricter about lexical sloppiness, Lightning is stricter about
// structure, and only Lightning knows the selectors this site deliberately
// ships. A page that passed the contract check could therefore fail the build,
// which is the wrong way round: the build is what decides whether bytes reach a
// visitor, so the build's parser is the one a pre-build check should agree with.
//
// Lightning CSS 1.33 does not know the CSS Overflow 5 carousel selectors
// (::scroll-marker, ::scroll-marker-group, ::scroll-button(), :target-current).
// /garage/horizon demos them on purpose, because being new is the page's subject,
// and minifying that page's inline CSS turned 13 advisory warnings into a hard
// deploy failure the first time step 7b ran over it.
//
// Verified against lightningcss 1.33.0: it warns and then emits the selector
// VERBATIM, so the output is correct and the warning is advice about a parser gap
// rather than a report of damage. Tolerating the family is therefore safe, and
// tolerating it blindly is not, so the pass-through is re-proven on every call:
// each warned selector must still appear in the output. A future Lightning that
// starts DROPPING what it cannot parse fails here instead of silently shipping a
// page with its demo stripped out.

import { readFileSync } from "node:fs";
import { Features, transform as transformCss } from "lightningcss";

// `@custom-media` (src/styles/custom-media.css) is resolved HERE, for every
// stylesheet, by the one engine that already parses them all. Two flags do it:
// `drafts.customMedia` lets the parser accept the at-rule, and `include`
// forces the transform, because with no `targets` Lightning preserves modern
// syntax rather than downleveling it, and a query no engine implements is
// exactly the one it would otherwise preserve verbatim. Nothing else is
// included, so oklch(), nesting and the rest still ship as authored.
//
// The definitions are APPENDED rather than prepended, which the spec allows
// (a definition applies stylesheet-wide, last one wins), so a parse error in
// the caller's CSS still reports the caller's line number. An unused
// definition emits nothing (measured on lightningcss 1.33.0), which is what
// lets this ride on every stylesheet for free; an undefined name throws
// `Custom media query --x is not defined`, and that is the failure wanted.
const CUSTOM_MEDIA = readFileSync(new URL("../../src/styles/custom-media.css", import.meta.url), "utf8");

export const UNKNOWN_SELECTOR = /'([^']+)' is not recognized as a valid pseudo-(?:element|class)/;

// Parse `sourceText`, throwing on anything Lightning reports that is not the
// tolerated family, and throwing again if a tolerated selector failed to survive.
// `minify` is the caller's business: the build wants minified bytes, a contract
// check only wants the verdict. Both want the same definition of "damaged".
export const parseCss = (filename: string, sourceText: string, { minify = false } = {}) => {
  const result = transformCss({
    filename,
    code: Buffer.from(sourceText + "\n" + CUSTOM_MEDIA),
    minify,
    drafts: { customMedia: true },
    include: Features.CustomMediaQueries,
  });
  const out = Buffer.from(result.code).toString();

  const fatal: string[] = [], tolerated: string[] = [];
  for (const w of result.warnings) {
    const m = UNKNOWN_SELECTOR.exec(w.message);
    if (m) tolerated.push(m[1]);
    else fatal.push(w.message);
  }
  // A block the caller never closed runs to end-of-input, which is now the
  // appended definitions, so they parse as at-rules NESTED in that block and
  // Lightning reports each one as unknown. Before the append that stylesheet
  // parsed clean (an implicit close at EOF is legal recovery), so the append
  // is what surfaces the bug; the message it surfaces it with is not, hence
  // the translation. Measured on 1.33.0 with `.c { d: 1 ` at EOF.
  if (fatal.some((f) => f === "Unknown at rule: @custom-media")) {
    throw new Error(`${filename}: a block is never closed (the stylesheet runs to end-of-input inside a rule), so the @custom-media definitions appended after it were read as nested at-rules; add the missing \`}\``);
  }
  if (fatal.length) {
    throw new Error(`${filename}: Lightning CSS emitted warnings: ${fatal.join("; ")}`);
  }
  for (const selector of new Set(tolerated)) {
    if (!out.includes(selector)) {
      throw new Error(`${filename}: Lightning CSS dropped the selector it could not parse (${selector}); it must be preserved verbatim`);
    }
  }
  return out;
};
