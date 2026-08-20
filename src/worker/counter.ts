import { claimReservation, dropReservation } from "../../cal/src/reservation.js";
import { asNumber } from "./lib/parse.ts";

// counter.js — the homepage visit counter: an in-house Durable Object, read by
// the document and advanced out-of-band by /hit.
//
// Migrated off cf-garage's cross-script Counter (the old Pages setup couldn't host DOs;
// can). Same wire protocol home.js already speaks: GET https://do/ increments and
// returns {n}; ?peek=1 reads without bumping (bots/prerender). Storage is the
// per-DO SQLite-backed KV (state.storage), one instance named "homepage-visits".
//
// Continuity: an in-house DO is a fresh namespace, so it started at 0. A one-time
// self-seed from env.COUNTER_SEED carried the count over from the old cf-garage DO
// (~2375 at migration). That ran, the `seeded` storage flag is set, and the counter
// is well past the seed, so the seed path and its once-per-instance storage read
// came out on 2026-07-28. The `seeded` key stays in storage, harmless and unread.
// This class also backs the coffee slot reservations, under instance names of
// the form `coffee-slot:<start>:<end>`. Two jobs in one class is deliberate: a
// second Durable Object class needs a `new_sqlite_classes` migration, and the
// release path publishes with `wrangler versions upload`, which cannot apply
// one. Instances are isolated by name, so a slot shares nothing with
// "homepage-visits", and the storage keys differ as well ("reservation" vs "n").
// The reservation logic itself lives in cal/src/reservation.js, pure over a
// storage interface, so it is tested without a runtime. See that file for why
// the pair has to be atomic at all.
export class Counter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // The reservation paths come first: they are addressed by pathname and must
    // never fall through to the odometer, which would bump a visit count on a
    // slot instance.
    if (url.pathname === "/reserve" || url.pathname === "/release") {
      let payload;
      try { payload = await request.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
      const bookingId = String(payload?.bookingId || "");
      if (!bookingId) return Response.json({ error: "bookingId is required" }, { status: 400 });
      if (url.pathname === "/release") {
        return Response.json({ released: await dropReservation(this.state.storage, bookingId) });
      }
      const claimed = await claimReservation(
        this.state.storage, bookingId, Number(payload.start), Number(payload.end),
      );
      return Response.json({ claimed });
    }

    let n = (await this.state.storage.get<number>("n")) || 0;

    // read-only: bots + speculative prerenders see the value without bumping it
    if (url.searchParams.has("peek")) return Response.json({ n });

    // default: atomic increment (classic-90s-counter behavior, no session dedup)
    n += 1;
    await this.state.storage.put("n", n);
    return Response.json({ n });
  }
}

// UAs that read the count without advancing it (mirrors the old home.js gate).
const PEEK_UA = /bot|crawl|spider|slurp|crawler|bingpreview|facebookexternalhit|embedly|slackbot|whatsapp|telegrambot|discordbot|redditbot|petalbot|gptbot|claudebot|ccbot|perplexity|bytespider|google-extended/i;

// ── the KV mirror the homepage render reads ──────────────────────────
// COUNT_KEY holds the value and never expires, so the render always finds a
// number even after a quiet night. FRESH_KEY is a TTL sentinel that throttles
// the writes, the same value + freshness pair the images manifest uses.
//
// The throttle is what keeps this inside the ~10K writes/day KV budget: an
// unthrottled mirror would be one write per visit AND would fight Cloudflare's
// 1-write-per-second-per-key limit under any burst. Behind the sentinel the worst
// case is 2 writes per MIRROR_TTL even under continuous traffic, ~2.9K/day, and a
// visit odometer trailing real time by a minute is not a number anyone audits.
export const COUNT_KEY = "counter:n";
const FRESH_KEY = "counter:n:fresh";
const MIRROR_TTL = 60;   // seconds; KV's floor for expirationTtl is 60

async function mirrorCount(env, n, force = false) {
  try {
    if (!force && await env.RN_KV.get(FRESH_KEY)) return;   // a recent tick already mirrored
    await Promise.all([
      env.RN_KV.put(COUNT_KEY, String(n)),
      env.RN_KV.put(FRESH_KEY, "1", { expirationTtl: MIRROR_TTL }),
    ]);
  } catch {}   // a missed mirror costs staleness, never the response
}

