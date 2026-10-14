import { fetchFollowingPublicRedirects, privateHostBlocked, validateLensTarget } from "./lib/public-fetch.ts";
import { readResponseCapped } from "./lib/crawl.ts";
import { esc, extractMeta, extractTitle } from "./lib/http.ts";
import { mf2All, mf2First, mf2Strings, mf2Values, parseMf2 } from "./lib/mf2.ts";
import { overBudget, rateLimitedHeaders } from "./lib/ratelimit.ts";
import { sign, verify } from "./lib/sign.ts";
import { resendSend } from "../../cal/src/email.ts";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.ts";
import { span } from "./lib/trace.ts";
import { sortLine, sortMention, sortSubjectTag } from "./webmention-sort.ts";

export const WEBMENTION_BUDGET = { binding: "WEBMENTION_RL", max: 10 };
const SOURCE_BYTE_CAP = 512 * 1024;
const SOURCE_TIMEOUT_MS = 8000;
const EXCERPT_MAX = 320;

const TABLE = "webmentions";
let ensured = false;
async function ensureTable(db) {
  if (ensured) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'mention',
      author TEXT,
      author_url TEXT,
      title TEXT,
      excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      received_at INTEGER NOT NULL,
      approved_at INTEGER,
      UNIQUE (source, target)
    )`
  ).run();
  ensured = true;
}

async function mentionId(source, target) {
  const data = new TextEncoder().encode(`${source}|${target}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest).subarray(0, 12).toHex();
}

export async function handleWebmention(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  }
  if (request.method !== "POST") {
    return text("This is the Webmention endpoint for aadhar.sh. POST source= and target= (application/x-www-form-urlencoded). See https://www.w3.org/TR/webmention/", 405);
  }

  let form;
  try { form = await request.formData(); } catch { return text("Send application/x-www-form-urlencoded with source and target.", 400); }
  const source = String(form.get("source") || "").trim();
  const target = String(form.get("target") || "").trim();

  if (!source || !target) return text("Both source and target are required.", 400);
  if (source === target) return text("source and target must differ.", 400);

  const origin = new URL(request.url).origin;
  const targetPath = sameOriginPath(target, origin);
  if (!targetPath) return text("target must be a URL on this site.", 400);
  if (!(await acceptsWebmention(targetPath, env))) {
    return text("That page does not accept webmentions.", 400);
  }

  const checked = validateLensTarget(source);
  if (!checked.ok) return text(`source: ${checked.error}`, 400);

  if (!absoluteHttpUrl(source)) return text("source must be an absolute http(s) URL.", 400);
  if (sameOriginPath(checked.url, origin)) return text("source must be on another site.", 400);

  if (await overBudget(WEBMENTION_BUDGET, request, env)) {
    return text("Too many webmentions from this address; try again in a minute.", 429, rateLimitedHeaders("webmention", WEBMENTION_BUDGET.max));
  }

  const job = processMention(checked.url, origin + targetPath, request, env)
    .catch((e) => console.error("webmention processing failed", e?.message || e));
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;

  // 202 and NO Location header. The spec ties Location to 201, where it must
  // point at a status URL the sender can poll; on a 200 or 202 it has no
  // defined meaning, and webmention.rocks receiver test #1 fails a 202 that
  // carries one. /inbox was never a status URL for this mention anyway, since
  // a pending mention deliberately does not appear there. It stays in the body,
  // which is where a human poking at the endpoint will read it.
  return text("Accepted. It will appear at /inbox once verified and approved.", 202);
}

