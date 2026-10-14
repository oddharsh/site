// dict.ts — the compression-dictionary oracle: will a browser ever actually use
// the dictionary you are serving?

import { lensProbe } from "./lens.ts";

const VETO = "veto", WARN = "warn", OK = "ok";

export const RULES = [
  {
    id: "use-as-dictionary",
    title: "Use-As-Dictionary header",
    check: (cc, headers) => (headers["use-as-dictionary"]
      ? { verdict: OK, detail: headers["use-as-dictionary"].slice(0, 60) }
      : { verdict: VETO, detail: "absent — nothing here is offered as a dictionary" }),
  },
  {
    id: "no-store",
    title: "no-store",
    check: (cc) => (cc.has("no-store")
      ? { verdict: VETO, detail: "the resource may not be stored, so it cannot be kept as a dictionary" }
      : { verdict: OK, detail: "absent" }),
  },
  {
    id: "no-cache",
    title: "no-cache",
    // Measured, not inferred. This one surprises people because no-cache does
    // not mean "do not store" anywhere else in HTTP — it means revalidate.
    check: (cc) => (cc.has("no-cache")
      ? { verdict: VETO, detail: "vetoes registration outright in Chromium, even though the bytes are still cached" }
      : { verdict: OK, detail: "absent" }),
  },
  {
    id: "must-revalidate",
    title: "must-revalidate",
    // Measured 2026-09-23 in Chrome 152: must-revalidate withdraws the permission to
    // serve stale, so it cancels the stale-while-revalidate window and leaves max-age
    // standing. `max-age=3600, must-revalidate` registers for an hour. It reads as a
    // veto only beside max-age=0, which is the pairing that makes it the most common
    // cause of a dictionary that never loads.
    check: (cc) => {
      if (!cc.has("must-revalidate")) return { verdict: OK, detail: "absent" };
      const maxAge = Number(cc.get("max-age"));
      if (!(maxAge > 0)) {
        return { verdict: VETO, detail: "cancels the stale-while-revalidate window, and with no positive max-age the dictionary is expired on arrival" };
      }
      return cc.has("stale-while-revalidate")
        ? { verdict: WARN, detail: `cancels stale-while-revalidate, so the dictionary lives only its max-age=${maxAge}s` }
        : { verdict: OK, detail: `the dictionary lives its max-age=${maxAge}s` };
    },
  },
  {
    id: "lifetime",
    title: "lifetime (stale-while-revalidate)",
    // THE non-obvious one: the dictionary lives for max-age plus the SWR window, and
    // a policy tuned for freshness usually has a max-age of 0. A dictionary with no
    // SWR is usable for zero seconds past freshness, which reads as "it worked
    // yesterday and not today". must-revalidate cancels the window outright.
    check: (cc) => {
      const swr = cc.get("stale-while-revalidate");
      if (swr !== undefined && cc.has("must-revalidate")) {
        return { verdict: WARN, detail: `stale-while-revalidate=${swr} is cancelled by must-revalidate` };
      }
      if (swr === undefined) {
        return { verdict: WARN, detail: "no stale-while-revalidate: the dictionary's usable life is only its freshness window" };
      }
      const seconds = Number(swr);
      if (!Number.isFinite(seconds) || seconds <= 0) return { verdict: WARN, detail: `stale-while-revalidate=${swr} is not a usable window` };
      return { verdict: OK, detail: `${seconds}s of stale window on top of max-age, and usually most of the dictionary's life` };
    },
  },
  {
    id: "s-maxage",
    title: "s-maxage",
    check: (cc) => (cc.has("s-maxage")
      ? { verdict: WARN, detail: "invisible here: s-maxage is a shared-cache directive and does not extend a browser's dictionary lifetime" }
      : { verdict: OK, detail: "absent (would be ignored anyway)" }),
  },
];

export function parseCacheControl(value) {
  const map = new Map();
  for (const part of String(value || "").split(",")) {
    const [rawKey, ...rest] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (key) map.set(key, rest.length ? rest.join("=").trim().replace(/^"|"$/g, "") : undefined);
  }
  return map;
}

export function auditDictionary(headers) {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) lower[String(key).toLowerCase()] = String(value);
  const cc = parseCacheControl(lower["cache-control"]);
  const results = RULES.map((rule) => ({ id: rule.id, title: rule.title, ...rule.check(cc, lower) }));
  const vetoes = results.filter((r) => r.verdict === VETO);
  return {
    results,
    vetoes,
    warns: results.filter((r) => r.verdict === WARN),
    registers: vetoes.length === 0,
    cacheControl: lower["cache-control"] || "",
  };
}

export function auditConsumer(headers) {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) lower[String(key).toLowerCase()] = String(value);
  const vary = (lower.vary || "").toLowerCase();
  const encoding = (lower["content-encoding"] || "").toLowerCase();
  return {
    encoding,
    isDelta: encoding === "dcz" || encoding === "dcb",
    variesOnDictionary: vary.includes("available-dictionary"),
    variesOnEncoding: vary.includes("accept-encoding"),
    vary: lower.vary || "",
  };
}

export async function auditUrl(target, env) {
  const probe = await lensProbe(target, env);
  if (probe?.error) return { ok: false, unreadable: true, why: String(probe.error).slice(0, 80) };
  if (!probe?.status) return { ok: false, why: "no answer" };
  const headers = probe.headers;
  if (!headers || !Object.keys(headers).length) return { ok: false, why: "no headers came back to audit" };
  return { ok: true, status: probe.status, dictionary: auditDictionary(headers), consumer: auditConsumer(headers), headers };
}

export const MEASURED = [
  ["shell assets (js/css)", "93-97% off, per-asset dictionaries"],
  ["pages, family corpus", "~26% off q11 (298,933 B vs 405,909 B across 38 pages)"],
  ["a dictionary 11 days stale", "still 87-93% — freshness matters far less than people fear"],
  ["dcz vs dcb, size", "dcb wins by ~6.8% across 12 pairs"],
  ["dcz vs dcb, decode", "dcz 0.0165ms vs brotli 0.1368ms on a 47KB rebuild — 8.3x"],
  ["why dcz anyway", "decode scales with the REBUILD, not the delta, so a smaller dcb never closes it"],
  ["zstd level 19 vs 22", "byte-identical on every asset here; above 19 is dead weight"],
];
