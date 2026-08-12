// lib/cron.js — the cron dispatcher's matching rule, pure and testable:
// index.js cannot be imported under node (it alone imports cloudflare:workers),
// so the rule lives here and contract-tests.mjs pins it.
//
// Match on the minute+hour signature, never the full expression. Cloudflare
// normalizes cron strings between what wrangler.jsonc declares and what
// event.cron delivers (day-of-week tokens especially: a "1" can come back
// "MON"), and an exact match against "17 8 * * 1" left the Monday census
// branch unreachable while the else-chain quietly ran the /around crawl in
// its place — three weeks of a 16-host roster produced zero cron rows and
// nothing logged, because every job is deliberately quiet. The minute and
// hour fields are plain numbers on every schedule this worker declares, and
// normalization leaves them alone.
//
// An unknown expression returns null so the caller can surface it as its own
// traced event instead of running somebody else's job.
export function cronJob(expr) {
  const sig = String(expr || "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (sig === "7,37 *") return "home_probe";
  if (sig === "17 8") return "census";
  if (sig === "41 5") return "webmention_send";
  if (sig === "23 */6") return "serendipity";
  if (sig === "*/30 *") return "around";
  return null;
}
