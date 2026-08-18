#!/usr/bin/env bun
// bump-version.ts — stage a release entry for /updates and /restore.
//
// WRITES ONE FILE AND NOTHING ELSE. No D1, no wrangler, no network, no account
// selection. Run it inside the PR that is being released; the entry ships with
// the merge, and `bun run deploy:promote` records it in D1 once traffic actually
// reaches 100%.
//
//   bun tools/photos/bump-version.ts <slug> "<title>"
//   e.g. bun tools/photos/bump-version.ts confetti "Run palette: Raycast confetti easter egg"
//
// slug   becomes the version suffix (aadhar-v<N+1>-<slug>) and the changelog tag.
// title  is the human description shown on /updates and /restore.
//
// ── why this stopped writing D1 ───────────────────────────────────────────
// It used to INSERT first and derive the projection second, which meant the
// changelog could only be logged AFTER the deploy it describes — and since
// /updates, /updates.json and /restore all render from the committed projection
// at BUILD time, publishing that entry then needed a SECOND deploy. Observed
// 2026-08-06: v173 was logged, the live page kept serving v172, and the only way
// out was to ride the projection on an unrelated open PR.
//
// Now the order matches reality. The repo says what a release CLAIMS to be, in
// the PR, where the title can be reviewed like any other prose. D1 says what
// actually SHIPPED, written at 100% by the one thing that knows traffic moved.
// `bun run checkpoints:check` allows the projection to run ahead by a contiguous
// tail of unreleased entries and fails on every other kind of divergence.
//
// ── why this has no REQUIRES ──────────────────────────────────────────────
// The shell version was bash wrapping a python3 heredoc, so it needed an
// interpreter to edit one JSON file. Bun is both, which drops python3 from this
// script's prerequisites entirely. That is the first tool the conversion removes
// rather than relocates.

/** No external binaries at all. Declared explicitly so the checker sees intent. */
export const REQUIRES = [] as const;

type Row = { slug: string; title: string; version: string; vnum: number; ymd: string };

/**
 * Python's `json.dumps(..., indent=2, sort_keys=True)`. The key sort is NOT
 * cosmetic: JSON.stringify preserves insertion order, so without this every
 * entry this script writes would order its keys differently from the 190 the
 * python version wrote, and the file would churn on every release.
 */
export function serialize(rows: Row[]): string {
  const sorted = rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k as keyof Row]])));
  return JSON.stringify(sorted, null, 2) + "\n";
}

export function stage(rows: Row[], slug: string, title: string, ymd: string) {
  if (rows.some((r) => r.slug === slug)) {
    throw new Error(`slug '${slug}' is already in the log — pick another`);
  }
  // The high-water mark comes from the PROJECTION, which is the whole point:
  // this script never reaches D1 to learn what number it is minting, so it runs
  // on a plane, in CI, or on a machine with no Cloudflare credentials at all.
  const vnum = Math.max(0, ...rows.map((r) => r.vnum)) + 1;
  const next = [...rows, { slug, title, version: `aadhar-v${vnum}-${slug}`, vnum, ymd }];
  next.sort((a, b) => a.vnum - b.vnum);
  return { rows: next, vnum, version: `aadhar-v${vnum}-${slug}` };
}

if (import.meta.main) {
  const [slug, title] = process.argv.slice(2);
  if (!slug || !title) {
    console.error('usage: bun tools/photos/bump-version.ts <slug> "<title>"');
    process.exit(1);
  }
  // slug is part of the version string + the changelog tag: lowercase alnum + dashes
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("slug must be lowercase alnum/dashes, e.g. 'sysprop' or 'instant-nav'");
    process.exit(1);
  }
  // The title still reaches D1 through a single-quoted SQL literal at ramp time.
  if (title.includes("'")) {
    console.error("title cannot contain a single quote (')");
    process.exit(1);
  }

  const out = new URL("../../src/worker/checkpoints.json", import.meta.url).pathname;
  const rows: Row[] = JSON.parse(await Bun.file(out).text());
  const ymd = new Date().toISOString().slice(0, 10);

  let staged;
  try {
    staged = stage(rows, slug, title, ymd);
  } catch (e) {
    console.error(`error:  ${(e as Error).message}`);
    process.exit(1);
  }

  await Bun.write(out, serialize(staged.rows));
  console.log(`staged: v${staged.vnum} (${ymd}) as ${staged.version}`);
  console.log(`        ${title}`);
  console.log("next:   commit src/worker/checkpoints.json with the change it describes.");
  console.log("        /updates + /restore show it as soon as that version serves;");
  console.log("        bun run deploy:promote records it in D1 at 100%.");
}
