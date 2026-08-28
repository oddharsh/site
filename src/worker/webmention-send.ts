import { validateLensTarget } from "./lens.ts";
import { privateHostBlocked, readResponseCapped } from "./lib/crawl.ts";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.ts";
import { span } from "./lib/trace.ts";
import { asText } from "./lib/parse.ts";

const SEND_TIMEOUT_MS = 8000;
const PAGE_BYTE_CAP = 512 * 1024;
const DISCOVERY_BYTE_CAP = 256 * 1024;
// Politeness cap per run, and the one bound that is about the RECEIVER rather
// than about us. The tick is daily (41 5 * * *, shared with /around); a run that
// re-notified every citation on every page would be a small crawl of its own.
//
// Under the subrequest budget below it cannot currently bind — 40 subrequests buy
// at most ~12 sends — so it is the ceiling that takes over if that budget is ever
// raised, which is what moving off Workers Free would do (the cap there is 1000).
// Kept rather than deleted because the two bounds answer different questions and
// only one of them is about being a good citizen.
const MAX_SENDS_PER_RUN = 25;
// Don't re-notify the same (source,target) pair more often than this. A
// re-send is legitimate (it's the spec's update signal) but weekly is plenty.
const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// THE BOUND THAT DECIDES THE SHAPE OF THIS JOB. Workers Free allows 50
// subrequests per invocation, and every D1 statement, every asset read and every
// outbound fetch is one (gotcha 36 — a fan-out that crosses it arrives as an
// ordinary exception, which a job written to swallow its own failures reports as
// silence). A full sweep here is ~35 pages plus ~100 citations at 2-3 statements
// each, so it was never going to fit and the honest move is to spend a budget and
// come back tomorrow rather than to die two thirds of the way through.
//
// 40 rather than 50, because this count is an ESTIMATE and has to fail on the
// safe side: a page read dispatches through route(), which reads the asset and
// may touch the Workers cache on the way, and none of that is visible from here.
// The headroom is what covers the difference.
const SUBREQUEST_BUDGET = 40;
// What one citation costs at worst: discover, POST, record. The loop stops while
// it can still afford a whole one, so a target is never half-processed.
const COST_PER_TARGET = 3;
// And what one page costs at worst, charged up front for the same reason: the
// dispatch is one call here and more than one subrequest down there.
const COST_PER_PAGE = 3;

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
// Traced with both CAPS as first-class attributes. A run stops on whichever of
// MAX_SENDS_PER_RUN (politeness, about the receivers) or SUBREQUEST_BUDGET
// (the platform, about us) it reaches first, and either one leaves work undone
// while looking, in the summary log, exactly like a run that finished.
// `webmention.capped` and `webmention.budget_spent` are the difference. The
// per-target spans additionally separate the three outcomes the summary line
// fuses — no endpoint (the common, fine case), an endpoint that took the POST,
// and an endpoint that rejected it.
export async function cronSendWebmentions(env, origin = "https://aadhar.sh") {
  return span("webmention.send", (s) => cronSendWebmentionsInner(env, origin, s));
}

