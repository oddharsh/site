// Footnotes on prose pages carry their text in the marker's href, so the
// browser's own link-hover bubble previews the note with no JS:
//
//   <a class="note-ref" href="#The note, as a sentence.">1</a>
//   ...
//   <ol class="footnotes"><li id="The note, as a sentence.">The note, as a sentence.</li></ol>
//
// A click jumps to the <li> whose id is that same string. Chrome decodes
// spaces and Unicode in the bubble (checked by hovering, 2026-11-21), so the
// fragment reads as the sentence. The <li> body is the note; its id and every
// href that points at it are copies, and footnoteProblems() is what keeps the
// three in agreement.

const MARKER = /<a class="note-ref" href="#([^"]*)">([^<]*)<\/a>/g;
const LIST = /<ol class="footnotes">([\s\S]*?)<\/ol>/g;
const ITEM = /<li id="([^"]*)">([\s\S]*?)<\/li>/g;

function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function footnoteProblems(html: string): string[] {
  const problems: string[] = [];
  const markers = [...html.matchAll(MARKER)];
  const markerCount = (html.match(/class="note-ref"/g) ?? []).length;
  if (markerCount !== markers.length) {
    problems.push(`${markerCount - markers.length} footnote marker(s) aren't in the <a class="note-ref" href="#note">n</a> shape`);
  }
  const lists = [...html.matchAll(LIST)];
  if (lists.length > 1) problems.push(`${lists.length} <ol class="footnotes"> lists; a page gets one`);
  if (markers.length === 0 && lists.length === 0) return problems;
  if (lists.length === 0) {
    problems.push(`${markers.length} footnote marker(s) but no <ol class="footnotes">`);
    return problems;
  }
  const items = [...lists[0][1].matchAll(ITEM)];
  if (items.length !== markers.length) {
    problems.push(`${markers.length} footnote marker(s) but ${items.length} <li id> in <ol class="footnotes">`);
  }
  for (const [index, item] of items.entries()) {
    const [, id, body] = item;
    const note = index + 1;
    if (/[%#]/.test(id)) problems.push(`footnote ${note}'s text has a % or #, which the href fragment would mangle`);
    if (plainText(body) !== id) problems.push(`footnote ${note}'s id doesn't match its text: id "${id}", text "${plainText(body)}"`);
  }
  for (const [index, marker] of markers.entries()) {
    const [, fragment, label] = marker;
    const note = index + 1;
    if (label !== String(note)) problems.push(`footnote marker ${note} reads "${label}"; markers count 1, 2, 3 in page order`);
    const item = items[index];
    if (item !== undefined && fragment !== item[1]) {
      problems.push(`footnote marker ${note}'s href "#${fragment}" doesn't match footnote ${note}'s id "${item[1]}"`);
    }
  }
  return problems;
}
