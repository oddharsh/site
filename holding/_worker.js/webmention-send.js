// webmention-send.js — the OUTBOUND half: this site telling the sources it
// cites that it linked to them. The mirror of webmention.js, and the reason the
// pair is worth having: a site that accepts mentions but never sends them is
// taking from the commons without paying in. Same good-citizenship instinct as
// llms.txt and the signed crawler.
//
// Runs on cron, never on a visitor request — the same discipline /around
// follows. A page render must never fan out to N third-party hosts.
//
// WHAT COUNTS AS A CITATION (the one real design question here):
// these pages mix two kinds of external link. Citations sit in the content
// ("concepts credit officialunofficial/mkit", a link to the iroh repo). Chrome
// links are stamped on every page by the desktop shell — my own GitHub, Spotify,
// Instagram. Webmentioning my own Spotify from 15 garage pages would be absurd,
// so the filter is: in-content links only, minus same-origin, minus my own
// profile domains.
//
// Discovery does the rest of the filtering for free. Most cited sources (repos,
// docs sites) advertise no endpoint, so the send is a silent no-op. That means
// there is no allowlist to maintain: send to every real citation, and only the
// webmention-aware ones light up.
import { validateLensTarget } from "./lens.js";
import { privateHostBlocked, readResponseCapped } from "./lib/crawl.js";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.js";

const SEND_TIMEOUT_MS = 8000;
const PAGE_BYTE_CAP = 512 * 1024;
const DISCOVERY_BYTE_CAP = 256 * 1024;
// Politeness cap per run. The cron fires every 30 minutes; a run that tried to
// re-notify every citation on every page would be a small crawl of its own.
const MAX_SENDS_PER_RUN = 25;
// Don't re-notify the same (source,target) pair more often than this. A
// re-send is legitimate (it's the spec's update signal) but nightly is plenty.
const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// My own profile links, stamped into every page by the desktop shell. Kept in
// sync with nav.js PROFILES by a contract test rather than by hope.
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

// ── the cron entry point ───────────────────────────────────────────────────
export async function cronSendWebmentions(env, origin = "https://aadhar.sh") {
  const db = env.SOCIAL_DB;
  if (!db) { console.warn("webmention-send: SOCIAL_DB unbound; skipping"); return { sent: 0, skipped: "unbound" }; }
  await ensureTable(db);

  const pages = await mentionablePages(env, origin);
  const now = Date.now();
  let sent = 0, discovered = 0, considered = 0;

  for (const pageUrl of pages) {
    if (sent >= MAX_SENDS_PER_RUN) break;
    const html = await fetchOwnPage(pageUrl);
    if (!html) continue;

    for (const target of citationsIn(html, origin)) {
      if (sent >= MAX_SENDS_PER_RUN) break;
      considered++;

      // already told them recently? the spec's re-send is an update signal, not
      // a heartbeat, so this stays quiet between real changes.
      const prior = await db.prepare(
        `SELECT last_sent_at FROM ${TABLE} WHERE source = ? AND target = ?`
      ).bind(pageUrl, target).first();
      if (prior && now - prior.last_sent_at < RESEND_AFTER_MS) continue;

      const endpoint = await discoverEndpoint(target);
      if (!endpoint) {
        // No endpoint is the common case and not a failure. Record it so the
        // next run doesn't re-probe the same URL for a week.
        await db.prepare(
          `INSERT INTO ${TABLE} (source, target, endpoint, status, last_sent_at) VALUES (?, ?, NULL, NULL, ?)
           ON CONFLICT(source, target) DO UPDATE SET endpoint = NULL, status = NULL, last_sent_at = excluded.last_sent_at`
        ).bind(pageUrl, target, now).run();
        continue;
      }
      discovered++;

      const status = await postMention(endpoint, pageUrl, target);
      await db.prepare(
        `INSERT INTO ${TABLE} (source, target, endpoint, status, last_sent_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, target) DO UPDATE SET endpoint = excluded.endpoint, status = excluded.status, last_sent_at = excluded.last_sent_at`
      ).bind(pageUrl, target, endpoint, status, now).run();
      sent++;
    }
  }

  console.log(`webmention-send: ${considered} citations considered, ${discovered} endpoints found, ${sent} sent`);
  return { sent, discovered, considered };
}

