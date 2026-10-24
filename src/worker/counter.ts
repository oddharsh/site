import { asNumber } from "./lib/parse.ts";
import { jsonResponse } from "./lib/http.ts";

// counter.ts — the homepage visit counter's HTTP side: /hit, and the KV mirror
// the homepage reads instead of asking the Durable Object.
//
// The Durable Object itself, Counter, lives in the aadhar-counter Worker
// (counter/src/counter.ts) since 2026-09-29, and this Worker reaches it through
// its COUNTER binding (`script_name: "aadhar-counter"`). It moved so that this
// Worker implements no Durable Object, which is the one thing that denied it
// preview URLs; docs/MAINTENANCE.md (preview URLs) has the story.
//
// Continuity: the transfer to aadhar-counter kept the same namespace, so the
// count did not reset. A future move has to keep it too.

// UAs that read the count without advancing it.
const PEEK_UA =
  /bot|crawl|spider|slurp|crawler|bingpreview|facebookexternalhit|embedly|slackbot|whatsapp|telegrambot|discordbot|redditbot|petalbot|gptbot|claudebot|ccbot|perplexity|bytespider|google-extended/i;

// ── the KV mirror the homepage render reads ──────────────────────────
// COUNT_KEY holds the value and never expires, so a reader always finds a
// number even after a quiet night. Its KV METADATA carries the write time, and
// that stamp is the throttle: the same one-key shape lib/cache.ts's swrKV uses,
// for the same reason (a timestamp beside the value costs no second key).
//
// Without a throttle this is one write per visit, and it would also fight
// Cloudflare's 1-write-per-second-per-key limit under any burst. Behind the stamp
// the worst case is one write per MIRROR_TTL under continuous traffic:
// 86400 / 60 = 1,440 a day. A visit odometer trailing real time by a minute is
// not a number anyone audits.
//
// THAT IS STILL OVER THE FREE-PLAN CEILING: Workers Free allows 1,000 KV writes
// a day (Paid is unlimited), so 1,440 is about 1.4x over. It rarely binds,
// because 1,440 is a CEILING on a site nowhere near a visit a second: a write
// happens only when /hit runs and finds the stamp lapsed, so the real figure is
// min(ticks, 1440) and a quiet day is a small fraction of it.
//
// MIRROR_TTL is the lever if it ever has to close: writes/day is 86400/MIRROR_TTL,
// so 90s buys 960/day and 120s buys 720. It stays at 60 because moving it trades
// odometer lag against a ceiling nobody has measured this hitting, and arithmetic
// alone is not evidence. No KV floor binds it: the stamp lives in metadata,
// which needs no expirationTtl.
export const COUNT_KEY = "counter:n";
const MIRROR_TTL = 60; // seconds between mirror writes; priced above

async function mirrorCount(env, n, force = false) {
  try {
    if (!force) {
      // An entry with no metadata reads as lapsed, so it mirrors once and gets
      // stamped. Same call shape as swrKV's read: absence is treated as stale
      // rather than guessed at.
      const { metadata } = await env.RN_KV.getWithMetadata(COUNT_KEY, { type: "text" });
      const written = Number(metadata && metadata.t);
      if (Number.isFinite(written) && Date.now() - written < MIRROR_TTL * 1000) return;
    }
    await env.RN_KV.put(COUNT_KEY, String(n), { metadata: { t: Date.now() } });
  } catch {} // a missed mirror costs staleness, never the response
}

