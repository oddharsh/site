#!/usr/bin/env bun
// gen-dotfiles.ts — project public/dotfiles/macos.sh out of the option data
// the /dotfiles page carries inline, with every option ticked.
//
//   bun run gen:dotfiles
//
// The page is the source: its <script type="application/json" id="dotfiles-data">
// block is what the checklist renders from, and the committed .sh is the same
// data through the same renderer (src/client/dotfiles.js) so the curl-able copy
// cannot say something the page does not. contract-dotfiles-script-matches-the-
// page.test.mjs deep-equals the two, which is what stands in for a derivation
// entry: a test over one artifact is stronger than a digest over its inputs.

import { readFileSync, writeFileSync } from "node:fs";
import { parseData, renderScript } from "../src/client/dotfiles.js";

export const PAGE = "src/pages/dotfiles/index.html";
export const SCRIPT = "public/dotfiles/macos.sh";

const BLOCK = /<script\b[^>]*\bid="dotfiles-data"[^>]*>([\s\S]*?)<\/script>/i;

/** The data block out of the page source. Exported so the test reads it the same way. */
export function pageData(html = readFileSync(PAGE, "utf8")) {
  const m = html.match(BLOCK);
  if (!m) throw new Error(`${PAGE}: no dotfiles-data block`);
  return parseData(m[1]);
}

export function projectScript(html?: string) {
  return renderScript(pageData(html));
}

if (import.meta.main) {
  const out = projectScript();
  writeFileSync(SCRIPT, out);
  console.log(`${SCRIPT}: ${out.split("\n").length} lines, ${pageData().options.length} options`);
}
