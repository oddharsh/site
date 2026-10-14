// ── committed JSON declares each key once ────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

const DECLARATIONS = [
  "package.json",
  "cal/package.json",
  "cf-garage/package.json",
  "lens-reader/package.json",
  "lwe-ask/package.json",
  "serendipity/package.json",
  "config/infra.json",
  "config/site-manifest.json",
  "config/tools.json",
  "config/derivations.json",
];

function duplicateKeys(text) {
  const dupes = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { stack.push(new Map()); continue; }
    if (ch === "[") { stack.push(null); continue; }
    if (ch === "}" || ch === "]") { stack.pop(); continue; }
    if (ch !== '"') continue;

    let j = i + 1;
    let raw = "";
    for (; j < text.length; j++) {
      if (text[j] === "\\") { raw += text[j] + text[j + 1]; j++; continue; }
      if (text[j] === '"') break;
      raw += text[j];
    }
    let k = j + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    const top = stack[stack.length - 1];
    if (text[k] === ":" && top instanceof Map) {
      top.set(raw, (top.get(raw) ?? 0) + 1);
      if (top.get(raw) === 2) dupes.push(raw);
    }
    i = j;
  }
  return dupes;
}

test("the scanner finds a duplicate, and is not fooled by quoting", () => {
  assert.deepEqual(duplicateKeys('{"a":1,"a":2}'), ["a"], "a plain duplicate is missed");
  assert.deepEqual(duplicateKeys('{"a":1,"b":{"a":2}}'), [], "a key repeated at a DIFFERENT depth is not a duplicate");
  assert.deepEqual(duplicateKeys('{"a":"x: y","b":"c: d"}'), [], "a colon inside a value reads as a key");
  assert.deepEqual(duplicateKeys('{"a\\":b":1,"a\\":b":2}'), ['a\\":b'], "an escaped quote inside a key breaks the scan");
  assert.deepEqual(duplicateKeys('{"a":[{"x":1},{"x":2}]}'), [], "sibling array elements are not one object");
  assert.deepEqual(duplicateKeys('[{"a":1,"a":2}]'), ["a"], "an object inside an array is not scanned");
});

test("no committed declaration file declares a key twice", async () => {
  let scanned = 0;
  for (const rel of DECLARATIONS) {
    const text = await readFile(new URL(rel, ROOT), "utf8");
    const dupes = duplicateKeys(text);
    assert.deepEqual(dupes, [], `${rel} declares ${dupes.join(", ")} more than once; JSON.parse keeps the LAST and says nothing`);
    scanned++;
  }
  assert.ok(scanned >= 10, `expected the declaration set, scanned ${scanned}`);
});
