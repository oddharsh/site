// wrangler-error.ts, what a failed wrangler spawn actually said.
//
// A ramp that dies mid-step has to explain itself in the terminal, because the
// alternative is what the first real ramp printed: thirty lines of ChildProcess
// internals around one line of usable error, which is a poor way to learn that
// traffic did not move. So the spawn's stderr is cut to its first few real lines
// and wrangler's colour codes come off.
//
// THE ESCAPE IS SPELLED `\u001b` RATHER THAN WRITTEN AS THE BYTE, and that
// spelling is the only thing about this pattern that changed on 2026-08-27. It
// shipped in #224 as a raw 0x1b character sitting inside the regex literal,
// which is correct and is invisible in every rendering of the file: a terminal,
// a diff, a review UI and a paste all show `/\[[0-9;]*m/`, so the pattern reads
// as though it matches the bracket and leaves the ESC that introduces it.
//
// It reads that way convincingly enough to have been reported as a bug, and the
// repair that reading implies is a real regression. Putting an escape in FRONT
// of the byte already there gives `\u001b\u001b\[`, which matches nothing, so every
// colour code survives into the one message a failed ramp prints. Measured
// against real wrangler stderr carrying 7 codes: the committed pattern leaves 0
// escapes and that "repair" leaves all 7. Leave this spelled out.
//
// The no-control-regex suppression is for the escape and is load-bearing in
// either spelling: delete it and `bun run lint` fails on this line.
//
// SGR ONLY (the `m` final), rather than every CSI final, and that is measured
// rather than assumed. Across three failing local wrangler 4.126.0 commands
// (missing entry point, unknown flag, unknown subcommand) all 107 escape
// sequences on stderr were SGR: no cursor moves, no erases, no OSC hyperlinks.
// wrangler colours its diagnostics and does nothing else to the stream, so a
// wider pattern would cover cases wrangler does not produce while giving the
// regex more room to eat real text.

// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/**
 * The readable lines of a failed wrangler spawn, capped so one chatty
 * failure cannot bury the ramp's own message under it.
 */
export function wranglerErrorLines(e: { stderr?: string; stdout?: string; message?: string }): string[] {
  return String(e?.stderr || e?.stdout || e?.message || "")
    .replace(ANSI_SGR, "")
    .split("\n").map((l) => l.trim()).filter(Boolean)
    // wrangler's own last line names the log file it wrote, which is where it
    // put the error rather than what the error was.
    .filter((l) => !l.startsWith("🪵"))
    .slice(0, 6);
}
