// inflight: what other open work already touches the files this branch touches.
//
//     bun run inflight                 this branch (commits and working tree)
//     bun run inflight <path>...       those paths, or anything under them
//
// Every Claude Code session in this repo also runs it at startup and on resume.
//
// Several sessions work in this repo at once, often forked from one another,
// and nothing told a session at startup what its siblings were changing. #1257
// rebuilt #1255, and on 2026-10-29 #1486 and #1487 both added gotcha 89, then
// #1487 and #1490 both added 90. Those PRs were green; the collision surfaced as
// merge conflicts afterwards, because each PR's CI saw only its own tree.
//
// Two reports:
//   - Overlap: every open PR and live local `claude/*` branch that touches a
//     file this branch touches.
//   - Allocations: identifiers handed out by appending (a gotcha number, a route
//     row, a derivation id, a cron slot) that two lines of work claimed
//     differently, or that origin/main took since a branch was cut. These can
//     merge with no textual conflict and still be wrong.
//
// An allocation is a key present at an item's head and absent at its merge-base
// with origin/main. Two items collide when they allocate the same key with
// different values. Comparing values is what keeps a stacked PR quiet: #1490
// carries #1487's gotcha under the same title, so the two agree, while #1486's
// 89 and #1487's 89 had different titles.
//
// Live branches come from git alone, which is what keeps this under a second.
// On 2026-10-29, 343 local `claude/*` branches were ahead of origin/main; the
// repo deletes a PR's head branch on merge, so `[gone]` upstreams drop 310 of
// them, and a 14-day commit window drops the rest of the dead ones, leaving the
// 5 that were live. A `gh pr list --state all` pass would do the same filtering
// for 1.5 s to 4 s.
//
// Limits: uncommitted work in other worktrees is not read (scanning the 14
// recently touched worktrees cost 2.2 s and found 1 dirty file), and gh lists
// at most 100 files per PR.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const BASE = "origin/main";
/** Days since a branch's last commit before it stops counting as live. */
const RECENT_DAYS = 14;
const GH_TIMEOUT_MS = 2500;
/** Workers Free allows 5 cron triggers per account; all 5 are in use. */
const CRON_SLOTS = 5;

export type Item = {
  /** "#1487" or "claude/foo" */
  label: string;
  branch: string;
  /** the PR title, or a branch's last commit subject */
  title: string;
  /** commit to read allocations from; null when that commit isn't local */
  head: string | null;
  files: string[];
};

type Allocator = {
  kind: string;
  matches: (path: string) => boolean;
  /** key -> value; equal values mean the same allocation */
  read: (text: string) => Map<string, string>;
};

const CONFIG = /(^|\/)(cloudflare|wrangler)\.config\.ts$/;

