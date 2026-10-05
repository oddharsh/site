// og-pages.mjs — the top-level PAGE DIRECTORIES that get an OG card, as one list
// both halves of the card pipeline read.
//
// There are three static shapes under public/ and the card pipeline only knew
// about one of them:
//
//   SECTION       many .html files under one directory (garage/, lwe/). Walked by
//                 gen-og-cards.mjs and inject-og-meta.mjs directly.
//   PAGE DIR      one index.html, its own top-level route, no section index
//                 (access/, pixel-peeper/). Invisible to that walk, which is why
//                 /access shipped without a card.
//   WORKER ROUTE  no file on disk at all (/lens). Hand-listed in the generator's
//                 WORKER_PAGES, and its meta is hand-written in the worker module
//                 because there is no file for the injector to edit.
//
// A page dir has a real file, so unlike a worker route it captures fine against
// the local static server, and unlike a worker route its meta CAN be injected.
//
// One list rather than two: EXCLUDE already lives in both scripts held together
// by a "must match gen-og-cards.mjs" comment, and that is the drift this avoids.
//
// Every page dir on disk is registered. The per-page capture config (hero
// selectors, and the preset click /pixel-peeper needs to get off its intro
// screen) lives in gen-og-cards.mjs's HERO table with every other page's, so
// this file stays the roster and nothing else.
export const OG_PAGE_DIRS = [
  {
    // The site root: `dir` is empty, so the page is src/pages/index.html and
    // the live route is `/`. The homepage is the URL people share most, and it
    // carried og tags with no image until 2026-10-05, so it unfurled as text.
    // Count- and subject-agnostic, because the grid draws a random twelve of the
    // library on every request and a regeneration changes every photo.
    id: "home",
    dir: "",
    alt: "The aadhar.sh homepage as a Windows XP window: Aadharsh Pannirselvam's name "
       + "and one-line bio above a contact sheet of his photographs.",
  },
  {
    id: "access",
    dir: "access",
    // Hand-written alt, because the generic "<og:title>, live demo screenshotted"
    // line the injector synthesises would describe this card as a demo. It is a
    // map, and the alt should say what is actually in the picture. Count-agnostic
    // on purpose: the board grows, and an alt naming a number goes stale silently.
    alt: "A Windows XP Device Manager window listing the flavors of language-model access "
       + "as a dependency graph, with yellow-bang and unknown-device icons marking the unfinished ones.",
  },
  {
    id: "pixel-peeper",
    dir: "pixel-peeper",
    // Deliberately count-agnostic: the exam picks a two-way or three-way trial at
    // random on every load, so the card is not deterministic and any alt naming a
    // number goes stale the next time someone regenerates it.
    alt: "A Windows XP window asking which looks best, showing the same photograph side by side "
       + "at different compression settings, with a hint to hover and pixel-peep.",
  },
  {
    id: "dotfiles",
    dir: "dotfiles",
    // A checklist rather than a demo, so the synthesised "live demo" line would
    // misdescribe it. Count-agnostic like the other two: options get added.
    alt: "A Windows XP Advanced settings list of macOS defaults, grouped into folders for "
       + "Keyboard, Trackpad and Appearance, every box ticked and each row showing its factory value.",
  },
];
