// browser-channel.ts — which Chrome a tool drives.

export const DEFAULT_CHROME_CHANNEL = "chrome";

export function chromeChannel(env: Record<string, string | undefined> = process.env): string {
  const asked = env.CHROME_CHANNEL?.trim();
  return asked ? asked : DEFAULT_CHROME_CHANNEL;
}
