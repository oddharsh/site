// prose-fold.ts — fold a long essay's later sections below the first screen.
//
// Wraps the top-level blocks of `.content.prose` into <section class="fold">
// from the first <h2> past FOLD_AFTER_CHARS of text, starting a new section at
// every <h2> after it. prose.css gives each fold `content-visibility: auto`, so
// on first paint the browser lays out the first screen of text and skips the
// rest, and `contain-intrinsic-block-size: auto <estimate>` keeps the scrollbar
// close to right until each section has rendered once.
//
// Measured 2026-10-07, this build against main served side by side, 24 runs per
// page at 50 Mbps with rotated order, on a quiet machine (load average about 6):
//   phone (390x844, 4x CPU)  /garage/horizon first paint -57.6 ms, /garage/wire -100.3 ms
//   desktop (1280x800)       /garage/horizon -16.6 ms,             /garage/wire -16.8 ms
// /lwe/fhe, unchanged by this, was the control (+8.6 ms phone, +1.1 ms desktop).
// /garage/compression didn't move (-2.6 ms phone, +2.2 ms desktop). CLS stayed 0.
// The LWE chat pages are `.content` without `.prose`, so nothing here touches
// them; an emulation measured no gain there. Production's per-card rules
// (`.demo`, `.msg`) stay: removing them cost horizon 20 to 28 ms, and the fold
// composes with them.
//
// A section starts only at a top-level <h2> or a top-level `section.demo` card
// (horizon's 98 cards, each holding its own h2), which keeps the margin fix in
// prose.css simple: before an h2 fold the block above drops its bottom margin
// and the h2 keeps its own, and a card has no top margin, so a card boundary
// needs no fix. An h2 starts a new fold every
// time; a card starts one once the current fold holds FOLD_EVERY_CHARS of text.
//
// The /garage shelf is one 16,000-character list, so no fold could open inside
// it. splitShelf cuts it first into runs of about SHELF_RUN_CHARS, and a run
// that continues the list opens a fold the way a card does. Measured 2026-10-07
// with the build-off's emulation, 25 runs a variant on a phone: /garage first
// paint -14.8 ms against a 0.0 ms floor, CLS 0, the first screen pixel-identical.
// Each run holds an even number of items, so the page's nth-child(even) striping
// carries on across a cut. A run that continues below carries class "open", one
// that continues from above "cont", and the page's own CSS hides the seam with
// them (classes rather than sibling selectors, since a fold can sit between two
// runs). shortcut: only ul.shelf splits; another long list would need its own
// seam CSS, and an <ol> its start numbers.
//
// It runs on readable, authored HTML, so it parses with HTMLRewriter (lol-html)
// rather than a regex: authored pages leave <p> unclosed in places, and a tag
// counter would misplace a section boundary inside a paragraph.

export const FOLD_AFTER_CHARS = 3000;
export const FOLD_EVERY_CHARS = 4000;
export const SHELF_RUN_CHARS = 1500;
const SHELF = ".content.prose > ul.shelf";
// The blocks a fold may open on, as direct children of `.content.prose`.
const STARTS = ".content.prose > h2, .content.prose > section.demo, .content.prose > ul.shelf.cont";
// Phone-width height per character of text, from the fold sections measured on
// /garage/horizon and /garage/compression (0.5 to 0.9 px, median about 0.6).
// `auto` replaces it with the real height once a section has rendered.
export const PX_PER_CHAR = 0.6;

/** The shelf cut into runs of whole items, or the page unchanged when it has no long shelf. */
function splitShelf(html: string): string {
  if (html.includes("shelf cont")) return html; // already split
  const items: number[] = [];
  let lists = 0;
  new HTMLRewriter()
    .on(SHELF, { element() { lists++; } })
    .on(`${SHELF} > li`, { element() { items.push(0); }, text(t) { items[items.length - 1] += t.text.replace(/\s+/g, " ").length; } }) // rendered text, as the measurement counted it
    .transform(html);
  if (lists !== 1) return html; // one shelf on the site today; two would need their items counted apart
  const cuts: number[] = [];
  for (let i = 0, run = 0, count = 0; i < items.length - 1; i++) {
    run += items[i]; count++;
    if (run >= SHELF_RUN_CHARS && count % 2 === 0) { cuts.push(i + 1); run = 0; count = 0; }
  }
  if (!cuts.length) return html;
  let attrs = "", i = -1;
  return new HTMLRewriter()
    .on(SHELF, {
      element(e) {
        attrs = [...e.attributes].filter(([n]) => n !== "class").map(([n, v]) => ` ${n}="${v.replace(/"/g, "&quot;")}"`).join("");
        e.setAttribute("class", `${e.getAttribute("class")} open`);
      },
    })
    .on(`${SHELF} > li`, {
      element(e) {
        i++;
        if (!cuts.includes(i)) return;
        const open = i === cuts[cuts.length - 1] ? "" : " open";
        e.before(`</ul><ul class="shelf${open} cont"${attrs}>`, { html: true });
      },
    })
    .transform(html);
}

type Plan = { starts: number[]; sizes: number[] };

/** Where the folds start (by index among the candidate blocks, in document order), and each fold's text length. */
function plan(html: string): Plan | null {
  let text = 0, hidden = 0, sawProse = false;
  const at: { h2: boolean; chars: number }[] = [];
  new HTMLRewriter()
    .on(".content.prose", { element() { sawProse = true; }, text(t) { text += t.text.length; } })
    // script, style and template text is in the count above; take it back out
    .on(".content.prose script, .content.prose style, .content.prose template", { text(t) { hidden += t.text.length; } })
    // the shelf's indentation too: its source is far more whitespace than an essay's,
    // so its raw length overstated each fold's height by about 40%
    .on(SHELF, { text(t) { hidden += t.text.length - t.text.replace(/\s+/g, " ").length; } })
    .on(STARTS, { element(e) { at.push({ h2: e.tagName === "h2", chars: text - hidden }); } })
    .transform(html);
  if (!sawProse) return null;
  const total = text - hidden;
  const starts: number[] = [];
  for (let i = 0; i < at.length; i++) {
    if (at[i].chars < FOLD_AFTER_CHARS) continue;
    const last = starts.length ? at[starts[starts.length - 1]].chars : -Infinity;
    if (!starts.length || at[i].h2 || at[i].chars - last >= FOLD_EVERY_CHARS) starts.push(i);
  }
  if (!starts.length) return null;
  const sizes = starts.map((i, k) => (k + 1 < starts.length ? at[starts[k + 1]].chars : total) - at[i].chars);
  return { starts, sizes };
}

/** The page with its long essay folded, or the page unchanged when it has nothing to fold. */
export function foldLongProse(html: string): string {
  if (html.includes('class="fold"')) return html; // already folded: the twin writer re-dresses pages
  html = splitShelf(html);
  const p = plan(html);
  if (!p) return html;
  const open = (k: number) =>
    `<section class="fold" style="contain-intrinsic-block-size:auto ${Math.max(200, Math.round(p.sizes[k] * PX_PER_CHAR))}px">`;
  let i = -1, k = 0;
  return new HTMLRewriter()
    .on(STARTS, {
      element(e) {
        i++;
        if (i !== p.starts[k]) return;
        e.before((k > 0 ? "</section>" : "") + open(k), { html: true });
        k++;
      },
    })
    .on(".content.prose", {
      element(e) {
        e.onEndTag((end) => { if (k > 0) end.before("</section>", { html: true }); });
      },
    })
    .transform(html);
}
