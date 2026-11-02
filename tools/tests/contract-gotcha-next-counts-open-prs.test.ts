// ── gotcha:next: a number an open PR holds is never handed out again ─────────
import { assert, test } from "./contract-shared.ts";
import { entries, holdings } from "../gotcha-next.ts";

// tools/gotcha-next.ts exists because #1486 and #1490 both took gotcha 89 on
// 2026-10-29. The fixtures replay that, and the stack #1487 to #1490 that
// carried one entry 90 through three PRs without colliding.

const doc = (...lines: string[]) => `# Gotchas\n\n## Gotchas\n\n${lines.join("\n")}\n`;

test("gotcha:next: reads each entry's number and title", () => {
  const text = doc("88. **A local() face.** body", "   wrapped text 3. **not an entry**", "89. **Local dev serves gzip.** body");
  assert.deepEqual(entries(text), [
    [88, "A local() face."],
    [89, "Local dev serves gzip."],
  ]);
});

test("gotcha:next: two PRs with different entries on one number collide", () => {
  const held = holdings(88, [
    { number: 1486, entries: [[89, "Local dev serves gzip."]] },
    { number: 1490, entries: [[89, "A git census can't see a file."]] },
  ]);
  assert.equal(held.get(89)?.titles.size, 2);
});

test("gotcha:next: a stack carrying one entry doesn't, and main's numbers aren't held", () => {
  const entry: [number, string] = [90, "A guard proven once goes blind."];
  const held = holdings(89, [
    { number: 1487, entries: [[89, "Local dev serves gzip."], entry] },
    { number: 1488, entries: [entry] },
    { number: 1490, entries: [entry, [91, "A git census can't see a file."]] },
  ]);
  assert.deepEqual([...held.keys()], [90, 91]);
  assert.deepEqual(held.get(90)?.prs, [1487, 1488, 1490]);
  assert.equal(held.get(90)?.titles.size, 1);
});
