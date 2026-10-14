// lib/cron.ts — the cron dispatcher's matching rule, pure and testable:
// index.ts cannot be imported under node (it alone imports cloudflare:workers),
// so the rule lives here and the contract suite pins it.

export function cronJob(expr) {
  const sig = String(expr || "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (sig === "7,37 *") return "home_probe";
  if (sig === "17 8") return "census";
  // The two daily OUTBOUND ticks, the only jobs that probe somebody else's
  // server, on a schedule chosen for POLITENESS rather than for freshness:
  // daily, off-peak, and twelve minutes apart so the two bursts never overlap.
  //
  // They shared 41 5 from 2026-08-14, when the /around crawl left its own
  // "*/30 *" trigger (twenty VC homepages do not change every half hour). One
  // invocation could not hold both: the crawl needs about 40 subrequests and the
  // sender budgets 40, against Workers Free's 50, so the invocation hit the
  // ceiling every day from at least 2026-09-14 and the crawl's history went
  // missing on 25 of 28 days. Split 2026-10-14. 53 5 took the account's fifth
  // and last cron slot (Workers Free caps an account at five; aadhar-sh holds
  // all of them). The next job that needs its own invocation self-dispatches
  // through the ctx.exports.default loopback instead (PR #1333: a fetch() to
  // this zone's own route never reaches the Worker, it gets a 522).
  if (sig === "41 5") return "around";
  if (sig === "53 5") return "webmention_send";
  if (sig === "23 */6") return "serendipity";
  return null;
}
