// lib/cron.ts — the cron dispatcher's matching rule, pure and testable:
// index.ts cannot be imported under node (it alone imports cloudflare:workers),
// so the rule lives here and the contract suite pins it.

export function cronJob(expr) {
  const sig = String(expr || "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (sig === "7,37 *") return "home_probe";
  if (sig === "17 8") return "census";
  if (sig === "41 5") return "daily_outbound";
  if (sig === "23 */6") return "serendipity";
  return null;
}
