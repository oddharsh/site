// ── the page-family trainer keeps what pages share and drops what one page owns ──
import { assert, test } from "./contract-shared.ts";
import { zstdDecompressSync } from "node:zlib";
import { zstdDictionaryFrame } from "../lib/dcz.ts";
import { trainFamilyDictionary } from "../lib/family-trainer.ts";

// Seeded pages: each opens on its own 6 KiB body and ends on a 3 KiB shell
// every page shares, the shape of a site page behind its Luna chrome.
function seededBytes(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = 0x20 + ((x >>> 0) % 95);
  }
  return out;
}
const SHELL = seededBytes(1, 3072);
const pages = Array.from({ length: 12 }, (_, i) => Buffer.concat([seededBytes(100 + i, 6144), SHELL]));
const SIZE = 8192;

test("the family trainer keeps the shared shell and drops a body only one page holds", () => {
  const dictionary = trainFamilyDictionary(pages, SIZE);
  assert.equal(dictionary.length, SIZE);
  // Every 8-byte string of the shell scores 11 (12 pages minus one), so the
  // picks cover all of it. Picks land in reverse order, so check strings, not
  // one contiguous run.
  for (let at = 0; at + 8 <= SHELL.length; at += 8) {
    assert.ok(dictionary.includes(SHELL.subarray(at, at + 8)), `shell bytes ${at}..${at + 8} are missing from the dictionary`);
  }
  // A body string scores 0, so after the shell's 3 KiB the trainer stops picking
  // and pads the front from the first page. No other page's body gets in.
  for (const [index, page] of pages.entries()) {
    if (index === 0) continue;
    for (let at = 0; at + 64 <= 6144; at += 64) {
      assert.equal(dictionary.includes(page.subarray(at, at + 64)), false, `page ${index}'s own body (bytes ${at}..${at + 64}) got into the dictionary`);
    }
  }
  assert.ok(dictionary.subarray(0, 1024).equals(pages[0].subarray(0, 1024)), "the padding is the first page's opening bytes");
});

test("the family trainer is a pure function of its pages", () => {
  assert.ok(trainFamilyDictionary(pages, SIZE).equals(trainFamilyDictionary(pages, SIZE)));
  assert.equal(
    trainFamilyDictionary(pages.slice().reverse(), SIZE).equals(trainFamilyDictionary(pages, SIZE)),
    false,
    "the caller owns page order; build.ts sorts by path",
  );
});

test("every page round-trips through zstd against the trained dictionary", () => {
  const dictionary = trainFamilyDictionary(pages, SIZE);
  for (const page of pages) {
    const frame = zstdDictionaryFrame(page, dictionary);
    assert.ok(zstdDecompressSync(frame, { dictionary }).equals(page));
    assert.ok(frame.length < 6144 + 512, `the shell should cost almost nothing, got a ${frame.length} B frame`);
  }
});

test("the family trainer refuses pages too small to fill the dictionary", () => {
  assert.throws(() => trainFamilyDictionary([Buffer.from("<p>one</p>"), Buffer.from("<p>two</p>")], SIZE), /short of the 8192 B dictionary/);
  assert.equal(trainFamilyDictionary(pages, pages.length * 9216).length, pages.length * 9216, "exactly enough bytes fills it");
});
