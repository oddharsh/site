// counter.js — the homepage visit counter: an in-house Durable Object, rendered
// as /hit.svg so the homepage document itself never carries the count.
//
// Migrated off cf-garage's cross-script Counter (the old Pages setup couldn't host DOs;
// can). Same wire protocol home.js already speaks: GET https://do/ increments and
// returns {n}; ?peek=1 reads without bumping (bots/prerender). Storage is the
// per-DO SQLite-backed KV (state.storage), one instance named "homepage-visits".
//
// Continuity: an in-house DO is a fresh namespace, so it would start at 0. On the
// first wake it self-seeds once from env.COUNTER_SEED (the count carried over from
// the old cf-garage DO) so the number doesn't reset. Idempotent + guarded in memory
// so it costs at most one storage read per DO lifetime, never per request.
export class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._checked = false;   // in-memory: seed-check runs once per DO instance, not per request
  }

  async fetch(request) {
    if (!this._checked) {
      this._checked = true;
      const seeded = await this.state.storage.get("seeded");
      if (!seeded && this.env && this.env.COUNTER_SEED != null) {
        await this.state.storage.put("n", parseInt(this.env.COUNTER_SEED, 10) || 0);
        await this.state.storage.put("seeded", true);
      }
    }

    const url = new URL(request.url);
    let n = (await this.state.storage.get("n")) || 0;

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

// ── GET /hit.svg — the counter's tick endpoint + a curl-able odometer ───────
// The homepage DISPLAYS the count as SSR'd text from a read-only peek (home.js),
// so rendering never mutates; the tick arrives here as ?tick=1 (the beacon at
// the end of index.html's body, deferred to prerenderingchange on speculative
// loads, plus a <noscript> pixel). HEAD, ?peek, verified bots, and Sec-Purpose
// speculative loads never tick. Fetch /hit.svg directly and you get the
// odometer as a tiny SVG, no-store, which is its own little easter egg.
export async function handleHitSvg(request, env) {
  const url = new URL(request.url);
  const ua = request.headers.get("user-agent") || "";
  const peek = request.method === "HEAD"
    || url.searchParams.has("peek")
    || /prefetch|prerender/i.test(request.headers.get("sec-purpose") || "")
    || request.cf?.botManagement?.verifiedBot === true
    || PEEK_UA.test(ua);

  let n = null;
  if (env.COUNTER) {
    try {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"));
      n = (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;
    } catch {}
  }

  // the activation beacon wants the tick, never the pixels
  if (url.searchParams.has("tick")) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // transparent SVG digits; the pill (dark ground, bevel, padding) stays page
  // CSS on img.counter, so the image re-skins with the page. null DO reads
  // render the classic dead-counter dashes rather than a fabricated number.
  const digits = typeof n === "number" ? String(n).padStart(6, "0") : "------";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="12" viewBox="0 0 52 12" role="img" aria-label="visitor ${digits}"><text x="0" y="10" font-family="'Courier New',Courier,monospace" font-size="12" font-weight="bold" letter-spacing="1.2" fill="oklch(86.52% 0.1768 90.38)">${digits}</text></svg>`;
  return new Response(svg, {
    headers: {
      "content-type":  "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag":  "noindex",
    },
  });
}
