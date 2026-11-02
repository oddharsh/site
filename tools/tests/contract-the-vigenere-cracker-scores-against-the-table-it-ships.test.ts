// ── the /lwe/vigenere cracker ───────────────────────────────────────────────
import { assert, brotliCompressSync, readFileSync, test, zlibConstants } from "./contract-shared.ts";

// Moved out of the Reader lens tests on 2026-10-24: the cracker is /lwe's, and
// a change to /lens must never be able to delete these.

test("the cracker's scorer matches the quadgram table it ships", () => {
  // The /lwe/vigenere cracker fetches public/lwe/quadgrams.txt and derives every
  // score from a gram's RANK in that file, so the file's SHAPE is part of the
  // scorer. Regenerating it at a different size, or with counts left in, changes
  // what the solver computes while both the page and the table still look fine.
  // Nothing else in the build reads this file, so this is the only thing that
  // would notice.
  const table = readFileSync("./public/lwe/quadgrams.txt", "utf8");
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");

  assert.match(table, /^[A-Z]+$/, "the table must be bare A-Z with no counts, separators or trailing newline");
  assert.equal(table.length % 4, 0, "the table must be whole quadgrams");
  const grams = table.length / 4;
  assert.equal(grams, 4000, `the page's prose and gauge thresholds were measured at 4,000 grams, got ${grams}`);

  const seen = new Set();
  for (let i = 0; i < table.length; i += 4) seen.add(table.slice(i, i + 4));
  assert.equal(seen.size, grams, "a duplicated quadgram would give one gram two ranks");
  assert.equal(table.slice(0, 4), "THAT", "the table must stay in frequency order; TOP is calibrated to the first entry");

  // TOP is log10 of the most common quadgram's corpus share and FLOOR is an
  // unseen one. tools/photos/gen-quadgram-table.ts prints both; the page
  // hardcodes them, and a table rebuilt from a different corpus moves them.
  const top = Number(page.match(/var TOP = (-[\d.]+)/)[1]);
  const floor = Number(page.match(/FLOOR = (-[\d.]+)/)[1]);
  assert.ok(top > floor, "an observed quadgram must outscore an unseen one");
  assert.ok(top > -3 && top < -2, `TOP looks recalibrated (${top}); rerun gen-quadgram-table.ts and update the page`);
  assert.ok(floor > -10 && floor < -8, `FLOOR looks recalibrated (${floor})`);

  // The page states the wire cost as a fact. It is a fact about these bytes.
  const wire = brotliCompressSync(Buffer.from(table), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  const claimed = Number(page.match(/<b>([\d.]+) KB<\/b> over the wire/)[1]);
  assert.ok(Math.abs(wire / 1024 - claimed) < 0.15, `the page claims ${claimed} KB over the wire, the table brotlis to ${(wire / 1024).toFixed(1)} KB`);
});

test("the cracker reports a verdict rather than always answering", () => {
  const page = readFileSync("./src/pages/lwe/vigenere.html", "utf8");
  // A solver that always returns its best guess is indistinguishable from one
  // that solved the cipher, which is the whole reason step 4 exists. The three
  // outcomes and the sample-size shrinkage are the load-bearing parts.
  assert.match(page, /<b>failed\.<\/b>/, "a run that did not solve must say so");
  // The scorer and its shrinkage, since both words also appear in comments and
  // in PERIOD_PSEUDO, which is a different estimate.
  assert.match(page, /function confidence\(L\)/, "the verdict must carry a confidence");
  assert.match(page, /\+ PSEUDO \* FLOOR\) \/ \(w \+ PSEUDO\)/, "confidence must be shrunk toward random on short text");
  assert.match(page, /margin over runner-up/, "the verdict must report the margin to the next candidate");
  // The gauge predicts failure BEFORE the run, from letters per column, which is
  // the number that actually governs it. These thresholds were measured.
  assert.match(page, /letters per column/, "the gauge must be per column, not per message");
  assert.match(page, /per >= 20/, "the measured comfortable threshold is 20 letters per column");
});
