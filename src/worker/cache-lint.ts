// cache-lint.js — does your cache validator actually work? A BEHAVIORAL probe,
// not a header read.
//
// ── the silent failure this catches ───────────────────────────────────────
// A huge class of origins serve an ETag that never matches: the server varies
// compression (or a template nonce, or a timestamp) per response, so the
// validator changes on every fetch and every If-None-Match revalidation comes
// back 200 with a full body. The headers look perfect. Nothing warns. Your
// "cached" asset re-downloads in full on every revisit, forever.
//
// No header-reading grader can see this, because the pathology is not IN one
// response — it is BETWEEN responses. So this tool fetches the target twice and
// then replays the validator, and reports what the origin actually did:
//
//   fetch #1                 -> note ETag / Last-Modified
//   fetch #2 (unconditional) -> did the validator CHANGE between identical requests?
//   fetch #3 (If-None-Match) -> did a 304 actually come back?
//
// Three subrequests, near-zero CPU: this runs comfortably inside the free
// plan's 10ms, which dict.js and lens's parse cap made the house standard.
//
// ── the second trap: negotiation without Vary ─────────────────────────────
// Hit in production on THIS site (#195): a route answered `Accept: text/markdown`
// with markdown, but the cached HTML's Vary named only accept-encoding, so a
// markdown ask off a warm cache came back HTML. The lint probes it the same
// behavioral way: ask for a second representation and check whether the answer
// changed while Vary claims it cannot.
import { botHeaders } from "./lib/botauth.ts";
import { CANONICAL_HOST } from "./lib/const.ts";
import { parseCacheControl } from "./dict.ts";

const FETCH_TIMEOUT = 8000;

