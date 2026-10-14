import { fetchFollowingPublicRedirects, privateHostBlocked, validateLensTarget } from "./lib/public-fetch.ts";
import { readResponseCapped } from "./lib/crawl.ts";
import { selfAdapter } from "./lib/outbound.ts";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.ts";
import { createBudget, isSubrequestLimit, meteredTransport, recordBudget } from "./lib/budget.ts";
import { span } from "./lib/trace.ts";
import type { PublicTransport } from "./lib/public-fetch.ts";
import { asText } from "./lib/parse.ts";

const SEND_TIMEOUT_MS = 8000;
const PAGE_BYTE_CAP = 512 * 1024;
const DISCOVERY_BYTE_CAP = 256 * 1024;
// Politeness cap per run, and the one bound that is about the RECEIVER rather
// than about us. The tick is daily (53 5 * * *, its own); a run that
// re-notified every citation on every page would be a small crawl of its own.
const MAX_SENDS_PER_RUN = 25;
const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// THE BOUND THAT DECIDES THE SHAPE OF THIS JOB. Workers Free allows 50
// subrequests per invocation (gotcha 36: a fan-out that crosses it arrives as an
// ordinary exception, which a job written to swallow its own failures reports as
// silence). Every outbound fetch is one, and every redirect hop. This ledger
// also charges each D1 statement and asset read, which production says do not
// count (lib/budget.ts, 2026-10-14); charging them anyway errs on the safe side. A full sweep here is ~35 pages plus ~100 citations at 2-3 statements
// each, so it was never going to fit and the honest move is to spend a budget and
// come back tomorrow rather than to die two thirds of the way through.
// 40 rather than 50, because the internal half of this count is an ESTIMATE: a
// page read dispatches through route(), which reads the asset and may touch the
// Workers cache on the way, and none of that is visible from here. The
// third-party half is exact, since meteredTransport charges each hop before it
// goes out.
//
// THIS JOB RUNS ALONE ON ITS TICK, and that is what makes 40 safe. Until
// 2026-10-14 it shared 41 5 with the /around crawl, whose twenty neighbors need
// 40 more on their own, so the invocation hit the platform's ceiling every day.
// contract-no-cron-tick-outspends-the-subrequest-cap pins the per-tick sum.
export const SUBREQUEST_BUDGET = 40;
const COST_PER_TARGET = 3;
const COST_PER_PAGE = 3;

export const SELF_LINK_HOSTS = [
  "github.com/oddharsh",
  "x.com/oddhash",
  "instagram.com/aadharsh.hif",
  "curius.app/aadharsh-pannirselvam",
  "beliapp.com/users/aadharsh",
  "open.spotify.com/user/aadharsh2010",
];

