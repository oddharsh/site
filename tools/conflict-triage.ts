// Which merge conflicts on a PR can be resolved in GitHub's web editor, and
// which need a local checkout. Conflict by conflict, and hunk by hunk inside
// each file.
//
//     bun run conflicts                  this branch against origin/main
//     bun run conflicts -- 876           one PR
//     bun run conflicts -- --all         every open PR that conflicts
//     bun run conflicts -- 876 --markdown | --json
//
// THE QUESTION HAS TWO HALVES, AND GITHUB ONLY ANSWERS THE FIRST. GitHub's
// editor handles "simple competing line change conflicts" and greys out its
// Resolve button for everything else (modify/delete, renames, binaries, mode
// changes). That half is mechanical. The second half is specific to this
// repository: .gitattributes routes package.json, the lockfiles, the pin and
// the long-form prose through tools/merge-driver.ts, and GITHUB NEVER RUNS IT.
// So GitHub shows conflicts a local merge resolves for free, and it will let you
// hand-merge bun.lock in a textarea, which is wrong by construction (the lock is
// a function of package.json, and CI's frozen install refuses a hand-merged
// one). Its merge commit also runs no hook here, so merge-finish never drains
// what the drivers would have parked.
//
// HOW EACH HALF IS MEASURED. Both are `git merge-tree --write-tree`, which does
// the whole merge in memory and touches no worktree, so this is safe to run in a
// tree other sessions are using.
//
//   the GitHub view   --attr-source=<empty tree>, so no path carries a merge=
//                     attribute and every file gets git's plain text merge.
//                     That is what GitHub computes. A control asserts the
//                     drivers really did not run (they announce themselves on
//                     stderr), since an --attr-source that stopped taking effect
//                     would make both views agree and report nothing.
//   the local view    attributes as committed, drivers live, and the driver's
//                     ledger redirected to a temp file (SITE_MERGE_LEDGER) so a
//                     triage run parks nothing in the real one. What it parked
//                     is reported as what the resolution OWES.
//
// For a PR the GitHub view is also checked against GitHub's own `mergeable`
// field, which is the only outside control on the emulation there is.
//
// THE HUNK GRADES ARE A FIRST CUT AND NOT A MEASUREMENT. The thresholds below
// were picked, not fitted, so every hunk prints its raw line counts beside its
// grade and a reader who disagrees has the numbers to disagree with.
//
// Exit 0: nothing needs a local checkout. 1: something does. 2: the instrument
// could not run, which is never reported as a clean result.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
};

export type Verdict =
  | "local-required" // GitHub cannot render it; the Resolve button is disabled
  | "regenerate" // a derived file: re-run its generator, never hand-merge it
  | "local-free" // this repo's merge driver resolves it; GitHub shows it anyway
  | "local-recommended" // renderable, but too big or too many hunks for a textarea
  | "web-ok";

const VERDICT_RANK: Verdict[] = ["local-required", "regenerate", "local-free", "local-recommended", "web-ok"];

export type FileTriage = {
  path: string;
  /** What GitHub is looking at. */
  github: "content" | "structural";
  /** git's own conflict labels for the path, e.g. "modify/delete". */
  kinds: string[];
  stages: number[];
  /** The same merge with this repository's drivers live. */
  local: "resolved" | "conflicted" | "drivers-not-wired";
  driverNotes: string[];
  verdict: Verdict;
  reasons: string[];
  owes: string[];
  hunks: Hunk[];
};

export type Report = {
  label: string;
  base: string;
  head: string;
  pr?: { number: number; url: string; mergeable: string };
  /** The GitHub-view result tree: `git cat-file -p <tree>:<path>` shows the markers. */
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
  stderr: string;
};

/**
 * `git merge-tree --write-tree --messages -z` and its NUL-separated output:
 * the tree, then `<mode> <oid> <stage>\t<path>` per unmerged entry, then an
 * empty field, then messages as `<n>, <path> x n, <type>, <text>`.
 */