/** One bounded, signed fetch that reads only headers (body cancelled). */
async function probeHeaders(url, env, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const base = {
      "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7",
      ...extraHeaders,
    };
    let isSelf = false;
    try { isSelf = new URL(url).hostname.toLowerCase() === CANONICAL_HOST && !!(env.SELF_FETCH || env.ASSETS); } catch { /* not self */ }
    const headers = await botHeaders(url, env, { headers: base, sign: !isSelf });
    const req = new Request(url, { headers, redirect: "follow" });
    const res = isSelf
      ? await (env.SELF_FETCH ? env.SELF_FETCH(req) : env.ASSETS.fetch(req))
      : await fetch(url, { headers, redirect: "follow", signal: controller.signal, cf: { cacheTtl: 0 } });
    const out = { status: res.status, headers: {} };
    for (const [key, value] of res.headers) out.headers[key.toLowerCase()] = value;
    try { await res.body?.cancel(); } catch { /* already drained */ }
    return out;
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

/**
 * The verdict, as a pure function of the three observations (plus the optional
 * negotiation pair). Pure so the rules are testable without a network — the
 * same argument dict.js and doors.js already made, and the same reason: every
 * external fetch here dies at signing under plain node.
 */
export function judgeRevalidation({ first, second, conditional, negotiated }) {
  const findings = [];
  const add = (id, verdict, detail) => findings.push({ id, verdict, detail });

  const etag1 = first.headers?.etag;
  const etag2 = second?.headers?.etag;
  const lastMod = first.headers?.["last-modified"];
  const cc = parseCacheControl(first.headers?.["cache-control"]);

  // Is there a validator at all?
  if (!etag1 && !lastMod) {
    add("validator", "veto", "no ETag and no Last-Modified — nothing to revalidate against; every expiry is a full re-download");
  } else {
    add("validator", "ok", etag1 ? `ETag ${etag1.slice(0, 40)}` : `Last-Modified only (${lastMod})`);
  }

  // Does the validator survive two identical requests? THE big one.
  if (etag1 && etag2) {
    if (etag1 === etag2) add("stability", "ok", "identical across two unconditional fetches");
    else add("stability", "veto", `CHANGED between identical requests (${etag1.slice(0, 24)} → ${etag2.slice(0, 24)}) — this ETag can never match, so revalidation is theater`);
  } else if (etag1 && second && !etag2) {
    add("stability", "warn", "ETag present on one response and absent on the next — intermittent validators cannot be relied on");
  }

  // Did the conditional request actually 304?
  if (conditional) {
    if (conditional.status === 304) add("revalidation", "ok", "If-None-Match answered 304 — the round trip costs headers, not the body");
    else if (conditional.status === 200 && etag1 === etag2 && etag1) {
      add("revalidation", "veto", "stable ETag but If-None-Match still answered 200 — the origin ignores conditional requests");
    } else if (conditional.status === 200) {
      add("revalidation", "bad-but-explained", "200, consistent with the unstable validator above");
    } else {
      add("revalidation", "warn", `unexpected ${conditional.status} to a conditional request`);
    }
  }

  // Weak validators are fine for bytes, fatal for ranges; say which kind this is.
  if (etag1?.startsWith("W/")) add("weak", "warn", "weak ETag — legal for revalidation, but disables If-Range resumption");

  // The #195 trap: a second representation from one URL with a Vary that
  // doesn't name the negotiating header.
  if (negotiated) {
    // TOKENS, not substring. "accept-encoding".includes("accept") is true, so a
    // substring test waves through the exact header combination #195 shipped
    // with. This bug existed in this very function for one commit; the contract
    // test caught it before it lied to anyone.
    const varyTokens = (first.headers?.vary || "").toLowerCase().split(",").map((t) => t.trim());
    const variesOnAccept = varyTokens.includes("accept") || varyTokens.includes("*");
    const differs = negotiated.headers?.["content-type"] !== first.headers?.["content-type"];
    if (differs && !variesOnAccept) {
      add("vary", "veto", `negotiates on Accept (${first.headers?.["content-type"]} vs ${negotiated.headers?.["content-type"]}) but Vary is "${first.headers?.vary || "(none)"}" — a shared cache WILL serve the wrong representation`);
    } else if (differs) {
      add("vary", "ok", "negotiates on Accept and says so in Vary");
    } else {
      add("vary", "ok", "one representation; Vary owes nothing");
    }
  }

  // Freshness context, so the verdict reads in terms of what actually happens.
  const maxAge = Number(cc.get("max-age"));
  if (cc.has("immutable") && Number.isFinite(maxAge) && maxAge >= 2592000) {
    add("freshness", "ok", "immutable + long max-age — revalidation rarely happens at all, which is the best outcome");
  } else if (Number.isFinite(maxAge)) {
    add("freshness", "ok", `max-age=${maxAge}; after that, every request pays the revalidation graded above`);
  }

  const vetoes = findings.filter((f) => f.verdict === "veto");
  return { findings, vetoes, healthy: vetoes.length === 0 };
}

/**
 * Run the whole probe against one URL. The caller has already validated the
 * target (validateLensTarget) and charged the rate budget.
 */
export async function probeRevalidation(url, env) {
  const first = await probeHeaders(url, env);
  if (first.error) return { ok: false, unreadable: true, why: first.error };
  if (!first.headers) return { ok: false, why: "no headers came back" };

  const second = await probeHeaders(url, env);
  const etag = first.headers.etag;
  const lastMod = first.headers["last-modified"];

  const conditionalHeaders = {};
  if (etag) conditionalHeaders["if-none-match"] = etag;
  if (lastMod) conditionalHeaders["if-modified-since"] = lastMod;
  const conditional = (etag || lastMod) ? await probeHeaders(url, env, conditionalHeaders) : null;

  // The negotiation probe only makes sense for HTML documents.
  const isHtml = (first.headers["content-type"] || "").includes("text/html");
  const negotiated = isHtml ? await probeHeaders(url, env, { accept: "text/markdown, text/plain;q=0.9" }) : null;

  return {
    ok: true,
    status: first.status,
    observations: { first, second, conditional, negotiated },
    verdict: judgeRevalidation({
      first, second,
      conditional: conditional?.error ? null : conditional,
      negotiated: negotiated?.error ? null : negotiated,
    }),
  };
}
