// ── dcb vs dcz: one record, every copy checked (src/worker/dict-measured.ts) ──
// tools/measure-dict-encodings.ts writes dict-measured.json and the page's
// figures table. The table must be exactly what the record renders, and the
// hand-written prose and quiz must quote every figure the argument rests on, so
// a re-measure that moves a number fails here until the words catch up. The
// 8.3x that outlived its measurement by four months is the defect (PR 1877).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { TABLE_END, TABLE_START, dictFacts, parseDictMeasured, renderDictTable } from "../dict-measured.ts";
import { DICT_FACTS, MEASURED } from "../dict.ts";

const PAGE = readFileSync(join(import.meta.dirname, "../../pages/garage/compression.html"), "utf8");
const PROSE_START = "<!-- dict-measured:prose";
const PROSE_END = "<!-- /dict-measured:prose -->";
const QUIZ_QUESTION = "The deltas ship as dcz even though brotli measured smaller. Why?";

function between(start: string, end: string): string {
  const from = PAGE.indexOf(start);
  const to = PAGE.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `compression.html lost its ${start} ... ${end} markers`);
  return PAGE.slice(from + start.length, to);
}

function quotes(where: string, text: string, keys: (keyof typeof DICT_FACTS)[]): void {
  for (const key of keys) {
    assert.ok(text.includes(DICT_FACTS[key]), `the ${where} no longer quotes ${DICT_FACTS[key]} (${key}); update it to src/worker/dict-measured.json`);
  }
}

test("the figures table is exactly what the record renders", () => {
  const region = between(TABLE_START, TABLE_END);
  assert.equal(region.trim(), renderDictTable(DICT_FACTS).trim());
});

test("the prose quotes every figure its argument rests on", () => {
  quotes("prose", between(PROSE_START, PROSE_END), [
    "pairs",
    "dcbSmaller",
    "decodeRatio",
    "savedBytes",
    "extraDecodeUs",
    "breakEvenMbps",
    "phoneBreakEvenMbps",
    "phoneSlowdown",
  ]);
});

test("the quiz answer quotes the same figures", () => {
  const question = PAGE.indexOf(`"q": "${QUIZ_QUESTION}"`);
  assert.ok(question >= 0, "the dcb vs dcz quiz question moved; update QUIZ_QUESTION");
  const next = PAGE.indexOf(`"q": "`, question + 1);
  const block = PAGE.slice(question, next < 0 ? undefined : next);
  const why = /"ok": true,\s*"why": "([^"]*)"/.exec(block);
  assert.ok(why, "the dcb vs dcz quiz question has no correct answer");
  quotes("quiz answer", why[1], ["pairs", "dcbSmaller", "decodeRatio", "dczUs", "dcbUs", "breakEvenMbps", "phoneBreakEvenMbps"]);
});

test("MEASURED quotes the record rather than its own copy", () => {
  const rows = new Map(MEASURED.map(([label, value]) => [label, value]));
  assert.equal(rows.get("dcz vs dcb, decode"), `dcz ${DICT_FACTS.dczUs} vs dcb ${DICT_FACTS.dcbUs} per rebuild in C, ${DICT_FACTS.decodeRatio}`);
  // Positive and negative space: the July figure is gone from every row.
  assert.ok(!MEASURED.some(([, value]) => value.includes("8.3x")));
});

const FIXED = {
  measured: "2026-01-01",
  machine: "test",
  decoders: { brotli: "1.2.1", zstd: "1.5.7" },
  pairs: { total: 10, shell: 4, pages: 6, rawBytes: 1_000_000 },
  size: { dcbBytes: 9_000, dczBytes: 10_000, dcbSmallerOn: 8, widest: { file: "nav.js", dcbBytes: 1_200, dczBytes: 1_500 } },
  decode: { dcbUs: 20, dczUs: 10 },
  assumed: { linkMbps: 50, phoneDecodeSlowdown: 3 },
};

test("the figures follow from the record by fixed formulas", () => {
  const f = dictFacts(parseDictMeasured(FIXED));
  assert.equal(f.dcbSmaller, "10.0%");
  assert.equal(f.decodeRatio, "2.0x");
  assert.equal(f.savedBytes, "100 bytes");
  assert.equal(f.extraDecodeUs, "10.0 µs");
  // 100 B is 800 bits, over 10 us: 80 bits per microsecond is 80 Mbps.
  assert.equal(f.breakEvenMbps, "80 Mbps");
  assert.equal(f.phoneBreakEvenMbps, "27 Mbps");
  assert.equal(f.averageRaw, "100,000 B");
  assert.equal(f.dcbMiBs, "4,768 MiB/s");
  assert.equal(f.dczMiBs, "9,537 MiB/s");
});

test("a record the figures can't rest on is refused at the boundary", () => {
  assert.equal(parseDictMeasured(FIXED).pairs.total, 10);
  assert.throws(() => parseDictMeasured({ ...FIXED, decode: { dcbUs: 10, dczUs: 10 } }), /assume dcb decodes slower/);
  assert.throws(() => parseDictMeasured({ ...FIXED, pairs: { ...FIXED.pairs, pages: 7 } }), /shell \+ pages != total/);
  assert.throws(() => parseDictMeasured({ ...FIXED, size: { ...FIXED.size, dcbBytes: -1 } }), /size\.dcbBytes is not a non-negative number/);
});
