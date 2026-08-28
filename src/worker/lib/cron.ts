// lib/cron.js — the cron dispatcher's matching rule, pure and testable:
// index.js cannot be imported under node (it alone imports cloudflare:workers),
// so the rule lives here and contract-tests.mjs pins it.
//
// Match on the minute+hour signature, never the full expression. Cloudflare
// normalizes cron strings between what wrangler.jsonc declares and what
// event.cron delivers (day-of-week tokens especially: a "1" can come back
// "MON"), and an exact match against "17 8 * * 1" left the weekly census
// branch unreachable while the else-chain quietly ran the /around crawl in
// its place — three weeks of a 16-host roster produced zero cron rows and
// nothing logged, because every job is deliberately quiet. The minute and
// hour fields are plain numbers on every schedule this worker declares, and
// normalization leaves them alone.
//
// THE ECHOED TOKEN AND THE FIRING DAY HAVE NOT BEEN RECONCILED, and the "MON"
// above is left exactly as it was observed rather than corrected to fit.
// Cloudflare numbers weekdays 1 = Sunday through 7 = Saturday, so "17 8 * * 1"
// schedules SUNDAY, which is what production does: every cron-written row in
// lens_census lands at 08:17 UTC on a Sunday, back to the first sweep on
// 2026-07-19. If Cloudflare really does echo "MON" for that same expression,
// that is an inconsistency on their side worth reporting, and it is equally
// possible the token was misremembered. Nobody has read a real event.cron
// since. Settle it by reading `cron.schedule` off a census span in Workers
// Traces after any Sunday 08:17 fire, and record what it actually says.
//
// Either way this dispatcher is unaffected: it matches minute+hour and never
// looks at the weekday field, which is also why the wrong day could sit in
// nine comments for six weeks without a single check going red.
//
// An unknown expression returns null so the caller can surface it as its own
// traced event instead of running somebody else's job.
export function cronJob(expr) {
  const sig = String(expr || "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (sig === "7,37 *") return "home_probe";
  if (sig === "17 8") return "census";
  // One daily outbound tick, two jobs. Both read this site and then probe
  // third parties, so they share a schedule chosen for POLITENESS rather than
  // for freshness. The /around crawl moved here from its own "*/30 *" trigger
  // on 2026-08-14: twenty VC homepages do not change every half hour, and the
  // old cadence spent 960 signed third-party fetches and 960 D1 row-writes a
  // day to notice that. Merging also freed a trigger slot, and Workers Free
  // caps an account at five.
  if (sig === "41 5") return "daily_outbound";
  if (sig === "23 */6") return "serendipity";
  return null;
}
