// Which merge conflicts on a PR can be resolved in GitHub's web editor, and
// which need a local checkout. Conflict by conflict, and hunk by hunk inside
// each file.
//
//     bun run conflicts                  this branch against origin/main
//     bun run conflicts -- 876           one PR
//     bun run conflicts -- --all         every open PR that conflicts
//     bun run conflicts -- 876 --markdown | --json
//     bun run conflicts -- --in-progress  the merge/rebase/cherry-pick git just stopped on
//     bun run conflicts -- 876 --html view.html [--notes notes.json]
//
// WHY EACH SIDE LOOKS THE WAY IT DOES. A verdict says where to resolve a
// conflict and nothing about what the two sides were trying to do, which is
// the thing a resolution actually needs. Every hunk therefore carries `why`:
// the commits on each side, since the merge base, whose patches added or
// removed the hunk's lines, ranked by how many they touched. On this repo a
// squash subject ends in `(#N)`, so a commit names its PR, and the PR names the
// intent. `--html` lays each hunk out as main | base | PR with those commits
// above their columns, and `--notes` adds a plain-language reading per hunk,
// keyed `<path>:<line>` (`<path>` for a file, `*` for the whole merge). The
// notes are written by whoever read the sides, never generated here: this
// file measures, and an explanation is a claim about intent it cannot check.
//
// `--in-progress` reads which operation stopped in the current worktree and
// orients it the way the rest of this file does, "main" being the upstream
// side: a merge of main INTO a branch is MERGE_HEAD against HEAD, while a
// rebase or cherry-pick replays one commit, so it is HEAD against that commit
// over the commit's own parent. It re-runs
// the merge in memory, so it describes the conflict as git first stopped on
// it, whatever has been resolved in the worktree since.
//
// WHAT GITHUB CAN RENDER. GitHub's editor handles "simple competing line
// change conflicts" and greys out its Resolve button for everything else
// (modify/delete, renames, binaries, mode changes). A derived file (a lockfile,
// anything config/derivations.json names as output) should never be
// hand-merged in a textarea either, since its merged text is never the answer.
//
// It is measured with `git merge-tree --write-tree`, which does the whole merge
// in memory and touches no worktree, so this is safe to run in a tree other
// sessions are using.
//
// For a PR the result is also checked against GitHub's own `mergeable` field,
// which is the only outside control on the emulation there is.
//
// THE HUNK GRADES ARE A FIRST CUT AND NOT A MEASUREMENT. The thresholds below
// were picked, not fitted, so every hunk prints its raw line counts beside its
// grade and a reader who disagrees has the numbers to disagree with.
//
// Exit 0: nothing needs a local checkout. 1: something does. 2: the instrument
// could not run, which is never reported as a clean result.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { asRecord, asText } from "../src/worker/lib/parse.ts";

// ── grades ────────────────────────────────────────────────────────────────────

/** Up to this many lines across both sides, a two-sided edit reads fine in a textarea. */
export const SMALL_EDIT = 8;
/** Past this many lines across both sides, a hunk wants a real diff tool. */
export const HEAVY_HUNK = 40;
/** Past this many hunks in one file, the web editor is scrolling, not reviewing. */
export const MANY_HUNKS = 6;

export type HunkClash =
  | "whitespace" // the two sides differ only in whitespace
  | "add-add" // base is empty: both sides inserted at the same spot
  | "edit-delete" // one side removed what the other side changed
  | "edit-edit"; // both sides rewrote the same base lines

export type HunkGrade = "trivial" | "easy" | "judgment" | "heavy";

export type Hunk = {
  /** 1-based line of the `<<<<<<<` marker in the conflicted file GitHub shows. */
  line: number;
  main: number;
  base: number | null;
  pr: number;
  clash: HunkClash;
  grade: HunkGrade;
  preview: { main: string; pr: string };
  /** The hunk's full text per side; `base` is null without diff3 markers. */
  sides: { main: string[]; base: string[] | null; pr: string[] };
  /** Commits on each side whose patches wrote or removed these lines, strongest first. */
  why?: { main: Origin[]; pr: Origin[] };
};

export type Origin = {
  sha: string;
  subject: string;
  /** The PR a squash subject names with a trailing `(#N)`. */
  pr: number | null;
  /** How many of the hunk's distinct lines this commit's patch added or removed. */
  lines: number;
};

export type Verdict =
  | "local-required" // GitHub cannot render it; the Resolve button is disabled
  | "regenerate" // a derived file: re-run its generator, never hand-merge it
  | "local-recommended" // renderable, but too big or too many hunks for a textarea
  | "web-ok";

