// ── the span vocabulary ─────────────────────────────────────────────
// Shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "src/worker/lib/span-vocabulary.ts";
const TREES = ["src/worker", "cal/src", "serendipity"];

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

function used() {
  const seen = new Map();
  for (const tree of TREES) {
    for (const file of walk(tree)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\b(?:span|cron)\(\s*"([^"]+)"|\bspan:\s*"([^"]+)"/g)) {
        const name = m[1] ?? m[2];
        if (!seen.has(name)) seen.set(name, file);
      }
    }
  }
  return seen;
}

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

test("the coffee module's spans are in the registry", () => {
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
