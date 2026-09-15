#!/usr/bin/env bun
// bun run pin:digest -- --repo <owner/name> --from <sha> --to <sha> [--out <file>]
//
// What a pin ADOPTS when it moves: the upstream commits between two shas, and
// for a repository that ships changesets, the release notes those commits
// carry before any release has been cut. Rendered as Markdown for the body of
// the nightly bump PR, so "move the pin from b149147 to 982b806" arrives with
// the list of what main gained rather than two shas and four green gates.
//
// WHY CHANGESETS ARE THE INTERESTING HALF. cloudflare/workers-sdk commits a
// `.changeset/<name>.md` beside each user-facing change, naming the package
// and the bump level with the note that will go into the CHANGELOG at the
// next release. Between two commits of main those files are exactly the
// unreleased changelog, and the compare API hands them back as added files
// with their whole content in the patch, so no second request is needed.
// bun has no changesets; its commit subjects are the digest, and the count of
// robobun's among them is worth printing because on a typical day it is most
// of them.
//
// ADVISORY BY CONSTRUCTION. This is prose in a PR body. If the API refuses or
// the network is down it prints one line saying so and exits 0, because a
// bump PR that carries its evidence and no digest is still a bump PR, and a
// bump that fails because GitHub rate-limited a reading nobody gates on is
// the wrong trade. `GITHUB_TOKEN` raises the per-IP limit when set.
//
// `renderDigest()` is pure so a test can hand it a compare payload.

import { writeFileSync } from "node:fs";

type Commit = { sha: string; commit: { message: string; author?: { name?: string } }; author?: { login?: string } | null };
type File = { filename: string; status: string; patch?: string };
export type Compare = { total_commits: number; commits: Commit[]; files?: File[]; html_url?: string };

const MAX_SUBJECTS = 40;

/** The added `.changeset/*.md` files in a compare, parsed: which packages, what bump, what note. */
export function changesets(files: File[] | undefined) {
  const out: { file: string; packages: { name: string; bump: string }[]; note: string }[] = [];
  for (const f of files ?? []) {
    if (!/^\.changeset\/[^/]+\.md$/.test(f.filename) || f.status !== "added" || !f.patch) continue;
    // An added file's patch is every line prefixed `+`; the front matter sits
    // between the first two `---` lines.
    const body = f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    const fences = body.map((l, i) => (l.trim() === "---" ? i : -1)).filter((i) => i >= 0);
    if (fences.length < 2) continue;
    const front = body.slice(fences[0] + 1, fences[1]);
    const packages = front
      .map((l) => /^"?([^":]+)"?\s*:\s*(\w+)\s*$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1], bump: m[2] }));
    const note = body.slice(fences[1] + 1).join("\n").trim();
    if (packages.length) out.push({ file: f.filename, packages, note });
  }
  return out;
}

/** Markdown for the PR body. `repo` is `owner/name`; `from` and `to` are the two shas. */
export function renderDigest(repo: string, from: string, to: string, cmp: Compare): string {
  const lines: string[] = [];
  const total = cmp.total_commits ?? cmp.commits.length;
  const url = cmp.html_url ?? `https://github.com/${repo}/compare/${from}...${to}`;
  lines.push(`**What \`${to}\` carries that \`${from}\` did not** ([${total} commit${total === 1 ? "" : "s"}](${url}))`, "");

  const sets = changesets(cmp.files);
  if (sets.length) {
    lines.push(`${sets.length} changeset${sets.length === 1 ? "" : "s"}, which is the unreleased changelog:`, "");
    // wrangler and miniflare first, since those are the two this repo installs.
    const rank = (s: (typeof sets)[number]) => (s.packages.some((p) => p.name === "wrangler") ? 0 : s.packages.some((p) => p.name === "miniflare") ? 1 : 2);
    for (const s of [...sets].sort((a, b) => rank(a) - rank(b))) {
      const who = s.packages.map((p) => `**${p.name}** ${p.bump}`).join(", ");
      const first = s.note.split("\n").find((l) => l.trim()) ?? "(no note)";
      lines.push(`- ${who}: ${first.trim()}`);
    }
    lines.push("");
  } else if (cmp.files?.some((f) => f.filename.startsWith(".changeset/"))) {
    // The range touched the changeset directory without adding one (a release
    // consumed them), so the upstream's own accounting says nothing user-facing
    // landed. A repository with no changesets at all says nothing here.
    lines.push("No changeset was added between the two, so nothing in this range is a user-facing change by the upstream's own accounting.", "");
  }

  const subjects = cmp.commits.map((c) => ({
    subject: c.commit.message.split("\n")[0].trim(),
    who: c.author?.login ?? c.commit.author?.name ?? "?",
  }));
  const bots = subjects.filter((s) => /\[bot\]$|^robobun$|^dependabot/.test(s.who)).length;
  if (subjects.length) {
    const shown = subjects.slice(0, MAX_SUBJECTS);
    lines.push(`<details><summary>${subjects.length} commit subject${subjects.length === 1 ? "" : "s"}${bots ? `, ${bots} by bots` : ""}${total > cmp.commits.length ? ` (the API returned ${cmp.commits.length} of ${total})` : ""}</summary>`, "");
    for (const s of shown) lines.push(`- ${s.subject.replace(/[<>]/g, "")} (${s.who})`);
    if (subjects.length > shown.length) lines.push(`- and ${subjects.length - shown.length} more`);
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}

async function compare(repo: string, from: string, to: string): Promise<Compare> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "aadhar-sh pin-digest" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${from}...${to}?per_page=250`, { headers });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}/compare/${from}...${to}`);
  return (await res.json()) as Compare;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const repo = flag("--repo");
  const from = flag("--from");
  const to = flag("--to");
  const outPath = flag("--out");
  if (!repo || !from || !to) {
    console.error("usage: pin-digest --repo <owner/name> --from <sha> --to <sha> [--out <file>]");
    process.exit(2);
  }
  let text: string;
  try {
    text = renderDigest(repo, from, to, await compare(repo, from, to));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (process.env.GITHUB_ACTIONS) console.error(`::warning title=pin digest unavailable::${why}`);
    text = `_Upstream digest unavailable: ${why}. Compare by hand: https://github.com/${repo}/compare/${from}...${to}_\n`;
  }
  if (outPath) writeFileSync(outPath, text);
  else process.stdout.write(text);
}
