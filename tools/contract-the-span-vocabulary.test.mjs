// ── the span vocabulary ─────────────────────────────────────────────
// Shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// src/worker/lib/span-vocabulary.ts declares every span this Worker may open,
// and `span()` is generic over that union, so the COMPILER already refuses an
// undeclared name in src/worker. This file covers the two things it cannot.
//
// 1. THE COFFEE MODULE IS NOT CHECKED BY THAT TYPE. cal/src/trace.ts is a
//    deliberate near-duplicate of lib/trace.ts and its `span()` is untyped, for
//    the reason gotcha 16 gives: cal's Vitest pool boots from cal/src/index.ts
//    alone, so a cal to src/worker import would make cal untestable without the
//    site tree. Types are erased and would not create that import at runtime,
//    but the rule is worth keeping intact rather than half-kept. So the NAMES
//    live in one registry and this test is what holds cal to it — the drift
//    protection without the import.
//
// 2. A DECLARED NAME NOTHING OPENS. The type only constrains use, so an entry
//    left behind by a refactor stays in the registry forever, reading as part
//    of the vocabulary while emitting nothing. That is precisely what happened
//    to `rn.scrape.tracks` and `rn.scrape.artists`, which CLAUDE.md still lists
//    as a three-tier scrape: the tiers moved to the cron in #395 and the names
//    went with them. A registry that documents spans nobody emits is worse than
//    no registry, because it is believed.
//
// THE SCANNER IS DELIBERATELY MULTILINE, and that is not a precaution either.
// The grep that seeded the registry was `span\("` on one line, and it MISSED
// `around.neighbor` and `rn.scrape.playlist` because both call sites wrap the
// name onto its own line. The compiler caught both. A test that re-used the
// same one-line assumption would have agreed with the broken grep and reported
// a pass, which is the failure this repo has recorded three times over its own
// minified HTML.

const REGISTRY = "src/worker/lib/span-vocabulary.ts";
const TREES = ["src/worker", "cal/src", "serendipity"];

// Names built from a template are exempt by construction: `route ${template}`
// is one span per route and the type already covers it as a template literal.
const TEMPLATE_PREFIXES = ["route "];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Every `span("literal"` and `cron("literal"` in the tree, allowing any
// whitespace (newlines included) between the paren and the quote.
function used() {
  const seen = new Map();
  for (const tree of TREES) {
    for (const file of walk(tree)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\b(?:span|cron)\(\s*"([^"]+)"/g)) {
        if (!seen.has(m[1])) seen.set(m[1], file);
      }
    }
  }
  return seen;
}

// The union members of `export type SpanName`, read off the declaration rather
// than the whole file, so an example inside a doc comment cannot be mistaken
// for a declared name.
function declared() {
  const src = readFileSync(REGISTRY, "utf8");
  const start = src.indexOf("export type SpanName =");
  assert.ok(start >= 0, `${REGISTRY} declares no SpanName`);
  const body = src.slice(start, src.indexOf(";", start));
  return new Set([...body.matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]));
}

test("every span name opened in the tree is declared in the registry", () => {
  const opened = used();
  const names = declared();

  // FLOORS. Both sides are sets and two empty sets agree, so a scanner that
  // stops matching reports a clean vocabulary over a tree it never read.
  assert.ok(opened.size >= 40, `scanned ${opened.size} span call sites — the scanner broke, not the tree`);
  assert.ok(names.size >= 40, `parsed ${names.size} declared names — the registry parse broke`);

  for (const [name, file] of opened) {
    if (TEMPLATE_PREFIXES.some((p) => name.startsWith(p))) continue;
    assert.ok(names.has(name), `${file} opens span "${name}", which ${REGISTRY} does not declare`);
  }
});

test("every declared span name is actually opened somewhere", () => {
  const opened = new Set(used().keys());
  const names = declared();
  assert.ok(opened.size >= 40 && names.size >= 40, "a floor tripped — see the test above");

  const dead = [...names].filter((n) => !opened.has(n));
  assert.deepEqual(
    dead, [],
    `${REGISTRY} declares span name(s) nothing opens: ${dead.join(", ")}. ` +
    "Delete them; a registry documenting spans that never fire is believed and wrong.",
  );
});

test("the coffee module's spans are in the registry, though its span() is untyped", () => {
  // cal is the half the compiler does not cover, so it gets its own assertion
  // rather than being folded into the sweep above. If cal ever stops opening
  // spans this fails loudly instead of passing over an empty scan.
  const calNames = [];
  for (const file of walk("cal/src")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bspan\(\s*"([^"]+)"/g)) calNames.push(m[1]);
  }
  assert.ok(calNames.length >= 3, `cal/src opens ${calNames.length} spans — expected at least 3`);

  const names = declared();
  for (const n of calNames) {
    assert.ok(names.has(n), `cal/src opens span "${n}", which ${REGISTRY} does not declare`);
  }
});
