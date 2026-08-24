// tsc-scope.mjs — run a tsc program and split its diagnostics into the ones it
// can legitimately judge and the ones it cannot.
//
// THE PROBLEM THIS SOLVES, stated once so neither caller has to. A program is
// only as accurate as the globals it declares, and several programs here hold
// files from two runtimes at once: tools/ imports the Worker, and the two
// node-runtime test suites import the Worker they exercise. Those imported
// modules get checked against the wrong global scope, which produces
// diagnostics that are missing declarations rather than findings
// (`RequestInitCfProperties` not found, `cf` does not exist in RequestInit,
// `innerHTML` on Node). Every one of them passes in the program whose globals
// match, and reporting them would train everyone to ignore the check.
//
// So a caller declares which path prefixes it OWNS, and gets those diagnostics
// alone. The rest are counted and named in the summary rather than hidden.
//
// THE FLOOR IS THE HONEST HALF, and it is the caller's job rather than this
// module's, because the two callers can afford different rigour: check-tool-types
// wants a count over 123 files, and check-test-types can compare the program
// against the directory exactly. What this module guarantees is that `listed`
// is real, so a filter that scanned nothing cannot read as a clean run. That is
// this repo's most-repeated failure and it has its own precedent in build.mjs's
// route invariant.
import { execFileSync } from "node:child_process";

/**
 * @param {object} opts
 * @param {string} opts.repo      absolute repo root
 * @param {string} opts.tsc       absolute path to the tsc binary
 * @param {string} opts.config    absolute path to the tsconfig
 * @param {string[]} opts.owns    repo-relative path prefixes this caller judges
 * @param {string} opts.label     the caller's name, used in failure text
 * @param {string} [opts.cwd]     working directory for tsc (defaults to repo)
 */
export function runScopedTsc({ repo, tsc, config, owns, label, cwd = repo }) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [tsc, "-p", config], { encoding: "utf8", cwd });
  } catch (e) {
    out = `${e.stdout || ""}\n${e.stderr || ""}`;
  }

  const lines = out.split("\n").filter((l) => /error TS\d+/.test(l));
  // A TS5xxx with no diagnostics means tsc rejected the PROGRAM (a bad option, a
  // config it could not read), which reports as clean under any filter.
  if (out.includes("error TS5") && !lines.length) {
    console.error(`${label}: tsc could not run the program:\n${out.trim().slice(-600)}`);
    process.exit(1);
  }

  const owned = (path) => owns.some((prefix) => path.startsWith(prefix));
  const mine = lines.filter((l) => owned(l));

  // The files the program actually held, repo-relative. Callers floor on this.
  //
  // The try is load-bearing rather than defensive. tsc EXITS NON-ZERO with
  // TS18003 when a config's include matches nothing, so a glob that has stopped
  // matching throws here, and an unguarded call crashes with a node stack
  // instead of reaching the caller's floor. That was measured against the floor
  // control on 2026-08-23: the check died rather than saying which directory it
  // had lost. Falling back to an empty listing hands the floor a zero, which is
  // exactly the case it exists to report.
  let listing = "";
  try {
    listing = execFileSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], { encoding: "utf8", cwd });
  } catch (e) {
    listing = String(e.stdout || "");
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