const TABLE = "webmentions_sent";
let ensured = false;
async function ensureTable(db) {
  if (ensured) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      endpoint TEXT,
      status INTEGER,
      last_sent_at INTEGER NOT NULL,
      PRIMARY KEY (source, target)
    )`
  ).run();
  ensured = true;
}

export async function cronSendWebmentions(env, origin = "https://aadhar.sh") {
  return span("webmention.send", (s) => cronSendWebmentionsInner(env, origin, s));
}

async function cronSendWebmentionsInner(env, origin, sSend) {
  const db = env.SOCIAL_DB;
  if (!db) {
    sSend.setAttribute("webmention.outcome", "db_unbound");
    console.warn("webmention-send: SOCIAL_DB unbound; skipping");
    return { sent: 0, discovered: 0, considered: 0, pagesRead: 0, spent: 0, skipped: "unbound" };
  }
  // The ledger. Internal calls (D1, the own-page dispatch) are charged by hand
  // at the estimates below; every third-party hop is charged by the transport
  // before it is dispatched, so a redirect chain is counted hop by hop rather
  // than as the one call it looks like from here.
  const budget = createBudget(SUBREQUEST_BUDGET);
  const transport = meteredTransport(budget, env.OUTBOUND_TRANSPORT);
  await ensureTable(db); budget.charge();

  const pages = await span("webmention.own_pages", () => mentionablePages(env, origin));
  sSend.setAttribute("webmention.pages", Array.isArray(pages) ? pages.length : 0);
  const now = Date.now();

  const priorRows = await db.prepare(`SELECT source, target, last_sent_at FROM ${TABLE}`).all(); budget.charge();
  const prior = new Map();
  for (const r of (priorRows && priorRows.results) || []) prior.set(`${r.source}|${r.target}`, r.last_sent_at || 0);
  const freshAt = (source, target) => now - (prior.get(`${source}|${target}`) ?? 0) < RESEND_AFTER_MS;

  const pageRead = (p) => prior.get(`${p}|${p}`) ?? 0;
  const queue = [...pages].sort((a, b) => pageRead(a) - pageRead(b));

  let sent = 0, discovered = 0, considered = 0, pagesRead = 0;
  // A refusal from the ledger mid-target: a redirect chain cost more than the
  // whole-target estimate. The run stops there and records nothing for it.
  let refused = false;
  const affordable = () => budget.left >= COST_PER_TARGET;

  for (const pageUrl of queue) {
    if (refused || sent >= MAX_SENDS_PER_RUN || budget.left < COST_PER_PAGE + COST_PER_TARGET) break;
    if (freshAt(pageUrl, pageUrl)) continue;

    const html = await span("webmention.fetch_own_page", (s) => {
      s.setAttribute("webmention.source", pageUrl);
      return fetchOwnPage(pageUrl, env);
    });
    budget.charge(COST_PER_PAGE);
    if (!html) continue;
    pagesRead++;

    let cut = false;
    for (const target of citationsIn(html, origin)) {
      if (sent >= MAX_SENDS_PER_RUN || !affordable()) { cut = true; break; }
      considered++;

      if (freshAt(pageUrl, target)) continue;

      let endpoint, status;
      try {
        endpoint = await span("webmention.discover", (s) => {
          s.setAttribute("webmention.target_host", hostOf(target));
          return discoverEndpoint(target, transport);
        });
        if (endpoint) {
          status = await span("webmention.post", async (s) => {
            s.setAttribute("webmention.target_host", hostOf(target));
            const st = await postMention(endpoint, pageUrl, target, transport);
            // the receiving endpoint's verdict. Stored in D1 per pair, but a run-level
            // view of "who is rejecting my mentions" needed a query nobody writes.
            s.setAttribute("http.response.status_code", st);
            return st;
          });
        }
      } catch (e) {
        // Only the ceiling reaches here: discoverEndpoint and postMention turn
        // every other failure into a value. Nothing is recorded for this
        // target, so tomorrow's run probes it again instead of trusting a
        // "no endpoint" the ledger made up.
        if (budget.fault(e) !== "cap") throw e;
        refused = true; cut = true; break;
      }
      if (!endpoint) {
        await recordSend(db, pageUrl, target, null, null, now); budget.charge();
        continue;
      }
      discovered++;
      await recordSend(db, pageUrl, target, endpoint, status, now); budget.charge();
      sent++;
    }

    // The marker, written LAST so a page only counts as swept once its citations
    // are. A run that ran out of budget mid-page leaves it unmarked and picks it
    // up first tomorrow. (Until 2026-10-14 the cut only left the inner loop and
    // fell through to this write, marking a half-swept page done for a week.)
    if (cut) break;
    await recordSend(db, pageUrl, pageUrl, null, null, now); budget.charge();
  }

  sSend.setAttribute("webmention.considered", considered);
  sSend.setAttribute("webmention.discovered", discovered);
  sSend.setAttribute("webmention.sent", sent);
  sSend.setAttribute("webmention.pages_read", pagesRead);
  const spent = budget.spent;
  sSend.setAttribute("webmention.budget_spent", spent);
  sSend.setAttribute("webmention.capped", refused || sent >= MAX_SENDS_PER_RUN || !affordable());
  recordBudget(sSend, budget);
  console.log(`webmention-send: ${pagesRead} pages read, ${considered} citations considered, ${discovered} endpoints found, ${sent} sent, ${spent}/${SUBREQUEST_BUDGET} subrequests`);
  return { sent, discovered, considered, pagesRead, spent };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function recordSend(db, source, target, endpoint, status, at) {
  return db.prepare(
    `INSERT INTO ${TABLE} (source, target, endpoint, status, last_sent_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, target) DO UPDATE SET endpoint = excluded.endpoint, status = excluded.status, last_sent_at = excluded.last_sent_at`
  ).bind(source, target, endpoint, status, at).run();
}

export async function mentionablePages(env, origin) {
  const paths = WEBMENTION_PATHS.filter((p) => !WEBMENTION_SECTIONS.includes(p));
  for (const section of WEBMENTION_SECTIONS) {
    if (section !== "/writing") continue;
    try {
      const res = await env.ASSETS.fetch("https://assets.local/writing/posts.json");
      if (!res.ok) continue;
      const posts = await res.json();
      for (const p of Array.isArray(posts) ? posts : []) {
        if (p && asText(p.slug) !== null) paths.push(`/writing/${p.slug}`);
      }
    } catch {}
  }
  return paths.map((p) => origin + p);
}

async function fetchOwnPage(url, env) {
  const req = new Request(url, {
    headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const read = selfAdapter(env);
  if (!read) { console.warn("webmention-send: no SELF_FETCH or ASSETS; cannot read own pages"); return ""; }
  try {
    const res = await read(req);
    if (!res || !res.ok) return "";
    const body = await readResponseCapped(res, PAGE_BYTE_CAP);
    return body?.text || "";
  } catch { return ""; }
}

export function contentOf(html) {
  return String(html)
    .replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, " ")
    .replace(/<!-- axp:desktop -->[\s\S]*?<!-- \/axp:desktop -->/g, " ")
    .replace(/<head\b[\s\S]*?<\/head\b[^>]*>/i, " ")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|--!>)/g, " ");
}

export function citationsIn(html, origin) {
  const out = new Set<string>();
  for (const m of contentOf(html).matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\binterestfor\s*=/i.test(tag) || /\bclass\s*=\s*("[^"]*\bcar-link\b|'[^']*\bcar-link\b)/i.test(tag)) continue;
    const href = (tag.match(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i) || [])[1];
    if (!href) continue;
    const raw = href.replace(/^["']|["']$/g, "").trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin === origin) continue;
    const bare = (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
    if (SELF_LINK_HOSTS.some((self) => bare === self || bare.startsWith(self + "/"))) continue;
    if (privateHostBlocked(u.hostname.toLowerCase())) continue;
    const checked = validateLensTarget(u.toString());
    if (!checked.ok) continue;
    u.hash = "";
    out.add(u.toString());
  }
  return [...out];
}

// Per spec: the Link header wins, then the first <link> or <a> carrying
// rel=webmention IN DOCUMENT ORDER (not all <link>s and then all <a>s — that
// ordering is what discovery tests 16 and 17 pull apart). Relative endpoints
// resolve against the fetched URL.

// rel is a space-separated token list, so "webmention" has to BE one of the
// tokens. A `\bwebmention\b` regex is not enough: "-" counts as a word
// boundary, so it happily matches rel="not-webmention", which is precisely the
// decoy discovery test 12 plants.
function relHasWebmention(rel) {
  return String(rel).trim().split(/\s+/).some((t) => t.toLowerCase() === "webmention");
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i"));
  return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

export function findEndpointIn(html, linkHeader, baseUrl) {
  if (linkHeader) {
    for (const part of String(linkHeader).split(/,(?![^<]*>)/)) {
      const href = (part.match(/<([^>]*)>/) || [])[1];
      const rel = (part.match(/rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]+))/i) || []).slice(1).find((v) => v != null);
      if (href !== undefined && rel && relHasWebmention(rel)) return abs(href, baseUrl);
    }
  }
  // Comments are not markup: a rel=webmention inside <!-- --> must not count
  // (discovery test 13). Escaped HTML (test 14) never matches anyway, since
  // these patterns want a literal "<".
  const body = String(html).replace(/<!--[\s\S]*?-->/g, " ");
  for (const m of body.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel");
    if (!rel || !relHasWebmention(rel)) continue;
    // A candidate with no href at all is not an endpoint. Keep scanning rather
    // than giving up, or a bare <link rel="webmention"> shadows the real one
    // further down the page (discovery test 20). An href of "" is different:
    // it is a legitimate self-reference and resolves to the page (test 15).
    const href = attr(m[0], "href");
    if (href === undefined) continue;
    return abs(href, baseUrl);
  }
  return null;
}

// `transport` is the send loop's metered adapter. Every failure is still a
// null, EXCEPT the ceiling: a null is recorded as "no endpoint" and trusted for
// a week, and a probe the ledger refused learned nothing about the target.
export async function discoverEndpoint(target, transport?: PublicTransport) {
  try {
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const followed = await fetchFollowingPublicRedirects(target, () => ({
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
      signal,
    }), validateLensTarget, 20, transport); // Preserve native fetch's redirect allowance.
    if (!followed.ok) return null;
    const { response: res, finalUrl } = followed;
    const linkHeader = res.headers.get("link");
    let endpoint;
    if (linkHeader && /\bwebmention\b/i.test(linkHeader)) {
      try { await res.body?.cancel(); } catch {}
      endpoint = findEndpointIn("", linkHeader, finalUrl);
    } else {
      if (!res.ok) return null;
      const body = await readResponseCapped(res, DISCOVERY_BYTE_CAP);
      endpoint = findEndpointIn(body?.text || "", null, finalUrl);
    }
    if (!endpoint) return null;
    const checked = validateLensTarget(endpoint);
    return checked.ok ? checked.url : null;
  } catch (e) {
    if (isSubrequestLimit(e)) throw e;
    return null;
  }
}

function abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

// ONE request, redirect: "manual". A followed redirect is a subrequest per hop
// that no ledger here can see, and its destination would skip the per-hop SSRF
// check discovery gets. A 3xx is stored as the receiver's verdict, like any
// other status.
async function postMention(endpoint, source, target, transport?: PublicTransport) {
  try {
    const send = transport ?? ((url, init) => fetch(url, init));
    const res = await send(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
      },
      body: new URLSearchParams({ source, target }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    void res.body?.cancel?.();
    return res.status;
  } catch (e) {
    if (isSubrequestLimit(e)) throw e;
    return 0;
  }
}
