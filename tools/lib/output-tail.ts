// The last lines a failed command wrote, for a gate's one-line detail.
//
// stderr first, stdout only when stderr is empty. The two copies this replaced
// joined stderr THEN stdout and kept the end, so whatever a tool printed to
// stdout after its error won the slot. wrangler prints its banner to stdout,
// so from 4.163.0 (2026-11-16) to 4.167.0 (2026-11-23) every red wrangler
// canary, and issue #1718, gave the banner as the reason; the real error
// ("Invalid discriminator value ... at worker.env.ANALYTICS.type") sat on
// stderr above it. Blank lines and ANSI colour codes are dropped because they
// count against the line budget and show up as noise in an issue table.
//
// The trade: a tool that warns on stderr and fails on stdout now shows its
// warnings. tsc, the one gate tool known to report on stdout, writes nothing
// to stderr, so it takes the fallback.

import { stripVTControlCharacters } from "node:util";

const visibleLines = (text: string | null | undefined): string[] =>
  stripVTControlCharacters(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function outputTail(out: { stdout?: string | null; stderr?: string | null }, lines: number): string {
  const stderr = visibleLines(out.stderr);
  return (stderr.length > 0 ? stderr : visibleLines(out.stdout)).slice(-lines).join(" ");
}
