import { mapWithConcurrency } from "./lib/crawl.ts";
import { FAN_OUT, lensFetch } from "./lens.ts";
import { defineLens } from "./lens-pipeline.ts";

const MARKDOWN_CACHE_SECONDS = 3600;
const BODY_SAMPLE = 4096;
const PROBE_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Real annotations rather than JSDoc, because a `@type` tag in a .ts file is
// inert and would type nothing at all (gotcha 42).
type CheckStatus = "pass" | "warn" | "fail" | "info";
type Check = { id: string; status: CheckStatus; detail: string };
type AgentRow = {
  key: string; label: string; vendor: string; verified: string; accept: string;
  ok: boolean; status: number | null; contentType: string; markdown: boolean;
  bytes: number | null; error?: string;
};

export const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7";

const UNSERVABLE = "application/x-lens-negotiation-probe";

export const AGENT_ACCEPTS = [
  { key: "claude-code",   label: "Claude Code",         vendor: "Anthropic",         verified: "2025-11-13",
    accept: "text/markdown, text/html, */*" },
  { key: "copilot-cli",   label: "Copilot CLI",         vendor: "GitHub",            verified: "2026-06-22",
    accept: "text/markdown, text/html, */*" },
  { key: "ms-copilot",    label: "Microsoft Copilot",   vendor: "Microsoft",         verified: "2026-06-22",
    accept: "text/markdown, text/html, */*" },
  { key: "copilot-chat",  label: "Copilot Chat",        vendor: "GitHub",            verified: "2026-06-22",
    accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/xml;q=0.8, */*;q=0.7" },
  { key: "cursor",        label: "Cursor",              vendor: "Anysphere",         verified: "2026-04-18",
    accept: "text/markdown, text/plain;q=0.9, */*;q=0.8" },
  { key: "openclaw",      label: "OpenClaw",            vendor: "OpenClaw",          verified: "2026-05-04",
    accept: "text/markdown, text/html;q=0.9, */*;q=0.1" },
  { key: "opencode",      label: "OpenCode",            vendor: "SST",               verified: "2026-05-04",
    accept: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1" },
];

export function probePlan() {
  const seen = new Map();
  const add = (id, accept) => seen.getOrInsertComputed(accept, () => ({ id, accept })).id;

  add("control", BROWSER_ACCEPT);
  add("markdown", "text/markdown");
  add("unservable", UNSERVABLE);
  add("q-ranked", "text/html;q=1.0, text/markdown;q=0.5");
  add("q-zero", "text/html, text/markdown;q=0");
  const agentProbe = new Map();
  for (const a of AGENT_ACCEPTS) agentProbe.set(a.key, add("agent:" + a.key, a.accept));

  return { probes: [...seen.values()], agentProbe };
}

export function isMarkdown(contentType) {
  const t = String(contentType || "").split(";")[0].trim().toLowerCase();
  return t === "text/markdown" || t === "text/x-markdown";
}

function mediaType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

export function variesOnAccept(vary) {
  const raw = String(vary || "").toLowerCase();
  if (raw.trim() === "*") return true;
  return raw.split(",").map((s) => s.trim()).includes("accept");
}

// May a SHARED cache store this response? RFC 9111 section 3: no-store and
// private forbid it, and everything else is storable, including a response with
// no Cache-Control at all, which a cache may still keep under heuristic
// freshness. Read as tokens for the same reason Vary is: "private" inside a
// quoted no-cache field list is not the directive.
export function sharedStorable(cacheControl) {
  const directives = String(cacheControl || "").toLowerCase().split(",")
    .map((d) => d.trim().split("=")[0].trim());
  return !directives.includes("no-store") && !directives.includes("private");
}

// Vary is a claim every variant has to make, and the public checklist reads it
// off one. A cache stores each response under the Vary THAT response carried, so
// an HTML copy with no Accept in its Vary is stored unconditionally and served to
// the next agent that asks for Markdown, however correct the Markdown copy's own
// Vary is. Cloudflare named this as the caveat on its Vary launch (2026-09-22):
// omit Vary on one cacheable response and the cache can serve the wrong variant.
// It is also this site's own #195 bug from the other side.
type ProbeRow = [string, { ok: boolean; status?: number; contentType?: string; vary?: string; cacheControl?: string; error?: string }];
export function varyEveryVariant(rows: ProbeRow[]): Check {
  const variants = rows.filter(([, r]) => r?.ok && (r.status ?? 0) >= 200 && (r.status ?? 0) < 300);
  const types = new Set<string>(variants.map(([, r]) => mediaType(r.contentType)));
  if (types.size < 2) {
    return { id: "vary-on-every-variant", status: "info",
      detail: `Every 2xx answer was ${[...types][0] || "untyped"}, so there is one representation and Vary owes nothing.` };
  }
  const bare = variants.filter(([, r]) => !variesOnAccept(r.vary));
  const exposed = bare.filter(([, r]) => sharedStorable(r.cacheControl));
  const summary = `${variants.length} answers across ${types.size} types`;
  if (!exposed.length) {
    return { id: "vary-on-every-variant", status: "pass",
      detail: bare.length
        ? `${summary}. ${bare.length} omit Accept from Vary, and each forbids shared caching, so no cache can hand it to the wrong client.`
        : `${summary}, and every one names Accept in Vary.` };
  }
  const named = exposed.map(([id, r]) =>
    `${mediaType(r.contentType) || "untyped"} for ${id} (Vary: ${r.vary || "none"}; Cache-Control: ${r.cacheControl || "none"})`);
  return { id: "vary-on-every-variant", status: "fail",
    detail: `${summary}. A shared cache may store ${named.join("; ")} without Accept in its key, then serve it to a client that asked for another type.` };
}

// RFC 8288 in the header, plus the HTML element that says the same thing. Codex
// CLI follows this rather than sending an Accept at all, so an origin can be
// perfectly reachable by one real client while failing every check above.
export function markdownAlternate(linkHeader, html) {
  const fromHeader = String(linkHeader || "")
    .split(/,(?=\s*<)/)
    .map((part) => {
      const url = part.match(/<([^>]*)>/);
      if (!url) return null;
      if (!/rel\s*=\s*"?[^";]*\balternate\b/i.test(part)) return null;
      if (!/type\s*=\s*"?text\/(x-)?markdown/i.test(part)) return null;
      return url[1];
    })
    .find(Boolean);
  if (fromHeader) return { href: fromHeader, where: "Link header" };

  const tag = String(html || "").match(/<link\b[^>]*>/gi) || [];
  for (const t of tag) {
    if (!/rel\s*=\s*["']?[^"';>]*\balternate\b/i.test(t)) continue;
    if (!/type\s*=\s*["']?text\/(x-)?markdown/i.test(t)) continue;
    const href = t.match(/href\s*=\s*["']([^"']+)["']/i) || t.match(/href\s*=\s*([^\s>]+)/i);
    if (href) return { href: href[1], where: "<link> element" };
  }
  return null;
}

async function readCounting(res, keepBytes, maxBytes) {
  if (!res.body) return { bytes: 0, head: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let head = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (head.length < keepBytes) head += decoder.decode(value, { stream: true });
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { bytes, head: head.slice(0, keepBytes), truncated };
}

async function probeOnce(targetUrl, env, accept) {
  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await lensFetch(targetUrl, env, deadline, accept, FAN_OUT);
    const body = await readCounting(res, BODY_SAMPLE, MAX_BODY_BYTES);
    return {
      ok: true,
      accept,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      vary: res.headers.get("vary") || "",
      cacheControl: res.headers.get("cache-control") || "",
      link: res.headers.get("link") || "",
      bytes: body.truncated ? null : body.bytes,
      sample: body.head,
    };
  } catch (e) {
    return { ok: false, accept, error: (e && e.message) || String(e) };
  }
}

const LENS_MARKDOWN = defineLens({
  span: "lens.markdown",
  budget: "markdown",
  targets: (params: URLSearchParams) => params.get("url") || "",
  cache: { prefix: "lens:md:", ttl: MARKDOWN_CACHE_SECONDS },
  run: async ({ target, env, span: s }) => {
    const host = new URL(target).hostname;

    const { probes, agentProbe } = probePlan();
    const results = await mapWithConcurrency(probes, 2, (p) => probeOnce(target, env, p.accept));
    const byId = new Map();
    for (let i = 0; i < probes.length; i++) byId.set(probes[i].id, results[i]);

    const control = byId.get("control");
    const md = byId.get("markdown");

    if (!control?.ok) {
      return {
        ok: false, status: 200, outcome: "unreadable",
        payload: {
          ok: false, url: target, host,
          unreadable: true,
          error: control?.error || "the origin did not answer a plain browser request",
        },
      };
    }

    const controlType = mediaType(control.contentType);
    const alternate = markdownAlternate(control.link, control.sample);

    const anyMarkdown = [...byId.values()].some((r) => r.ok && isMarkdown(r.contentType));

    const checks: Check[] = [];

    checks.push(md?.ok
      ? (isMarkdown(md.contentType)
        ? { id: "serves-markdown", status: "pass", detail: `Content-Type: ${md.contentType}` }
        : { id: "serves-markdown", status: md.status === 406 ? "warn" : "fail",
            detail: md.status === 406
              ? `Answered 406 to Accept: text/markdown, which is honest and means there is no Markdown here.`
              : `Answered ${md.status} ${mediaType(md.contentType) || "with no content-type"} to Accept: text/markdown.` })
      : { id: "serves-markdown", status: "fail", detail: md?.error || "no answer" });

    const varySource = (md?.ok && isMarkdown(md.contentType)) ? md : control;
    checks.push(variesOnAccept(varySource.vary)
      ? { id: "varies-by-accept", status: "pass", detail: `Vary: ${varySource.vary}` }
      : { id: "varies-by-accept", status: anyMarkdown ? "fail" : "warn",
          detail: varySource.vary
            ? `Vary: ${varySource.vary}. It does not name Accept, so a shared cache can hand one audience the other's copy.`
            : "No Vary header. A shared cache can hand one audience the other's copy." });

    checks.push(varyEveryVariant([...byId.entries()]));

    const bogus = byId.get("unservable");
    checks.push(bogus?.ok
      ? (bogus.status === 406
        ? { id: "rejects-unservable", status: "pass", detail: `406 for Accept: ${UNSERVABLE}` }
        : { id: "rejects-unservable", status: "warn",
            detail: `Answered ${bogus.status} to a media type nothing serves. RFC 9110 permits ignoring Accept and returning a default, so this is a preference rather than a defect.` })
      : { id: "rejects-unservable", status: "warn", detail: bogus?.error || "no answer" });

    const qr = byId.get("q-ranked");
    checks.push(qr?.ok
      ? (!isMarkdown(qr.contentType)
        ? { id: "q-ranked", status: "pass", detail: `Served ${mediaType(qr.contentType) || "a non-Markdown type"} for text/html;q=1.0, text/markdown;q=0.5` }
        : { id: "q-ranked", status: "fail", detail: "Served Markdown although the header ranked HTML above it." })
      : { id: "q-ranked", status: "warn", detail: qr?.error || "no answer" });

    const qz = byId.get("q-zero");
    checks.push(qz?.ok
      ? (!isMarkdown(qz.contentType)
        ? { id: "q-zero", status: "pass", detail: `Served ${mediaType(qz.contentType) || "a non-Markdown type"} for text/markdown;q=0` }
        : { id: "q-zero", status: "fail", detail: "Served Markdown for text/markdown;q=0, which is the header explicitly refusing it. That is the signature of a substring match rather than a parse." })
      : { id: "q-zero", status: "warn", detail: qz?.error || "no answer" });

    checks.push(alternate
      ? { id: "link-alternate", status: "pass", detail: `${alternate.where}: ${alternate.href}` }
      : { id: "link-alternate", status: anyMarkdown ? "warn" : "info",
          detail: "No rel=alternate pointing at a Markdown copy. Clients that follow the link rather than send an Accept header (Codex CLI is the one on the public matrix) have nothing to follow." });

    const negotiating = [...byId.values()].some((r) => r.ok && mediaType(r.contentType) !== controlType);
    const agents: AgentRow[] = AGENT_ACCEPTS.map((a) => {
      const r = byId.get(agentProbe.get(a.key));
      if (!r?.ok) {
        return { ...a, ok: false, status: null, contentType: "", markdown: false, bytes: null,
                 error: r?.error || "no answer" };
      }
      return {
        ...a, ok: true,
        status: r.status,
        contentType: mediaType(r.contentType),
        markdown: isMarkdown(r.contentType),
        bytes: r.bytes,
      };
    });
    const answered = agents.filter((a) => a.ok);
    const reached = answered.filter((a) => a.markdown).length;

    const viaAgent = answered.find((a) => a.markdown);
    const mdBest = (viaAgent && byId.get(agentProbe.get(viaAgent.key)))
      || (md?.ok && isMarkdown(md.contentType) ? md : null);
    const delta = (mdBest && control.bytes && mdBest.bytes)
      ? {
          htmlBytes: control.bytes,
          markdownBytes: mdBest.bytes,
          ratio: Number((control.bytes / mdBest.bytes).toFixed(1)),
          saved: Number((100 * (1 - mdBest.bytes / control.bytes)).toFixed(1)),
        }
      : null;

    const failed = checks.filter((c) => c.status === "fail").length;
    s.setAttribute("lens.md_reached", reached);
    s.setAttribute("lens.md_answered", answered.length);
    s.setAttribute("lens.md_negotiating", negotiating);
    s.setAttribute("lens.md_failed_checks", failed);
    if (delta) s.setAttribute("lens.md_ratio", delta.ratio);

    const payload = {
      ok: true,
      url: target,
      host,
      reach: negotiating ? { reached, of: answered.length } : null,
      negotiating,
      anyMarkdown,
      controlType,
      checks,
      agents,
      alternate,
      delta,
      responses: probes.map((p) => {
        const r = byId.get(p.id);
        return { id: p.id, accept: p.accept, ok: !!r?.ok, status: r?.status ?? null,
                 contentType: r?.contentType || "", vary: r?.vary || "",
                 cacheControl: r?.cacheControl || "", error: r?.error };
      }),
      sample: mdBest ? mdBest.sample.slice(0, BODY_SAMPLE) : "",
      source: "https://acceptmarkdown.com/status",
    };
    return { ok: true, outcome: anyMarkdown ? "markdown" : "html-only", value: payload };
  },
});

export function handleLensMarkdown(request, env, ctx?) {
  return LENS_MARKDOWN.handle(request, env, ctx);
}
