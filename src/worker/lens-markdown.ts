// lens-markdown.js — the Markdown lens: which representation an agent actually
// gets back when it asks this URL for Markdown.
//
// The four conformance checks here are the ones acceptmarkdown.com scores a URL
// against (serves Markdown, sets Vary, refuses what it cannot serve, honours
// q-values), and the site is credited in the pane. They are RFC 9110 read back
// as a checklist, so the checks are re-derived from the spec rather than copied,
// and two more are added below for reasons the four cannot cover.
//
// WHAT THIS TAB IS FOR, WHICH IS NOT THE CHECKLIST. A conformance grade answers
// "is this origin correct". The question an agent author has is "does MY client
// get Markdown here", and those come apart badly. Three of the seven shipping
// agent clients send `text/markdown, text/html, */*`, where both types arrive at
// q=1 and nothing in the header breaks the tie; a server that ranks strictly by
// q-value serves them HTML while passing every check on the list. So the tab
// REPLAYS the real Accept strings and reports what each one got. Measured on our
// own /garage/horizon the day this was written: full marks on the checklist, and
// Claude Code got HTML.
//
// That result is the reason the replay is the headline and the checklist is the
// supporting evidence, rather than the other way around.
//
// THE CONTROL IS LOAD-BEARING, and it is the bot-views lesson one tier over. A
// row reading "HTML" has two explanations that look identical from one sample:
// the origin negotiated and chose HTML, or the origin has no Markdown to serve
// anybody. The browser baseline separates them, because an origin that answers
// every Accept with the same bytes is not negotiating at all. With no baseline
// admitted the pane reports reach as null and says why, rather than printing a
// confident 0 of 7.
//
// WHAT IT SENDS. An honest AadharshBot user-agent carrying somebody else's
// Accept header. The Accept IS the instrument here, so replaying it is the
// measurement, and wearing the agent's user-agent on top would buy nothing and
// cost the disclosure rule the About dialog now makes explicit. No signature, in
// line with the other lens fetch paths.
//
// COST. Ten plain GETs of one URL, deduped by Accept string, no browser and
// no model. Cheaper per run than the Reader or Wire tabs and more than a knock,
// which is why it is opt-in, cached for an hour, and rate-limited on its own
// budget rather than the shared browser ceiling.
import { validateLensTarget } from "./lib/crawl.ts";
import { jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { LENS_BUDGETS, lensFetchAsBot, lensSha256Hex, overLensBudget } from "./lens.ts";

const MARKDOWN_CACHE_SECONDS = 3600;
const BODY_SAMPLE = 4096;
const PROBE_TIMEOUT_MS = 6000;
// Matches the 2MB ceiling the other lens fetch paths use. Ten of these run
// per invocation, so the real ceiling is the isolate's memory rather than any
// one response.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Real annotations rather than JSDoc, because a `@type` tag in a .ts file is
// inert and would type nothing at all (gotcha 42).
type CheckStatus = "pass" | "warn" | "fail" | "info";
type Check = { id: string; status: CheckStatus; detail: string };
// One shape for both arms. An agent whose probe threw keeps every field a
// readable row needs and carries `ok:false`, so the pane never has to ask
// whether a property exists before printing it, and `markdown:false` on an
// unanswered row can never be counted as reach: `reached` filters on `ok` first.
type AgentRow = {
  key: string; label: string; vendor: string; verified: string; accept: string;
  ok: boolean; status: number | null; contentType: string; markdown: boolean;
  bytes: number | null; error?: string;
};

// The Accept header a mainstream browser sends, used as the control. Same string
// lensFetchAsBot defaults to, restated here because this tab's whole argument
// rests on it being a BROWSER's header rather than a lens default that might
// drift into something agent-flavoured later.
export const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7";

// A media type nothing serves, for the 406 probe. Named after this lens so an
// origin reading its own logs can tell what hit it.
const UNSERVABLE = "application/x-lens-negotiation-probe";

// The shipping agent clients that advertise a Markdown preference, and the exact
// Accept header each one sends. Compiled and dated by acceptmarkdown.com, whose
// support matrix is the only public record of these strings; the pane links out
// to it. Agents that send no Markdown preference at all are deliberately absent,
// because replaying a browser-shaped Accept under an agent's name would report a
// finding about our own table rather than about the origin.
//
// `verified` is THEIR observation date, carried through rather than restated as
// ours. A string that has drifted since is a fact about the table, and the pane
// prints the date next to the row so a stale entry argues with itself instead of
// quietly grading an origin against a header nobody sends any more.
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

// Every distinct Accept string the run needs, each fetched once. Three agents
// share one header, so seven rows cost six requests, and two identical requests
// could not honestly return different answers anyway.
export function probePlan() {
  const seen = new Map();
  const add = (id, accept) => { if (!seen.has(accept)) seen.set(accept, { id, accept }); return seen.get(accept).id; };

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

// A `Vary` naming Accept, matched as a token rather than a substring: `Vary:
// accept-encoding` contains the letters of "accept" and means something else
// entirely, and reading it as a pass is how an origin that varies only on
// compression gets graded as negotiating.
export function variesOnAccept(vary) {
  const raw = String(vary || "").toLowerCase();
  if (raw.trim() === "*") return true;
  return raw.split(",").map((s) => s.trim()).includes("accept");
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

// Counts the WHOLE decoded body and keeps only the head of it.
//
// The first version of this read `Content-Length` instead, and it was wrong in
// two ways that a passing test would not have caught. It is usually ABSENT: a
// chunked or compressed response sends none, so the byte comparison silently
// declined to render on most origins, including the 38x case that motivated it.
// And where both headers DO exist they describe COMPRESSED bytes, while the
// sample beside them is decoded, so any comparison mixing the two is measuring
// two different quantities and calling the difference a saving.
//
// Decoded is also the number the argument actually wants. An agent spends
// context on the characters, not on what the transfer encoding managed to do
// with them, so this is what "a fraction of the bytes" has to mean to be true.
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
      // Cancel rather than drain: past the cap the count can no longer be honest
      // and there is nothing left to learn from the rest of the body.
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { bytes, head: head.slice(0, keepBytes), truncated };
}

async function probeOnce(targetUrl, env, accept) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await lensFetchAsBot(targetUrl, env, ctrl.signal, "AadharshBot/1.0 (+https://aadhar.sh/bot)", accept);
    const body = await readCounting(res, BODY_SAMPLE, MAX_BODY_BYTES);
    return {
      ok: true,
      accept,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      vary: res.headers.get("vary") || "",
      link: res.headers.get("link") || "",
      // Measured, decoded, and null when it hit the cap, so a truncated read
      // reports no size rather than a floor dressed up as a total.
      bytes: body.truncated ? null : body.bytes,
      sample: body.head,
    };
  } catch (e) {
    return { ok: false, accept, error: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

export async function handleLensMarkdown(request, env) {
  const params = new URL(request.url).searchParams;

  const v = validateLensTarget(params.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  const target = v.url;
  const cacheKey = "lens:md:" + (await lensSha256Hex(target));

  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "json");
    if (hit) {
      return span("lens.markdown", (s) => {
        s.setAttribute("lens.target_host", hit.host);
        s.setAttribute("lens.cache", "hit");
        return jsonResponse({ ...hit, fromCache: true });
      });
    }
  }

  if (await overLensBudget(LENS_BUDGETS.markdown, request, env)) {
    return jsonResponse({ ok: false, error: `Markdown checks are rate-limited to ${LENS_BUDGETS.markdown.max}/min, because each one fetches the same page ten times from somebody else's origin. Hang on a moment.` }, 429);
  }

  return span("lens.markdown", async (s) => {
    const host = (() => { try { return new URL(target).hostname; } catch { return undefined; } })();
    s.setAttribute("lens.target_host", host);
    s.setAttribute("lens.cache", "miss");

    const { probes, agentProbe } = probePlan();
    // Serial rather than fanned out. Ten concurrent requests to one URL is a
    // burst somebody's rate limiter is right to refuse, and a refusal here would
    // be indistinguishable from the origin declining to negotiate, which is the
    // one confusion this tab exists to remove.
    const byId = new Map();
    for (const p of probes) byId.set(p.id, await probeOnce(target, env, p.accept));

    const control = byId.get("control");
    const md = byId.get("markdown");

    if (!control?.ok) {
      s.setAttribute("lens.outcome", "unreadable");
      return jsonResponse({
        ok: false, url: target, host,
        unreadable: true,
        error: control?.error || "the origin did not answer a plain browser request",
      });
    }

    const controlType = mediaType(control.contentType);
    const alternate = markdownAlternate(control.link, control.sample);

    // Does anything at all come back as Markdown? Read across every probe rather
    // than off the one check, because an origin that serves Markdown to Cursor
    // and not to a bare `text/markdown` still serves Markdown.
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

    // Read off the MARKDOWN response where there is one, because Vary is a claim
    // about the negotiated representation. An origin that varies correctly on the
    // HTML it always serves has not demonstrated anything.
    const varySource = (md?.ok && isMarkdown(md.contentType)) ? md : control;
    checks.push(variesOnAccept(varySource.vary)
      ? { id: "varies-by-accept", status: "pass", detail: `Vary: ${varySource.vary}` }
      : { id: "varies-by-accept", status: anyMarkdown ? "fail" : "warn",
          detail: varySource.vary
            ? `Vary: ${varySource.vary} — it does not name Accept, so a shared cache can hand one audience the other's copy.`
            : "No Vary header. A shared cache can hand one audience the other's copy." });

    const bogus = byId.get("unservable");
    checks.push(bogus?.ok
      ? (bogus.status === 406
        ? { id: "rejects-unservable", status: "pass", detail: `406 for Accept: ${UNSERVABLE}` }
        : { id: "rejects-unservable", status: "warn",
            detail: `Answered ${bogus.status} to a media type nothing serves. RFC 9110 permits ignoring Accept and returning a default, so this is a preference rather than a defect.` })
      : { id: "rejects-unservable", status: "warn", detail: bogus?.error || "no answer" });

    // Two q-value checks, because the single one on the public checklist tests
    // only the easy half. Ranking Markdown below HTML should yield HTML, and
    // that is what a server ordering by q-value gets right by construction.
    // `q=0` is the half that catches a substring match: it is an explicit
    // REFUSAL, and a server matching on the presence of the string serves
    // Markdown to a client that just said it will not take any.
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

    // ── the replay ───────────────────────────────────────────────────────────
    // Reach is scored against the CONTROL, never in isolation. Where the origin
    // hands every Accept the same bytes it is not negotiating, and the honest
    // reading is that no agent gets Markdown because there is none, rather than
    // that seven agents were individually turned away.
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

    // ── the delta ────────────────────────────────────────────────────────────
    // The claim every page about this makes is "a fraction of the bytes". This is
    // that claim as a number, on this URL, from the two responses just fetched.
    // Only where a Markdown representation actually came back, and only from
    // declared lengths, so nothing here is inferred from a 4KB sample.
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
    s.setAttribute("lens.outcome", anyMarkdown ? "markdown" : "html-only");

    const payload = {
      ok: true,
      url: target,
      host,
      // Null rather than 0 when the instrument cannot speak: no control admitted
      // means no reach number, for the same reason sampledBots refuses one.
      reach: negotiating ? { reached, of: answered.length } : null,
      negotiating,
      anyMarkdown,
      controlType,
      checks,
      agents,
      alternate,
      delta,
      // Every raw response the verdict rests on, so a reader can disagree with
      // the grading without re-running anything.
      responses: probes.map((p) => {
        const r = byId.get(p.id);
        return { id: p.id, accept: p.accept, ok: !!r?.ok, status: r?.status ?? null,
                 contentType: r?.contentType || "", vary: r?.vary || "", error: r?.error };
      }),
      sample: mdBest ? mdBest.sample.slice(0, BODY_SAMPLE) : "",
      source: "https://acceptmarkdown.com/status",
    };

    if (env.RN_KV) {
      await env.RN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: MARKDOWN_CACHE_SECONDS })
        .catch(() => { /* a cache write is never worth failing the read for */ });
    }
    return jsonResponse(payload);
  });
}