// ── GET /hit — the counter's tick endpoint, and an odometer if you ask for one ──
// The homepage DISPLAYS the count as SSR'd text from a read-only peek (home.js),
// so rendering never mutates. Advancing it happens here, and callers arrive
// wanting one of two things:
//   ?tick=1  the scripted beacon at the end of index.html's body (deferred to
//            prerenderingchange on speculative loads). It wants the side effect
//            and no bytes → 204, returned WITHOUT waiting on the DO (see below).
//   bare     the <noscript> pixel and anyone who curls the route. An <img> asked,
//            so an image answers → ~330B of SVG odometer, which needs the number
//            and therefore does wait for it.
// HEAD, ?peek, verified bots, and Sec-Purpose speculative loads read without
// advancing, whichever shape they asked for.
//
// No file extension: only one of the two shapes is an image, and browsers pick a
// decoder off content-type rather than the path, so the <noscript> <img> is happy
// against a bare route. It was /hit.svg while the footer count ITSELF was the
// image (v133–v138); the count came back to the document as text in v138 and the
// name outlived the reason.
export async function handleHit(request, env, ctx) {
  const url = new URL(request.url);
  const ua = request.headers.get("user-agent") || "";
  const peek = request.method === "HEAD"
    || url.searchParams.has("peek")
    || /prefetch|prerender/i.test(request.headers.get("sec-purpose") || "")
    || request.cf?.botManagement?.verifiedBot === true
    || PEEK_UA.test(ua);

  // The one DO round trip. A DO is a single global instance, so this costs a trip
  // to wherever it lives: 185-308ms measured from SJC, and 630ms on a cold
  // contended incognito load (devtools, 2026-07-28) where it competed with the
  // grid's 12 AVIF tiles for the connection pool.
  const readCount = async () => {
    if (!env.COUNTER) return null;
    try {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"));
      return (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;
    } catch { return null; }
  };
  // Mirror the fresh count into KV so the homepage render never has to ask the DO.
  // home.js used to await the DO read inside its `.counter` HTMLRewriter handler,
  // which suspended the HTML output stream at the footer — a devtools trace on
  // 2026-07-27 caught the parser idle from 635ms to 901ms, and that tail gates
  // DCL, nav.js, and the whole desktop shell behind it. Reading KV instead folds
  // the count into the render's existing parallel fan-out at 5-8ms. The number
  // can lag by up to MIRROR_TTL, which is invisible on an odometer and cheaper
  // than stalling every visitor's shell.
  const mirror = (n) => (env.RN_KV && asNumber(n) !== null ? mirrorCount(env, n) : null);

  // The activation beacon wants the tick and discards the number, so there is
  // nothing here for the client to wait on. Hand back the 204 immediately and
  // finish the DO trip (and the mirror it feeds) under waitUntil, which keeps
  // the worker alive until they settle — the side effect is just as durable,
  // and the beacon stops holding a socket for ~630ms against the same pool the
  // photo tiles are queued in. Without a ctx (tests, direct calls) fall back to
  // awaiting, so the tick can never be silently dropped.
  if (url.searchParams.has("tick")) {
    const work = readCount().then(mirror).catch(() => {});
    if (ctx) ctx.waitUntil(work); else await work;
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // `?n=1`: the number as JSON, for the footer odometer.
  //
  // The homepage used to SSR this digit string from the KV mirror. `/` is a
  // deterministic document now, and a per-visitor count is the definition of
  // non-deterministic, so it hydrates instead. It reads the MIRROR rather than
  // the DO — same source the old render used, 5-8ms instead of the 185-630ms
  // global round trip — and it is fetched on idle, because a footer odometer is
  // the last thing on the page that matters. A miss leaves the static
  // placeholder alone rather than inventing a number.
  if (url.searchParams.has("n")) {
    let n = null;
    try { const v = env.RN_KV && await env.RN_KV.get(COUNT_KEY); if (v != null) n = Number(v); } catch {}
    return Response.json({ n: Number.isFinite(n) ? n : null }, {
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }

  // everyone else asked for an image, which means they asked for the NUMBER, so
  // this path still waits for the DO. The mirror stays off it. bare transparent
  // digits in the footer pill's own ink, so the standalone render reads as the
  // same odometer minus its housing. null DO reads render the classic
  // dead-counter dashes rather than a fabricated number.
  const n = await readCount();
  const pending = mirror(n);
  if (pending && ctx) ctx.waitUntil(pending);

  const digits = asNumber(n) === null ? "------" : String(n).padStart(6, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="12" viewBox="0 0 52 12" role="img" aria-label="visitor ${digits}"><text x="0" y="10" font-family="'Courier New',Courier,monospace" font-size="12" font-weight="bold" letter-spacing="1.2" fill="oklch(86.52% 0.1768 90.38)">${digits}</text></svg>`;
  return new Response(svg, {
    headers: {
      "content-type":  "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag":  "noindex",
    },
  });
}
