// The paint-gate parser behind `bun run archive:gate`, pinned to the committed
// /garage/enc fixtures whose gates that page quotes. The zenc q84 fixture is the
// case the page measured in Chromium 152 (Cr DC data at byte 13,763); its two
// twins hold the same coefficients in libjpeg's script and in one baseline scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateClass, paintGate } from "./lib/jpeg-paint-gate.ts";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`../public/garage/enc/${name}.jpg`, import.meta.url)));

test("the gate is the first entropy byte of the scan that starts the last channel", () => {
  const zenc = paintGate(fixture("c-zc84"));
  assert.equal(zenc.gate, 13763);
  assert.deepEqual(zenc.scans, ["1:0-0", "1:1-2", "1:3-63", "2:0-0", "3:0-0"]);
  assert.equal(gateClass(zenc), "colour, separate DC");

  const libjpeg = paintGate(fixture("c-zc84-libjpeg"));
  assert.deepEqual(libjpeg.scans, ["1,2,3:0-0"]);
  // interleaved DC starts every channel in the first scan, 318 bytes in
  assert.equal(libjpeg.gate, 318);
  assert.equal(gateClass(libjpeg), "colour, interleaved DC");

  assert.equal(gateClass(paintGate(fixture("c-zc84-baseline"))), "baseline");
});

test("a prefix that ends before the last channel starts reports no gate rather than a number", () => {
  const whole = fixture("c-zc84");
  const cut = paintGate(whole.subarray(0, 13760));
  assert.equal(cut.gate, null);
  assert.equal(gateClass(cut), "colour, no paint within the prefix");
  // control: the complete scan header is enough, since the gate is where it ends
  assert.equal(paintGate(whole.subarray(0, 13763)).gate, 13763);
});
