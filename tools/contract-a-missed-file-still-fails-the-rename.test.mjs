// ── a missed file still fails the rename ────────────────────────────────────
// Step 5c renames every custom property across the staged tree, and
// assertIntegrity is what stops a file the walk missed: its var(--long-name)
// keeps the old name, nothing defines it any more, and the colour falls back
// to nothing. Since 2026-10-08 the check reuses a file's scan when the rename
// left its text alone, so a missed file, which is exactly an unchanged file,
// takes the reused path. These pin that it still fails there.
import {
  assert,
  test,
} from "./contract-shared.ts";

const { applyMangle, assertIntegrity, unresolved } = await import("./lib/mangle-custom-properties.ts");

const before = new Map([
  ["luna.css", ":root{--surface-window:#fff;--ink:#000}"],
  ["page.html", "<style>.w{background:var(--surface-window);color:var(--ink)}</style>"],
  ["other.css", ".x{color:var(--never-defined)}"],
]);
const map = new Map([["--surface-window", "--a"], ["--ink", "--b"]]);
const renamed = (skip) => new Map([...before].map(([rel, text]) => [rel, rel === skip ? text : applyMangle(text, map)]));

test("a complete rename passes", () => {
  assert.doesNotThrow(() => assertIntegrity(before, renamed(null), map, 2));
});

test("a file the rename missed fails, though its scan is reused", () => {
  const after = renamed("page.html");
  assert.equal(after.get("page.html"), before.get("page.html"), "the missed file is unchanged, so its scan is reused");
  assert.throws(() => assertIntegrity(before, after, map, 2), /newly dangling: --surface-window, --ink/);
});

test("a definition the rename missed fails too", () => {
  assert.throws(() => assertIntegrity(before, renamed("luna.css"), map, 2), /newly dangling: --a, --b/);
});

test("reused scans and fresh scans agree", () => {
  for (const skip of [null, "page.html", "luna.css", "other.css"]) {
    const after = renamed(skip);
    const fresh = new Set([...unresolved(after)]);
    let reusedResult = "passes";
    try { assertIntegrity(before, after, map, 2); } catch (e) { reusedResult = String(e.message); }
    const expected = new Set([...unresolved(before)].map((n) => map.get(n) ?? n));
    const freshResult = [...fresh].every((n) => expected.has(n)) && [...expected].every((n) => fresh.has(n)) ? "passes" : "fails";
    assert.equal(reusedResult === "passes" ? "passes" : "fails", freshResult, `skip ${skip}`);
  }
});
