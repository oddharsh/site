import { sendEmail } from "./email.ts";
import { cleanText, decodeHtmlEntities } from "./html.ts";
import { json, withSiteHeaders } from "./http.ts";
import { fetchPublicResource, validateLensTarget } from "./lens.ts";
import { signValue, verifyValue } from "./signatures.ts";

type Secrets = { SIGNING_SECRET?: string; RESEND_API_KEY?: string };
type Mention = { id: string; source: string; target: string; kind: string; author: string | null; title: string | null; excerpt: string | null };

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function canonicalTarget(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["aadhar.sh", "www.aadhar.sh"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    url.hostname = "aadhar.sh"; url.search = ""; url.hash = "";
    url.pathname = url.pathname === "/index.html" ? "/" : url.pathname.replace(/\/$/, "") || "/";
    return url;
  } catch { return null; }
}

async function targetAccepted(env: Env, target: URL): Promise<boolean> {
  if (/^\/serendipity\/event\/[^/]+$/.test(target.pathname)) return true;
  try {
    const response = await env.ASSETS.fetch("https://assets.invalid/webmention-targets.json");
    const paths = await response.json<string[]>();
    return paths.includes(target.pathname);
  } catch { return false; }
}

export async function parseMentionDocument(html: string, source: URL, target: URL): Promise<{ linked: boolean; mention: Omit<Mention, "id"> }> {
  let linked = false;
  let titleText = "";
  let authorText = "";
  let excerptText = "";
  let ignoredDepth = 0;

  const transformed = new HTMLRewriter()
    .on("script,style,template,noscript", {
      element(element) {
        ignoredDepth += 1;
        element.onEndTag(() => { ignoredDepth = Math.max(0, ignoredDepth - 1); });
      },
    })
    .on("a[href]", {
      element(element) {
        if (linked) return;
        try {
          const href = new URL(decodeHtmlEntities(element.getAttribute("href") ?? ""), source);
          linked = canonicalTarget(href.href)?.href === target.href;
        } catch { /* ignore malformed links */ }
      },
    })
    .on("title", {
      text(chunk) { if (titleText.length < 600) titleText += chunk.text; },
    })
    .on("meta", {
      element(element) {
        if (!authorText && element.getAttribute("name")?.toLowerCase() === "author") authorText = element.getAttribute("content") ?? "";
      },
    })
    .on("body", {
      text(chunk) { if (!ignoredDepth && excerptText.length < 1200) excerptText += `${chunk.text} `; },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));

  await transformed.arrayBuffer();
  const title = cleanText(titleText).slice(0, 300) || source.hostname;
  const author = cleanText(authorText).slice(0, 200) || null;
  const excerpt = cleanText(excerptText).slice(0, 500) || null;
  return { linked, mention: { source: source.href, target: target.href, kind: "mention", author, title, excerpt } };
}