async function cronSendWebmentionsInner(env, origin, sSend) {
  const db = env.SOCIAL_DB;
  if (!db) {
    sSend.setAttribute("webmention.outcome", "db_unbound");
    console.warn("webmention-send: SOCIAL_DB unbound; skipping");
    // the full shape even here, so a caller reading `pagesRead` or `spent` off
    // this job never has to ask which branch it came back from.
    return { sent: 0, discovered: 0, considered: 0, pagesRead: 0, spent: 0, skipped: "unbound" };
  }
  let spent = 0;
  await ensureTable(db); spent++;

  const pages = await span("webmention.own_pages", () => mentionablePages(env, origin));
  sSend.setAttribute("webmention.pages", Array.isArray(pages) ? pages.length : 0);
  const now = Date.now();

  // ONE read of everything this job has ever recorded, rather than a SELECT per
  // citation. The table holds one row per (page, citation) plus one marker row
  // per page, so it is a few hundred rows and it buys back ~100 subrequests —
  // which is the whole difference between a run that finishes and a run that
  // dies at the platform cap.
  const priorRows = await db.prepare(`SELECT source, target, last_sent_at FROM ${TABLE}`).all(); spent++;
  const prior = new Map();
  for (const r of (priorRows && priorRows.results) || []) prior.set(`${r.source}|${r.target}`, r.last_sent_at || 0);
  const freshAt = (source, target) => now - (prior.get(`${source}|${target}`) ?? 0) < RESEND_AFTER_MS;

  // ROTATION, and it needs the marker rows to work. A bounded run always starts
  // at the top of the list, so without a memory of which pages have been READ the
  // first few would be swept every night and the tail never at all — and the
  // twelve pages that cite nothing would starve it hardest, because a page with
  // no citations writes no row and so always looks new. The marker is the
  // self-pair (source === target), which no real citation can ever be:
  // citationsIn drops same-origin links, so the two key spaces cannot collide.
  const pageRead = (p) => prior.get(`${p}|${p}`) ?? 0;
  const queue = [...pages].sort((a, b) => pageRead(a) - pageRead(b));

  let sent = 0, discovered = 0, considered = 0, pagesRead = 0;
  const affordable = () => spent + COST_PER_TARGET <= SUBREQUEST_BUDGET;

  for (const pageUrl of queue) {
    if (sent >= MAX_SENDS_PER_RUN || spent + COST_PER_PAGE + COST_PER_TARGET > SUBREQUEST_BUDGET) break;
    // A page whose own marker is fresh has had every citation on it recorded
    // within the window, so re-reading it can only produce rows we would skip.
    // Costs nothing to check and is what makes the rotation advance.
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

      // already told them recently? the spec's re-send is an update signal, not
      // a heartbeat, so this stays quiet between real changes.
      if (freshAt(pageUrl, target)) continue;

      const endpoint = await span("webmention.discover", (s) => {
        s.setAttribute("webmention.target_host", hostOf(target));
        return discoverEndpoint(target);
      });
      spent++;
      if (!endpoint) {
        // No endpoint is the common case and not a failure. Record it so the
        // next run doesn't re-probe the same URL for a week.
        await recordSend(db, pageUrl, target, null, null, now); spent++;
        continue;
      }
      discovered++;

      const status = await span("webmention.post", async (s) => {
        s.setAttribute("webmention.target_host", hostOf(target));
        const st = await postMention(endpoint, pageUrl, target);
        // the receiving endpoint's verdict. Stored in D1 per pair, but a run-level
        // view of "who is rejecting my mentions" needed a query nobody writes.
        s.setAttribute("http.response.status_code", st);
        return st;
      });
      spent++;
      await recordSend(db, pageUrl, target, endpoint, status, now); spent++;
      sent++;
    }

    // The marker, written LAST so a page only counts as swept once its citations
    // are. A run that ran out of budget mid-page leaves it unmarked and picks it
    // up first tomorrow.
    await recordSend(db, pageUrl, pageUrl, null, null, now); spent++;
  }

  sSend.setAttribute("webmention.considered", considered);
  sSend.setAttribute("webmention.discovered", discovered);
  sSend.setAttribute("webmention.sent", sent);
  sSend.setAttribute("webmention.pages_read", pagesRead);
  sSend.setAttribute("webmention.budget_spent", spent);
  // the honest cap flags: either means this run stopped early and there is more
  // to do, which the summary line below cannot express.
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
        if (p && asText(p.slug) !== null) paths.push(`/writing/${p.slug}`);
      }
    } catch {}
  }
  return paths.map((p) => origin + p);
}

// Read one of my own pages, IN-PROCESS.
//
// This used to be a plain `fetch(url)` at the public origin, with a comment
// saying it went over the network on purpose because the worker-rendered pages
// (writing posts) do not exist as static files. The reasoning is right and the
// mechanism is not available: a fetch to our own hostname from inside this worker
// is blocked as recursion (error 1042), which perf-probe.js and lens's SELF_FETCH
// each already document. It failed by RETURNING "" — the catch is right there —
// so every page was skipped, every run wrote nothing, and the job reported the
// same silence a working job reports.
//
// Measured 2026-08-28, weeks after the feature shipped: `webmentions_sent` held
// zero rows, `webmentions` held zero rows, and /around on the same daily tick had
// run that morning. The whole outbound half had never fetched one page.
//
// SELF_FETCH dispatches through route() and is what a reader would have got,
// worker enhancement included; index.js sets IDENTITY_BODY on it so the
// precompressed page tier arrives readable rather than as raw brotli. ASSETS is
// the fallback for a caller that has no dispatcher (dev, tests): it returns the
// pre-enhancement static bytes, which is worse but is still the page's own links.
// There is deliberately NO plain-fetch arm, because that arm is the bug.
async function fetchOwnPage(url, env) {
  const req = new Request(url, {
    headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html" },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const read = env?.SELF_FETCH
    ? (r) => env.SELF_FETCH(r)
    : env?.ASSETS
      ? (r) => env.ASSETS.fetch(r)
      : null;
  if (!read) { console.warn("webmention-send: no SELF_FETCH or ASSETS; cannot read own pages"); return ""; }
  try {
    const res = await read(req);
    if (!res || !res.ok) return "";
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
    .replace(/<head\b[\s\S]*?<\/head\b[^>]*>/i, " ")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|--!>)/g, " ");
}

// Every external link in the page's own content, deduped, minus my own profiles
// and anything the SSRF guard won't touch.
export function citationsIn(html, origin) {
  const out = new Set<string>();
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
      void res.body?.cancel?.();
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
    void res.body?.cancel?.();
    return res.status;
  } catch { return 0; }
}