function mergeTree(base: string, head: string, opts: { githubView: boolean; ledger?: string }): MergeTree {
  const pre = ["-c", "merge.conflictStyle=diff3"];
  if (opts.githubView) pre.push(`--attr-source=${emptyTree()}`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.ledger) env.SITE_MERGE_LEDGER = opts.ledger;
  const run = spawnSync("git", [...pre, "merge-tree", "--write-tree", "--messages", "-z", base, head], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env,
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
  return { tree, entries, messages, stderr: run.stderr };
}

let EMPTY_TREE: string | null = null;
function emptyTree(): string {
  // Computed rather than hardcoded, because the constant differs between SHA-1
  // and SHA-256 repositories.
  EMPTY_TREE ??= execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { input: "", encoding: "utf8" }).trim();
  return EMPTY_TREE;
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

/** The merge= attribute each path carries in the base tree, which is what a local merge reads. */
function mergeAttrs(base: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const text = git([`--attr-source=${base}`, "check-attr", "-z", "merge", "--", ...paths]);
  const f = text.split("\0");
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] !== "unspecified") out.set(f[i], f[i + 2]);
  return out;
}

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

export function triage(base: string, head: string, label: string): Report {
  const warnings: string[] = [];
  for (const ref of [base, head]) {
    if (gitTry(["rev-parse", "--verify", "-q", `${ref}^{commit}`]) === null) throw new Instrument(`not a commit: ${ref}`);
  }
  const wired = gitTry(["config", "--get", "merge.json.driver"]) !== null;
  // BOTH passes get a throwaway ledger. The GitHub view should never reach a
  // driver, but when that control fails it fails AFTER the merge ran, and the
  // first version of this file let that run park a real `bun install` in the
  // worktree's ledger on its way to reporting the failure.
  const scratch = mkdtempSync(join(tmpdir(), "conflict-triage-"));
  const ledgerPath = join(scratch, "ledger");
  let github: MergeTree;
  let local: MergeTree;
  let ledger: { path: string; note: string }[] = [];
  try {
    github = mergeTree(base, head, { githubView: true, ledger: join(scratch, "github-ledger") });
    if (/^merge-driver:/m.test(github.stderr) || existsSync(join(scratch, "github-ledger"))) {
      throw new Instrument("control failed: a merge driver ran in the GitHub view, so --attr-source did not take effect");
    }
    local = mergeTree(base, head, { githubView: false, ledger: ledgerPath });
    if (existsSync(ledgerPath)) {
      ledger = readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const [path, ...rest] = row.split("\t");
          return { path, note: rest.join("\t") };
        });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!wired) warnings.push("merge drivers are not wired in this clone (`bun run setup:merge`), so the local view is the GitHub view");

  const driverNotes = new Map<string, string[]>();
  for (const m of local.stderr.matchAll(/^merge-driver: (.+?): (.+)$/gm)) {
    driverNotes.set(m[1], [...(driverNotes.get(m[1]) ?? []), m[2]]);
  }

  const githubPaths = new Set(github.entries.map((e) => e.path));
  const localPaths = new Set(local.entries.map((e) => e.path));
  for (const path of localPaths) {
    if (!githubPaths.has(path)) warnings.push(`${path} conflicts locally but not on GitHub; a driver refused a merge git would have made`);
  }

  const paths = [...new Set([...githubPaths, ...localPaths])].sort();
  const attrs = mergeAttrs(base, paths);
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
    const blob = githubPaths.has(path) ? gitTry(["cat-file", "blob", `${github.tree}:${path}`]) : null;
    if (blob !== null) hunks = parseHunks(blob);

    const structural =
      kinds.some((k) => STRUCTURAL.test(k)) ||
      !stages.includes(2) ||
      !stages.includes(3) ||
      modes.size > 1 ||
      [...modes].some((m) => m === "120000" || m === "160000") ||
      (githubPaths.has(path) && hunks.length === 0);

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
    const attr = attrs.get(path);
    const exact = derived.find((d) => (d.outputs ?? []).includes(path));
    const byDir = exact ? undefined : derived.find((d) => (d.outputs ?? []).some((o) => under(path, o)));
    const ledgerOwes = ledger.filter((r) => r.path === path).map((r) => r.note);
    if (attr === "regen" || exact) {
      lift("regenerate", exact ? `derived by ${exact.id}; the merged text is never the answer` : "derived file (merge=regen); the merged text is never the answer");
      if (exact?.regenerate) owes.push(exact.regenerate);
      else if (ledgerOwes.length === 0) owes.push(path.endsWith("bun.lock") ? "bun install" : "bun run derive:check -- --lock");
    }
    if (byDir) reasons.push(`sits under ${(byDir.outputs ?? []).find((o) => under(path, o))}, which ${byDir.id} declares as output; regenerate if it is one of that generator's files`);

    const notes = driverNotes.get(path) ?? [];
    const localState: FileTriage["local"] = !wired ? "drivers-not-wired" : localPaths.has(path) ? "conflicted" : "resolved";
    if (localState === "resolved" && attr && attr !== "regen") {
      lift("local-free", `merge=${attr} resolves it locally (${notes.join("; ") || "driver ran"}); GitHub never runs it`);
    }

    if (!structural && hunks.length > 0) {
      const heavy = hunks.filter((h) => h.grade === "heavy").length;
      if (heavy > 0) lift("local-recommended", `${heavy} hunk(s) over ${HEAVY_HUNK} lines`);
      if (hunks.length > MANY_HUNKS) lift("local-recommended", `${hunks.length} hunks, over ${MANY_HUNKS}`);
      if (CODE.test(path) && hunks.some((h) => h.grade === "judgment")) {
        reasons.push("code: the first thing to compile a web-editor resolution is CI's validate");
      }
    }

    owes.push(...ledgerOwes);
    for (const d of derived) {
      if (d.regenerate && (d.inputs?.paths ?? []).some((p) => under(path, p)) && !owes.includes(d.regenerate)) {
        owes.push(`${d.regenerate}  (input to ${d.id})`);
      }
    }
    if (path === "config/derivations.json") owes.push("bun run derive:check -- --lock, after reading what it vouches for");
    // A merged input moves a recorded digest, so `validate` runs derive:check
    // against a hash neither side recorded. The web editor commits and stops;
    // it cannot run the command that clears that, so the owed step is the
    // reason to take the file local even when every hunk is small.
    if (owes.length > 0) lift("local-recommended", "the resolution owes a command the web editor cannot run");

    return {
      path,
      github: structural ? "structural" : "content",
      kinds,
      stages,
      local: localState,
      driverNotes: notes,
      verdict,
      reasons,
      owes: [...new Set(owes)],
      hunks,
    };
  });

  files.sort((a, b) => VERDICT_RANK.indexOf(a.verdict) - VERDICT_RANK.indexOf(b.verdict) || a.path.localeCompare(b.path));
  const webEditorAvailable = !files.some((f) => f.verdict === "local-required");
  const verdict: Report["verdict"] = files.length === 0 ? "clean" : files.every((f) => f.verdict === "web-ok") ? "web" : "local";
  return { label, base, head, tree: github.tree, verdict, webEditorAvailable, files, warnings };
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
  // evidence either way; the other two must agree with the GitHub view.
  const ours = report.files.length > 0 ? "CONFLICTING" : "MERGEABLE";
  if (meta.mergeable !== "UNKNOWN" && meta.mergeable !== ours) {
    report.warnings.push(`GitHub reports ${meta.mergeable} and the emulated GitHub view reads ${ours}; trust neither until one is re-read`);
  }
  return report;
}

// ── output ───────────────────────────────────────────────────────────────────

const ICON: Record<Verdict, string> = {
  "local-required": "LOCAL (required)",
  regenerate: "LOCAL (regenerate)",
  "local-free": "LOCAL (free)",
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
    `Resolve every file in ONE local merge, including the web-ok ones: check out ${branch}, \`git merge origin/main\`, then \`bun run merge:finish\`.`,
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
  out.push("", `<sub>\`bun run conflicts -- ${r.pr?.number ?? ""}\`, GitHub view emulated with drivers off and checked against GitHub's own mergeable field.</sub>`);
  return out.join("\n");
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
  } else {
    const base = flag("--base") ?? "origin/main";
    const head = flag("--head") ?? "HEAD";
    if (base.startsWith("origin/")) git(["fetch", "-q", "origin", base.slice("origin/".length)]);
    reports = [triage(base, git(["rev-parse", head]).trim(), head === "HEAD" ? git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() : head)];
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
