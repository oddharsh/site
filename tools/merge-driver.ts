// The merge driver for this repository's MACHINE-OWNED files.
//
// Several agents merge here through the day, so `main` moves under every open
// branch. Replaying the last 80 commits (cherry-pick each onto the parent of the
// one before it, which is exactly "my branch was cut before that landed") gives
// 11 conflicts in 78 adjacent pairs, about 14%. What those conflicts ARE is the
// reason this file exists, and it is not what it looks like from the terminal:
// 22 of the 44 conflicted regions are ADD/ADD, two branches each inserting a
// line into the same block (a new `scripts` entry, a new `derivations` entry),
// and exactly ONE of the 11 was a version bump in the ordinary sense.
//
// THREE CLASSES, and they want different answers.
//
//   json   package.json, config/derivations.json. A structural three-way merge
//          over the PARSED value: a key only one side touched is taken, a key
//          both sides moved is still a conflict. This is the add/add class, the
//          biggest one, and a text merge fails it only because the lines happen
//          to be adjacent.
//
//   pin    config/bun-pin.json. Resolve to the NEWER pin and record that its
//          gate is owed, because this repository's model is that a pin advances
//          only after its gates pass on that candidate (bump-bun-pin.ts).
//          Picking a side without re-running the gate adopts a pin vetted
//          against a different tree.
//
//   regen  bun.lock, lens-reader/bun.lock, config/derivations.lock.json. The
//          merged TEXT is never the answer. These are functions of other files,
//          so the resolution is to re-run the generator once the inputs are
//          final, which is strictly after this driver has run (git resolves
//          paths one at a time, and `bun.lock` sorts before `package.json`).
//          The driver therefore parks a defined side and records the path;
//          merge-finish.ts drains it.
//
// WHY A REGENERATING DRIVER RATHER THAN A "TAKE THEIRS" ONE. %A and %B INVERT
// between merge and rebase, measured rather than assumed:
//
//     git merge  upstream  ->  ours=FEATURE   theirs=UPSTREAM
//     git rebase upstream  ->  ours=UPSTREAM  theirs=FEATURE
//
// So a driver written as "take theirs" silently takes the opposite side
// depending on how the branch was integrated, and both paths are used here
// (dependabot-relock.yml rebases; local work does either). Every mode below is
// either side-independent by construction (`pin` takes the newer, `json` merges
// the values) or asks which side is the MAINLINE explicitly, never which side
// git happened to label ours.
//
// THE ROUND-TRIP GUARD IS THE LOAD-BEARING SAFETY PROPERTY. `json` and `pin`
// rewrite the whole file from a parsed value, so a serializer that disagrees
// with the file's existing formatting by one space would churn every line of
// package.json and re-mint nothing useful. Before merging anything, each mode
// re-serializes the UNMODIFIED inputs and requires them back byte for byte. A
// file this module cannot reproduce is refused and left as a conflict, which
// is the one outcome that is always safe.
//
// Git's contract: argv is <mode> %O %A %B %P, the result goes to %A, exit 0
// means resolved and non-zero leaves the conflict standing.


import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, basePath, oursPath, theirsPath, markerSizeArg, repoPath = "(unknown)"] = process.argv.slice(2);
const markerSize = Number(markerSizeArg) || 7;

