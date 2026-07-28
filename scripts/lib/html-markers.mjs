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
