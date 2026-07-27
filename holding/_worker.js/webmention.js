// webmention.js — the inbound half of Webmention (W3C REC, 2017): the open
// web's way to tell this site "I linked to you." Spiritually a trackback, which
// makes it period-correct for a site that renders as Windows XP, and it is the
// only standard mechanism by which someone else's page can appear on aadhar.sh.
//
// The lifecycle, and where each guarantee comes from:
//
//   1. POST /webmention {source, target}  — form-encoded, unauthenticated. The
//      open web is the sender, so there is no account to hold.
//   2. Cheap synchronous gate: is `target` one of MY pages, and one flagged
//      webmention:true in site-manifest.json? Is `source` a public http(s) URL?
//      Is this IP under budget? Then 202 Accepted and the work moves to
//      ctx.waitUntil — the spec explicitly allows async verification, and it
//      keeps a slow third-party fetch off the request path.
//   3. Verify (the anti-forgery step): fetch `source` as AadharshBot and confirm
//      it ACTUALLY links to `target`. This is why webmention isn't spam by
//      construction — you cannot claim a link that isn't there. The fetch reuses
//      Lens's SSRF guard (validateLensTarget) and capped reader, because
//      "fetch an attacker-supplied URL" is already a solved problem in this
//      codebase and solving it twice is how the second copy gets it wrong.
//   4. Store as PENDING and email the host a signed approve/decline pair, using
//      the same HMAC construction cal uses for booking approvals. Nothing is
//      displayed unmoderated: verification stops forgeries, moderation stops the
//      verified-but-garbage.
//   5. GET /webmention/approve?t=&sig= flips it live; /decline drops it.
//
// Re-sending is the spec's own edit/delete signal, so a repeat send re-verifies
// and, when the source no longer links here (or is gone), retracts the mention.
// A displayed mention should still be TRUE, the same reason /around re-crawls.
import { lensHostBlocked, validateLensTarget } from "./lens.js";
import { readResponseCapped } from "./lib/crawl.js";
import { esc, extractMeta, extractTitle } from "./lib/http.js";
import { sign, verify } from "../../cal/src/sign.js";
import { resendSend } from "../../cal/src/email.js";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.js";

export const WEBMENTION_PATH = "/webmention";
// One bucket, one ceiling, matching the /lens posture. Fails OPEN without KV
// (dev): this is abuse control, and the SSRF guard is what enforces safety.
const WM_BUDGET = { key: "wm:rl", max: 10 };
const SOURCE_BYTE_CAP = 512 * 1024;   // a blog post that needs more isn't a mention
const SOURCE_TIMEOUT_MS = 8000;
const EXCERPT_MAX = 320;

// ── storage ────────────────────────────────────────────────────────────────
// Its own database (SOCIAL_DB / aadhar-social), deliberately NOT the deploy-log
// DB: social content is third-party, moderated, and mutable, while the
// checkpoints table is the site's own append-only history. Created lazily like
// census.js and around.js do, so a fresh binding self-provisions instead of
// requiring a migration step before the route works. migrations/0001_init.sql
// carries the same DDL for anyone who prefers to apply it up front.
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