/** The value space JSON.parse actually produces, named so the rest is typed. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function gitDir(): string {
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
}

// WHICH SIDE IS THE MAINLINE, measured rather than reasoned about. The obvious
// detector is wrong: MERGE_HEAD and CHERRY_PICK_HEAD DO NOT EXIST YET when the
// driver runs, so a merge and a cherry-pick look identical by marker file while
// having OPPOSITE orientations. Probed on this git, one driver, three verbs:
//
//   verb          GIT_REFLOG_ACTION   markers        %A (ours)   %B (theirs)
//   merge         "merge upstream"    none           FEATURE     UPSTREAM
//   rebase        unset               rebase-merge   UPSTREAM    FEATURE
//   cherry-pick   unset               none           UPSTREAM    FEATURE
//
// Merge is the odd one out and it is the one carrying a positive signal, so that
// is what this reads. Everything else REPLAYS a commit onto HEAD, which puts the
// mainline on %A.
//
// Only the PIN_KEYS rule below depends on getting this right; every other mode
// is side-independent by construction, which is deliberate. When it is wrong it
// is wrong LOUDLY rather than silently: the driver names the pin it took and
// records the gate that pin owes, so the resolution arrives with its own
// evidence attached.
//
// A rebase run with the --apply backend never calls a merge driver at all,
// because it applies patches rather than merging trees. A branch rebased that
// way meets these conflicts by hand exactly as before.
function mainlineIsOurs(): boolean {
  return !/^(merge|pull)\b/.test(process.env.GIT_REFLOG_ACTION ?? "");
}

function pending(path: string, note: string) {
  appendFileSync(join(gitDir(), "site-merge-pending"), `${path}\t${note}\n`);
}

function say(line: string) {
  process.stderr.write(`merge-driver: ${line}\n`);
}

/**
 * Hand the file back to git's own three-way text merge and report WHAT THAT
 * SAID, which is the whole subtlety: a driver REPLACES the default merge for
 * every path it claims, including the many that the default resolves cleanly.
 *
 * Returning 1 unconditionally here is therefore not "declining to help", it is
 * manufacturing conflicts. Measured: claiming CLAUDE.md and refusing with a
 * hard 1 took the replay from 11 conflicted pairs to 24, because the prose
 * driver ran on every three-way merge of that file rather than only on the ones
 * that were already conflicts.
 *
 * git merge-file does exactly the default merge, in place, and exits with the
 * number of conflicting hunks, so 0 means it merged cleanly and this path is a
 * true no-op. That also fixes the second half: a custom driver that exits
 * non-zero leaves %A as it found it and git does NOT write markers on its
 * behalf, so a refusal without this call left the mainline side sitting clean in
 * the working tree where staging it would take one side blind.
 */
function fallBackToTextMerge(why: string): number {
  say(`${repoPath}: ${why}`);
  try {
    execFileSync(
      "git",
      [
        "merge-file",
        `--marker-size=${markerSize}`,
        "-L",
        "HEAD",
        "-L",
        "base",
        "-L",
        "incoming",
        oursPath,
        basePath,
        theirsPath,
      ],
      { stdio: "ignore" },
    );
    return 0;
  } catch {
    // merge-file exits with the conflict count, so any throw here is a genuine
    // conflict that now carries ordinary markers.
    return 1;
  }
}

// ── formatting-preserving JSON ───────────────────────────────────────────────

function detectIndent(text: string): string {
  const m = text.match(/\n([ \t]+)"/);
  return m ? m[1] : "  ";
}

function serialize(value: Json, indent: string, trailingNewline: boolean): string {
  return JSON.stringify(value, null, indent) + (trailingNewline ? "\n" : "");
}

type Parsed = { ok: true; value: Json; indent: string; nl: boolean } | { ok: false };

/**
 * Parse at the boundary, and refuse any file this module cannot reproduce byte
 * for byte. Without the round trip the driver would quietly reformat
 * package.json on the first conflict it resolved, which would re-mint nothing
 * useful and churn every line.
 */
function parseExact(text: string): Parsed {
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return { ok: false };
  }
  const indent = detectIndent(text);
  const nl = text.endsWith("\n");
  if (serialize(value, indent, nl) !== text) return { ok: false };
  return { ok: true, value, indent, nl };
}

const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** A reference rather than a primitive, tested without narrowing a representation. */
const isReference = (v: Json | undefined) => Object(v) === v;
const isPlainObject = (v: Json | undefined): v is { [key: string]: Json } =>
  isReference(v) && !Array.isArray(v);
/** A JSON string, tested by value: only a string round-trips through String(). */
const asText = (v: Json | undefined): string | null => {
  if (v === null || v === undefined || isPlainObject(v) || Array.isArray(v)) return null;
  return v === String(v) ? String(v) : null;
};

// Keys where BOTH sides moving the value is still resolvable, because the value
// carries no order a merge could read and provenance settles it instead.
//
// devDependencies.wrangler is a pkg.pr.new COMMIT of workers-sdk main. Two git
// shas have no newer/older relation in the string, so "take the newer" is
// undecidable here in a way it is not for config/bun-pin.json, whose canary pins
// carry a date. What IS decidable is which side is PROPOSING the pin: a branch
// that did not touch it agrees with base and never reaches this code, so a
// genuine two-sided move means the branch being integrated is advancing past a
// pin main already holds, which is exactly what the nightly wrangler-pin job
// produces when two of its PRs are open at once.
//
// Taking the proposal and RECORDING THE GATE is the only honest form of this. A
// pin advances here after canary:wrangler passes on that candidate, and the gate
// that ran on the unrebased branch ran against a different tree.
const PIN_KEYS = new Set(["devDependencies.wrangler"]);
const pinGates: string[] = [];

