// browser-channel.ts — which Chrome a tool drives.
//
// Every Playwright probe in tools/ used to launch `channel: "chrome"` as a
// literal, nine of them, so the only browser any measurement here could see
// was the one stable Chrome on the workstation. Chrome Canary sat two majors
// ahead in /Applications with nothing pointing at it, which is how the
// WebMCP API drifted under webmcp.js (registerTool going async, the registry
// moving from document to navigator, #790) and was found from the wrong side:
// after the rename shipped rather than the week it landed in Canary.
//
// ONE environment variable, read in one place. `CHROME_CHANNEL` names any
// channel Playwright's registry knows (chrome, chrome-beta, chrome-canary,
// chrome-beta, msedge-dev, ...), and an unknown one fails at launch with
// Playwright's own error naming the channel, so this does not restate the
// list. Unset means what it always meant.
//
//   CHROME_CHANNEL=chrome-canary bun run csp:sweep
//   CHROME_CHANNEL=chrome-beta bun run csp:sweep
//
// A function rather than a constant so a test can set the variable and read
// the result without re-importing the module.

export const DEFAULT_CHROME_CHANNEL = "chrome";

/** The Playwright channel name a tool should launch Chrome with. */
export function chromeChannel(env: Record<string, string | undefined> = process.env): string {
  const asked = env.CHROME_CHANNEL?.trim();
  return asked ? asked : DEFAULT_CHROME_CHANNEL;
}