export const ALLOCATORS: Allocator[] = [
  {
    kind: "gotcha",
    matches: (p) => p === "docs/GOTCHAS.md",
    read: (text) => new Map([...text.matchAll(/^(\d+)\. (\*\*.*)$/gm)].map((m) => [m[1], m[2].trim()])),
  },
  {
    kind: "route",
    matches: (p) => p === "src/worker/routes.ts",
    // An island route names its path by constant (`path: INBOX_MAIL_URL`), so the constant is its key.
    read: (text) => new Map([...text.matchAll(/^\s*(?:\{\s*path|label):\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*)\b).*$/gm)].map((m) => [m[1] ?? m[2], m[0].trim()])),
  },
  {
    kind: "derivation",
    matches: (p) => p === "config/derivations.json",
    read: (text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return new Map(); // conflict markers or a half-written file: nothing to compare
      }
      const out = new Map<string, string>();
      const { derivations = [], writers = {} } = json as { derivations?: { id: string }[]; writers?: { exempt?: Record<string, unknown> } };
      for (const d of derivations) out.set(`id ${d.id}`, JSON.stringify(d));
      for (const [path, why] of Object.entries(writers.exempt ?? {})) if (path !== "$comment") out.set(`writers.exempt ${path}`, JSON.stringify(why));
      return out;
    },
  },
  {
    kind: "cron",
    matches: (p) => CONFIG.test(p),
    read: (text) => new Map([...text.matchAll(/triggers\.scheduled\(\{\s*schedule:\s*"([^"]+)"/g)].map((m) => [m[1], m[1]])),
  },
];

export type Collision = { kind: string; key: string; claims: { label: string; value: string }[] };

const run = promisify(execFile);

// Every git call is async so the calls overlap. Each spawn cost ~50 ms on
// 2026-10-29 at a load average of 28 (sibling sessions running suites), and the
// sequential version took 2 s for about 30 of them.
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const tryGit = (root: string, args: string[]) => git(root, args).catch(() => null);

const lines = (s: string | null) => (s ? s.split("\n").filter(Boolean) : []);

export type Branch = { branch: string; sha: string; title: string };

/** Live local branches: ahead of BASE, upstream not deleted, committed recently. */
export async function liveBranches(root: string, now = Date.now()): Promise<Branch[]> {
  const since = now / 1000 - RECENT_DAYS * 86400;
  const rows = lines(
    await git(root, [
      "for-each-ref",
      `--format=%(refname:short)%00%(ahead-behind:${BASE})%00%(upstream:track)%00%(committerdate:unix)%00%(objectname)%00%(contents:subject)`,
      "refs/heads/claude/",
    ]),
  );
  return rows
    .map((row) => row.split("\0"))
    .filter(([, aheadBehind, track, when]) => Number(aheadBehind.split(" ")[0]) > 0 && !track.includes("gone") && Number(when) >= since)
    .map(([branch, , , , sha, title]) => ({ branch, sha, title }));
}

export const branchItems = (root: string, branches: Branch[]): Promise<Item[]> =>
  Promise.all(
    branches.map(async ({ branch, sha, title }) => ({
      label: branch,
      branch,
      title,
      head: sha,
      files: lines(await git(root, ["diff", "--name-only", `${BASE}...${sha}`])),
    })),
  );

export type PrRow = { number: number; title: string; headRefName: string; headRefOid: string; files: { path: string }[] };

export async function prItems(root: string, rows: PrRow[]): Promise<Item[]> {
  const present = new Set(
    await Promise.all(rows.map((r) => tryGit(root, ["cat-file", "-e", `${r.headRefOid}^{commit}`]).then((ok) => (ok === null ? null : r.headRefOid)))),
  );
  return rows.map((r) => ({
    label: `#${r.number}`,
    branch: r.headRefName,
    title: r.title,
    head: present.has(r.headRefOid) ? r.headRefOid : null,
    files: r.files.map((f) => f.path),
  }));
}

/** This checkout: committed changes since BASE plus the working tree, untracked included. */
export async function selfFiles(root: string): Promise<string[]> {
  const [committed, status] = await Promise.all([
    tryGit(root, ["diff", "--name-only", `${BASE}...HEAD`]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const dirty = lines(status).map((l) => l.slice(3).replace(/^.* -> /, ""));
  return [...new Set([...lines(committed), ...dirty])].sort();
}

const under = (path: string, scope: string) => path === scope || path.startsWith(scope.replace(/\/?$/, "/"));

/** path -> labels of the items that touch it, for each path in `scope` any item touches. */
export function overlaps(scope: string[], items: Item[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of items) {
    for (const f of item.files) {
      if (!scope.some((s) => under(f, s))) continue;
      out.set(f, [...(out.get(f) ?? []), item.label]);
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** A file's text at `ref`, or from the working tree when `ref` is null. */
async function readAt(root: string, ref: string | null, path: string): Promise<string> {
  if (ref === null) return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "";
  return (await tryGit(root, ["show", `${ref}:${path}`])) ?? "";
}

type Claim = { value: string; path: string };

/** kind -> key -> claim: what `head` (null = working tree) adds over its merge-base with BASE. */
async function allocationsOf(root: string, head: string | null, files: string[]): Promise<Map<string, Map<string, Claim>>> {
  const out = new Map<string, Map<string, Claim>>();
  const base = await tryGit(root, ["merge-base", BASE, head ?? "HEAD"]);
  if (!base) return out;
  const pairs = ALLOCATORS.flatMap((a) => files.filter(a.matches).map((f) => ({ a, f })));
  const texts = await Promise.all(pairs.map(({ f }) => Promise.all([readAt(root, base, f), readAt(root, head, f)])));
  pairs.forEach(({ a, f }, i) => {
    const before = a.read(texts[i][0]);
    const added = out.get(a.kind) ?? new Map<string, Claim>();
    for (const [k, v] of a.read(texts[i][1])) if (!before.has(k)) added.set(k, { value: v, path: f });
    if (added.size) out.set(a.kind, added);
  });
  return out;
}

export type Report = { found: Collision[]; unread: string[]; cron: { used: number; added: string[] } };

/** Every key allocated twice with different values, BASE included as a claimant. */
export async function collisions(root: string, self: { label: string; files: string[] } | null, items: Item[]): Promise<Report> {
  const unread = items.filter((i) => i.head === null && i.files.some((f) => ALLOCATORS.some((a) => a.matches(f)))).map((i) => i.label);
  const sources = [
    ...(self ? [{ label: self.label, head: null as string | null, files: self.files }] : []),
    ...items.filter((i) => i.head !== null).map((i) => ({ label: i.label, head: i.head, files: i.files })),
  ].filter((s) => s.files.some((f) => ALLOCATORS.some((a) => a.matches(f))));
  // Cron slots are a budget, not a key space: any new schedule past the cap collides.
  const [claimants, cronLines] = await Promise.all([
    Promise.all(sources.map(async (s) => ({ label: s.label, alloc: await allocationsOf(root, s.head, s.files) }))),
    tryGit(root, ["grep", "-hE", "triggers\\.scheduled\\(", BASE, "--", "*cloudflare.config.ts", "*wrangler.config.ts"]),
  ]);

  const byKey = new Map<string, { a: Allocator; key: string; claims: ({ label: string } & Claim)[] }>();
  for (const a of ALLOCATORS)
    for (const c of claimants)
      for (const [key, claim] of c.alloc.get(a.kind) ?? []) {
        const slot = byKey.get(`${a.kind}\0${key}`) ?? { a, key, claims: [] };
        slot.claims.push({ label: c.label, ...claim });
        byKey.set(`${a.kind}\0${key}`, slot);
      }
  const mainPaths = [...new Set([...byKey.values()].map((s) => s.claims[0].path))];
  const mainText = new Map(await Promise.all(mainPaths.map(async (p) => [p, await readAt(root, BASE, p)] as const)));

  const found: Collision[] = [];
  for (const { a, key, claims } of byKey.values()) {
    const main = a.read(mainText.get(claims[0].path)!).get(key);
    const all = main === undefined ? claims : [{ label: BASE, value: main }, ...claims];
    if (new Set(all.map((c) => c.value)).size > 1) found.push({ kind: a.kind, key, claims: all.map(({ label, value }) => ({ label, value })) });
  }
  const added = claimants.flatMap((c) => [...(c.alloc.get("cron")?.keys() ?? [])].map((k) => `${c.label} "${k}"`));
  return { found, unread, cron: { used: lines(cronLines).length, added } };
}

async function openPrs(root: string): Promise<{ ok: true; rows: PrRow[] } | { ok: false; why: string }> {
  try {
    const { stdout } = await run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName,headRefOid,files"], {
      cwd: root,
      timeout: GH_TIMEOUT_MS,
    });
    return { ok: true, rows: JSON.parse(stdout) as PrRow[] };
  } catch (error) {
    // execFile's message repeats the argv; gh's own first stderr line names the cause.
    const { stderr, killed } = error as { stderr?: string; killed?: boolean };
    return { ok: false, why: killed ? `no answer in ${GH_TIMEOUT_MS} ms` : (stderr?.trim().split("\n")[0] ?? String(error)) };
  }
}

async function main() {
  const started = performance.now();
  const root = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const prs = openPrs(root); // in flight while git works
  const paths = process.argv.slice(2);
  const [current, branches, scope] = await Promise.all([
    tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]).then((b) => b ?? "HEAD"),
    liveBranches(root),
    paths.length ? paths : selfFiles(root),
  ]);
  const self = paths.length ? null : { label: current, files: scope };
  const others = branches.filter((b) => b.branch !== current);

  const listed = await prs;
  const notices: string[] = [];
  let items: Item[];
  if (!listed.ok) {
    notices.push(`inflight: offline or gh failed, so local branches only (${listed.why})`);
    items = await branchItems(root, others);
  } else {
    // A branch with an open PR is that PR; gh already knows its files.
    const prHeads = new Set(listed.rows.map((p) => p.headRefName));
    const [fromPrs, fromBranches] = await Promise.all([
      prItems(
        root,
        listed.rows.filter((p) => p.headRefName !== current),
      ),
      branchItems(
        root,
        others.filter((b) => !prHeads.has(b.branch)),
      ),
    ]);
    items = [...fromPrs, ...fromBranches];
  }

  const touching = overlaps(scope, items);
  const { found, unread, cron } = await collisions(root, self, items);
  const out: string[] = [...notices];
  const ms = Math.round(performance.now() - started);
  out.push(`inflight: ${items.length} lines of work in flight beside ${paths.length ? paths.join(" ") : current} (${ms} ms)`);
  if (touching.size) {
    out.push("", "Touching the same files:");
    const width = Math.max(...[...touching.keys()].map((p) => p.length));
    for (const [path, labels] of touching) out.push(`  ${path.padEnd(width)}  ${labels.join(" ")}`);
  }
  const cronOver = cron.used + cron.added.length > CRON_SLOTS;
  if (found.length || cronOver) {
    out.push("", "Allocation collisions (these can merge cleanly and still be wrong):");
    for (const c of found) {
      out.push(`  ${c.kind} ${c.key}:`);
      const width = Math.max(...c.claims.map((claim) => claim.label.length));
      for (const claim of c.claims) out.push(`    ${claim.label.padEnd(width)}  ${claim.value.slice(0, 90)}`);
    }
    if (cronOver) out.push(`  cron: ${BASE} uses ${cron.used} of ${CRON_SLOTS} slots, and ${cron.added.join(", ")} adds more`);
  }
  if (unread.length) out.push("", `Not checked for allocations, head not fetched (git fetch origin): ${unread.join(" ")}`);
  if (items.length) {
    out.push("", "In flight:");
    for (const item of items) out.push(`  ${item.label}  ${item.title} (${item.files.length} files)`);
  }
  console.log(out.join("\n"));
}

// A SessionStart hook in .claude/settings.json runs this, and its stdout becomes
// the session's first context. Anything unexpected prints one line and exits 0,
// so a broken report never holds a session up.
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.log(`inflight: could not run (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  });
}