/** An array of objects each carrying a unique string id is a registry, not a list. */
function idKeyed(v: Json | undefined): Map<string, Json> | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = new Map<string, Json>();
  for (const el of v) {
    if (!isPlainObject(el)) return null;
    const id = asText(el.id);
    if (id === null || out.has(id)) return null;
    out.set(id, el);
  }
  return out;
}

const CONFLICT = Symbol("conflict");

/**
 * Three-way merge over parsed values. A key one side moved is taken; a key both
 * sides moved to different values stays a real disagreement. `mainFirst` only
 * decides the order NEW keys are appended in, never who wins.
 */
function merge3(
  base: Json | undefined,
  ours: Json,
  theirs: Json,
  mainFirst: boolean,
  path = "",
): Json | typeof CONFLICT {
  if (PIN_KEYS.has(path) && !same(ours, theirs)) {
    const chosen = mainFirst ? theirs : ours;
    pinGates.push(`${path} -> ${asText(chosen) ?? JSON.stringify(chosen)}`);
    return chosen;
  }
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;

  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const [first, second] = mainFirst ? [ours, theirs] : [theirs, ours];
    const order = [...Object.keys(base), ...Object.keys(first), ...Object.keys(second)];
    const out: { [key: string]: Json } = {};
    const done = new Set<string>();
    for (const key of order) {
      if (done.has(key)) continue;
      done.add(key);
      const has = (o: { [key: string]: Json }) => Object.prototype.hasOwnProperty.call(o, key);
      // A key deleted on one side and untouched on the other is a deletion.
      if (!has(ours) && !has(theirs)) continue;
      if (!has(ours)) {
        if (has(base) && !same(base[key], theirs[key])) return CONFLICT;
        if (!has(base)) out[key] = theirs[key];
        continue;
      }
      if (!has(theirs)) {
        if (has(base) && !same(base[key], ours[key])) return CONFLICT;
        if (!has(base)) out[key] = ours[key];
        continue;
      }
      const merged = merge3(
        has(base) ? base[key] : undefined,
        ours[key],
        theirs[key],
        mainFirst,
        path ? `${path}.${key}` : key,
      );
      if (merged === CONFLICT) return CONFLICT;
      out[key] = merged;
    }
    return out;
  }

  const [bm, om, tm] = [idKeyed(base), idKeyed(ours), idKeyed(theirs)];
  if (bm && om && tm) {
    const [first, second] = mainFirst ? [om, tm] : [tm, om];
    const order = [...bm.keys(), ...first.keys(), ...second.keys()];
    const out: Json[] = [];
    const done = new Set<string>();
    for (const id of order) {
      if (done.has(id)) continue;
      done.add(id);
      const o = om.get(id);
      const t = tm.get(id);
      if (o === undefined && t === undefined) continue;
      if (o === undefined) {
        if (bm.has(id) && !same(bm.get(id), t)) return CONFLICT;
        if (!bm.has(id) && t !== undefined) out.push(t);
        continue;
      }
      if (t === undefined) {
        if (bm.has(id) && !same(bm.get(id), o)) return CONFLICT;
        if (!bm.has(id)) out.push(o);
        continue;
      }
      const merged = merge3(bm.get(id), o, t, mainFirst, path ? `${path}[${id}]` : id);
      if (merged === CONFLICT) return CONFLICT;
      out.push(merged);
    }
    return out;
  }

  return CONFLICT;
}

// ── modes ────────────────────────────────────────────────────────────────────

function readAll() {
  return {
    base: readFileSync(basePath, "utf8"),
    ours: readFileSync(oursPath, "utf8"),
    theirs: readFileSync(theirsPath, "utf8"),
  };
}

