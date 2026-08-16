#!/usr/bin/env node
// Compare two browser-lab recordings. Exit status is part of the interface:
//   0 promote, 1 reject/error, 2 inconclusive.
// A promoted browser result is still only one gate; the experiment must also
// pass the repository's correctness suite and deterministic wire-size diff.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareReports, renderComparison } from "./lib/perf-research.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const [command, basePath, candidatePath, ...rest] = argv;
const value = (flag) => {
  const index = rest.indexOf(flag);
  return index >= 0 ? rest[index + 1] : "";
};

if (command !== "compare" || !basePath || !candidatePath) {
  console.error(
    "usage: node scripts/perf-research.mjs compare <base.json> <candidate.json> " +
    "[--out report.md] [--json decision.json]"
  );
  process.exit(1);
}

try {
  const [base, candidate] = await Promise.all([
    readFile(basePath, "utf8").then(JSON.parse),
    readFile(candidatePath, "utf8").then(JSON.parse),
  ]);
  const result = compareReports(base, candidate);
  const markdown = renderComparison(result);
  const outPath = value("--out");
  const jsonPath = value("--json");
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown);
  }
  if (jsonPath) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(markdown);
  process.exitCode = result.decision === "promote" ? 0 : result.decision === "reject" ? 1 : 2;
} catch (error) {
  console.error(`perf-research: ${error.message}`);
  process.exitCode = 1;
}