// ── GET /hit — the counter's tick endpoint, and an odometer if you ask for one ──
// `/` never mutates the count while it renders. Advancing it happens here, and
// callers arrive wanting one of three things:
//   ?tick=1&n=1  the scripted beacon at the end of index.html's body (deferred
//            to prerenderingchange on speculative loads): the tick, then the
//            mirrored count as JSON for the footer odometer.
//   ?tick=1  the side effect and no bytes → 204, returned WITHOUT waiting on
//            the DO (see below).
//   bare     the <noscript> pixel and anyone who curls the route. An <img> asked,
//            so an image answers → an SVG odometer, which needs the number and
//            therefore does wait for it.
// HEAD, ?peek, verified bots, and Sec-Purpose speculative loads read without
// advancing, whichever shape they asked for.
//
// No file extension: only one of the shapes is an image, and browsers pick a
// decoder off content-type rather than the path, so the <noscript> <img> is happy
// against a bare route.
export async function handleHit(request, env, ctx) {
  const url = new URL(request.url);
  const ua = request.headers.get("user-agent") || "";
  const peek =
    request.method === "HEAD" ||
    url.searchParams.has("peek") ||
    /prefetch|prerender/i.test(request.headers.get("sec-purpose") || "") ||
    request.cf?.botManagement?.verifiedBot === true ||
    PEEK_UA.test(ua);

  // The one DO round trip. A DO is a single global instance, so this costs a trip
  // to wherever it lives: 185-308ms measured from SJC, and 630ms on a cold
  // contended incognito load (devtools, 2026-07-28) where it competed with the
  // grid's 12 AVIF tiles for the connection pool.
  const readCount = async () => {
    if (!env.COUNTER) return null;
    try {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"));
      return (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;
    } catch {
      return null;
    }
  };
  // Mirror the fresh count into KV so nothing on the homepage's path has to ask
  // the DO. Awaiting the DO inside the homepage render suspended the HTML stream
  // at the footer: a devtools trace on 2026-07-27 caught the parser idle from
  // 635ms to 901ms, and that tail gates DCL, nav.js, and the whole desktop shell
  // behind it. A KV read costs 5-8ms. The number can lag by up to MIRROR_TTL,
  // which is invisible on an odometer and cheaper than stalling every
  // visitor's shell.
  const mirror = (n) => (env.RN_KV && asNumber(n) !== null ? mirrorCount(env, n) : null);

  // The activation beacon wants the tick, and the number it reads comes from the
  // mirror, so there is nothing here for the client to wait on. Hand back the
  // response immediately and finish the DO trip (and the mirror it feeds) under
  // waitUntil, which keeps the worker alive until they settle. The side effect
  // is just as durable, and the beacon stops holding a socket for ~630ms against
  // the same pool the photo tiles are queued in. Without a ctx (tests, direct
  // calls) fall back to awaiting, so the tick can never be silently dropped.
  if (url.searchParams.has("tick")) {
    const work = readCount()
      .then(mirror)
      .catch(() => {});
    if (ctx) ctx.waitUntil(work);
    else await work;
    if (!url.searchParams.has("n")) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // `?n=1`: the number as JSON, for the footer odometer. Alone it reads without
  // ticking; the homepage sends it with `tick=1`.
  //
  // `/` is a deterministic document, and a per-visitor count is the definition
  // of non-deterministic, so the count hydrates from here. It reads the MIRROR
  // rather than the DO (5-8ms instead of the 185-630ms global round trip). A
  // miss answers null, and the page leaves its static placeholder rather than
  // inventing a number.
  //
  // cacheTtl MIRROR_TTL: the mirror behind this key is rewritten at most once per
  // MIRROR_TTL anyway, so caching the read for the same window can only ever double
  // the lag the throttle above already accepts, to two minutes. KV's floor is 30
  // seconds (lowered from 60 on 2026-01-30), so 60 is a choice rather than the
  // minimum.
  if (url.searchParams.has("n")) {
    let n = null;
    try {
      const v = env.RN_KV && (await env.RN_KV.get(COUNT_KEY, { cacheTtl: MIRROR_TTL }));
      if (v != null) n = Number(v);
    } catch {}
    return jsonResponse({ n: Number.isFinite(n) ? n : null }, 200, { "x-robots-tag": "noindex" }, { pretty: false });
  }

  // everyone else asked for an image, which means they asked for the NUMBER, so
  // this path still waits for the DO. bare transparent digits in the footer
  // pill's own ink, so the standalone render reads as the same odometer minus
  // its housing. null DO reads render the classic dead-counter dashes rather
  // than a fabricated number.
  const n = await readCount();
  const pending = mirror(n);
  if (pending && ctx) ctx.waitUntil(pending);

  const digits = asNumber(n) === null ? "------" : String(n).padStart(6, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="12" viewBox="0 0 52 12" role="img" aria-label="visitor ${digits}"><text x="0" y="10" font-family="'Courier New',Courier,monospace" font-size="12" font-weight="bold" letter-spacing="1.2" fill="oklch(86.52% 0.1768 90.38)">${digits}</text></svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
