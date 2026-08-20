// ── lib/tui.js ───────────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
  tui,
} from "./contract-shared.mjs";

// ── lib/tui.js ───────────────────────────────────────────────────────────────
// A fixed-80-column renderer fails SILENTLY. A frame one column wide or narrow
// still returns a string, still serves 200, and just looks subtly wrong; nothing
// throws and no check notices. These pin the width contract instead, because it
// is the property every renderer in that file depends on and none of them state.
//
// The module is pure ON PURPOSE, which is what lets one renderer answer HTTP,
// MCP and `node --test` (see the note at its head). Until now that purity bought
// 3.7% line coverage: it was testable and untested.

test("tui width() counts code points, never UTF-16 units", () => {
  // The `[...text]` spreads throughout tui.js exist for exactly this. Counting
  // .length instead would make every frame containing an emoji or a CJK name
  // render narrow, and photo captions plus third-party page titles both flow
  // through these frames.
  assert.equal(tui.width([tui.s("abc")]), 3);
  assert.equal(tui.width([tui.s("😀")]), 1, "an astral character is ONE column, not two");
  assert.equal("😀".length, 2, "...which is the UTF-16 length this must not use");
  assert.equal(tui.width([tui.s("a"), tui.s("😀"), tui.s("b")]), 3, "spans sum by code point");
  assert.equal(tui.width([tui.s(null), tui.s(undefined)]), 0, "null and undefined are empty, not 'null'");
});

test("tui fit() is EXACTLY the requested width, whatever went in", () => {
  // fit()'s own docblock promises this and nothing enforced it. Every framed
  // surface (/finger, /radar, /dict, /cache, the /terminal console) is built out
  // of it, so one off-by-one here misaligns every frame on the site at once.
  const cases = [
    ["", "empty"],
    ["short", "under"],
    ["x".repeat(40), "exact"],
    ["x".repeat(200), "over"],
    ["😀".repeat(30), "astral, over"],
    ["a😀b", "mixed"],
  ];
  for (const [text, label] of cases) {
    for (const w of [1, 2, 10, 40, tui.COLS]) {
      assert.equal(tui.width(tui.fit([tui.s(text)], w)), w, `fit(${label}, ${w}) must be exactly ${w} columns`);
    }
  }
});

test("tui truncTo() reserves exactly one column for its ellipsis", () => {
  const long = [tui.s("x".repeat(50))];
  const out = tui.truncTo(long, 10);
  assert.equal(tui.width(out), 10, "a truncated line still measures the requested width");
  assert.ok(out.at(-1)[0].endsWith("…"), "the cut is marked");
  assert.equal(tui.width(tui.truncTo([tui.s("abc")], 10)), 3, "a line that fits is returned untouched");
  assert.deepEqual(tui.truncTo(long, 0), [], "a zero-width column truncates to nothing rather than an ellipsis");
});

test("tui ends() fills its line and never lets the two sides touch", () => {
  // ends() is what draws every header row: a label left, a value right. If the
  // gap maths is wrong the two run together and the frame reads as corrupted.
  for (const [l, r] of [["left", "right"], ["", ""], ["x".repeat(70), "y".repeat(20)], ["😀".repeat(9), "z"]]) {
    const out = tui.ends([tui.s(l)], [tui.s(r)], tui.COLS);
    assert.equal(tui.width(out), tui.COLS, `ends(${l.slice(0, 6)}…) must fill exactly ${tui.COLS}`);
    const flat = out.map(([t]) => t).join("");
    if (l && r) assert.match(flat, / /, "there is always whitespace between the two sides");
  }
});

test("tui wrap() never returns a line wider than the column", () => {
  const w = 24;
  const inputs = [
    "short",
    "a series of perfectly ordinary words that must be broken across several lines",
    "https://example.com/" + "a".repeat(120),      // one unbreakable token
    "😀".repeat(80),                                // astral, unbreakable
    "   collapsing\n\twhitespace   ",
    "",
  ];
  for (const text of inputs) {
    for (const row of tui.wrap(text, w)) {
      assert.ok([...row].length <= w, `wrap kept a ${[...row].length}-column row in a ${w} column pane: ${row.slice(0, 30)}`);
    }
  }
  assert.deepEqual(tui.wrap("", w), [], "empty input wraps to no lines, not one blank one");
  assert.deepEqual(tui.wrap("   ", w), [], "whitespace-only input too");
});

test("tui table() emits rows that are all exactly the table width", () => {
  const out = tui.table({
    cols: [{ label: "name", width: 20 }, { label: "value" }],
    rows: [["short", "x"], ["😀".repeat(30), "y".repeat(90)], ["", ""]],
    width: tui.COLS,
  });
  assert.ok(out.length >= 3, "header plus rows");
  for (const line of out) {
    assert.equal(tui.width(line), tui.COLS, "every table row measures the full width");
  }
});

test("tui emit() is plain text, always", () => {
  // The header is explicit that this is the ONLY place escapes could be produced
  // and that it deliberately produces none: an escape sequence in a model's
  // context window is noise the model then has to be robust to, and these frames
  // are served to MCP and to the Markdown twins as well as to a terminal.
  const painted = tui.emit([
    [tui.s("plain"), tui.s("styled", "dim")],
    tui.rule(tui.COLS, "section"),
    ...tui.wrap("some prose", tui.COLS).map((r) => [tui.s(r)]),
  ]);
  assert.doesNotMatch(painted, /\[/, "no ANSI escape may reach the output");
  assert.match(painted, /plain/);
  assert.match(painted, /styled/, "dropping the escapes must not drop the text");
});

test("tui pane() and plainFrame() render at the console width", () => {
  const paneOut = tui.pane({ title: "title", body: tui.wrap("body text", tui.COLS - 4).map((r) => [tui.s(r)]) });
  for (const line of paneOut) assert.ok(tui.width(line) <= tui.COLS, "a pane never exceeds the console");
  const frame = tui.emit(tui.plainFrame({ title: "t", body: [[tui.s("b")]], status: "ok" }));
  assert.ok(frame.split("\n").every((l) => [...l].length <= tui.COLS), "no frame line exceeds 80 columns");
});