async function processMention(source, target, request, env) {
  const fetched = await fetchSource(source);

  // Retraction path: the source is gone (410/404) or no longer links here.
  // Both mean the mention should stop being displayed, per the spec's
  // update/delete semantics. Only touches an EXISTING row; a first-time send
  // that fails verification simply never becomes a row.
  // fetched.url, not `source`: relative and protocol-relative hrefs resolve
  // against where the document actually came FROM, which differs whenever the
  // source redirected.
  if (!fetched.ok || !linksTo(fetched.html, target, fetched.url)) {
    await retract(env, source, target, fetched.ok ? "source no longer links here" : `source unreachable (${fetched.status})`);
    return;
  }

  const parsed = parseSource(fetched.html, fetched.url, target);
  const id = await mentionId(source, target);
  const db = env.SOCIAL_DB;
  if (!db) { console.warn("webmention verified but SOCIAL_DB is unbound; dropping", source); return; }
  await ensureTable(db);

  const row = await db.prepare(
    `INSERT INTO ${TABLE} (id, source, target, kind, author, author_url, title, excerpt, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(source, target) DO UPDATE SET
       kind = excluded.kind, author = excluded.author, author_url = excluded.author_url,
       title = excluded.title, excerpt = excluded.excerpt, received_at = excluded.received_at
     RETURNING status`
  ).bind(id, source, target, parsed.kind, parsed.author, parsed.authorUrl, parsed.title, parsed.excerpt, Date.now()).first();

  if (row?.status === "approved") return;

  await emailHost(env, request, { id, source, target, ...parsed });
}

async function retract(env, source, target, why) {
  const db = env.SOCIAL_DB;
  if (!db) return;
  await ensureTable(db);
  const res = await db.prepare(`DELETE FROM ${TABLE} WHERE source = ? AND target = ?`).bind(source, target).run();
  if (res?.meta?.changes) console.log(`webmention retracted (${why})`, source, "->", target);
}

async function fetchSource(url) {
  try {
    const signal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
    const followed = await fetchFollowingPublicRedirects(
      url,
      () => ({
        headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html,application/xhtml+xml" },
        signal,
      }),
      (candidate) => {
        try {
          const u = new URL(candidate);
          if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "not http(s)" };
          if (privateHostBlocked(u.hostname)) return { ok: false, error: "private host" };
          return { ok: true };
        } catch { return { ok: false, error: "unparseable" }; }
      },
    );
    if (!followed.ok) return { ok: false, status: 0, html: "", url: followed.url || url };
    const res = followed.response;
    const finalUrl = followed.finalUrl || res.url || url;
    if (!res.ok) return { ok: false, status: res.status, html: "", url: finalUrl };
    const body = await readResponseCapped(res, SOURCE_BYTE_CAP);
    return { ok: true, status: res.status, html: body?.text || body || "", url: finalUrl };
  } catch {
    return { ok: false, status: 0, html: "", url };
  }
}

const INERT_REGIONS = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|textarea|svg|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

export function documentContent(html) {
  return String(html ?? "").replace(INERT_REGIONS, " ");
}

function canonicalForCompare(url) {
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
}

