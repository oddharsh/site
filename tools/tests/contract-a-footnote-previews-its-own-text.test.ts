// ── a footnote previews its own text ────────────────────────────────────────
// A prose footnote's marker href, its <li> id and its <li> text are one string
// written 3 times (tools/lib/footnotes.ts). These pin that the page check
// passes when all 3 agree and names the footnote when any one drifts.
import { assert, test } from "./contract-shared.ts";
import { footnoteProblems } from "../lib/footnotes.ts";

const page = (markers: string, items: string) => `<p>Body${markers}.</p><ol class="footnotes">${items}</ol>`;

test("a footnote whose href, id and text agree has no problems", () => {
  const html = page(
    '<a class="note-ref" href="#First note.">1</a> and <a class="note-ref" href="#Second, with a link.">2</a>',
    '<li id="First note.">First note.</li><li id="Second, with a link.">Second, with <a href="/x">a link</a>.</li>',
  );
  assert.deepEqual(footnoteProblems(html), []);
});

test("a page with no footnotes has no problems", () => {
  assert.deepEqual(footnoteProblems("<p>No notes here.</p>"), []);
});

test("an href that drifts from its id is named by footnote number", () => {
  const html = page('<a class="note-ref" href="#Old note.">1</a>', '<li id="New note.">New note.</li>');
  assert.deepEqual(footnoteProblems(html), [`footnote marker 1's href "#Old note." doesn't match footnote 1's id "New note."`]);
});

test("an id that drifts from its text is named by footnote number", () => {
  const html = page('<a class="note-ref" href="#Old note.">1</a>', '<li id="Old note.">New note.</li>');
  assert.deepEqual(footnoteProblems(html), [`footnote 1's id doesn't match its text: id "Old note.", text "New note."`]);
});

test("markers count up from 1 and match the list's length", () => {
  const html = page('<a class="note-ref" href="#A.">2</a>', '<li id="A.">A.</li><li id="B.">B.</li>');
  assert.deepEqual(footnoteProblems(html), [
    `1 footnote marker(s) but 2 <li id> in <ol class="footnotes">`,
    `footnote marker 1 reads "2"; markers count 1, 2, 3 in page order`,
  ]);
});

test("a marker with no list, or in another shape, is a problem", () => {
  assert.deepEqual(footnoteProblems('<a class="note-ref" href="#A.">1</a>'), [`1 footnote marker(s) but no <ol class="footnotes">`]);
  assert.deepEqual(footnoteProblems('<sup class="note-ref">1</sup>'), [`1 footnote marker(s) aren't in the <a class="note-ref" href="#note">n</a> shape`]);
});

test("a % or # in the text is refused, since the fragment would change it", () => {
  const html = page('<a class="note-ref" href="#Up 40%.">1</a>', '<li id="Up 40%.">Up 40%.</li>');
  assert.deepEqual(footnoteProblems(html), [`footnote 1's text has a % or #, which the href fragment would mangle`]);
});
