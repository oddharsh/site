// Run TypeScript and keep each runtime program's owned diagnostics. Tools and
// tests also import Worker code, which is checked against its own globals by a
// separate program. Configuration/process failures and failed file enumeration
// always stop the check; each caller enforces its own coverage floor.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// The two file sets a program defines, which are NOT the same set.
//
// `covered` is what tsc ends up holding: the include globs plus everything
// reached from them by import. `named` is what the globs alone match.
// serendipity.ts sat in the gap for months (gotcha in check-ts-coverage.ts's
// header, fixed in #882), and the gap is invisible to tsc by construction,
// since resolving those imports is tsc doing its job correctly.
//
// It matters because tsgolint, which oxlint's type-aware pass runs on,
// discovers a config PER FILE by walking up and asking which one NAMES it. A
// file in the gap is type-checked correctly and linted against a default
// DOM-lib program, and reports zero findings while doing it.
//
// `--showConfig` is what computes `named`, rather than a glob matcher written
// here: it expands the includes with tsc's own engine, so `exclude`, the
// default exclusions and the extends chain all apply. Neither call resolves a
// type, so both are cheap.
export function programFileSets({ repo, tsc, configs, cwd = repo }) {
  // Annotated rather than inferred: callers spread these, and an untyped Set
  // hands them `unknown[]`. A real annotation and not JSDoc, because this is a
  // .ts file where a `@type` tag is inert (gotcha 42). Both are erasable.
  const covered = new Set<string>();
  const named = new Set<string>();
  for (const config of configs) {
    // tsc can print every owned path before rejecting a config, and a failed
    // census is not coverage evidence even when another program holds the files.
    const listing = execFileSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], { encoding: "utf8", cwd });
    for (const line of listing.split("\n")) {
      if (line.startsWith(`${repo}/`)) covered.add(line.slice(repo.length + 1));
    }
    // Paths come out relative to the CONFIG'S OWN directory, which is config/
    // for all ten of this repo's programs and is not the repo root.
    const shown = JSON.parse(execFileSync(process.execPath, [tsc, "-p", config, "--showConfig"], { encoding: "utf8", cwd }));
    for (const file of shown.files ?? []) {
      named.add(relative(repo, resolve(dirname(config), file)));
    }
  }
  return { covered, named };
}
export function runScopedTsc({ repo, tsc, config, owns, label, cwd = repo }) {
  const args = [tsc, "-p", config, "--pretty", "false"];
  let out = "";
  let failed = false;
  try {
    out = execFileSync(process.execPath, args, { encoding: "utf8", cwd });
  } catch (e) {
    failed = true;
    out = `${e.stdout || ""}\n${e.stderr || ""}`;
  }

  const lines = out.split("\n").filter((l) => /error TS\d+/.test(l));
  // Only diagnostics with a file location can belong to another runtime's
  // source. Global errors (such as missing standard types) and compiler crashes
  // must stop the check before the ownership filter can discard them.
  if ((failed && !lines.length) || lines.some((l) => !/^.+\(\d+,\d+\): error TS\d+:/.test(l))) {
    console.error(`${label}: tsc could not run the program:\n${out.trim().slice(-600)}`);
    process.exit(1);
  }

  const owned = (path) => owns.some((prefix) => path.startsWith(prefix));
  const mine = lines.filter((l) => owned(l));

  // Only a successful enumeration establishes which files the program held.
  // tsc can print a partial file list alongside a rejected compiler option;
  // accepting it would let that config error hide in the foreign bucket while
  // the owned-file floor still passes.
  let listing = "";
  try {
    listing = execFileSync(process.execPath, [...args, "--listFilesOnly"], { encoding: "utf8", cwd });
  } catch (e) {
    const detail = `${e.stdout || ""}\n${e.stderr || ""}`;
    console.error(`${label}: tsc could not enumerate the program:\n${detail.trim().slice(0, 600)}`);
    process.exit(1);
  }
  const listed = listing
    .split("\n")
    .map((f) => (f.startsWith(`${repo}/`) ? f.slice(repo.length + 1) : f))
    .filter((f) => f && !f.includes("node_modules/"));

  const byFile = new Map();
  for (const l of mine) {
    const f = l.slice(0, l.indexOf("("));
    byFile.set(f, (byFile.get(f) || 0) + 1);
  }

  return { mine, foreign: lines.length - mine.length, listed, ownedFiles: listed.filter(owned), byFile };
}

// Per-file counts must match the recorded baseline. Improvements need an
// explicit update so a later regression cannot hide in the old allowance.
export function ratchet({ baselinePath, byFile, updateCommand, update = false }) {
  // Sorted by filename so the baseline file stays diffable. The comparator is
  // explicit because the type-aware lint requires one, and because a default
  // sort on [file, count] pairs compares them stringified, which is only
  // accidentally the same order.
  const actual = Object.fromEntries([...byFile].sort((a, b) => a[0].localeCompare(b[0])));

  if (update) {
    writeFileSync(baselinePath, `${JSON.stringify({ files: actual }, null, 2)}\n`);
    return { rewritten: true, problems: [] };
  }

  const declared = JSON.parse(readFileSync(baselinePath, "utf8"));
  const problems: string[] = [];
  for (const [f, n] of Object.entries(actual)) {
    const was = declared.files[f];
    if (was === undefined) problems.push(`${f}: ${n} error(s), and this file is not in the baseline`);
    else if (!Number.isSafeInteger(was) || was < 1) problems.push(`${f}: baseline count must be a positive integer`);
    else if (n > was) problems.push(`${f}: ${n} error(s), up from ${was}`);
    else if (n < was) problems.push(`${f}: ${n} error(s), DOWN from ${was} — run \`${updateCommand}\``);
  }
  for (const f of Object.keys(declared.files)) {
    if (!(f in actual)) problems.push(`${f}: now clean — run \`${updateCommand}\` and drop it`);
  }
  return { rewritten: false, problems };
}