export function linksTo(html, target, sourceUrl) {
  let wanted;
  try { wanted = canonicalForCompare(new URL(target)); } catch { return false; }
  for (const m of documentContent(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const raw = m[1].replace(/^["']|["']$/g, "").trim();
    if (!raw) continue;
    try {
      if (canonicalForCompare(new URL(raw, sourceUrl || undefined)) === wanted) return true;
    } catch { }
  }
  return false;
}

export function parseSource(html, sourceUrl, target) {
  const doc = parseMf2(html, sourceUrl);
  const entry = entryOf(doc, sourceUrl);
  const author = authorOf(html, sourceUrl, doc, entry);
  const name = squash(explicit(entry, "name")).slice(0, 200);
  const title = name || clean((extractTitle(html) || "").slice(0, 200)) || new URL(sourceUrl).hostname;
  return {
    kind: mentionKind(html, target),
    author: author.name,
    authorUrl: author.url,
    authorPhoto: author.photo,
    title,
    excerpt: excerptAround(html, target),
    name,
    url: httpUrl(mf2First(entry, "url")),
    published: squash(mf2First(entry, "published")).slice(0, 64),
  };
}

function entryOf(doc, sourceUrl) {
  const entries = mf2All(doc).filter((i) => i.type.includes("h-entry"));
  const self = sameUrl(sourceUrl);
  return entries.find((e) => mf2Strings(e, "url").some((u) => sameUrl(u) === self)) || entries[0];
}

function explicit(entry, prop) {
  if (!entry || entry.implied?.includes(prop)) return "";
  return mf2First(entry, prop);
}

// The rungs, in order. The first four are the IndieWeb authorship algorithm
// (https://indieweb.org/authorship-spec) without its one network step: we never
// fetch an author page, because this runs on a stranger's say-so.
//
//   1. the h-entry's author property
//   2. the author of an h-feed the entry sits in
//   3. rel=author
//   4. the page's representative h-card (uid = url = page, or url is a rel=me)
//   5. a top-level h-card whose url is the source site's home page, which is how
//      a personal site marks up its owner in a sidebar
//   6. <meta name="author">, then the host of any author URL found above, then
//      the source's host
function authorOf(html, sourceUrl, doc, entry) {
  const all = mf2All(doc);
  const cards = all.filter((i) => i.type.includes("h-card"));
  const feed = entry && all.find((i) => i.type.includes("h-feed") && (i.children || []).includes(entry));
  const asItems = (card) => (card ? [{ item: card }] : []);
  const rungs = [
    () => mf2Values(entry, "author"),
    () => mf2Values(feed, "author"),
    () => (doc.rels.author || []).map((text) => ({ text })),
    () => asItems(representativeCard(doc, sourceUrl)),
    () => asItems(homeCard(doc, sourceUrl)),
  ];

  let found: { name: string; url: string; photo: string } | null = null;
  for (const rung of rungs) {
    for (const v of rung()) {
      found = resolveAuthor(v, cards);
      if (found) break;
    }
    if (found) break;
  }

  const url = httpUrl(found?.url) || new URL(sourceUrl).origin;
  const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");
  const name = [found?.name, extractMeta(html, "author"), found?.url && httpUrl(found.url) ? hostOf(found.url) : "", hostOf(sourceUrl)]
    .map((n) => squash(n || "").slice(0, 120))
    .find(Boolean) ?? hostOf(sourceUrl);
  return { name, url: url.slice(0, 500), photo: httpUrl(found?.photo) };
}

function resolveAuthor(v, cards) {
  if ("item" in v) {
    const it = v.item;
    if (it.type.includes("h-card")) {
      const card = { name: mf2First(it, "name"), url: mf2First(it, "url"), photo: mf2First(it, "photo") };
      return squash(card.name) || httpUrl(card.url) ? card : null;
    }
    return squash(it.value) ? { name: it.value, url: "", photo: "" } : null;
  }
  const s = v.text.trim();
  if (!s) return null;
  if (!httpUrl(s)) return { name: s, url: "", photo: "" };
  const card = cards.find((c) => mf2Strings(c, "url").some((u) => sameUrl(u) === sameUrl(s)));
  return card
    ? { name: mf2First(card, "name"), url: s, photo: mf2First(card, "photo") }
    : { name: "", url: s, photo: "" };
}

// https://microformats.org/wiki/representative-h-card-parsing, over top-level
// cards only, as the spec says.
function representativeCard(doc, pageUrl) {
  const page = sameUrl(pageUrl);
  const top = doc.items.filter((i) => i.type.includes("h-card"));
  const urls = (c, p) => mf2Strings(c, p).map(sameUrl);
  const me = (doc.rels.me || []).map(sameUrl);
  const byUid = top.find((c) => urls(c, "uid").includes(page) && urls(c, "url").includes(page));
  if (byUid) return byUid;
  const byMe = top.find((c) => urls(c, "url").some((u) => me.includes(u)));
  if (byMe) return byMe;
  const byUrl = top.filter((c) => urls(c, "url").includes(page));
  return byUrl.length === 1 ? byUrl[0] : null;
}

function homeCard(doc, pageUrl) {
  const home = sameUrl(new URL("/", pageUrl).href);
  return doc.items.find((c) => c.type.includes("h-card") &&
    mf2Strings(c, "url").some((u) => sameUrl(u) === home)) || null;
}

function sameUrl(raw) {
  try { return canonicalForCompare(new URL(raw)); } catch { return ""; }
}

function httpUrl(raw) {
  const s = String(raw || "").trim();
  return absoluteHttpUrl(s) ? s.slice(0, 500) : "";
}

function mentionKind(html, target) {
  const window = 400;
  const content = documentContent(html);
  const idx = content.indexOf(target);
  const near = idx === -1 ? content : content.slice(Math.max(0, idx - window), idx + window);
  if (/\bu-in-reply-to\b/i.test(near)) return "reply";
  if (/\bu-like-of\b/i.test(near)) return "like";
  if (/\bu-repost-of\b/i.test(near)) return "repost";
  if (/\bu-bookmark-of\b/i.test(near)) return "bookmark";
  return "mention";
}

function excerptAround(html, target) {
  const stripped = String(html)
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg\b[^>]*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\b[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|--!>)/g, " ");
  const e = firstMatch(stripped, /class="[^"]*\be-content\b[^"]*"[^>]*>([\s\S]{0,1200})</i);
  const hay = e || stripped;
  const idx = hay.indexOf(target);
  const start = idx === -1 ? 0 : Math.max(0, idx - 400);
  let slice = idx === -1 ? hay.slice(0, 1200) : hay.slice(start, idx + 400);

  if (start > 0) {
    const lt = slice.indexOf("<"), gt = slice.indexOf(">");
    if (gt !== -1 && (lt === -1 || gt < lt)) slice = slice.slice(gt + 1);
  }
  slice = slice.replace(/<[^>]*$/, "");

  const textOnly = clean(slice.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " "));
  return textOnly.slice(0, EXCERPT_MAX);
}

function firstMatch(s, re) { return (String(s).match(re) || [])[1] || ""; }
function clean(s) {
  return String(s || "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }[m] || " "))
    .replace(/\s+/g, " ").trim();
}
function squash(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

async function emailHost(env, request, m) {
  if (!env.SIGNING_SECRET || !env.RESEND_API_KEY || !env.HOST_EMAIL) {
    console.warn("webmention pending but mail/signing is unconfigured; approve at /inbox once wired", m.source);
    return;
  }
  const origin = new URL(request.url).origin;
  const sort = await span("webmention.sort", async (s) => {
    const r = await sortMention(env, m);
    s.setAttribute("webmention.sort_outcome", "error" in r ? r.error : "clef");
    if (!("error" in r)) {
      s.setAttribute("webmention.sort_verdict", r.verdict);
      s.setAttribute("webmention.sort_p_spam", r.probabilities.spam);
    }
    return r;
  });
  const approve = `${origin}/webmention/approve?t=${m.id}&sig=${await sign(`${m.id}|approve`, env.SIGNING_SECRET)}`;
  const decline = `${origin}/webmention/decline?t=${m.id}&sig=${await sign(`${m.id}|decline`, env.SIGNING_SECRET)}`;
  const html = `
    <p><strong>${esc(m.author)}</strong> ${esc(kindPhrase(m.kind))} <a href="${esc(m.target)}">${esc(m.target.replace(origin, ""))}</a></p>
    <p><a href="${esc(m.source)}">${esc(m.title)}</a>${m.published ? ` <span style="color:#888">published ${esc(m.published)}</span>` : ""}</p>
    ${m.excerpt ? `<blockquote style="border-left:3px solid #888;padding-left:.8em;margin-left:0;color:#333">${esc(m.excerpt)}</blockquote>` : ""}
    <p style="color:#555">${esc(sortLine(sort))}</p>
    <p>
      <a href="${approve}" style="display:inline-block;padding:8px 14px;background:#0a0;color:#fff;text-decoration:none;border-radius:3px">approve &amp; publish</a>
      &nbsp;&nbsp;
      <a href="${decline}" style="display:inline-block;padding:8px 14px;background:#900;color:#fff;text-decoration:none;border-radius:3px">decline</a>
    </p>
    <p style="color:#888;font-size:12px">verified: the source really does link to that page. signed url; only you can use these.</p>
  `;
  await resendSend(env, {
    from: "aadhar.sh <noreply@aadhar.sh>",
    to: [env.HOST_EMAIL],
    subject: `${sortSubjectTag(sort)}✉ ${m.author} ${kindPhrase(m.kind)} ${m.target.replace(origin, "")}`,
    html,
  });
}

function kindPhrase(kind) {
  return kind === "reply" ? "replied to" : kind === "like" ? "liked" : kind === "repost" ? "reposted" : kind === "bookmark" ? "bookmarked" : "mentioned";
}

export async function handleWebmentionDecision(request, env, ctx, url) {
  const decision = url.pathname.endsWith("/approve") ? "approve" : "decline";
  const id = url.searchParams.get("t") || "";
  const sig = url.searchParams.get("sig") || "";
  if (!id || !sig || !env.SIGNING_SECRET) return text("Invalid link.", 400);
  if (!(await verify(`${id}|${decision}`, sig, env.SIGNING_SECRET))) return text("That link is not valid.", 403);

  const db = env.SOCIAL_DB;
  if (!db) return text("The mention store is not connected.", 503);
  await ensureTable(db);

  if (decision === "approve") {
    await db.prepare(`UPDATE ${TABLE} SET status = 'approved', approved_at = ? WHERE id = ?`).bind(Date.now(), id).run();
    return text("Approved — it's live at /inbox.", 200);
  }
  await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id).run();
  return text("Declined — nothing published.", 200);
}

export async function readApprovedMentions(env, limit = 200) {
  if (!env.SOCIAL_DB) return { state: "unbound", mentions: [] };
  try {
    await ensureTable(env.SOCIAL_DB);
    const r = await env.SOCIAL_DB.prepare(
      `SELECT source, target, kind, author, author_url, title, excerpt, approved_at
       FROM ${TABLE} WHERE status = 'approved' ORDER BY approved_at DESC LIMIT ?`
    ).bind(Math.min(limit, 500)).all();
    const mentions = (r && r.results) || [];
    return { state: mentions.length ? "ok" : "empty", mentions };
  } catch (e) {
    return { state: "error", mentions: [] };
  }
}

const WEBMENTION_PATH_SET = new Set(WEBMENTION_PATHS);

export async function acceptsWebmention(path, env) {
  if (WEBMENTION_PATH_SET.has(path)) return true;
  if (!WEBMENTION_SECTIONS.includes("/writing") || !path.startsWith("/writing/")) return false;
  const slug = path.slice("/writing/".length);
  if (!slug || slug.includes("/") || slug.includes(".")) return false;
  try {
    const res = await env.ASSETS.fetch("https://assets.local/writing/posts.json");
    if (!res.ok) return false;
    const posts = await res.json();
    return Array.isArray(posts) && posts.some((p) => p.slug === slug);
  } catch { return false; }
}

/** A URL a machine sent, rather than a string a person typed: it carries an
 *  http(s) scheme and a host of its own, and nothing is inferred.
 *
 *  The SHAPE is checked before the parse, and that order is the whole point.
 *  WHATWG parsing is forgiving about the slashes after a scheme, so
 *  `new URL("https:///some/path")` does not come back host-less the way it
 *  reads: it comes back with host `some` and path `/path`. So a parse-only
 *  check accepts it, and what it accepts is an instruction to fetch a hostname
 *  the sender never wrote. Found by the suite's network tripwire, which caught
 *  a test firing at `https://no-host/`. */
export function absoluteHttpUrl(raw) {
  const s = String(raw ?? "");
  if (!/^https?:\/\/[^/\\?#]/i.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch { return false; }
}

function sameOriginPath(raw, origin) {
  try {
    const u = new URL(raw);
    if (u.origin !== origin) return null;
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch { return null; }
}

function text(body, status, extra = {}) {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra },
  });
}
