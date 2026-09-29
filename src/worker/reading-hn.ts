// reading-hn.ts: which /reading links have a Hacker News thread, and how big.
// Bundled by wrangler at deploy; not served, and node-safe so the contract
// suite can import it.
//
// The Cloudflare blog's "Discuss on Hacker News" button is a bare
// `news.ycombinator.com/submitlink?u=<url>` link. HN redirects a LOGGED-IN
// visitor to the existing thread, and hands everyone else a login form
// (measured 2026-09-29: 200, "You have to be logged in to submit"). So that
// button costs nothing and works for the one reader who already has an HN
// account open. This page wants the other half: show the thread only where one
// exists, with its comment count, and link straight to it.
//
// HN's own API has no URL search. Algolia's HN index does, one URL per query,
// and /reading holds ~150 links. One query each would spend three times the
// 50 subrequests Workers Free allows an invocation (gotcha 36), so this runs as
// a bounded batch on the :07/:37 tick, the same shape as cronEnrichTracks, and
// converges over a few hours. The page joins the map at render time, so a
// visitor never waits on Algolia and a prerender never makes this site fetch
// anything.
import { signedFetch } from "./lib/botauth.ts";
import { createBudget, mapWithBudget, recordBudget } from "./lib/budget.ts";
import { asList, asNumber, asRecord, asText } from "./lib/parse.ts";
import { span } from "./lib/trace.ts";
import type { BudgetedRun } from "./lib/budget.ts";

// parse.ts's helpers take their fallback untyped, which the checker reads as
// `null`; these two name the fallbacks this file actually wants.
const text = (value: unknown): string => asText(value) ?? "";
const num = (value: unknown): number => asNumber(value) ?? 0;

export const HN_MAP_KEY = "reading:hn:v1";
const HN_SEARCH = "https://hn.algolia.com/api/v1/search";
const HN_ITEM = "https://news.ycombinator.com/item?id=";

// THIS JOB'S SHARE OF THE TICK, and the sum has to be redone if any of the
// three jobs on it grows. The platform cap is per INVOCATION, and :07/:37 runs
// three jobs in one: the home probe (about 8 at worst, counting an SWR rebuild
// of the tracks fragment), rn.enrich (23 at worst, its own comment has the
// sum), and this. 8 + 23 + 14 = 45 of 50.
//
// Inside the 14: one bulk KV read, up to 3 for the robots gate (a KV read, a
// robots.txt fetch and a KV write, all inside signedFetch where this ledger
// cannot see them, so they are charged up front), the lookups, and one KV write
// held back by the reserve.
const HN_TICK_SHARE = 14;
const HN_RESERVE = 1;
const HN_ROBOTS_WORST = 3;
const HN_LOOKUP_BATCH = 8;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// An entry nobody has saved for this long leaves the map. Pruned BY AGE, never
// by absence from one Curius read: rn.ts learned on 2026-08-15 that a short
// upstream read looks exactly like a real deletion.
const HN_MAX_AGE = 60 * DAY;

export type HnEntry = {
  /** The thread's HN item id, or null when no story links this URL. */
  id: number | null;
  /** Comments on the chosen thread. */
  c: number;
  /** Points on the chosen thread. */
  p: number;
  /** How many HN stories link this exact URL. */
  n: number;
  /** When Algolia was last asked. */
  checked: number;
  /** When this URL was last in the Curius list. */
  seen: number;
};

export type HnMap = Record<string, HnEntry>;

// Query parameters that name the sharer rather than the page. Curius saves the
// URL as it was clicked, and an HN submission usually carries none of these,
// so leaving them in would miss a thread that is there.
const TRACKING = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|si)$/i;

/**
 * The form two URLs are compared in, and the key the map is stored under.
 * Scheme, `www.`, a trailing slash, the fragment and tracking parameters are
 * dropped, because each is a spelling difference HN submitters vary on while
 * naming the same page. Returns null for anything that is not http(s).
 */
export function hnKey(link: string): string | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  const kept = [...url.searchParams].filter(([k]) => !TRACKING.test(k));
  const query = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
  return host + path + query;
}

// A link that already IS an HN thread needs no lookup: its title links there.
const isHnHosted = (key: string) => key.startsWith("news.ycombinator.com/");

/**
 * Pick the thread worth linking from one Algolia answer.
 *
 * Algolia's `url` search is tokenized, so a query for `example.com/a` also
 * returns `example.com/a/b` and every other page on that host. Only hits whose
 * own URL normalizes to the same key count. Among those, the most-commented
 * thread wins, because comments are what the reader came for.
 */
export function pickThread(key: string, body: unknown): Omit<HnEntry, "checked" | "seen"> {
  const hits = asList(asRecord(body)?.hits)
    .map(asRecord)
    .filter((h) => h && hnKey(text(h.url)) === key);
  let best: { id: number; c: number; p: number } | null = null;
  for (const h of hits) {
    const c = num(h.num_comments), p = num(h.points);
    if (!best || c > best.c || (c === best.c && p > best.p)) {
      const id = Number(asText(h.objectID) ?? h.story_id);
      if (Number.isSafeInteger(id) && id > 0) best = { id, c, p };
    }
  }
  return best ? { ...best, n: hits.length } : { id: null, c: 0, p: 0, n: 0 };
}

/**
 * How long an answer stays good. A thread on something saved this fortnight is
 * still collecting comments, so it is re-read every 6 hours; older ones every
 * week. "No thread yet" is re-asked on the same curve, stretched, since a link
 * can be submitted long after it was written.
 */
