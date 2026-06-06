// cf-garage — backend for the /garage/cloudflare demo. Exercises four free-tier
// Cloudflare platform features live, one endpoint each. Routed at
// aadhar.sh/garage/cf/* (ahead of the Pages project). Every request logs a
// structured line (Workers Logs, feature #4).

const ORIGIN = "https://aadhar.sh";
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": ORIGIN,
      "cache-control": "no-store",
    },
  });

// ── Durable Object: an atomic, strongly-consistent counter ────────────────
// SQLite-backed (the free-tier DO flavour). Unlike the KV counter on the
// homepage (eventually consistent + 1k writes/day cap), this increments exactly
// once per call with no race — the canonical DO use case.
export class Counter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url);
    let n = (await this.state.storage.get("n")) || 0;
    // one-time idempotent seed — migrate a starting value (e.g. the old KV count)
    // in without ever clobbering a counter that's already live.
    if (url.searchParams.has("seed")) {
      if (!(await this.state.storage.get("seeded"))) {
        n = parseInt(url.searchParams.get("seed"), 10) || 0;
        await this.state.storage.put("n", n);
        await this.state.storage.put("seeded", true);
      }
      return Response.json({ n, seeded: true });
    }
    // read-only — bots/peekers see the value without bumping it
    if (url.searchParams.has("peek")) return Response.json({ n });
    // default — atomic increment (the canonical counter behaviour)
    n += 1;
    await this.state.storage.put("n", n);
    return Response.json({ n });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const t0 = Date.now();

    // Feature #4 — Workers Logs: structured line per request, captured + filterable
    // in the dashboard (200k events/day free). We log the feature + outcome below.
    const log = (extra) =>
      console.log(JSON.stringify({ path, ua: (request.headers.get("user-agent") || "").slice(0, 48), ...extra }));

    try {
      // Feature #1 — Durable Objects: atomic counter
      if (path === "/garage/cf/counter") {
        const id = env.COUNTER.idFromName("garage-global");
        const res = await env.COUNTER.get(id).fetch("https://do/");
        const { n } = await res.json();
        log({ feature: "durable-object", n, ms: Date.now() - t0 });
        return json({ ok: true, count: n });
      }

      // One-time migration helper: seed the "homepage-visits" Counter instance from
      // the old KV count, so when the homepage's COUNTER binding goes live it picks up
      // where KV left off instead of resetting to zero. Idempotent — the DO only seeds
      // once, so re-calls are no-ops. Same DO instance the homepage _worker.js addresses
      // (DO identity = namespace + name), so seeding here lands there.
      if (path === "/garage/cf/seed-homepage") {
        const seed = parseInt(url.searchParams.get("n") || "0", 10) || 0;
        const id = env.COUNTER.idFromName("homepage-visits");
        const res = await env.COUNTER.get(id).fetch(`https://do/?seed=${seed}`);
        const out = await res.json();
        log({ feature: "do-seed", seed, n: out.n, ms: Date.now() - t0 });
        return json({ ok: true, ...out });
      }

      // Feature #2 — Workers AI: caption a real grid photo (10k neurons/day free)
      if (path === "/garage/cf/caption") {
        const stem = (url.searchParams.get("img") || "XT508165").replace(/[^A-Za-z0-9_-]/g, "");
        const img = await fetch(`${ORIGIN}/images/${stem}.jpg?v=17`);
        if (!img.ok) { log({ feature: "workers-ai", err: "thumb-missing" }); return json({ ok: false, error: "thumbnail not found" }, 404); }
        const bytes = [...new Uint8Array(await img.arrayBuffer())];
        // ?mode=alt → tight, factual alt text (used to bake <img alt> for the grid).
        // default → the vivid demo caption. alt text shouldn't editorialize or guess.
        const prompt = url.searchParams.get("mode") === "alt"
          ? "Write alt text for this photo: one plain, factual sentence naming only what is clearly visible (main subject and setting). No mood, no interpretation, no guessing, no 'image of'. Under 16 words."
          : "Describe this photograph in one vivid sentence suitable as alt text. Be concrete about subject, light, and mood.";
        const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: bytes,
          prompt,
          max_tokens: 64,
        });
        let caption = (out.description || out.response || "").trim()
          .replace(/^(an? |the )?(image|photo|photograph|picture) (of|shows|depicts|captures)\s*/i, "")
          .replace(/\s+/g, " ").trim();
        if (caption) caption = caption[0].toUpperCase() + caption.slice(1);
        log({ feature: "workers-ai", stem, mode: url.searchParams.get("mode") || "demo", chars: caption.length, ms: Date.now() - t0 });
        return json({ ok: true, stem, caption });
      }

      // Feature #3 — Browser Rendering: headless-Chromium screenshot. PARKED (see
      // /garage/cloudflare). A bare GET no-ops WITHOUT launching, so crawlers,
      // prerenders, and cache-busted probes can't burn the free 10-min/day budget or
      // leak sessions — only ?go=1 drives a real browser. Every path is BOUNDED and
      // ALWAYS releases the browser:
      //   • the launch is raced against a 25s timeout; if it resolves late, the browser
      //     is reaped via waitUntil rather than stranded (the old code abandoned a live
      //     browser on timeout → the isolate tore down its pending websocket → the
      //     "Websocket error: SessionID …" log noise, and the un-close()d session ate
      //     one of the 2 free concurrent slots, erroring the next launch).
      //   • NO session reuse: connecting to an "idle" session is unbounded, and a dead
      //     orphan reads as idle, so reuse just hangs on the corpse. A fresh launch each
      //     time is slower but always bounded.
      //   • close() in finally frees the slot + stops the per-session time meter.
      if (path === "/garage/cf/screenshot") {
        if (url.searchParams.get("go") !== "1") {
          log({ feature: "browser-rendering", step: "parked-noop", ms: Date.now() - t0 });
          return json({ ok: false, parked: true,
            error: "Browser Rendering is parked — append ?go=1 to actually launch a browser. See /garage/cloudflare." }, 503);
        }
        let target = url.searchParams.get("url") || ORIGIN;
        if (!/^https:\/\/(www\.)?aadhar\.sh(\/|$)/.test(target)) target = ORIGIN; // SSRF guard
        const puppeteer = (await import("@cloudflare/puppeteer")).default;
        const launch = puppeteer.launch(env.BROWSER);
        let browser;
        try {
          browser = await Promise.race([
            launch,
            new Promise((_, rej) => setTimeout(() => rej(new Error("launch timed out (25s) — free tier didn't provision a browser in time")), 25000)),
          ]);
        } catch (e) {
          ctx.waitUntil(launch.then((b) => b.close()).catch(() => {})); // reap a late launch
          log({ feature: "browser-rendering", step: "launch-timeout", ms: Date.now() - t0 });
          return json({ ok: false, error: String(e.message || e) }, 502);
        }
        log({ feature: "browser-rendering", step: "launched", ms: Date.now() - t0 });
        try {
          const page = await browser.newPage();
          await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
          await new Promise((r) => setTimeout(r, 800)); // brief paint settle
          const png = await page.screenshot({ type: "png" });
          log({ feature: "browser-rendering", target, bytes: png.length, ms: Date.now() - t0 });
          return new Response(png, {
            headers: {
              "content-type": "image/png",
              "access-control-allow-origin": ORIGIN,
              "cache-control": "public, max-age=300",
            },
          });
        } finally { try { await browser.close(); } catch {} }
      }

      log({ feature: "none", status: 404 });
      return json({ ok: false, error: "unknown endpoint" }, 404);
    } catch (e) {
      // graceful per-feature failure (e.g. a binding not yet enabled on the zone)
      log({ path, error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 });
      return json({ ok: false, error: String(e && e.message || e).slice(0, 200) }, 502);
    }
  },
};