const VERDICT_RANK: Verdict[] = ["local-required", "regenerate", "local-recommended", "web-ok"];

export type FileTriage = {
  path: string;
  /** What GitHub is looking at. */
  github: "content" | "structural";
  /** git's own conflict labels for the path, e.g. "modify/delete". */
  kinds: string[];
  stages: number[];
  verdict: Verdict;
  reasons: string[];
  owes: string[];
  hunks: Hunk[];
  /** The newest commits touching the path on each side, for a conflict with no hunks to attribute (a modify/delete). */
  history: { main: Origin[]; pr: Origin[] };
};

export type Report = {
  label: string;
  base: string;
  head: string;
  /** The common ancestor both sides are measured from. */
  mergeBase: string;
  /** `https://github.com/<owner>/<repo>`, for linking commits and PRs, when origin is on GitHub. */
  repo: string | null;
  pr?: { number: number; url: string; mergeable: string };
  /** The merged result tree: `git cat-file -p <tree>:<path>` shows the markers. */
  tree: string;
  verdict: "clean" | "web" | "local";
  webEditorAvailable: boolean;
  files: FileTriage[];
  warnings: string[];
};

// ── git plumbing ─────────────────────────────────────────────────────────────

class Instrument extends Error {}

function git(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitTry(args: string[]): string | null {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

type MergeTree = {
  tree: string;
  entries: { mode: string; oid: string; stage: number; path: string }[];
  messages: { paths: string[]; type: string; text: string }[];
};

/**
 * `git merge-tree --write-tree --messages -z` and its NUL-separated output:
 * the tree, then `<mode> <oid> <stage>\t<path>` per unmerged entry, then an
 * empty field, then messages as `<n>, <path> x n, <type>, <text>`.
 */
function mergeTree(base: string, head: string, mergeBase?: string): MergeTree {
  const explicit = mergeBase ? [`--merge-base=${mergeBase}`] : [];
  const run = spawnSync("git", ["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", "--messages", "-z", ...explicit, base, head], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // merge-tree exits 1 for "merged with conflicts", which is a result. Anything
  // else (no merge base, a bad ref) is the instrument failing.
  if (run.status !== 0 && run.status !== 1) {
    throw new Instrument(`git merge-tree exited ${run.status}: ${run.stderr.trim()}`);
  }
  const fields = run.stdout.split("\0");
  const tree = fields.shift() ?? "";
  // Exit 1 ALSO means "not something we can merge" (a bad ref), with nothing on
  // stdout. Read as a result, that is an empty conflict list: a clean merge.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) throw new Instrument(`git merge-tree produced no tree: ${run.stderr.trim() || "(no stderr)"}`);
  const entries: MergeTree["entries"] = [];
  while (fields.length > 0 && fields[0] !== "") {
    const field = fields.shift() ?? "";
    const m = field.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
    if (!m) throw new Instrument(`unreadable merge-tree entry: ${JSON.stringify(field)}`);
    entries.push({ mode: m[1], oid: m[2], stage: Number(m[3]), path: m[4] });
  }
  fields.shift();
  const messages: MergeTree["messages"] = [];
  while (fields.length > 1) {
    const n = Number(fields.shift());
    if (!Number.isInteger(n) || n < 1) break;
    const paths = fields.splice(0, n);
    const type = fields.shift() ?? "";
    const text = (fields.shift() ?? "").trim();
    messages.push({ paths, type, text });
  }
  return { tree, entries, messages };
}

// ── provenance: which commit wrote each side ────────────────────────────────

const prOf = (subject: string) => Number(subject.match(/\(#(\d+)\)\s*$/)?.[1]) || null;

type Patch = { sha: string; subject: string; added: Set<string>; removed: Set<string> };

/**
 * Every non-merge commit in `from..to` that touched `path`, newest first, with
 * the lines its patch added and removed. Lines are compared trimmed: a
 * conflict hunk is cut from the merged file and a re-indent should not hide
 * the commit that wrote the line.
 */
function patches(from: string, to: string, path: string): Patch[] {
  const text = gitTry(["log", "--no-merges", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=%x00%H%x09%s", `${from}..${to}`, "--", path]);
  if (!text) return [];
  return text
    .split("\0")
    .filter(Boolean)
    .map((chunk) => {
      const [head, ...diff] = chunk.split("\n");
      const [sha, ...subject] = head.split("\t");
      const added = new Set<string>();
      const removed = new Set<string>();
      for (const line of diff) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        const body = line.slice(1).trim();
        if (!body) continue;
        if (line[0] === "+") added.add(body);
        else if (line[0] === "-") removed.add(body);
      }
      return { sha, subject: subject.join("\t"), added, removed };
    });
}

/**
 * Rank a side's commits by how many of the hunk's distinct lines their patches
 * touched: lines the side now holds that a patch ADDED, plus base lines that a
 * patch REMOVED (which is how a pure deletion gets an author at all). A commit
 * that touched the file but none of these lines is left out, so an unrelated
 * edit elsewhere in the file cannot claim the hunk.
 */
export function attribute(list: Patch[], side: string[], base: string[] | null, keep = 3): Origin[] {
  const now = new Set(side.map((l) => l.trim()).filter(Boolean));
  const was = new Set((base ?? []).map((l) => l.trim()).filter(Boolean));
  return list
    .map((p) => {
      let lines = 0;
      for (const l of now) if (p.added.has(l)) lines++;
      for (const l of was) if (!now.has(l) && p.removed.has(l)) lines++;
      return { sha: p.sha, subject: p.subject, pr: prOf(p.subject), lines };
    })
    .filter((o) => o.lines > 0)
    .sort((a, b) => b.lines - a.lines) // stable, so ties stay newest first
    .slice(0, keep);
}

function history(from: string, to: string, path: string, keep = 3): Origin[] {
  const text = gitTry(["log", "--no-merges", `-${keep}`, "--format=%H%x09%s", `${from}..${to}`, "--", path]);
  if (!text) return [];
  return text.split("\n").map((row) => {
    const [sha, ...subject] = row.split("\t");
    const s = subject.join("\t");
    return { sha, subject: s, pr: prOf(s), lines: 0 };
  });
}

function githubRepo(): string | null {
  const url = gitTry(["remote", "get-url", "origin"]);
  const m = url?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
}

// ── repository policy, read from the BASE tree ──────────────────────────────

type Derivation = { id: string; outputs?: string[]; inputs?: { paths?: string[] }; regenerate?: string };

function derivations(base: string): Derivation[] {
  const text = gitTry(["show", `${base}:config/derivations.json`]);
  if (!text) return [];
  try {
    return (JSON.parse(text) as { derivations?: Derivation[] }).derivations ?? [];
  } catch {
    return [];
  }
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

// ── hunks ────────────────────────────────────────────────────────────────────

const squash = (lines: string[]) => lines.join("\n").replace(/\s+/g, " ").trim();
const clip = (lines: string[]) => {
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const one = first.trim();
  return one.length > 72 ? `${one.slice(0, 71)}…` : one;
};

/** Share of the shorter side's non-blank lines that also appear on the other side. */
function overlap(a: string[], b: string[]): number {
  const norm = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);
  const [small, large] = [norm(a), norm(b)].sort((x, y) => x.length - y.length);
  if (small.length === 0) return 0;
  const pool = new Set(large);
  return small.filter((l) => pool.has(l)).length / small.length;
}

export function gradeHunk(main: string[], base: string[] | null, pr: string[]): { clash: HunkClash; grade: HunkGrade } {
  const size = main.length + pr.length;
  if (squash(main) === squash(pr)) return { clash: "whitespace", grade: "trivial" };
  if (size > HEAVY_HUNK) {
    const clash: HunkClash = base !== null && base.length === 0 ? "add-add" : main.length === 0 || pr.length === 0 ? "edit-delete" : "edit-edit";
    return { clash, grade: "heavy" };
  }
  // An add/add is "keep both" only when the two insertions are different
  // things. When they share most of their lines (two branches landing the same
  // helper, or one branch carrying an earlier copy of the other), keeping both
  // DUPLICATES the code, and choosing between two near-copies is a judgment.
  if (base !== null && base.length === 0) return { clash: "add-add", grade: overlap(main, pr) > 0.5 ? "judgment" : "easy" };
  if (main.length === 0 || pr.length === 0) return { clash: "edit-delete", grade: "judgment" };
  return { clash: "edit-edit", grade: size <= SMALL_EDIT ? "easy" : "judgment" };
}

export function parseHunks(text: string): Hunk[] {
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let state: "out" | "main" | "base" | "pr" = "out";
  let start = 0;
  let main: string[] = [];
  let base: string[] | null = null;
  let pr: string[] = [];
  lines.forEach((line, i) => {
    if (state === "out" && /^<{7}(?: |$)/.test(line)) {
      state = "main";
      start = i + 1;
      main = [];
      base = null;
      pr = [];
    } else if (state === "main" && /^\|{7}(?: |$)/.test(line)) {
      state = "base";
      base = [];
    } else if ((state === "main" || state === "base") && /^={7}$/.test(line)) {
      state = "pr";
    } else if (state === "pr" && /^>{7}(?: |$)/.test(line)) {
      const { clash, grade } = gradeHunk(main, base, pr);
      hunks.push({
        line: start,
        main: main.length,
        base: base === null ? null : (base as string[]).length,
        pr: pr.length,
        clash,
        grade,
        preview: { main: clip(main), pr: clip(pr) },
        sides: { main, base, pr },
      });
      state = "out";
    } else if (state === "main") main.push(line);
    else if (state === "base") (base as string[]).push(line);
    else if (state === "pr") pr.push(line);
  });
  return hunks;
}

// ── triage ───────────────────────────────────────────────────────────────────

/** Labels git uses for conflicts GitHub's editor cannot show. */
const STRUCTURAL = /^(modify\/delete|file location|rename|file\/directory|directory\/file|distinct modes|binary|submodule|add\/add, mode)/;
const CODE = /\.(ts|tsx|js|mjs|cjs|rs|css|html|sh)$/;

export function triage(base: string, head: string, label: string, opts: { mergeBase?: string } = {}): Report {
  const warnings: string[] = [];
  for (const ref of [base, head, ...(opts.mergeBase ? [opts.mergeBase] : [])]) {
    if (gitTry(["rev-parse", "--verify", "-q", `${ref}^{commit}`]) === null) throw new Instrument(`not a commit: ${ref}`);
  }
  const mergeBase = opts.mergeBase ? git(["rev-parse", opts.mergeBase]).trim() : gitTry(["merge-base", base, head]);
  if (!mergeBase) throw new Instrument(`${base} and ${head} share no merge base`);
  const github = mergeTree(base, head, opts.mergeBase);
  const paths = [...new Set(github.entries.map((e) => e.path))].sort();
  const derived = derivations(base);

  const files: FileTriage[] = paths.map((path) => {
    const entries = github.entries.filter((e) => e.path === path);
    const stages = [...new Set(entries.map((e) => e.stage))].sort((a, b) => a - b);
    const modes = new Set(entries.map((e) => e.mode));
    const kinds = [
      ...new Set(
        github.messages
          .filter((m) => m.paths.includes(path) && m.type.startsWith("CONFLICT"))
          .map((m) => (m.text.match(/^CONFLICT \(([^)]+)\)/)?.[1] ?? m.type)),
      ),
    ];

    let hunks: Hunk[] = [];
    const blob = gitTry(["cat-file", "blob", `${github.tree}:${path}`]);
    if (blob !== null) hunks = parseHunks(blob);

    const structural =
      kinds.some((k) => STRUCTURAL.test(k)) ||
      !stages.includes(2) ||
      !stages.includes(3) ||
      modes.size > 1 ||
      [...modes].some((m) => m === "120000" || m === "160000") ||
      hunks.length === 0;

    const reasons: string[] = [];
    const owes: string[] = [];
    let verdict: Verdict = "web-ok";
    const lift = (v: Verdict, why: string) => {
      reasons.push(why);
      if (VERDICT_RANK.indexOf(v) < VERDICT_RANK.indexOf(verdict)) verdict = v;
    };

    if (structural) {
      const what = kinds.length > 0 ? kinds.join(", ") : !stages.includes(2) ? "deleted on main" : !stages.includes(3) ? "deleted in the PR" : "not a line conflict";
      lift("local-required", `GitHub cannot render ${what}; its Resolve button is disabled for this`);
    }

    // A derivation naming this exact file is decisive. One naming a DIRECTORY
    // above it is not: repo/card declares all of `.github` for one PNG, so a
    // conflict in a workflow file would read as generated. That match is a note.
    const exact = derived.find((d) => (d.outputs ?? []).includes(path));
    const byDir = exact ? undefined : derived.find((d) => (d.outputs ?? []).some((o) => under(path, o)));
    const lockfile = path.endsWith("bun.lock");
    if (exact || lockfile) {
      lift("regenerate", exact ? `derived by ${exact.id}; the merged text is never the answer` : "a lockfile; the merged text is never the answer");
      owes.push(exact?.regenerate ?? "bun install");
    }
    if (byDir) reasons.push(`sits under ${(byDir.outputs ?? []).find((o) => under(path, o))}, which ${byDir.id} declares as output; regenerate if it is one of that generator's files`);

    if (!structural && hunks.length > 0) {
      const heavy = hunks.filter((h) => h.grade === "heavy").length;
      if (heavy > 0) lift("local-recommended", `${heavy} hunk(s) over ${HEAVY_HUNK} lines`);
      if (hunks.length > MANY_HUNKS) lift("local-recommended", `${hunks.length} hunks, over ${MANY_HUNKS}`);
      if (CODE.test(path) && hunks.some((h) => h.grade === "judgment")) {
        reasons.push("code: the first thing to compile a web-editor resolution is CI's validate");
      }
    }

    for (const d of derived) {
      if (d.regenerate && (d.inputs?.paths ?? []).some((p) => under(path, p)) && !owes.includes(d.regenerate)) {
        owes.push(`${d.regenerate}  (input to ${d.id})`);
      }
    }
    if (path === "config/derivations.json") owes.push("bun run derive:check -- --lock, after reading what it vouches for");    // A merged input moves a recorded digest, so `validate` runs derive:check
    // against a hash neither side recorded. The web editor commits and stops;
    // it cannot run the command that clears that, so the owed step is the
    // reason to take the file local even when every hunk is small.
    if (owes.length > 0) lift("local-recommended", "the resolution owes a command the web editor cannot run");

    return {
      path,
      github: structural ? "structural" : "content",
      kinds,
      stages,
      verdict,
      reasons,
      owes: [...new Set(owes)],
      hunks,
      history: { main: history(mergeBase, base, path), pr: history(mergeBase, head, path) },
    };
  });

  // Attribution reads every patch on both sides, so it is skipped where no
  // reading of the hunks is owed: a derived file is regenerated, never merged.
  for (const f of files) {
    if (f.hunks.length === 0 || f.verdict === "regenerate") continue;
    const mainPatches = patches(mergeBase, base, f.path);
    const prPatches = patches(mergeBase, head, f.path);
    for (const h of f.hunks) {
      h.why = { main: attribute(mainPatches, h.sides.main, h.sides.base), pr: attribute(prPatches, h.sides.pr, h.sides.base) };
    }
  }

  files.sort((a, b) => VERDICT_RANK.indexOf(a.verdict) - VERDICT_RANK.indexOf(b.verdict) || a.path.localeCompare(b.path));
  const webEditorAvailable = !files.some((f) => f.verdict === "local-required");
  const verdict: Report["verdict"] = files.length === 0 ? "clean" : files.every((f) => f.verdict === "web-ok") ? "web" : "local";
  return { label, base, head, mergeBase, repo: githubRepo(), tree: github.tree, verdict, webEditorAvailable, files, warnings };
}

// ── targets ──────────────────────────────────────────────────────────────────

type PrMeta = { number: number; title: string; url: string; headRefName: string; headRefOid: string; baseRefName: string; mergeable: string };

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const PR_FIELDS = "number,title,url,headRefName,headRefOid,baseRefName,mergeable";

function triagePr(meta: PrMeta): Report {
  git(["fetch", "-q", "origin", meta.baseRefName, `pull/${meta.number}/head`]);
  if (gitTry(["cat-file", "-e", `${meta.headRefOid}^{commit}`]) === null) {
    throw new Instrument(`PR #${meta.number}: head ${meta.headRefOid.slice(0, 8)} was not fetched`);
  }
  const report = triage(`origin/${meta.baseRefName}`, meta.headRefOid, `#${meta.number} ${meta.title}`);
  report.pr = { number: meta.number, url: meta.url, mergeable: meta.mergeable };
  // The outside control. GitHub computes `mergeable` lazily, so UNKNOWN is no
  // evidence either way; the other two must agree with ours.
  const ours = report.files.length > 0 ? "CONFLICTING" : "MERGEABLE";
  if (meta.mergeable !== "UNKNOWN" && meta.mergeable !== ours) {
    report.warnings.push(`GitHub reports ${meta.mergeable} and the local merge reads ${ours}; trust neither until one is re-read`);
  }
  return report;
}

// ── output ───────────────────────────────────────────────────────────────────

const ICON: Record<Verdict, string> = {
  "local-required": "LOCAL (required)",
  regenerate: "LOCAL (regenerate)",
  "local-recommended": "LOCAL (recommended)",
  "web-ok": "WEB OK",
};

function route(r: Report): string[] {
  if (r.verdict === "clean") return ["No conflicts."];
  if (r.verdict === "web") return ["Every conflict is a small line conflict. GitHub's web editor is fine for all of them."];
  const branch = r.pr ? `the PR branch` : "this branch";
  return [
    r.webEditorAvailable
      ? "GitHub will offer its editor, but at least one conflict should not go through it."
      : "GitHub's Resolve button is disabled for this PR: at least one conflict is not a line conflict.",
    `Resolve every file in ONE local merge, including the web-ok ones: check out ${branch}, \`git merge origin/main\`, resolve, then run what each file owes.`,
  ];
}

export function renderText(r: Report): string {
  const out = [`${r.label}`, `  ${r.base} <- ${r.head.slice(0, 12)}   verdict: ${r.verdict}`];
  for (const w of r.warnings) out.push(`  warning: ${w}`);
  for (const f of r.files) {
    out.push("", `  [${ICON[f.verdict]}] ${f.path}${f.kinds.length ? `  (${f.kinds.join(", ")})` : ""}`);
    for (const why of f.reasons) out.push(`      - ${why}`);
    for (const h of f.hunks) {
      const base = h.base === null ? "" : ` base ${h.base} /`;
      out.push(`      hunk @${h.line}: ${h.grade} ${h.clash}, main ${h.main} /${base} pr ${h.pr} lines`);
      if (h.preview.main || h.preview.pr) out.push(`          main: ${h.preview.main || "(empty)"}`, `          pr:   ${h.preview.pr || "(empty)"}`);
      for (const side of ["main", "pr"] as const) {
        const top = h.why?.[side][0];
        if (top) out.push(`          ${side === "main" ? "main" : "pr  "} by ${top.sha.slice(0, 8)} ${top.subject}`);
      }
    }
    if (f.hunks.length === 0) {
      for (const side of ["main", "pr"] as const) {
        const top = f.history[side][0];
        if (top) out.push(`      last on ${side}: ${top.sha.slice(0, 8)} ${top.subject}`);
      }
    }
    for (const o of f.owes) out.push(`      owes: ${o}`);
  }
  out.push("", ...route(r).map((l) => `  ${l}`));
  return out.join("\n");
}

export function renderMarkdown(r: Report): string {
  const title = r.pr ? `### Conflict triage for [#${r.pr.number}](${r.pr.url})` : `### Conflict triage: ${r.label}`;
  const out = [title, "", ...route(r), ""];
  if (r.files.length > 0) {
    out.push("| conflict | verdict | hunks | why |", "|---|---|---|---|");
    for (const f of r.files) {
      const grades = f.hunks.length ? f.hunks.map((h) => `${h.grade} (${h.main}/${h.pr})`).join(", ") : "none";
      const why = [...f.reasons, ...f.owes.map((o) => `owes \`${o}\``)].join("; ").replaceAll("|", "\\|");
      out.push(`| \`${f.path}\` | ${ICON[f.verdict]} | ${grades} | ${why} |`);
    }
  }
  for (const w of r.warnings) out.push("", `> ${w}`);
  out.push("", `<sub>\`bun run conflicts -- ${r.pr?.number ?? ""}\`, checked against GitHub's own mergeable field.</sub>`);
  return out.join("\n");
}

// ── the three-way view ───────────────────────────────────────────────────────

/** Notes keyed `<path>:<line>` (a hunk), `<path>` (a file) or `*` (the merge). Plain text; `code` spans in backticks. */
export type Notes = Record<string, string>;

/** A notes file decoded at the boundary, or null when any entry is not non-empty text. */
function parseNotes(value: unknown): Notes | null {
  const record = asRecord(value);
  if (!record) return null;
  const out: Notes = {};
  for (const [key, note] of Object.entries(record)) {
    const text = asText(note);
    if (text === null) return null;
    out[key] = text;
  }
  return out;
}

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const prose = (s: string) =>
  esc(s)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/`([^`\n]+)`/g, "<code>$1</code>").replaceAll("\n", "<br>")}</p>`)
    .join("");

/** Past this many lines a column is cut, with the count of what was left out. */
const VIEW_LINES = 80;

/** `lines` undefined renders the commits alone, for a file-level column with no hunk text. */
function column(label: string, lines: string[] | null | undefined, origins: Origin[] | undefined, repo: string | null): string {
  const chips = (origins ?? [])
    .map((o) => {
      const sha = repo ? `<a href="${esc(`${repo}/commit/${o.sha}`)}">${o.sha.slice(0, 8)}</a>` : o.sha.slice(0, 8);
      const pr = o.pr && repo ? ` <a href="${esc(`${repo}/pull/${o.pr}`)}">#${o.pr}</a>` : "";
      const subject = o.subject.replace(/\s*\(#\d+\)\s*$/, "");
      return `<li>${sha}${pr} ${esc(subject)} <span class="n">${o.lines} line${o.lines === 1 ? "" : "s"}</span></li>`;
    })
    .join("");
  const body =
    lines === undefined
      ? chips
        ? ""
        : `<div class="none">no commits on this side since the merge base</div>`
      : lines === null
      ? `<div class="none">no base (git wrote no diff3 section)</div>`
      : lines.length === 0
        ? `<div class="none">nothing: this side has no lines here</div>`
        : `<pre>${esc(lines.slice(0, VIEW_LINES).join("\n"))}${lines.length > VIEW_LINES ? `\n<span class="n">… ${lines.length - VIEW_LINES} more lines</span>` : ""}</pre>`;
  return `<div class="col ${label}"><h4>${label}</h4>${chips ? `<ul class="by">${chips}</ul>` : ""}${body}</div>`;
}

export function renderHtml(reports: Report[], notes: Notes = {}): string {
  const sections = reports.map((r) => {
    const title = r.pr ? `<a href="${esc(r.pr.url)}">#${r.pr.number}</a> ${esc(r.label.replace(/^#\d+\s*/, ""))}` : esc(r.label);
    const files = r.files.map((f) => {
      const hunks = f.hunks
        .map((h) => {
          const note = notes[`${f.path}:${h.line}`];
          return `<article class="hunk">
<header><span class="grade ${h.grade}">${h.grade}</span> ${h.clash} <span class="n">@${h.line} · main ${h.main} / base ${h.base ?? "?"} / pr ${h.pr}</span></header>
${note ? `<div class="note">${prose(note)}</div>` : ""}
<div class="cols">${column("main", h.sides.main, h.why?.main, r.repo)}${column("base", h.sides.base, undefined, r.repo)}${column("pr", h.sides.pr, h.why?.pr, r.repo)}</div>
</article>`;
        })
        .join("");
      const hist =
        f.hunks.length === 0
          ? `<div class="cols two">${column("main", undefined, f.history.main, r.repo)}${column("pr", undefined, f.history.pr, r.repo)}</div>`
          : "";
      const note = notes[f.path];
      return `<section class="file">
<h3><code>${esc(f.path)}</code> <span class="verdict ${f.verdict}">${ICON[f.verdict]}</span>${f.kinds.length ? ` <span class="n">${esc(f.kinds.join(", "))}</span>` : ""}</h3>
${note ? `<div class="note">${prose(note)}</div>` : ""}
${f.reasons.length || f.owes.length ? `<ul class="reasons">${[...f.reasons.map(esc), ...f.owes.map((o) => `owes <code>${esc(o)}</code>`)].map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}
${hist}${hunks}
</section>`;
    });
    const top = notes["*"];
    return `<section class="report">
<h2>${title}</h2>
<p class="n">${esc(r.base)} ← ${esc(r.head.slice(0, 12))}, from merge base ${esc(r.mergeBase.slice(0, 12))}</p>
${top ? `<div class="note lead">${prose(top)}</div>` : ""}
<div class="route">${route(r).map((l) => `<p>${esc(l).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`).join("")}</div>
${r.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
${files.join("")}
</section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conflict view</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--main:#2f5fb3;--pr:#a14d12;--base:#6b6b66;--note:#f3f0e4;--warn:#9b2c2c;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#e8e6df;--muted:#9a9890;--line:#2e2d2a;--card:#1e1e1c;--main:#7fa6ea;--pr:#e09a62;--base:#9a9890;--note:#26241d;--warn:#f08080}}
:root[data-theme="dark"]{--bg:#161615;--fg:#e8e6df;--muted:#9a9890;--line:#2e2d2a;--card:#1e1e1c;--main:#7fa6ea;--pr:#e09a62;--base:#9a9890;--note:#26241d;--warn:#f08080}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1280px;margin:0 auto}a{color:inherit}code,pre{font-family:var(--mono);font-size:12.5px}
h2{margin:0 0 4px;font-size:20px}h3{font-size:15px;margin:28px 0 8px;display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.n{color:var(--muted);font-size:12.5px}.warn{color:var(--warn)}
.note{background:var(--note);border-radius:6px;padding:8px 12px;margin:8px 0}.note p{margin:4px 0}.lead{font-size:15.5px}
.route p{margin:4px 0}.reasons{margin:4px 0;padding-left:20px;color:var(--muted);font-size:13.5px}
.verdict,.grade{font-size:11.5px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-weight:600}
.hunk{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}.hunk header{font-size:13.5px}
.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:8px}.cols.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.col{min-width:0}.col.main h4{color:var(--main)}.col.pr h4{color:var(--pr)}.col.base h4{color:var(--base)}
.col pre{margin:0;padding:8px;border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.col.main pre{border-left:3px solid var(--main)}.col.pr pre{border-left:3px solid var(--pr)}.col.base pre{border-left:3px solid var(--base);opacity:.85}
.by{list-style:none;margin:0 0 6px;padding:0;font-size:12.5px}.by li{overflow-wrap:anywhere}
.none{color:var(--muted);font-style:italic;font-size:13px;padding:8px;border:1px dashed var(--line);border-radius:6px}
@media (max-width:760px){.cols,.cols.two{grid-template-columns:minmax(0,1fr)}}
</style></head><body><main>
${sections.join("\n")}
</main></body></html>
`;
}

/** What `git` is in the middle of in the current worktree, oriented upstream-first. */
function inProgress(): { base: string; head: string; mergeBase?: string; label: string } {
  const has = (name: string) => gitTry(["rev-parse", "-q", "--verify", name]) !== null;
  if (has("MERGE_HEAD")) return { base: "MERGE_HEAD", head: "HEAD", label: "merge in progress (MERGE_HEAD into HEAD)" };
  for (const name of ["REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (has(name)) {
      const subject = gitTry(["log", "-1", "--format=%s", name]) ?? "";
      return { base: "HEAD", head: name, mergeBase: `${name}^`, label: `${name === "REBASE_HEAD" ? "rebase" : "cherry-pick"} replaying ${subject}` };
    }
  }
  throw new Instrument("--in-progress: git is not stopped in a merge, rebase or cherry-pick here");
}

// ── cli ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const format = args.includes("--json") ? "json" : args.includes("--markdown") ? "markdown" : "text";
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const prArg = args.find((a) => /^#?\d+$/.test(a));

  const [major, minor] = (git(["--version"]).match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  if (major < 2 || (major === 2 && minor < 40)) throw new Instrument("git 2.40 or newer is needed for --attr-source");

  let reports: Report[];
  if (args.includes("--all")) {
    const open = JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "100", "--json", PR_FIELDS])) as PrMeta[];
    reports = open.map(triagePr).filter((r) => r.files.length > 0);
    if (format === "text" && reports.length === 0) console.log(`conflicts: none of ${open.length} open PRs conflict with their base.`);
  } else if (prArg) {
    const meta = JSON.parse(gh(["pr", "view", prArg.replace("#", ""), "--json", PR_FIELDS])) as PrMeta;
    reports = [triagePr(meta)];
  } else if (args.includes("--in-progress")) {
    const op = inProgress();
    reports = [triage(git(["rev-parse", op.base]).trim(), git(["rev-parse", op.head]).trim(), op.label, { mergeBase: op.mergeBase })];
  } else {
    const base = flag("--base") ?? "origin/main";
    const head = flag("--head") ?? "HEAD";
    if (base.startsWith("origin/")) git(["fetch", "-q", "origin", base.slice("origin/".length)]);
    reports = [triage(base, git(["rev-parse", head]).trim(), head === "HEAD" ? git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() : head)];
  }

  const htmlPath = flag("--html");
  if (htmlPath) {
    const notesPath = flag("--notes");
    let notes: Notes = {};
    if (notesPath) {
      const parsed = parseNotes(JSON.parse(readFileSync(notesPath, "utf8")));
      if (!parsed) throw new Instrument(`--notes ${notesPath}: expected an object of non-empty strings keyed "<path>:<line>", "<path>" or "*"`);
      notes = parsed;
      // A key that names no hunk is a note nobody will see, which reads as an
      // explanation that was written and is simply absent from the page.
      const known = new Set(["*", ...reports.flatMap((r) => r.files.flatMap((f) => [f.path, ...f.hunks.map((h) => `${f.path}:${h.line}`)]))]);
      const stray = Object.keys(notes).filter((k) => !known.has(k));
      if (stray.length > 0) throw new Instrument(`--notes: no such hunk or file: ${stray.join(", ")}`);
    }
    writeFileSync(htmlPath, renderHtml(reports, notes));
    console.error(`conflicts: wrote ${htmlPath}`);
  }

  if (format === "json") console.log(JSON.stringify(reports.length === 1 && !args.includes("--all") ? reports[0] : reports, null, 2));
  else console.log(reports.map(format === "markdown" ? renderMarkdown : renderText).join("\n\n"));
  process.exit(reports.some((r) => r.verdict === "local") ? 1 : 0);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`conflicts: ${error instanceof Instrument ? "" : "could not run: "}${why}`);
    process.exit(2);
  }
}
