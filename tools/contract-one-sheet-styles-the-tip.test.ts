// Tip of the Day (#axp-tips) is a tray balloon, styled by nav-tray.css alone.
// Both nav-run.css and nav-tray.css are lazy, and Run's "Tip of the Day" row
// opens the tip with both linked, so a #axp-tips rule in nav-run.css fights the
// balloon's at equal specificity and the link order decides. #1069 moved the
// tip into the tray and left the dialog-era selectors behind: measured
// 2026-10-17 at 1280x800, Run-first shoved the balloon 170px left and 53px up
// off the clock (nav-run's translate under nav-tray's inset), and tray-first
// centred it at 440px in the Run frame with its tail in mid-air. The balloon
// doesn't drag either: its tail is placed against the clock, as #axp-balloon's is.
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const namesTip = (css: string): boolean => /#axp-tips\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""));

test("the check sees a #axp-tips selector and ignores one in a comment", () => {
  assert.ok(namesTip("#axp-run,#axp-tips{position:fixed}"));
  assert.ok(namesTip(":is(#axp-run,#axp-tips) .tb{cursor:move}"));
  assert.ok(!namesTip("/* #axp-tips lives in nav-tray.css */#axp-run{left:50%}"));
});

test("nav-tray.css styles the tip and nav-run.css does not", () => {
  assert.ok(namesTip(read("src/styles/nav-tray.css")), "nav-tray.css lost its #axp-tips rules");
  assert.ok(!namesTip(read("src/styles/nav-run.css")), "nav-run.css styles #axp-tips again; the tip's look and position would depend on which sheet linked last");
});

test("the title-bar drag leaves the tip balloon alone", () => {
  const src = read("src/client/nav.ts");
  const start = src.indexOf("function initDrag()");
  const grab = src.slice(start, src.indexOf("\"axp-max\"", start));
  assert.ok(start >= 0 && grab.includes("#axp-run .tb"), "initDrag moved; point this test at its selectors");
  assert.ok(!/#axp-tips/.test(grab), "initDrag drags #axp-tips again, which pulls the balloon's tail off the clock");
});
