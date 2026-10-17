// A Markdown twin's table cells are escaped for GFM, and the escape is correct
// for a reason no reader can see from the line: a table cell is unescaped TWICE
// (the table stage resolves `\|`, then inline parsing resolves `\\`), so the
// right number of backslashes to emit depends on how many the cell already
// carries. CodeQL's js/incomplete-sanitization reads it as a missing backslash
// escape and is wrong here; the long argument is at renderTable.
//
// This pins the BYTES rather than the reasoning. Each expectation below was
// rendered through GitHub's own GFM renderer on 2026-08-24 and came back as the
// source content, so a refactor that "fixes" the escape has to explain why these
// moved. The renderer is not reachable from the suite (no network), which is why
// the measurement is recorded as constants and the recipe is written down here:
//
//   gh api /markdown -f mode=gfm -f text="$(cat table.md)"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDocument } from "./lib/html-to-md.ts";

// [label, cell content, expected TEXT-cell markdown, expected CODE-cell markdown]
// The last two columns are what GFM must receive to render the second column back.
const CASES = [
  ["plain pipe",         "x|y",     "x\\|y",       "`x\\|y`"],
  ["backslash + pipe",   "i\\|j",   "i\\\\\\|j",   "`i\\\\|j`"],
  ["2 backslash + pipe", "m\\\\|n", "m\\\\\\\\\\|n", "`m\\\\\\|n`"],
  ["lone backslash",     "g\\h",    "g\\\\h",      "`g\\h`"],
  ["trailing backslash", "t\\",     "t\\\\",       "`t\\`"],
];

const twin = (cells) => readDocument(
  `<html><body><div class="content"><table><tr><th>a</th><th>b</th></tr>${cells}</tr></table></div></body></html>`,
).body;

test("table cells escape pipes for GFM's two-stage unescape", () => {
  for (const [label, content, wantText, wantCode] of CASES) {
    const body = twin(`<tr><td>${content}</td><td><code>${content}</code></td>`);
    const row = body.split("\n").at(-1);
    assert.equal(row, `| ${wantText} | ${wantCode} |`, label);
  }
});

// cmark-gfm's own cell-splitting rule, scanned left to right: `\|` is consumed
// as an escaped pipe and every other character (backslash included) is copied.
// A regex cannot stand in for this -- the first attempt counted 4 delimiters in
// a 2-column row, because "pipe not preceded by an odd run of backslashes" is
// the INLINE rule and the table stage runs first and reads differently.
function delimiters(row) {
  let n = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\" && row[i + 1] === "|") { i += 1; continue; }
    if (row[i] === "|") n += 1;
  }
  return n;
}

test("no cell content can split a row", () => {
  // The property the escape exists for: whatever a cell holds, the row carries
  // exactly the delimiters its structure put there. Two columns is three.
  assert.equal(delimiters("| a | b |"), 3, "control: an unescaped row");
  assert.equal(delimiters("| a|b | c |"), 4, "control: an UNescaped pipe does split");
  for (const [label, content] of CASES) {
    const row = twin(`<tr><td>${content}</td><td><code>${content}</code></td>`).split("\n").at(-1);
    assert.equal(delimiters(row), 3, `${label}: ${row}`);
  }
});