export function hnInterval(entry: HnEntry, savedAt: number | null, now: number): number {
  const young = savedAt !== null && now - savedAt < 14 * DAY;
  if (entry.id) return young ? 6 * HOUR : 7 * DAY;
  if (young) return 12 * HOUR;
  return savedAt !== null && now - savedAt < 90 * DAY ? 7 * DAY : 30 * DAY;
}

type Pending = { key: string; savedAt: number | null; checked: number };

/**
 * Which links to ask about this tick, most useful first: never-asked links
 * newest-saved first (the top of the page), then the stalest answers.
 */
export function pickPending(items: unknown[], map: HnMap, now: number, limit = HN_LOOKUP_BATCH): Pending[] {
  const due: Pending[] = [];
  const queued = new Set<string>();
  for (const raw of items) {
    const it = asRecord(raw);
    const key = hnKey(text(it?.link));
    if (!key || isHnHosted(key) || queued.has(key)) continue;
    queued.add(key);
    const saved = Date.parse(text(it.created));
    const savedAt = Number.isFinite(saved) ? saved : null;
    const entry = map[key];
    if (entry && now - entry.checked < hnInterval(entry, savedAt, now)) continue;
    due.push({ key, savedAt, checked: entry ? entry.checked : -1 });
  }
  // A stable sort keeps the Curius order (newest first) among the never-asked.
  due.sort((a, b) => a.checked - b.checked);
  return due.slice(0, limit);
}

async function askAlgolia(key: string, env): Promise<unknown> {
  const params = new URLSearchParams({
    query: key.slice(0, 500),
    restrictSearchableAttributes: "url",
    tags: "story",
    hitsPerPage: "20",
  });
  const res = await signedFetch(`${HN_SEARCH}?${params.toString()}`, env, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`algolia ${res.status}`);
  }
  return res.json();
}

/** Parse the stored map, dropping any entry an older deploy shaped differently. */
export function readHnMap(raw: unknown): HnMap {
  const out: HnMap = {};
  for (const [key, value] of Object.entries(asRecord(raw) ?? {})) {
    const e = asRecord(value);
    const checked = asNumber(e?.checked);
    if (checked === null) continue;
    const id = asNumber(e.id);
    out[key] = {
      id: id !== null && id > 0 ? id : null,
      c: num(e.c), p: num(e.p), n: num(e.n),
      checked, seen: asNumber(e.seen) ?? checked,
    };
  }
  return out;
}

export async function cronEnrichReadingHn(env, now = Date.now()) {
  if (!env?.RN_KV) return { ok: false, reason: "no_kv_binding" };

  return span("reading.hn", async (s) => {
    const budget = createBudget(HN_TICK_SHARE, { reserve: HN_RESERVE });

    // Both keys in ONE bulk read, which is one subrequest (rn.ts kvBulkJson
    // cites the KV reference for that).
    budget.charge(1);
    const stored = await env.RN_KV.get(["curius:links", HN_MAP_KEY], "json");
    const items = asList(asRecord(stored.get("curius:links"))?.items);
    if (items.length === 0) {
      // The /reading SWR path owns building the list; this only reads it.
      s.setAttribute("reading.outcome", "no_payload");
      return { ok: false, reason: "no_payload" };
    }
    const map = readHnMap(stored.get(HN_MAP_KEY));

    let pruned = 0;
    for (const raw of items) {
      const key = hnKey(text(asRecord(raw)?.link));
      if (key && map[key]) map[key].seen = now;
    }
    for (const key of Object.keys(map)) {
      if (now - map[key].seen > HN_MAX_AGE) { delete map[key]; pruned++; }
    }

    const pending = pickPending(items, map, now);
    let run: BudgetedRun<unknown> = { results: [], failed: 0, skipped: 0, hitCap: false };
    if (pending.length > 0 && budget.afford(HN_ROBOTS_WORST)) {
      run = await mapWithBudget(pending, budget, async ({ key }) => {
        const thread = pickThread(key, await askAlgolia(key, env));
        map[key] = { ...thread, checked: now, seen: now };
        return thread;
      });
    }

    // Written only when something moved, so a converged tick costs one read.
    if (run.results.length > 0 || pruned > 0) {
      budget.charge(1);
      await env.RN_KV.put(HN_MAP_KEY, JSON.stringify(map));
    }

    const entries = Object.values(map);
    s.setAttribute("reading.links", items.length);
    s.setAttribute("reading.hn_asked", run.results.length);
    s.setAttribute("reading.hn_failed", run.failed);
    s.setAttribute("reading.hn_skipped", run.skipped);
    s.setAttribute("reading.hn_capped", run.hitCap);
    s.setAttribute("reading.hn_threads", entries.filter((e) => e.id).length);
    s.setAttribute("reading.hn_pruned", pruned);
    // The number that should walk to 0 and stay there between refreshes.
    s.setAttribute("reading.hn_pending", pickPending(items, map, now, Infinity).length);
    recordBudget(s, budget);
    return { ok: true, asked: run.results.length, failed: run.failed };
  });
}

/** The thread to show beside a link, or null when there is nothing to read. */
export function hnThreadFor(link: string, map: HnMap): { href: string; comments: number; points: number } | null {
  const key = hnKey(link);
  const e = key ? map[key] : null;
  if (!e || !e.id || e.c < 1) return null;
  return { href: HN_ITEM + e.id, comments: e.c, points: e.p };
}