function runJson(): number {
  const text = readAll();
  const b = parseExact(text.base);
  const o = parseExact(text.ours);
  const t = parseExact(text.theirs);
  if (!b.ok || !o.ok || !t.ok) {
    return fallBackToTextMerge("not reproducible by this serializer, leaving the conflict.");
  }
  const merged = merge3(b.value, o.value, t.value, mainlineIsOurs());
  if (merged === CONFLICT) {
    return fallBackToTextMerge("both sides moved the same key, leaving the conflict.");
  }
  writeFileSync(oursPath, serialize(merged, o.indent, o.nl));
  say(`${repoPath}: merged structurally.`);
  // package.json decides bun.lock, and a lockfile that did not itself conflict
  // now describes a package.json neither side wrote. Mark it regardless: bun
  // install is a no-op when nothing moved.
  if (repoPath === "package.json") pending("bun.lock", "bun install");
  for (const gate of pinGates) {
    say(`${repoPath}: took the proposed pin ${gate}.`);
    pending(repoPath, `bun run canary:wrangler   (the gate is owed on ${gate})`);
  }
  return 0;
}

async function runPin(): Promise<number> {
  const text = readAll();
  const o = parseExact(text.ours);
  const t = parseExact(text.theirs);
  if (!o.ok || !t.ok) {
    return fallBackToTextMerge("not reproducible by this serializer, leaving the conflict.");
  }
  if (!isPlainObject(o.value) || !isPlainObject(t.value)) {
    return fallBackToTextMerge("not a JSON object on both sides, leaving the conflict.");
  }
  const ourPin = asText(o.value.bun);
  const theirPin = asText(t.value.bun);
  if (ourPin === null || theirPin === null) {
    return fallBackToTextMerge("no string bun pin on both sides, leaving the conflict.");
  }
  if (ourPin === theirPin) return 0;

  // Side-independent by construction, so the ours/theirs inversion cannot reach it.
  let cmp: number;
  try {
    const { compareVersions, channelOf } = await import("./lib/bun-pin.ts");
    if (channelOf(ourPin) !== channelOf(theirPin)) {
      return fallBackToTextMerge("the two sides are on different channels, leaving the conflict.");
    }
    cmp = compareVersions(ourPin, theirPin);
  } catch {
    return fallBackToTextMerge("could not compare the pins, leaving the conflict.");
  }
  const winner = cmp >= 0 ? o : t;
  const chosen = cmp >= 0 ? ourPin : theirPin;
  const other = cmp >= 0 ? theirPin : ourPin;
  // Keep the winning side's prose WHOLE rather than merging two comment blocks.
  writeFileSync(oursPath, serialize(winner.value, winner.indent, winner.nl));
  say(`${repoPath}: took the newer pin ${chosen} over ${other}.`);
  pending(repoPath, `bun run bun:pin   (the gate is owed on ${chosen})`);
  return 0;
}

function runRegen(): number {
  const text = readAll();
  // Park the mainline side. Which one that is depends on the verb, never on the
  // ours/theirs labels, and it barely matters: merge-finish.ts overwrites this.
  writeFileSync(oursPath, mainlineIsOurs() ? text.ours : text.theirs);
  const how =
    repoPath === "config/derivations.lock.json"
      ? "bun run derive:check   (NOT automatic: re-recording vouches for artifacts)"
      : repoPath.endsWith("bun.lock")
        ? `bun install${repoPath.includes("/") ? ` in ${repoPath.replace(/\/bun\.lock$/, "")}` : ""}`
        : "regenerate by hand";
  pending(repoPath, how);
  say(`${repoPath}: derived file, parked pending regeneration (${how}).`);
  return 0;
}


