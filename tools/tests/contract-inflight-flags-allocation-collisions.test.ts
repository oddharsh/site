// ── inflight: two lines of work that claim the same identifier ──────────────
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { ALLOCATORS, branchItems, collisions, liveBranches } from "../inflight.ts";
import { EXACT_ROUTES, PREFIX_ROUTES } from "../../src/worker/routes.ts";

// tools/inflight.ts exists because #1486 and #1487 both added gotcha 89 on
// 2026-10-29, then #1487 and #1490 both added 90, and every one of them was
// green. The fixture replays that shape in a scratch repo: two branches that
// number a gotcha the same way with different titles, a third stacked on one
// of them, and origin/main taking the number after they were cut.

const repoRoot = fileURLToPath(ROOT);

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const gotchas = (...entries: string[]) => ["# Gotchas", "", ...entries.map((e) => `${e}\n   Checked by: nothing (judgment).\n`)].join("\n");
const cfg = (...schedules: string[]) => schedules.map((s) => `triggers.scheduled({ schedule: "${s}" }),`).join("\n") + "\n";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflight-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "contract"]);
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", message]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  // The allocators read fixed paths, so the fixture keeps the real layout.
  mkdirSync(join(dir, "docs"));
  const main = commit(
    { "docs/GOTCHAS.md": gotchas("88. **Eighty-eight.**"), "cloudflare.config.ts": cfg("1 * * * *", "2 * * * *", "3 * * * *", "4 * * * *", "5 * * * *") },
    "base",
  );
  git(dir, ["update-ref", "refs/remotes/origin/main", main]);
  const branch = (name: string, from: string, files: Record<string, string>) => {
    git(dir, ["checkout", "-q", "-b", name, from]);
    return commit(files, name);
  };
  const gzip = branch("claude/gzip", main, { "docs/GOTCHAS.md": gotchas("88. **Eighty-eight.**", "89. **Local dev serves gzip.**") });
  branch("claude/guard", main, { "docs/GOTCHAS.md": gotchas("88. **Eighty-eight.**", "89. **A guard goes blind.**") });
  branch("claude/census", "claude/guard", {
    "docs/GOTCHAS.md": gotchas("88. **Eighty-eight.**", "89. **A guard goes blind.**", "90. **A census misses new files.**"),
  });
  branch("claude/cron", main, { "cloudflare.config.ts": cfg("1 * * * *", "2 * * * *", "3 * * * *", "4 * * * *", "5 * * * *", "6 * * * *") });
  git(dir, ["checkout", "-q", "-b", "claude/self", main]);
  return { dir, gzip };
}

async function report(dir: string, self: { label: string; files: string[] } | null = null) {
  const items = await branchItems(dir, await liveBranches(dir));
  return { items, ...(await collisions(dir, self, items)) };
}

test("two branches that number a gotcha differently collide, and a stacked branch that inherits one does not", async () => {
  const { dir } = fixture();
  try {
    const { items, found, cron } = await report(dir);
    // claude/self sits on origin/main, so it is not ahead and not listed.
    assert.deepEqual(
      items.map((i) => i.label),
      ["claude/census", "claude/cron", "claude/guard", "claude/gzip"],
    );
    assert.deepEqual(found, [
      {
        kind: "gotcha",
        key: "89",
        claims: [
          { label: "claude/census", value: "**A guard goes blind.**" },
          { label: "claude/guard", value: "**A guard goes blind.**" },
          { label: "claude/gzip", value: "**Local dev serves gzip.**" },
        ],
      },
    ]);
    // 90 is claimed by claude/census alone (claude/guard never had it), so it is no collision.
    assert.equal(found.filter((c) => c.key === "90").length, 0);
    // The sixth cron schedule is a collision with the cap even though no key repeats.
    assert.deepEqual(cron, { used: 5, added: ['claude/cron "6 * * * *"'] });

    // Without claude/gzip, claude/census and claude/guard both hold 89 under one title: a stack, no collision.
    git(dir, ["branch", "-q", "-D", "claude/gzip"]);
    assert.deepEqual((await report(dir)).found, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a number origin/main took after a branch was cut collides with that branch", async () => {
  const { dir, gzip } = fixture();
  try {
    // claude/gzip lands: origin/main now holds 89 under gzip's title.
    git(dir, ["update-ref", "refs/remotes/origin/main", gzip]);
    git(dir, ["branch", "-q", "-D", "claude/gzip"]);
    const { found } = await report(dir);
    const g89 = found.find((c) => c.key === "89");
    assert.deepEqual(g89?.claims[0], { label: "origin/main", value: "**Local dev serves gzip.**" });
    assert.deepEqual(g89?.claims.map((c) => c.label).sort(), ["claude/census", "claude/guard", "origin/main"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renumbering clears the collision, and uncommitted work in this checkout counts as a claim", async () => {
  const { dir } = fixture();
  try {
    git(dir, ["checkout", "-q", "claude/guard"]);
    writeFileSync(join(dir, "docs/GOTCHAS.md"), gotchas("88. **Eighty-eight.**", "91. **A guard goes blind.**"));
    git(dir, ["commit", "-qam", "renumber"]);
    git(dir, ["checkout", "-q", "claude/self"]);
    git(dir, ["branch", "-q", "-D", "claude/census"]);
    assert.deepEqual((await report(dir)).found, []);

    // Now this checkout, uncommitted, writes 91 under another title.
    writeFileSync(join(dir, "docs/GOTCHAS.md"), gotchas("88. **Eighty-eight.**", "91. **Something else.**"));
    const { found } = await report(dir, { label: "claude/self", files: ["docs/GOTCHAS.md"] });
    assert.deepEqual(found, [
      {
        kind: "gotcha",
        key: "91",
        claims: [
          { label: "claude/self", value: "**Something else.**" },
          { label: "claude/guard", value: "**A guard goes blind.**" },
        ],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The extractors are regexes over files other sessions edit. If a file changes
// shape, an extractor would read nothing and every report would come back
// clean (gotcha 79's walks read zero files for 55 days that way). Each count
// below comes from the file's own structure, so a reshaped file fails here.
test("every allocator reads every identifier in the real file", () => {
  const read = (kind: string, path: string) => ALLOCATORS.find((a) => a.kind === kind)!.read(readFileSync(join(repoRoot, path), "utf8"));
  const text = (path: string) => readFileSync(join(repoRoot, path), "utf8");

  const checkedBy = text("docs/GOTCHAS.md").match(/^ +Checked by:/gm)!.length;
  assert.equal(read("gotcha", "docs/GOTCHAS.md").size, checkedBy);
  assert.equal(read("route", "src/worker/routes.ts").size, EXACT_ROUTES.length + PREFIX_ROUTES.length);
  const d = JSON.parse(text("config/derivations.json"));
  assert.equal(read("derivation", "config/derivations.json").size, d.derivations.length + Object.keys(d.writers.exempt).filter((k) => k !== "$comment").length);
  assert.equal(read("cron", "cloudflare.config.ts").size, text("cloudflare.config.ts").match(/triggers\.scheduled\(/g)!.length);
});
