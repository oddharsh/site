import { fetchFollowingPublicRedirects, privateHostBlocked, validateLensTarget } from "./lib/public-fetch.ts";
import { readResponseCapped } from "./lib/crawl.ts";
import { selfAdapter } from "./lib/outbound.ts";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.ts";
import { span } from "./lib/trace.ts";
import { asText } from "./lib/parse.ts";

const SEND_TIMEOUT_MS = 8000;
const PAGE_BYTE_CAP = 512 * 1024;
const DISCOVERY_BYTE_CAP = 256 * 1024;
const MAX_SENDS_PER_RUN = 25;
const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// THE BOUND THAT DECIDES THE SHAPE OF THIS JOB. Workers Free allows 50
// subrequests per invocation, and every D1 statement, every asset read and every
// outbound fetch is one (gotcha 36 — a fan-out that crosses it arrives as an
// ordinary exception, which a job written to swallow its own failures reports as
// silence). A full sweep here is ~35 pages plus ~100 citations at 2-3 statements
// each, so it was never going to fit and the honest move is to spend a budget and
// come back tomorrow rather than to die two thirds of the way through.
const SUBREQUEST_BUDGET = 40;
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
  let spent = 0;
  await ensureTable(db); spent++;

  const pages = await span("webmention.own_pages", () => mentionablePages(env, origin));
  sSend.setAttribute("webmention.pages", Array.isArray(pages) ? pages.length : 0);
  const now = Date.now();

  const priorRows = await db.prepare(`SELECT source, target, last_sent_at FROM ${TABLE}`).all(); spent++;
  const prior = new Map();
  for (const r of (priorRows && priorRows.results) || []) prior.set(`${r.source}|${r.target}`, r.last_sent_at || 0);
  const freshAt = (source, target) => now - (prior.get(`${source}|${target}`) ?? 0) < RESEND_AFTER_MS;

  const pageRead = (p) => prior.get(`${p}|${p}`) ?? 0;
  const queue = [...pages].sort((a, b) => pageRead(a) - pageRead(b));

  let sent = 0, discovered = 0, considered = 0, pagesRead = 0;
  const affordable = () => spent + COST_PER_TARGET <= SUBREQUEST_BUDGET;

  for (const pageUrl of queue) {
    if (sent >= MAX_SENDS_PER_RUN || spent + COST_PER_PAGE + COST_PER_TARGET > SUBREQUEST_BUDGET) break;
    if (freshAt(pageUrl, pageUrl)) continue;

    const html = await span("webmention.fetch_own_page", (s) => {
      s.setAttribute("webmention.source", pageUrl);
      return fetchOwnPage(pageUrl, env);
    });
    spent += COST_PER_PAGE;
    if (!html) continue;
    pagesRead++;

    for (const target of citationsIn(html, origin)) {
      if (sent >= MAX_SENDS_PER_RUN || !affordable()) break;
      considered++;

      if (freshAt(pageUrl, target)) continue;

      const endpoint = await span("webmention.discover", (s) => {
        s.setAttribute("webmention.target_host", hostOf(target));
        return discoverEndpoint(target);
      });
      spent++;
      if (!endpoint) {
        await recordSend(db, pageUrl, target, null, null, now); spent++;
        continue;
      }
      discovered++;

      const status = await span("webmention.post", async (s) => {
        s.setAttribute("webmention.target_host", hostOf(target));
        const st = await postMention(endpoint, pageUrl, target);
        s.setAttribute("http.response.status_code", st);
        return st;
      });
      spent++;
      await recordSend(db, pageUrl, target, endpoint, status, now); spent++;
      sent++;
    }

    await recordSend(db, pageUrl, pageUrl, null, null, now); spent++;
  }

  sSend.setAttribute("webmention.considered", considered);
  sSend.setAttribute("webmention.discovered", discovered);
  sSend.setAttribute("webmention.sent", sent);
  sSend.setAttribute("webmention.pages_read", pagesRead);
  sSend.setAttribute("webmention.budget_spent", spent);
  sSend.setAttribute("webmention.capped", sent >= MAX_SENDS_PER_RUN || !affordable());
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

export async function discoverEndpoint(target) {
  try {
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const followed = await fetchFollowingPublicRedirects(target, () => ({
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
      signal,
    }), validateLensTarget, 20); // Preserve native fetch's redirect allowance.
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
  } catch { return null; }
}

function abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function postMention(endpoint, source, target) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
      },
      body: new URLSearchParams({ source, target }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    void res.body?.cancel?.();
    return res.status;
  } catch { return 0; }
}