// Every page that accepts mentions also SENDS them: if a page is public enough
// to be written about, it's public enough to credit what it cites. /writing is a
// section, so its leaf posts come from posts.json.
export async function mentionablePages(env, origin) {
  const paths = WEBMENTION_PATHS.filter((p) => !WEBMENTION_SECTIONS.includes(p));
  for (const section of WEBMENTION_SECTIONS) {
    if (section !== "/writing") continue;
    try {
      const res = await env.ASSETS.fetch("https://assets.local/writing/posts.json");
      if (!res.ok) continue;
      const posts = await res.json();
      for (const p of Array.isArray(posts) ? posts : []) {
        if (p && typeof p.slug === "string") paths.push(`/writing/${p.slug}`);
      }
    } catch {}
  }
  return paths.map((p) => origin + p);
}

// Read one of my own pages. Goes over the network to the public origin rather
// than through ASSETS, because the worker-rendered pages (writing posts) don't
// exist as static files — what a reader sees is what should be credited.
async function fetchOwnPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const body = await readResponseCapped(res, PAGE_BYTE_CAP);
    return body?.text || "";
  } catch { return ""; }
}

// ── the citation filter ────────────────────────────────────────────────────
// Strip the shell before looking for links: the desktop chrome (icons, taskbar,
// tray) is injected into every page between markers and is where every one of my
// own profile links lives. What survives is the page's own content.
export function contentOf(html) {
  return String(html)
    .replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, " ")
    .replace(/<!-- axp:desktop -->[\s\S]*?<!-- \/axp:desktop -->/g, " ")
    .replace(/<head\b[\s\S]*?<\/head>/i, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

// Every external link in the page's own content, deduped, minus my own profiles
// and anything the SSRF guard won't touch.
export function citationsIn(html, origin) {
  const out = new Set();
  for (const m of contentOf(html).matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    // An anchor whose job is to open a hover card is chrome, not a citation:
    // same reasoning as stripping the desktop shell, one level down. The car
    // references are the whole population here — `interestfor` (Interest
    // Invoker) on the garage pages, `class="car-link"` on the homepage — and
    // they point at Google SEARCH URLs, so telling google.com/search?q=Singer
    // it had been cited would be nonsense rather than good citizenship.
    if (/\binterestfor\s*=/i.test(tag) || /\bclass\s*=\s*("[^"]*\bcar-link\b|'[^']*\bcar-link\b)/i.test(tag)) continue;
    const href = (tag.match(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i) || [])[1];
    if (!href) continue;
    const raw = href.replace(/^["']|["']$/g, "").trim();
    if (!/^https?:\/\//i.test(raw)) continue;             // relative + mailto + raycast:// etc
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin === origin) continue;                     // my own pages
    const bare = (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
    if (SELF_LINK_HOSTS.some((self) => bare === self || bare.startsWith(self + "/"))) continue;
    if (privateHostBlocked(u.hostname.toLowerCase())) continue;
    const checked = validateLensTarget(u.toString());
    if (!checked.ok) continue;
    u.hash = "";                                           // #anchor is the same document
    out.add(u.toString());
  }
  return [...out];
}

// ── discovery ──────────────────────────────────────────────────────────────
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
    const res = await fetch(target, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const finalUrl = res.url || target;
    if (privateHostBlocked(new URL(finalUrl).hostname.toLowerCase())) return null;
    const linkHeader = res.headers.get("link");
    // A HEAD-equivalent shortcut: if the Link header already names an endpoint,
    // don't read the body at all.
    if (linkHeader && /\bwebmention\b/i.test(linkHeader)) {
      res.body?.cancel?.();
      return findEndpointIn("", linkHeader, finalUrl);
    }
    if (!res.ok) return null;
    const body = await readResponseCapped(res, DISCOVERY_BYTE_CAP);
    const endpoint = findEndpointIn(body?.text || "", null, finalUrl);
    if (!endpoint) return null;
    // The endpoint itself is an attacker-supplied URL (it comes from a page I
    // don't control), so it gets the same guard as everything else.
    const checked = validateLensTarget(endpoint);
    return checked.ok && !privateHostBlocked(new URL(checked.url).hostname.toLowerCase()) ? checked.url : null;
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
    res.body?.cancel?.();
    return res.status;
  } catch { return 0; }
}
