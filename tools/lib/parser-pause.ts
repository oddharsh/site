// parser-pause.ts — let the first screen paint before the rest of a long page parses.
//
// Puts `<link rel="stylesheet" href="/quiz.css">` between two top-level blocks
// of `.window > .content`, at the first boundary past FOLD_AFTER_CHARS of text,
// where prose-fold.ts already puts the end of the first screen. Chrome stops
// parsing at an in-body stylesheet until it loads and paints what it has
// meanwhile, so the first frame holds the first screen and not the whole
// document. The sheet is the understanding check's, which quiz.js loads
// anyway once the reader nears the quiz at the bottom, so the pause costs no
// new file: a cold visit fetches it at the fold instead of on scroll, and a
// warm one has it cached and doesn't pause at all.
//
// Measured in the 2026-10 build-off (follow-up T1, an emulation on production
// at 59afbac1): phone first paint -85 ms on /garage/compression, -92 ms on
// /garage, -49 ms on /lwe/fhe, against a 6.5 ms floor, on a saturated machine.
// The gain was GPU raster of the `.content` scroller's whole contents, not
// main-thread layout. The PR that added this file has the rerun on this build.
//
// THE COST. The build appends the taskbar after `.window`, so it parses after
// the pause, and the first frame paints without it until the sheet arrives
// (about one round trip).
//
// Chat pages (`.content > .msgr > .log`) are one block at the top level, so
// their boundaries are the `.log`'s messages. A page whose first paint waits
// for its first prose fold (`rel=expect`, lib/critical-css.ts) takes the pause
// only after that fold, since a pause before it would hold first paint for the
// sheet instead of releasing it.
//
// The threshold is the fold's and not lower: at 2,500 characters the pause
// sat 590 px down /garage/horizon at 1280x800, inside the 645 px first screen
// (2026-11-07), and the build-off's 1,750 sat inside it on two pages.
//
// It runs on readable, authored HTML, so it parses with HTMLRewriter, as
// prose-fold.ts does.

import { FOLD_AFTER_CHARS } from "./prose-fold.ts";

export const PAUSE_MIN_REST = 400; // less text than this left below isn't worth a pause
export const PAUSE_HREF = "/quiz.css";
const LINK = `<link rel="stylesheet" href="${PAUSE_HREF}">`;
const BLOCKS = ".window > .content > *:not(.msgr), .window > .content > .msgr > .log > *";

/** The page with the pause before its first block past FOLD_AFTER_CHARS, or unchanged. */
export function pauseBelowFirstScreen(html: string, { afterFirstFold = false } = {}): string {
  if (html.includes(LINK)) return html; // already paused: the twin writer re-dresses pages
  let text = 0,
    hidden = 0,
    folds = 0;
  const at: { chars: number; afterFold: boolean }[] = [];
  new HTMLRewriter()
    .on(".window > .content", {
      text(t) {
        text += t.text.replace(/\s+/g, " ").length;
      },
    })
    .on(".window > .content script, .window > .content style, .window > .content template", {
      text(t) {
        hidden += t.text.replace(/\s+/g, " ").length;
      },
    })
    .on(BLOCKS, {
      element(e) {
        at.push({ chars: text - hidden, afterFold: folds > 0 });
        if (e.tagName === "section" && e.getAttribute("class") === "fold") folds++;
      },
    })
    .transform(html);
  const total = text - hidden;
  const pick = at.findIndex((b) => b.chars >= FOLD_AFTER_CHARS && total - b.chars >= PAUSE_MIN_REST && (!afterFirstFold || b.afterFold));
  if (pick < 0) return html;
  let i = -1;
  return new HTMLRewriter()
    .on(BLOCKS, {
      element(e) {
        if (++i === pick) e.before(LINK, { html: true });
      },
    })
    .transform(html);
}
