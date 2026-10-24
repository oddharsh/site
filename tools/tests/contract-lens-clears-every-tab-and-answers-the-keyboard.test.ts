// ── /lens clears every tab on a new scan, and answers the keyboard ──────────
// Two bugs and two accessibility gaps found by the 2026-10-24 ponytail pass over
// /lens, pinned here so they stay fixed.
//
// A new scan, an error and Back each reset the tabs' results by hand, and all
// three lists missed Tools, NLWeb and Markdown: site A's catalogue showed on site
// B, and a request in flight when the next scan began left its tab "pending" for
// good. One clearScanResults() now covers every tab, and the first test fails
// when a tab adds a result or busy flag the reset does not clear.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { renderLensShell } from "../../src/worker/lens.ts";

const client = readFileSync("./src/client/lens.ts", "utf8");

test("a new scan, an error and Back clear every tab's result and busy flag", () => {
  const reset = client.match(/function clearScanResults\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(reset, "clearScanResults() is the one reset");
  // every per-scan result and busy flag the shell declares; `data` is the scan
  // itself, the head-to-head keeps its own reset (exitVs), and initialData is
  // the server-rendered seed
  const declared = [...client.matchAll(/^ {2}var (\w+(?:Data|Busy))\b/gm)].map((m) => m[1]).filter((n) => !n.startsWith("vs") && n !== "initialData");
  assert.ok(declared.length >= 14, `found only ${declared.length} tab variables: the pattern stopped matching`);
  const missing = declared.filter((n) => !new RegExp(`\\b${n} = (?:null|false);`).test(reset[1]));
  assert.deepEqual(missing, [], "clearScanResults() must clear these");
  assert.equal((client.match(/clearScanResults\(\);/g) ?? []).length, 3, "run(), showError() and the Back handler each call it");
});

test("every lens tab has its own idle primer", () => {
  const labelBlock = client.match(/var LENS_LABEL = \{([\s\S]*?)\};/)?.[1];
  const primers = client.match(/var primers = \{([\s\S]*?)\n {4}\};/)?.[1];
  assert.ok(labelBlock && primers, "LENS_LABEL and the idle primers are where this test reads them");
  const labels = [...labelBlock.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  const without = labels.filter((k) => !new RegExp(`^ {6}${k}: \\{`, "m").test(primers));
  assert.deepEqual(without, [], "a tab with no primer shows Anatomy's");
});

test("a late Browser Run reply never lands on the next scan", () => {
  const browser = readFileSync("./src/client/lens-browser.ts", "utf8");
  assert.match(client, /var stale = \(\) => !data \|\| \(data\.finalUrl \|\| data\.url\) !== targetUrl;/);
  assert.equal((client.match(/if \(stale\(\)\) return/g) ?? []).length, 2, "both the success and the failure callback check it");
  assert.match(browser, /if \(onError\(error\) === false\) return;\s+body\.innerHTML = unavailable/, "the island asks before it paints a failure");
});

test("the status line is a live region", async () => {
  const html = await renderLensShell({}, { view: "both", lens: "anatomy" }).text();
  assert.match(html, /<div class="lx-status" id="lx-status" role="status">/, "a screen reader hears scan progress and failures");
});

test("arrow keys, Home and End move through the views and the lens tabs", () => {
  assert.match(client, /viewGroup\.addEventListener\("keydown", arrowKeys\("\.lx-seg"\)\)/);
  assert.match(client, /lensGroup\.addEventListener\("keydown", arrowKeys\("\.lx-tab"\)\)/);
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) assert.ok(client.includes(`"${key}"`), `${key} is handled`);
  // roving tabindex: only the selected item is in the Tab order, after every change
  assert.match(client, /b\.setAttribute\("tabindex", b\.classList\.contains\("is-on"\) \? "0" : "-1"\)/);
  assert.equal((client.match(/^\s+syncRoving\(\);$/gm) ?? []).length, 2, "updateModeUi() and setLens() keep the Tab order on the selection");
});