// ── prose ────────────────────────────────────────────────────────────────────
//
// A THREE-WAY MERGE AT PARAGRAPH GRANULARITY, which unions only where unioning
// is safe. The granularity and the one exception are both measured.
//
// Half of every conflicted region in this repository is add/add, two branches
// each inserting a block in the same place, and for CLAUDE.md and the runbooks
// that is two people documenting two different things. Git's built-in
// `merge=union` resolves those by concatenating both sides of a conflicting
// hunk, which is right for an insertion and WRONG for an edit, and it works on
// lines so it cannot tell them apart. The case that settled it, from the real
// history: one side had
//
//   # First run (2026-09-14) found margin-trim live in Canary 155
//
// and the other had that sentence WITH a full stop plus 21 lines extending the
// section. Line union keeps both, so the sentence lands in CLAUDE.md twice in a
// row differing by one character, silently. A duplicate-line counter scores that
// zero, because the lines are not identical.
//
// So the rule is ordinary diff3 over blocks: a chunk only one side moved is
// taken, a chunk both sides moved the same way is taken once, and a chunk both
// sides moved differently is a conflict. THE ONE EXCEPTION is a chunk whose BASE
// IS EMPTY, which means neither side edited anything and both inserted. That is
// the add/add class and the only place both sides are emitted.
//
// A PURE-INSERTION GATE WAS TRIED FIRST AND IS TOO STRICT TO EVER FIRE. It asked
// whether base's blocks were still a subsequence of each side's, which is true
// only if nothing anywhere in the file was edited. Measured against the eight
// real diverged branches in this repository, it resolved 0 of 4 prose conflicts,
// because CLAUDE.md is rewritten in place constantly rather than appended to.
//
// A block carries its trailing blank lines, so rejoining is concatenation and no
// formatting is invented. That is asserted rather than assumed: a file whose
// blocks do not rejoin to the original bytes is refused, the same round-trip
// rule the JSON modes use.

/**
 * Blocks: blank-line paragraphs, and additionally one per LIST ITEM, HEADING
 * and TABLE ROW, with fenced code kept whole.
 *
 * The list-item rule is what makes this useful rather than merely safe.
 * Markdown puts no blank line between bullets, so a blank-line splitter reads a
 * 30-item list as ONE block and any two branches touching that list collide.
 * Measured against the real diverged branches here, that granularity resolved 0
 * of 4 prose conflicts; the DEPENDENCIES.md case is main bumping
 * `Oxlint 1.83.0 -> 1.84.0` in one bullet while a branch adds a different bullet
 * beside it, which is the version-bump-next-to-an-insertion shape this whole
 * change exists for. Per item, that is a one-sided edit and a one-sided
 * insertion, and diff3 takes both.
 *
 * Splitting finer is safe by construction: a block is still a run of whole
 * lines, so rejoining is concatenation either way, and finer blocks only ever
 * give the merge MORE places where a chunk is one-sided. The round trip is
 * asserted rather than trusted.
 */
function blocks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length > 0) out.push(current.join("\n"));
    current = [];
  };
  const startsBlock = (line: string) =>
    /^\s*([-*+]|\d+[.)])\s/.test(line) || /^#{1,6}\s/.test(line) || /^\s*\|/.test(line);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null && mark) fence = mark[1][0];
    else if (fence !== null && mark && mark[1][0] === fence) fence = null;

    // A new item, heading or row opens its own block, but only when something is
    // already being accumulated and we are not inside a fence.
    if (fence === null && current.length > 0 && startsBlock(line) && current.at(-1)?.trim() !== "") {
      flush();
    }
    current.push(line);
    if (fence === null && line.trim() === "" && (i + 1 >= lines.length || lines[i + 1].trim() !== "")) {
      flush();
    }
  }
  flush();
  return out;
}

const joinBlocks = (parts: string[]) => parts.join("\n");

/** Longest common subsequence as a base-index to side-index map. */
function matchMap(base: string[], side: string[]): Map<number, number> {
  const n = base.length;
  const m = side.length;
  const table = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        base[i] === side[j]
          ? table[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + (j + 1)]);
    }
  }
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === side[j]) {
      out.set(i, j);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + (j + 1)]) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * Where each side inserted within a chunk, keyed by how many base blocks precede
 * it, or null when that side did anything other than insert.
 */
function insertionsWithin(base: string[], side: string[]): Map<number, string[]> | null {
  const inserts = new Map<number, string[]>();
  let b = 0;
  for (const block of side) {
    if (b < base.length && base[b] === block) {
      b += 1;
      continue;
    }
    const at = inserts.get(b) ?? [];
    at.push(block);
    inserts.set(b, at);
  }
  return b === base.length ? inserts : null;
}

