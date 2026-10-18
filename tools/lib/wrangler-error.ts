// wrangler-error.ts, what a failed wrangler spawn actually said.
//
// A ramp that dies mid-step has to explain itself in the terminal, because the
// alternative is what the first real ramp printed: thirty lines of ChildProcess
// internals around one line of usable error, which is a poor way to learn that
// traffic did not move. So the spawn's stderr is cut to its first few real lines
// and wrangler's colour codes come off.
//
// SGR ONLY (the `m` final), rather than every CSI final, and that is measured
// rather than assumed. Across three failing local wrangler 4.126.0 commands
// (missing entry point, unknown flag, unknown subcommand) all 107 escape
// sequences on stderr were SGR: no cursor moves, no erases, no OSC hyperlinks.
// wrangler colours its diagnostics and does nothing else to the stream, so a
// wider pattern would cover cases wrangler does not produce while giving the
// regex more room to eat real text.

// ESC is built from its char code, so the source holds no raw control byte (a
// raw 0x1b inside a regex literal is invisible in a terminal, a diff and a
// review UI) and needs no no-control-regex suppression.
const ESC = String.fromCharCode(0x1b);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

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
