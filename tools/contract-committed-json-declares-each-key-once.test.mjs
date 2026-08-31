// ── committed JSON declares each key once ────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// JSON.parse KEEPS THE LAST duplicate key and reports nothing, so a second
// `"engines"` or `"scripts"` in package.json silently shadows the first and
// every reader agrees with the wrong one. This is not hypothetical: writing the
// two-node-floors change on 2026-08-31 added a `comment:engines` beside
// `engines` without noticing package.json already carried one 23 lines down.
// Both parsed. Both validated. bun's own loader printed a warning that nothing
// was reading, and `pages:check` and `derive:check` both exited 0 over it.
//
// The declaration files are the ones where this costs something, because they
// are the repository's single source of truth for state no code can derive:
// what CI installs, what Cloudflare should look like, which binaries produce
// shipped bytes. A shadowed key there is a declaration that quietly says
// something nobody wrote.
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

// This walks the text as a SCANNER, for the same reason the CSP hash pass walks
// tags rather than matching them: a key is a string in a POSITION, and finding
// the position needs the string boundaries. Escapes inside a key (`\"`) and a
// colon inside a VALUE (a URL, or this very comment as a JSON string) both
// defeat any pattern that does not track quoting. Arrays push `null`, so a `:`
// can never be read as a key inside one.
function duplicateKeys(text) {
  const dupes = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { stack.push(new Map()); continue; }
    if (ch === "[") { stack.push(null); continue; }
    if (ch === "}" || ch === "]") { stack.pop(); continue; }
    if (ch !== '"') continue;

    // Read the whole string, honouring backslash escapes.
    let j = i + 1;
    let raw = "";
    for (; j < text.length; j++) {
      if (text[j] === "\\") { raw += text[j] + text[j + 1]; j++; continue; }
      if (text[j] === '"') break;
      raw += text[j];
    }
    // A string is a KEY only when the next non-space character is a colon.
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
  // THE CONTROL RUNS FIRST, because a scanner that matched nothing would report
  // every file clean and read exactly like a pass.
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
  // A FLOOR, the same one tools:check carries for each of its guard scanners:
  // a list that quietly emptied would pass this test without reading a byte.
  assert.ok(scanned >= 10, `expected the declaration set, scanned ${scanned}`);
});