/**
 * Both sides changed this chunk, but possibly in ways that do not touch each
 * other: one side only INSERTED blocks while the other only edited blocks that
 * the first left alone. That is the common shape here and the one the original
 * question was about, measured on docs/DEPENDENCIES.md: main bumped
 * `Oxlint 1.83.0 -> 1.84.0` in one bullet while a branch added a different
 * bullet immediately above it. Per block those are disjoint, and plain diff3
 * still calls the chunk contested because both sides changed SOMETHING in it.
 *
 * So when one side is pure insertion against the chunk's base, lay its new
 * blocks back into the other side's text at the same anchors. Null when that
 * does not hold, which keeps a real two-sided edit of one block a conflict.
 */
function combineChunk(base: string[], inserter: string[], editor: string[]): string[] | null {
  const inserts = insertionsWithin(base, inserter);
  if (!inserts) return null;
  const kept = matchMap(base, editor);
  const out: string[] = [];
  let e = 0;
  for (let i = 0; i <= base.length; i += 1) {
    for (const block of inserts.get(i) ?? []) out.push(block);
    if (i === base.length) break;
    const target = kept.get(i);
    if (target === undefined) continue;
    while (e <= target) {
      out.push(editor[e]);
      e += 1;
    }
  }
  while (e < editor.length) {
    out.push(editor[e]);
    e += 1;
  }
  return out;
}

const sameChunk = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function runProse(): number {
  const text = readAll();
  const base = blocks(text.base);
  const ours = blocks(text.ours);
  const theirs = blocks(text.theirs);
  for (const [parts, original] of [
    [base, text.base],
    [ours, text.ours],
    [theirs, text.theirs],
  ] as const) {
    if (joinBlocks(parts) !== original) {
      return fallBackToTextMerge("blocks do not rejoin to the original bytes, leaving it to the text merge.");
    }
  }

  const mo = matchMap(base, ours);
  const mt = matchMap(base, theirs);
  const anchors = [...mo.keys()].filter((i) => mt.has(i)).sort((a, b) => a - b);

  const mainFirst = mainlineIsOurs();
  const merged: string[] = [];
  let unioned = 0;
  let disjoint = 0;
  let taken = 0;
  let prevB = 0;
  let prevO = 0;
  let prevT = 0;

  for (const anchor of [...anchors, base.length]) {
    const isEnd = anchor === base.length;
    const endO = isEnd ? ours.length : (mo.get(anchor) as number);
    const endT = isEnd ? theirs.length : (mt.get(anchor) as number);
    const baseChunk = base.slice(prevB, anchor);
    const ourChunk = ours.slice(prevO, endO);
    const theirChunk = theirs.slice(prevT, endT);

    if (sameChunk(ourChunk, theirChunk)) merged.push(...ourChunk);
    else if (sameChunk(ourChunk, baseChunk)) {
      merged.push(...theirChunk);
      taken += 1;
    } else if (sameChunk(theirChunk, baseChunk)) {
      merged.push(...ourChunk);
      taken += 1;
    } else if (baseChunk.length === 0) {
      // Neither side edited anything here; both inserted. This is the only place
      // both sides are emitted, and it is what a union buys.
      const [first, second] = mainFirst ? [ourChunk, theirChunk] : [theirChunk, ourChunk];
      const seen = new Set<string>();
      for (const block of [...first, ...second]) {
        if (seen.has(block)) continue;
        seen.add(block);
        merged.push(block);
      }
      unioned += 1;
    } else {
      const [inserterFirst, editorFirst] = [
        combineChunk(baseChunk, theirChunk, ourChunk),
        combineChunk(baseChunk, ourChunk, theirChunk),
      ];
      const combined = inserterFirst ?? editorFirst;
      if (!combined) {
        return fallBackToTextMerge("a block was edited on both sides, leaving it to the text merge.");
      }
      merged.push(...combined);
      disjoint += 1;
    }

    if (!isEnd) {
      merged.push(base[anchor]);
      prevB = anchor + 1;
      prevO = endO + 1;
      prevT = endT + 1;
    }
  }

  writeFileSync(oursPath, joinBlocks(merged));
  say(`${repoPath}: merged at block level (${unioned} add/add unioned, ${disjoint} disjoint chunk(s) combined, ${taken} one-sided).`);
  return 0;
}

const run = { json: runJson, pin: runPin, regen: runRegen, prose: runProse }[mode ?? ""];
if (!run) {
  say(`unknown mode ${JSON.stringify(mode)}; expected one of json, pin, regen, prose.`);
  process.exit(1);
}
process.exit(await run());
