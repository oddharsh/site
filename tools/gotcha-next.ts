// The next free gotcha number, counting the ones open PRs have already taken.
//
// Several sessions add gotchas at once, and each read the next number off its
// own checkout of main. On 2026-10-29 #1486 and #1490 both took 89, and
// `contract-gotcha-numbers-resolve` failed #1490 once the first had merged.
// This reads docs/GOTCHAS.md at origin/main and at every open PR's head, so a
// number one of them holds is never handed out again.
//
//   bun run gotcha:next      prints the number, then who holds the ones above main

import { execFileSync } from "node:child_process";

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Every entry in a GOTCHAS.md as [number, title], in file order. */
export function entries(text: string): [number, string][] {
  return [...text.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)].map((m) => [Number(m[1]), m[2]]);
}

/**
 * Numbers above main that open PRs hold, each with its PRs and whether they
 * disagree. A stack of PRs carries the same entry, so two PRs holding one
 * number collide only when their titles differ.
 */
export function holdings(top: number, prs: { number: number; entries: [number, string][] }[]) {
  const held = new Map<number, { prs: number[]; titles: Set<string> }>();
  for (const pr of prs)
    for (const [n, title] of pr.entries) {
      if (n <= top) continue;
      const h = held.get(n) ?? { prs: [], titles: new Set<string>() };
      h.prs.push(pr.number);
      h.titles.add(title);
      held.set(n, h);
    }
  return held;
}

function entriesAt(ref: string): [number, string][] {
  try {
    return entries(git(["show", `${ref}:docs/GOTCHAS.md`]));
  } catch {
    return [];
  }
}

if (import.meta.main) {
  git(["fetch", "--quiet", "--prune", "origin"]);
  const top = Math.max(0, ...entriesAt("origin/main").map(([n]) => n));
  const prs: { number: number; headRefName: string }[] = JSON.parse(
    execFileSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName"], { encoding: "utf8" }),
  );
  const held = holdings(
    top,
    prs.map((pr) => ({ number: pr.number, entries: entriesAt(`origin/${pr.headRefName}`) })),
  );
  console.log(Math.max(top, ...held.keys()) + 1);
  for (const [n, h] of [...held].sort((a, b) => a[0] - b[0]))
    console.error(`  ${n} held by ${h.prs.map((o) => `#${o}`).join(", ")}${h.titles.size > 1 ? " (COLLISION: different entries)" : ""}`);
}
