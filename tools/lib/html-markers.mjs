// html-markers.mjs — the load-bearing structures the minified homepage must still
// carry, as one list both halves of the gate read.
//
// build.mjs throws if the minifier drops one, and perf-budget.mjs fails the deploy
// if the shipped file is missing one. Those are the same claim checked at two
// moments, so they were the same array written out twice, byte-identical. A marker
// added to one copy and not the other silently narrows the gate to whatever the
// two still agree on, which is the failure a tripwire is supposed to prevent.
// Consolidated 2026-07-28.
//
// Each entry is [label, regex]. The regexes tolerate the minifier's attribute
// unquoting (`type=application/ld+json` as well as the quoted form), because the
// point is to prove the STRUCTURE survived, not that its bytes went untouched.
export const HTML_MARKERS = [
  ["JSON-LD", /<script\b[^>]*\btype=(?:"application\/ld\+json"|application\/ld\+json)(?:\s|>)/i],
  ["photos", /<section\b[^>]*\bclass=(?:"[^"]*\bphotos\b"|'[^']*\bphotos\b'|photos)(?:\s|>)/i],
  ["playlist", /<(?:ol|ul)\b[^>]*\bid=(?:"np-list"|np-list)(?:\s|>)/i],
  ["speculation rules", /<script\b[^>]*\btype=(?:"speculationrules"|speculationrules)(?:\s|>)/i],
  ["footer", /<footer\b/i],
];

// The same idea for every OTHER served page, once minification stopped being a
// homepage-only thing (2026-07-31). These are applied DIFFERENTIALLY: a marker is
// required in the output only when the page carried it on the way in.
//
// That difference matters, and it is not a softening. A fixed per-family list would
// have to know which of the 43 pages is a garage explainer, which is an LWE chat,
// and which is a Worker-rendered document with no quiz at all, and it would have to
// be edited every time a family gains a member. Asking "did minification LOSE this"
// is the claim the tripwire actually wants, it holds for every page without a
// roster, and a new page family inherits it with no edit here.
export const PAGE_MARKERS = [
  ["understanding-check data", /<script\b[^>]*\bid=(?:"luq-data"|luq-data)(?:\s|>)/i],
  ["understanding-check mount", /<(?:section|div)\b[^>]*\bid=(?:"luq"|luq)(?:\s|>)/i],
  ["quiz runtime", /<script\b[^>]*\bsrc=(?:"[^"]*\/(?:a\/)?quiz[.\w]*\.js"|[^\s>]*\/(?:a\/)?quiz[.\w]*\.js)/i],
  ["desktop shell", /\bid=(?:"axp-desktop"|axp-desktop)(?:\s|>)/i],
  ["taskbar", /\bid=(?:"axp-taskbar"|axp-taskbar)(?:\s|>)/i],
  ["nav runtime", /<script\b[^>]*\bsrc=(?:"[^"]*\/(?:a\/)?nav[.\w]*\.js"|[^\s>]*\/(?:a\/)?nav[.\w]*\.js)/i],
  ["stylesheet link", /<link\b[^>]*\brel=(?:"stylesheet"|stylesheet)(?:\s|>)/i],
];
