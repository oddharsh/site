import { outboundRead } from "./lib/outbound.ts";
import { parseCacheControl } from "./dict.ts";

const FETCH_TIMEOUT = 8000;

type HeaderProbe =
  | { status: number; headers: Record<string, string>; error?: never }
  | { error: string; status?: never; headers?: never };

async function probeHeaders(url, env, extraHeaders = {}): Promise<HeaderProbe> {
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT);
  try {
    const base = {
      "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7",
      ...extraHeaders,
    };
    const read = await outboundRead(url, env, {
      method: "GET",
      headers: base,
      signal: deadline,
      identity: { as: "aadharshbot" },
      maxHops: 20,
    });
    if (!read.ok) return { error: read.error.slice(0, 80) };
    const res = read.response;
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of res.headers) responseHeaders[key.toLowerCase()] = value;
    try { await res.body?.cancel(); } catch { }
    return { status: res.status, headers: responseHeaders };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 80) };
  }
}

export function judgeRevalidation({ first, second, conditional, negotiated }: {
  first?: any; second?: any; conditional?: any; negotiated?: any;
}) {
  const findings = [];
  const add = (id, verdict, detail) => findings.push({ id, verdict, detail });

  const etag1 = first.headers?.etag;
  const etag2 = second?.headers?.etag;
  const lastMod = first.headers?.["last-modified"];
  const cc = parseCacheControl(first.headers?.["cache-control"]);

  if (!etag1 && !lastMod) {
    add("validator", "veto", "no ETag and no Last-Modified — nothing to revalidate against; every expiry is a full re-download");
  } else {
    add("validator", "ok", etag1 ? `ETag ${etag1.slice(0, 40)}` : `Last-Modified only (${lastMod})`);
  }

  if (etag1 && etag2) {
    if (etag1 === etag2) add("stability", "ok", "identical across two unconditional fetches");
    else add("stability", "veto", `CHANGED between identical requests (${etag1.slice(0, 24)} → ${etag2.slice(0, 24)}) — this ETag can never match, so revalidation is theater`);
  } else if (etag1 && second && !etag2) {
    add("stability", "warn", "ETag present on one response and absent on the next — intermittent validators cannot be relied on");
  }

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

  if (etag1?.startsWith("W/")) add("weak", "warn", "weak ETag — legal for revalidation, but disables If-Range resumption");

  if (negotiated) {
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

  const maxAge = Number(cc.get("max-age"));
  if (cc.has("immutable") && Number.isFinite(maxAge) && maxAge >= 2592000) {
    add("freshness", "ok", "immutable + long max-age — revalidation rarely happens at all, which is the best outcome");
  } else if (Number.isFinite(maxAge)) {
    add("freshness", "ok", `max-age=${maxAge}; after that, every request pays the revalidation graded above`);
  }

  const vetoes = findings.filter((f) => f.verdict === "veto");
  return { findings, vetoes, healthy: vetoes.length === 0 };
}

export async function probeRevalidation(url, env) {
  const first = await probeHeaders(url, env);
  if ("error" in first) return { ok: false, unreadable: true, why: first.error };
  if (!first.headers) return { ok: false, why: "no headers came back" };

  const second = await probeHeaders(url, env);
  const etag = first.headers.etag;
  const lastMod = first.headers["last-modified"];

  const conditionalHeaders = {};
  if (etag) conditionalHeaders["if-none-match"] = etag;
  if (lastMod) conditionalHeaders["if-modified-since"] = lastMod;
  const conditional = (etag || lastMod) ? await probeHeaders(url, env, conditionalHeaders) : null;

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
