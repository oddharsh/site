// design/tokens/fonts.css names the house families in local()-only @font-face
// rules, one regular face per family claiming weights 400 to 700. Loaded, it
// replaces the installed family: on 2026-10-29 Chrome drew bold Tahoma at
// regular weight and Verdana italic as slanted regular, while WebKit found the
// real faces anyway. design/styles.css imported it for the design skill's
// prototypes until then. The file stays as a reference; this keeps it unloaded
// and keeps any other @font-face from reusing a house family name (gotcha 88).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

const FONTS = "design/tokens/fonts.css";
const SELF = "tools/tests/contract-design-fonts-stay-unloaded.test.ts";

const families = (): string[] =>
  [...readFileSync(new URL(FONTS, ROOT), "utf8").matchAll(/@font-face\s*\{[^}]*?font-family:\s*["']?([^"';]+?)["']?\s*;/g)].map((m) => m[1]);

// Block comments go first: luna.css and styles.css explain in prose why they
// leave fonts.css out, and that prose must not read as an import.
const blank = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, " ");

function findings(text: string, house: string[]): string[] {
  const src = blank(text);
  const out: string[] = [];
  if (/@import\s+(?:url\()?\s*["']?[^"';)]*tokens\/fonts\.css/i.test(src)) out.push("@import of tokens/fonts.css");
  if (/<link\b[^>]*href=["'][^"']*tokens\/fonts\.css/i.test(src)) out.push("<link> to tokens/fonts.css");
  // a list entry, as in the design skill's globalCssPaths
  if (/[[,]\s*["'][^"']*tokens\/fonts\.css["']/.test(src)) out.push("tokens/fonts.css named as a path to load");
  for (const m of src.matchAll(/@font-face\s*\{[^}]*?font-family:\s*["']?([^"';]+?)["']?\s*;/gi)) {
    if (house.some((f) => f.toLowerCase() === m[1].trim().toLowerCase())) out.push(`@font-face reuses the installed family "${m[1].trim()}"`);
  }
  return out;
}

test("the matcher finds every way to load fonts.css, and only those", () => {
  const house = families();
  assert.deepEqual(house, ["Trebuchet MS", "Tahoma", "Verdana", "Geneva", "Courier New"], `${FONTS} declares ${house.join(", ")}`);
  // Each fixture IS found, so an empty report below means clean and not blind.
  assert.deepEqual(findings('@import "tokens/fonts.css";', house), ["@import of tokens/fonts.css"]);
  assert.deepEqual(findings('@import url("../design/tokens/fonts.css");', house), ["@import of tokens/fonts.css"]);
  assert.deepEqual(findings('<link rel="stylesheet" href="/design/tokens/fonts.css">', house), ["<link> to tokens/fonts.css"]);
  assert.deepEqual(findings('{"globalCssPaths":["tokens/fonts.css"]}', house), ["tokens/fonts.css named as a path to load"]);
  assert.deepEqual(findings('@font-face { font-family: "Tahoma"; src: local("Tahoma"); }', house), ['@font-face reuses the installed family "Tahoma"']);
  assert.deepEqual(findings("/* tokens/fonts.css is left out, see @import notes */", house), [], "prose in a comment is not an import");
  assert.deepEqual(findings('@font-face { font-family: "Demo Face"; src: local("Tahoma"); }', house), [], "an alias family does not hide an installed one");
});

test(`nothing tracked loads ${FONTS} or reuses a house family in @font-face`, () => {
  const house = families();
  const files = execFileSync("git", ["ls-files", "-z", "*.css", "*.html", "*.json", "*.ts", "*.js", "*.jsx"], {
    cwd: fileURLToPath(ROOT),
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && f !== FONTS && f !== SELF && !f.startsWith("src/dict/"));
  assert.ok(files.length >= 500, `scanned ${files.length} files`);
  const offenders = files.flatMap((f) => findings(readFileSync(new URL(f, ROOT), "utf8"), house).map((why) => `${f}: ${why}`));
  assert.deepEqual(offenders, [], `${FONTS} is reference only (gotcha 88):\n  ${offenders.join("\n  ")}`);
});