// A mention is identified by (source, target), so a re-send updates the existing
// row instead of minting a duplicate. Deterministic id keeps the signed
// approve/decline links stable across re-sends of the same pair.
async function mentionId(source, target) {
  const data = new TextEncoder().encode(`${source}|${target}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── POST /webmention ───────────────────────────────────────────────────────
export async function handleWebmention(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  }
  if (request.method !== "POST") {
    // GET on the endpoint is a human poking at it; say what it is rather than 405ing blankly.
    return text("This is the Webmention endpoint for aadhar.sh. POST source= and target= (application/x-www-form-urlencoded). See https://www.w3.org/TR/webmention/", 405);
  }

  let form;
  try { form = await request.formData(); } catch { return text("Send application/x-www-form-urlencoded with source and target.", 400); }
  const source = String(form.get("source") || "").trim();
  const target = String(form.get("target") || "").trim();

  if (!source || !target) return text("Both source and target are required.", 400);
  if (source === target) return text("source and target must differ.", 400);

  // target must be a real, mention-enabled page on THIS origin. Checking the
  // registry (not just the origin) means turning mentions on for a section is a
  // manifest flag, not a code change — and a target we don't accept gets a plain
  // 400 rather than a silently-swallowed mention.
  const origin = new URL(request.url).origin;
  const targetPath = sameOriginPath(target, origin);
  if (!targetPath) return text("target must be a URL on this site.", 400);
  if (!(await acceptsWebmention(targetPath, env))) {
    return text("That page does not accept webmentions.", 400);
  }

  // source must be a public http(s) URL — the same guard Lens uses before it
  // fetches anything a stranger names.
  const checked = validateLensTarget(source);
  if (!checked.ok) return text(`source: ${checked.error}`, 400);
  if (sameOriginPath(checked.url, origin)) return text("source must be on another site.", 400);

  if (await overBudget(request, env, ctx)) {
    return text("Too many webmentions from this address; try again in a minute.", 429);
  }

  // Accepted: everything past here is slow (a third-party fetch, D1, email), and
  // the spec is explicit that verification may be async. The sender gets 202
  // immediately and never waits on my moderation.
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

// verify → parse → store pending → email the host.
async function processMention(source, target, request, env) {
  const fetched = await fetchSource(source);

  // Retraction path: the source is gone (410/404) or no longer links here.
  // Both mean the mention should stop being displayed, per the spec's
  // update/delete semantics. Only touches an EXISTING row; a first-time send
  // that fails verification simply never becomes a row.
  if (!fetched.ok || !linksTo(fetched.html, target)) {
    await retract(env, source, target, fetched.ok ? "source no longer links here" : `source unreachable (${fetched.status})`);
    return;
  }

  const parsed = parseSource(fetched.html, fetched.url, target);
  const id = await mentionId(source, target);
  const db = env.SOCIAL_DB;
  if (!db) { console.warn("webmention verified but SOCIAL_DB is unbound; dropping", source); return; }
  await ensureTable(db);

  // A re-send of an already-approved mention refreshes its content but keeps it
  // approved — re-moderating an edit I already blessed would be busywork.
  await db.prepare(
    `INSERT INTO ${TABLE} (id, source, target, kind, author, author_url, title, excerpt, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(source, target) DO UPDATE SET
       kind = excluded.kind, author = excluded.author, author_url = excluded.author_url,
       title = excluded.title, excerpt = excluded.excerpt, received_at = excluded.received_at`
  ).bind(id, source, target, parsed.kind, parsed.author, parsed.authorUrl, parsed.title, parsed.excerpt, Date.now()).run();

  const row = await db.prepare(`SELECT status FROM ${TABLE} WHERE source = ? AND target = ?`).bind(source, target).first();
  if (row?.status === "approved") return;   // already live; no second email

  await emailHost(env, request, { id, source, target, ...parsed });
}

async function retract(env, source, target, why) {
  const db = env.SOCIAL_DB;
  if (!db) return;
  await ensureTable(db);
  const res = await db.prepare(`DELETE FROM ${TABLE} WHERE source = ? AND target = ?`).bind(source, target).run();
  if (res?.meta?.changes) console.log(`webmention retracted (${why})`, source, "->", target);
}

// ── fetching the source ────────────────────────────────────────────────────
// Identifies honestly as AadharshBot, follows redirects (a mention often comes
// from a shortened or canonical URL), re-checks the FINAL host against the
// blocklist so a public URL can't redirect into private space, and caps both
// time and bytes.
async function fetchSource(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    const finalUrl = res.url || url;
    if (lensHostBlocked(new URL(finalUrl).hostname.toLowerCase())) return { ok: false, status: 0, html: "", url: finalUrl };
    if (!res.ok) return { ok: false, status: res.status, html: "", url: finalUrl };
    const body = await readResponseCapped(res, SOURCE_BYTE_CAP);
    return { ok: true, status: res.status, html: body?.text || body || "", url: finalUrl };
  } catch {
    return { ok: false, status: 0, html: "", url };
  }
}

// Does the source actually link to the target? Compare on href values so a bare
// mention of the URL in prose doesn't count as a link — the spec wants a real
// <a href>, and that distinction is the entire anti-forgery property.
function linksTo(html, target) {
  const variants = new Set([target, target + "/", target.replace(/\/$/, "")]);
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const href = m[1].replace(/^["']|["']$/g, "").trim();
    if (variants.has(href) || variants.has(href.replace(/[?#].*$/, ""))) return true;
  }
  return false;
}

// ── parsing ────────────────────────────────────────────────────────────────
// Deliberately minimal: microformats2 where it's cheap to read, standard meta as
// the fallback, the domain as the floor. Never fabricate an author — an unknown
// author renders as the site it came from, which is honest and still useful.
function parseSource(html, sourceUrl, target) {
  const title = (extractTitle(html) || "").slice(0, 200) || new URL(sourceUrl).hostname;
  const author =
    firstMatch(html, /class="[^"]*\bp-author\b[^"]*"[^>]*>([^<]{1,120})</i) ||
    firstMatch(html, /class="[^"]*\bp-name\b[^"]*"[^>]*>([^<]{1,120})</i) ||
    extractMeta(html, "author") ||
    new URL(sourceUrl).hostname.replace(/^www\./, "");
  return {
    kind: mentionKind(html, target),
    author: clean(author).slice(0, 120),
    authorUrl: new URL(sourceUrl).origin,
    title: clean(title),
    excerpt: excerptAround(html, target),
  };
}

// The microformats2 class on the link that points at me decides how this reads
// in the inbox: a reply is a message, a like is a read receipt, a repost is a
// forward. Everything else is a plain mention.
function mentionKind(html, target) {
  const window = 400;
  const idx = String(html).indexOf(target);
  const near = idx === -1 ? String(html) : String(html).slice(Math.max(0, idx - window), idx + window);
  if (/\bu-in-reply-to\b/i.test(near)) return "reply";
  if (/\bu-like-of\b/i.test(near)) return "like";
  if (/\bu-repost-of\b/i.test(near)) return "repost";
  if (/\bu-bookmark-of\b/i.test(near)) return "bookmark";
  return "mention";
}

// The sentence around the link, which is the part that actually says something
// about my page — far more useful than the post's opening line.
function excerptAround(html, target) {
  const stripped = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    // <svg> matters as much as <script> here: an inline icon carries a d="M9.64a1.998
    // 2 0 0 0 2.83 0l1.25-1.25…" path, and a page like a GitHub gist is full of them.
    // Left in, that geometry is what lands in the excerpt and makes a real mention
    // read like spam.
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const e = firstMatch(stripped, /class="[^"]*\be-content\b[^"]*"[^>]*>([\s\S]{0,1200})</i);
  const hay = e || stripped;
  const idx = hay.indexOf(target);
  const start = idx === -1 ? 0 : Math.max(0, idx - 400);
  let slice = idx === -1 ? hay.slice(0, 1200) : hay.slice(start, idx + 400);

  // The window is cut at a byte offset, so it can open in the middle of a tag,
  // or worse, inside an attribute value: the tag stripper below only removes
  // COMPLETE tags, so a leading fragment survives as text. The target URL lives
  // in an href, which guarantees the cut lands mid-tag whenever it is centred on
  // a link. Detect it by which of < and > comes first, and drop both partials.
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

// ── moderation ─────────────────────────────────────────────────────────────
// The exact HMAC construction cal uses for booking approvals: only the holder of
// SIGNING_SECRET (me, via this email) can flip a mention live, so nobody can
// approve their own webmention by guessing a URL.
async function emailHost(env, request, m) {
  if (!env.SIGNING_SECRET || !env.RESEND_API_KEY || !env.HOST_EMAIL) {
    console.warn("webmention pending but mail/signing is unconfigured; approve at /inbox once wired", m.source);
    return;
  }
  const origin = new URL(request.url).origin;
  const approve = `${origin}/webmention/approve?t=${m.id}&sig=${await sign(`${m.id}|approve`, env.SIGNING_SECRET)}`;
  const decline = `${origin}/webmention/decline?t=${m.id}&sig=${await sign(`${m.id}|decline`, env.SIGNING_SECRET)}`;
  const html = `
    <p><strong>${esc(m.author)}</strong> ${esc(kindPhrase(m.kind))} <a href="${esc(m.target)}">${esc(m.target.replace(origin, ""))}</a></p>
    <p><a href="${esc(m.source)}">${esc(m.title)}</a></p>
    ${m.excerpt ? `<blockquote style="border-left:3px solid #888;padding-left:.8em;margin-left:0;color:#333">${esc(m.excerpt)}</blockquote>` : ""}
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
    subject: `✉ ${m.author} ${kindPhrase(m.kind)} ${m.target.replace(origin, "")}`,
    html,
  });
}