async function mentionId(source: string, target: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${source}|${target}`)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function ensureSchema(env: Env): Promise<void> {
  await env.SOCIAL_DB.prepare(`CREATE TABLE IF NOT EXISTS webmentions (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'mention', author TEXT, author_url TEXT, title TEXT, excerpt TEXT, status TEXT NOT NULL DEFAULT 'pending', received_at INTEGER NOT NULL, approved_at INTEGER, UNIQUE(source,target))`).run();
  await env.SOCIAL_DB.prepare("CREATE INDEX IF NOT EXISTS webmentions_status_approved ON webmentions(status, approved_at DESC)").run();
}

async function store(env: Env, mention: Mention): Promise<string> {
  let prior: { status: string } | null = null;
  try { prior = await env.SOCIAL_DB.prepare("SELECT status FROM webmentions WHERE id=?").bind(mention.id).first<{ status: string }>(); }
  catch (error) { if (!/no such table|does not exist/i.test(String(error))) throw error; await ensureSchema(env); }
  await env.SOCIAL_DB.prepare(`INSERT INTO webmentions(id,source,target,kind,author,title,excerpt,status,received_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(source,target) DO UPDATE SET kind=excluded.kind,author=excluded.author,title=excluded.title,excerpt=excluded.excerpt,received_at=excluded.received_at`).bind(mention.id, mention.source, mention.target, mention.kind, mention.author, mention.title, mention.excerpt, Date.now()).run();
  return prior?.status ?? "pending";
}

async function notify(env: Env, mention: Mention): Promise<void> {
  const secret = (env as Env & Secrets).SIGNING_SECRET;
  if (!secret || !(env as Env & Secrets).RESEND_API_KEY) return;
  const approve = await signValue(`${mention.id}|approve`, secret);
  const decline = await signValue(`${mention.id}|decline`, secret);
  await sendEmail(env, {
    from: "aadhar.sh inbox <noreply@aadhar.sh>", to: [env.HOST_EMAIL], subject: `Webmention from ${new URL(mention.source).hostname}`,
    html: `<p><a href="${escapeHtml(mention.source)}">${escapeHtml(mention.title || mention.source)}</a> links to ${escapeHtml(new URL(mention.target).pathname)}.</p>${mention.excerpt ? `<blockquote>${escapeHtml(mention.excerpt)}</blockquote>` : ""}<p><a href="https://aadhar.sh/webmention/approve?t=${mention.id}&amp;sig=${approve}">Approve</a> · <a href="https://aadhar.sh/webmention/decline?t=${mention.id}&amp;sig=${decline}">Decline</a></p>`,
  });
}

async function overBudget(request: Request, env: Env): Promise<boolean> {
  try { return !(await env.LENS_RL_INSPECT.limit({ key: `webmention:${request.headers.get("cf-connecting-ip") || "anonymous"}` })).success; }
  catch { return false; }
}

export async function receiveWebmention(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST source and target as form data." }, { status: 405, headers: { allow: "POST" } });
  if (Number(request.headers.get("content-length") || 0) > 16 * 1024) return json({ error: "request too large" }, { status: 413 });
  if (await overBudget(request, env)) return json({ error: "receiver budget exceeded; retry later" }, { status: 429, headers: { "retry-after": "60" } });
  let form: FormData; try { form = await request.formData(); } catch { return json({ error: "invalid form data" }, { status: 400 }); }
  const sourceRaw = String(form.get("source") ?? "").slice(0, 2048);
  const target = canonicalTarget(String(form.get("target") ?? "").slice(0, 2048));
  const sourceValidation = validateLensTarget(sourceRaw);
  if (!target || !await targetAccepted(env, target)) return json({ error: "target is not an accepted aadhar.sh document" }, { status: 400 });
  if (!sourceValidation.target || ["aadhar.sh", "www.aadhar.sh"].includes(sourceValidation.target.hostname.toLowerCase())) return json({ error: sourceValidation.error || "source must be an external public page" }, { status: 400 });
  try {
    const fetched = await fetchPublicResource(sourceValidation.target.href, env, { accept: "text/html,application/xhtml+xml;q=0.9" }, 256 * 1024);
    if (["aadhar.sh", "www.aadhar.sh"].includes(fetched.finalUrl.hostname.toLowerCase())) return json({ error: "source redirects back to this site" }, { status: 400 });
    if (!fetched.response.ok || !/^text\/(?:html|plain)|application\/xhtml\+xml/i.test(fetched.response.headers.get("content-type") || "")) return json({ error: "source is not a readable HTML document" }, { status: 400 });
    const parsed = await parseMentionDocument(fetched.body.text, fetched.finalUrl, target);
    if (!parsed.linked) return json({ error: "source does not link to target" }, { status: 400 });
    const fields = parsed.mention;
    const mention = { id: await mentionId(fields.source, fields.target), ...fields };
    const status = await store(env, mention);
    if (status !== "approved") ctx.waitUntil(notify(env, mention).catch((error) => console.warn("webmention notification failed", String(error))));
    return json({ accepted: true, status: status === "approved" ? "approved" : "pending moderation", id: mention.id }, { status: 202, headers: { "cache-control": "no-store", location: `https://aadhar.sh/inbox#${mention.id}` } });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "verification failed" }, { status: 400, headers: { "cache-control": "no-store" } }); }
}

async function decisionPage(request: Request, env: Env, title: string, message: string, status: number): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(new URL("/inbox", request.url), request));
  const transformed = new HTMLRewriter().on(".document", { element(element) { element.setInnerContent(`<header><p class="eyebrow">Outlook Express · Moderation</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p></header><p><a href="/inbox">Open Inbox</a></p>`, { html: true }); } }).transform(response);
  const secured = withSiteHeaders(transformed, request); secured.headers.set("cache-control", "no-store"); secured.headers.set("referrer-policy", "no-referrer"); secured.headers.set("x-robots-tag", "noindex");
  return new Response(secured.body, { status, headers: secured.headers });
}

export async function decideWebmention(request: Request, env: Env, action: "approve" | "decline"): Promise<Response> {
  const url = new URL(request.url); const id = url.searchParams.get("t") ?? ""; const signature = url.searchParams.get("sig") ?? ""; const secret = (env as Env & Secrets).SIGNING_SECRET;
  if (!secret || !id || !signature || !await verifyValue(`${id}|${action}`, signature, secret)) return decisionPage(request, env, "Link refused", "This moderation link is invalid or expired.", 401);
  const existing = await env.SOCIAL_DB.prepare("SELECT status FROM webmentions WHERE id=?").bind(id).first<{ status: string }>().catch(() => null);
  if (!existing) return decisionPage(request, env, "Mention not found", "The pending record is absent.", 404);
  const status = action === "approve" ? "approved" : "declined";
  await env.SOCIAL_DB.prepare("UPDATE webmentions SET status=?, approved_at=? WHERE id=?").bind(status, action === "approve" ? Date.now() : null, id).run();
  return decisionPage(request, env, action === "approve" ? "Mention approved" : "Mention declined", action === "approve" ? "It can now appear in the public Inbox." : "It will remain out of the public Inbox.", 200);
}
