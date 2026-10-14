#!/usr/bin/env bun
// gen-dotfiles.ts — project public/dotfiles/macos.sh out of the option data
// the /dotfiles page carries inline, with every option ticked.

import { readFileSync, writeFileSync } from "node:fs";
import { parseData, renderScript } from "../src/client/dotfiles.js";

export const PAGE = "src/pages/dotfiles/index.html";
export const SCRIPT = "public/dotfiles/macos.sh";

const BLOCK = /<script\b[^>]*\bid="dotfiles-data"[^>]*>([\s\S]*?)<\/script>/i;

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
