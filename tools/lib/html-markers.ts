// html-markers.mjs — the load-bearing structures the minified homepage must still
// carry, as one list both halves of the gate read.
export const HTML_MARKERS: Array<[label: string, marker: RegExp]> = [
  ["JSON-LD", /<script\b[^>]*\btype=(?:"application\/ld\+json"|application\/ld\+json)(?:\s|>)/i],
  ["photos", /<section\b[^>]*\bclass=(?:"[^"]*\bphotos\b"|'[^']*\bphotos\b'|photos)(?:\s|>)/i],
  ["playlist", /<(?:ol|ul)\b[^>]*\bid=(?:"np-list"|np-list)(?:\s|>)/i],
  ["footer", /<footer\b/i],
];

export const PAGE_MARKERS: Array<[label: string, marker: RegExp]> = [
  ["understanding-check data", /<script\b[^>]*\bid=(?:"luq-data"|luq-data)(?:\s|>)/i],
  ["understanding-check mount", /<(?:section|div)\b[^>]*\bid=(?:"luq"|luq)(?:\s|>)/i],
  ["quiz runtime", /<script\b[^>]*\bsrc=(?:"[^"]*\/(?:a\/)?quiz[.\w]*\.js"|[^\s>]*\/(?:a\/)?quiz[.\w]*\.js)/i],
  ["desktop shell", /\bid=(?:"axp-desktop"|axp-desktop)(?:\s|>)/i],
  ["taskbar", /\bid=(?:"axp-taskbar"|axp-taskbar)(?:\s|>)/i],
  ["nav runtime", /<script\b[^>]*\bsrc=(?:"[^"]*\/(?:a\/)?nav[.\w]*\.js"|[^\s>]*\/(?:a\/)?nav[.\w]*\.js)/i],
  ["stylesheet link", /<link\b[^>]*\brel=(?:"stylesheet"|stylesheet)(?:\s|>)/i],
];
