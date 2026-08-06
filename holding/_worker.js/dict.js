// dict.js — the compression-dictionary oracle: will a browser ever actually use
// the dictionary you are serving?
//
// ── why this is a lint and not a delta calculator ─────────────────────────
// The obvious tool is "POST two files, get the dcz delta". A Worker cannot do
// that, and the way it fails is the reason this file exists at all.
//
// MEASURED 2026-08-05 in workerd with nodejs_compat: node:zlib is present,
// zstdCompressSync works, and the `dictionary` option is SILENTLY IGNORED. Two
// versions of a 30KB document compressed to 1187 bytes plain, 1187 with the
// correct dictionary, and 1187 with a deliberately wrong one. A delta computed
// here would be plain zstd wearing a delta's name, and the tool would report a
// saving that does not exist. There is no error to catch — the numbers just come
// out confident and false, which is worse than not offering the feature.
//
// So the delta stays in build.mjs, where real node computes it, and this route
// does the half that is genuinely missing from the world.
//
// ── the half that is missing ──────────────────────────────────────────────
// Compression dictionaries fail SILENTLY in the other direction too. Chromium
// will decline to register a perfectly good dictionary because of a cache
// directive on it, and nothing tells you: no console warning, no header, no
// failed request. Your site simply serves full responses forever while you
// believe it is serving deltas. The rules that decide it are not written down
// anywhere convenient, and they are not guessable.
//
// This encodes them, measured on this site (see CLAUDE.md and the local probe
// recipe in MAINTENANCE.md) rather than inferred from the spec.
import { lensProbe } from "./lens.js";

// The verdicts a single rule can return. `veto` means the dictionary is dead;
// `warn` means it works but not the way you probably intended.
const VETO = "veto", WARN = "warn", OK = "ok";

/**
 * The registration rules, in the order a reader should meet them.
 *
 * Each one takes the parsed Cache-Control of the DICTIONARY resource and returns
 * a verdict plus the sentence that explains it. Kept as data rather than an if
 * chain so the frame can print every rule that was checked, including the ones
 * that passed — a lint that only prints failures leaves you unsure whether it
 * looked.
 */
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
    check: (cc) => (cc.has("must-revalidate")
      ? { verdict: VETO, detail: "vetoes registration outright — the single most common cause of a dictionary that never loads" }
      : { verdict: OK, detail: "absent" }),
  },
  {
    id: "lifetime",
    title: "lifetime (stale-while-revalidate)",
    // THE non-obvious one: the dictionary lives for the SWR window, not max-age.
    // A dictionary with a year of max-age and no SWR is usable for zero seconds
    // past freshness, which reads as "it worked yesterday and not today".
    check: (cc) => {
      const swr = cc.get("stale-while-revalidate");
      if (swr === undefined) {
        return { verdict: WARN, detail: "no stale-while-revalidate: the dictionary's usable life is only its freshness window" };
      }
      const seconds = Number(swr);
      if (!Number.isFinite(seconds) || seconds <= 0) return { verdict: WARN, detail: `stale-while-revalidate=${swr} is not a usable window` };
      return { verdict: OK, detail: `${seconds}s — this, not max-age, is how long the dictionary stays usable` };
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

/** `max-age=60, stale-while-revalidate=600` -> Map plus a has() for bare tokens. */
export function parseCacheControl(value) {
  const map = new Map();
  for (const part of String(value || "").split(",")) {
    const [rawKey, ...rest] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (key) map.set(key, rest.length ? rest.join("=").trim().replace(/^"|"$/g, "") : undefined);
  }
  return map;
}

/**
 * Judge one set of response headers as a DICTIONARY.
 *
 * Pure, so the whole rule set is testable without a network — which matters
 * because the rules are the product and every external fetch in this repo dies
 * at signing in a test environment.
 */
export function auditDictionary(headers) {
  const lower = {};
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

/**
 * Judge headers as a resource that WANTS to be served as a delta.
 *
 * The other half of the handshake, and a separate failure: a correctly
 * registered dictionary still buys nothing if the response that should use it
 * does not vary on available-dictionary, because a shared cache will then hand
 * a delta to a client that has no dictionary to apply it with. That is not a
 * slow page, it is ERR_CONTENT_DECODING_FAILED.
 */
export function auditConsumer(headers) {
  const lower = {};
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

/** Fetch a target and audit it, through Lens's guarded, signed, capped fetcher. */
export async function auditUrl(target, env) {
  const probe = await lensProbe(target, env);
  if (probe?.error) return { ok: false, unreadable: true, why: String(probe.error).slice(0, 80) };
  if (!probe?.status) return { ok: false, why: "no answer" };
  // A lint that graded an empty header set would pass everything, so the absence
  // of headers is a failure to report rather than a clean bill of health.
  const headers = probe.headers;
  if (!headers || !Object.keys(headers).length) return { ok: false, why: "no headers came back to audit" };
  return { ok: true, status: probe.status, dictionary: auditDictionary(headers), consumer: auditConsumer(headers), headers };
}

// The site's own measured figures, offered as reference rather than recomputed.
// This is the oracle half: the numbers came from real deploys of this origin and
// are the kind of thing you cannot get from a spec.
export const MEASURED = [
  ["shell assets (js/css)", "93-97% off, per-asset dictionaries"],
  ["pages, family corpus", "~26% off q11 (298,933 B vs 405,909 B across 38 pages)"],
  ["a dictionary 11 days stale", "still 87-93% — freshness matters far less than people fear"],
  ["dcz vs dcb, size", "dcb wins by ~6.8% across 12 pairs"],
  ["dcz vs dcb, decode", "dcz 0.0165ms vs brotli 0.1368ms on a 47KB rebuild — 8.3x"],
  ["why dcz anyway", "decode scales with the REBUILD, not the delta, so a smaller dcb never closes it"],
  ["zstd level 19 vs 22", "byte-identical on every asset here; above 19 is dead weight"],
];
