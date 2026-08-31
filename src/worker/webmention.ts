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
import { validateLensTarget } from "./lens.ts";
import { fetchFollowingPublicRedirects, privateHostBlocked, readResponseCapped } from "./lib/crawl.ts";
import { esc, extractMeta, extractTitle } from "./lib/http.ts";
import { overBudget } from "./lib/ratelimit.ts";
import { sign, verify } from "../../cal/src/sign.ts";
import { resendSend } from "../../cal/src/email.ts";
import { WEBMENTION_PATHS, WEBMENTION_SECTIONS } from "./lib/site-manifest.ts";

// One bucket, one ceiling, matching the /lens posture. Fails OPEN without the
// binding (dev): this is abuse control, and the SSRF guard is what enforces
// safety. `max` is mirrored in wrangler.jsonc's ratelimits and a contract test
// pins the pair, the same as every /lens budget.
export const WEBMENTION_BUDGET = { binding: "WEBMENTION_RL", max: 10 };
const SOURCE_BYTE_CAP = 512 * 1024;   // a blog post that needs more isn't a mention
const SOURCE_TIMEOUT_MS = 8000;
const EXCERPT_MAX = 320;

// ── storage ────────────────────────────────────────────────────────────────
// Its own database (SOCIAL_DB / aadhar-social), deliberately NOT the deploy-log
// DB: social content is third-party, moderated, and mutable, while the
// checkpoints table is the site's own append-only history. Created lazily like
// census.js and around.js do, so a fresh binding self-provisions instead of
// requiring a migration step before the route works. migrations/0001_webmentions.sql
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

  // …and then it must be an ABSOLUTE one, which that guard deliberately does not
  // require. validateLensTarget prepends https:// to a schemeless string, because
  // the /lens box is a place a visitor TYPES "example.com" and means a website.
  // An endpoint that machines POST to is the opposite case: the spec's `source`
  // is a URL, and guessing at a scheme accepts input that was never one.
  //
  // Measured against production 2026-08-28, running webmention.rocks receiver
  // test 2, whose entire contract is "HTTP 400 for all the requests it receives":
  // `source=/some/path` became `https:///some/path`, passed every check, and came
  // back 202. The mention then died quietly in verification, so the only visible
  // symptom was a conformance test failing. `https:///x` gets in the same way and
  // is checked here too: it carries a scheme and no host at all.
  //
  // The lens guard is left alone on purpose. Both surfaces are right about their
  // own callers, and the difference is who is doing the typing.
  if (!absoluteHttpUrl(source)) return text("source must be an absolute http(s) URL.", 400);
  if (sameOriginPath(checked.url, origin)) return text("source must be on another site.", 400);

  if (await overBudget(WEBMENTION_BUDGET, request, env)) {
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

  // A re-send of an already-approved mention refreshes its content but keeps it
  // approved — re-moderating an edit I already blessed would be busywork.
  const row = await db.prepare(
    `INSERT INTO ${TABLE} (id, source, target, kind, author, author_url, title, excerpt, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(source, target) DO UPDATE SET
       kind = excluded.kind, author = excluded.author, author_url = excluded.author_url,
       title = excluded.title, excerpt = excluded.excerpt, received_at = excluded.received_at
     RETURNING status`
  ).bind(id, source, target, parsed.kind, parsed.author, parsed.authorUrl, parsed.title, parsed.excerpt, Date.now()).first();

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
// Identifies honestly as AadharshBot, follows redirects one hop at a time (a
// mention often comes from a shortened or canonical URL) and checks EVERY hop
// against the blocklist, so a public URL cannot redirect into private space.
// Caps both time and bytes.
//
// This used to follow redirects in one call and check only the final host. The
// body was correctly discarded on a blocked landing, so the exposure was a blind
// request rather than a read — but the request was still made, and the check now
// runs before each hop instead of after all of them.
async function fetchSource(url) {
  try {
    const followed = await fetchFollowingPublicRedirects(
      url,
      {
        headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      },
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

// Does the source actually link to the target? Compare on href values so a bare
// mention of the URL in prose doesn't count as a link — the spec wants a real
// <a href>, and that distinction is the entire anti-forgery property.
// Regions whose text is NOT document content. An <a> written inside any of them
// is not a link: a comment is markup the author removed, a script is code, a
// template is inert until cloned, and a textarea's contents are the field's
// value. Scanning the raw source credited all four, which is the anti-forgery
// property failing in the direction that matters — anyone could claim a mention
// with markup that never renders as a link. Measured 2026-08-07 against the
// previous implementation: a link in a comment, in a <script>, and in a
// <textarea> were all credited.
//
// Stripping is the SAFE direction for this check. Removing too much loses a link
// and refuses a real mention; removing too little credits a fake one. So an
// unterminated region swallows the rest of the document on purpose.
const INERT_REGIONS = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|textarea|svg|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

export function documentContent(html) {
  return String(html ?? "").replace(INERT_REGIONS, " ");
}

/** Compare on the parts of a URL that identify a page: scheme, host (which is
 *  case-insensitive), and path (which is not). Query and fragment are dropped —
 *  a mention of ?utm_source=x is a mention of the page. */
function canonicalForCompare(url) {
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
}

// Does the source actually link to the target? Compare on href values so a bare
// mention of the URL in prose doesn't count as a link — the spec wants a real
// <a href>, and that distinction is the entire anti-forgery property.
//
// Hrefs are RESOLVED against the source URL rather than string-matched, so the
// spellings a real page uses all count: protocol-relative (//aadhar.sh/x) and an
// uppercase host were both refused before, and both are ordinary HTML.
export function linksTo(html, target, sourceUrl) {
  let wanted;
  try { wanted = canonicalForCompare(new URL(target)); } catch { return false; }
  for (const m of documentContent(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    const raw = m[1].replace(/^["']|["']$/g, "").trim();
    if (!raw) continue;
    try {
      // `sourceUrl` is the base a browser would use. Without it a protocol-
      // relative href cannot be resolved at all.
      if (canonicalForCompare(new URL(raw, sourceUrl || undefined)) === wanted) return true;
    } catch { /* an unparseable href is not a link to anything */ }
  }
  return false;
}

// ── parsing ────────────────────────────────────────────────────────────────
// Deliberately minimal: microformats2 where it's cheap to read, standard meta as
// the fallback, the domain as the floor. Never fabricate an author — an unknown
// author renders as the site it came from, which is honest and still useful.
function parseSource(html, sourceUrl, target) {
  const title = (extractTitle(html) || "").slice(0, 200) || new URL(sourceUrl).hostname;
  return {
    kind: mentionKind(html, target),
    author: authorOf(html, sourceUrl),
    authorUrl: new URL(sourceUrl).origin,
    title: clean(title),
    excerpt: excerptAround(html, target),
  };
}

// Who sent it. The floor is the hostname, which is honest and still useful, and
// the rule is that NOTHING may win this by being confidently wrong.
//
// Both halves of that were broken, and the first real webmention this site ever
// received is what showed it (webmention.rocks receiver test 1, 2026-08-28,
// stored with an empty author):
//
//   <div class="left p-author h-card">
//     <a href="/"><img class="u-photo" alt="Webmention Rocks!"></a>
//   </div>
//   ...
//   <h1 class="p-name"><a href="/receive/1">Receiver Test #1</a></h1>
//
//   1. The p-author pattern matched, then captured the WHITESPACE between that
//      div's ">" and the "<a" on the next line. A whitespace string is truthy,
//      so the `||` chain stopped there and the hostname floor never ran. clean()
//      then reduced it to "". An h-card wrapping a photo is the ordinary shape on
//      a real IndieWeb site, so this was not a quirk of the test post: every
//      reply from a site that markes its author up properly would have arrived
//      blank.
//   2. Falling back to a bare p-name is worse than falling back to the hostname.
//      In microformats2 a p-name inside an h-card is the author's name, and a
//      p-name inside an h-entry is the POST's name, and a pattern that cannot
//      see which parent it is under picks up the title. On this very document
//      that fallback would have called the author "Receiver Test #1".
//
// So: read the p-author ELEMENT (bounded by its own closing tag, not by a
// character window, because the post title sits a few hundred characters past
// this one's end), take its text, then a p-name nested INSIDE it, then the alt
// of its photo, which mf2 says contributes the name for a p-* property. Every
// candidate has to survive clean() as a non-empty string to win.
function authorOf(html, sourceUrl) {
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  for (const candidate of [() => authorFromCard(html), () => extractMeta(html, "author"), () => host]) {
    const value = clean(candidate() || "").slice(0, 120);
    if (value) return value;
  }
  return host;
}

function authorFromCard(html) {
  const open = String(html).match(/<(\w+)\b[^>]*class="[^"]*\bp-author\b[^"]*"[^>]*>/i);
  // `index` is always set on a non-global match; the checker cannot know that.
  if (!open || open.index === undefined) return "";
  const inner = elementInner(html, open.index + open[0].length, open[1]);
  const nested = firstMatch(inner, /class="[^"]*\bp-name\b[^"]*"[^>]*>([\s\S]{0,200}?)</i);
  const alt = firstMatch(inner, /<img\b[^>]*\balt\s*=\s*"([^"]{1,120})"/i);
  return clean(nested) || clean(stripTags(inner)) || clean(alt);
}

/** The inner HTML of an element whose opening tag ended at `from`, found by
 *  counting its own tag's nesting rather than by taking a fixed window. A window
 *  is what would run past the h-card's end and into the entry title. An element
 *  that is never closed yields the rest of the document, which is the safe
 *  direction here: it can only make an author emptier or longer, never wrong. */
function elementInner(html, from, tag) {
  const s = String(html);
  const scan = new RegExp(`<(/?)${tag}\\b`, "gi");
  scan.lastIndex = from;
  let depth = 1;
  for (let m = scan.exec(s); m; m = scan.exec(s)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return s.slice(from, m.index);
  }
  return s.slice(from);
}

function stripTags(html) {
  return String(html).replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");
}

// The microformats2 class on the link that points at me decides how this reads
// in the inbox: a reply is a message, a like is a read receipt, a repost is a
// forward. Everything else is a plain mention.
function mentionKind(html, target) {
  const window = 400;
  // Same content-only view the link check uses: a commented-out u-in-reply-to
  // should not relabel a plain mention as a reply.
  const content = documentContent(html);
  const idx = content.indexOf(target);
  const near = idx === -1 ? content : content.slice(Math.max(0, idx - window), idx + window);
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
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    // <svg> matters as much as <script> here: an inline icon carries a d="M9.64a1.998
    // 2 0 0 0 2.83 0l1.25-1.25…" path, and a page like a GitHub gist is full of them.
    // Left in, that geometry is what lands in the excerpt and makes a real mention
    // read like spam.
    .replace(/<svg\b[\s\S]*?<\/svg\b[^>]*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\b[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|--!>)/g, " ");
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
  // scheme, exactly two slashes, then something that is already the host
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