function kindPhrase(kind) {
  return kind === "reply" ? "replied to" : kind === "like" ? "liked" : kind === "repost" ? "reposted" : kind === "bookmark" ? "bookmarked" : "mentioned";
}

// ── GET /webmention/approve | /decline ─────────────────────────────────────
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

// ── reads for /inbox ───────────────────────────────────────────────────────
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

// ── which pages accept a mention ───────────────────────────────────────────
// Two sources, one rule. The registry names the pages directly (garage/lwe
// content). A section flagged webmention (/writing) also vouches for its leaf
// posts, which live in posts.json rather than the manifest — so a new note
// accepts mentions the moment it's published, with no second list to update.
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

// ── helpers ────────────────────────────────────────────────────────────────
function sameOriginPath(raw, origin) {
  try {
    const u = new URL(raw);
    if (u.origin !== origin) return null;
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch { return null; }
}

async function overBudget(request, env, ctx) {
  if (!env.RN_KV) return false;
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const bucket = `${WM_BUDGET.key}:${ip}:${Math.floor(Date.now() / 60000)}`;
  let n = 0;
  try { n = parseInt((await env.RN_KV.get(bucket)) || "0", 10) || 0; } catch {}
  if (n >= WM_BUDGET.max) return true;
  const write = env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
  return false;
}

function text(body, status, extra = {}) {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra },
  });
}
