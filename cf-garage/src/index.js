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
  async fetch() {
    const n = ((await this.state.storage.get("n")) || 0) + 1;
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

      // Feature #2 — Workers AI: caption a real grid photo (10k neurons/day free)
      if (path === "/garage/cf/caption") {
        const stem = (url.searchParams.get("img") || "XT508165").replace(/[^A-Za-z0-9_-]/g, "");
        const img = await fetch(`${ORIGIN}/images/${stem}.jpg?v=17`);
        if (!img.ok) { log({ feature: "workers-ai", err: "thumb-missing" }); return json({ ok: false, error: "thumbnail not found" }, 404); }
        const bytes = [...new Uint8Array(await img.arrayBuffer())];
        const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: bytes,
          prompt: "Describe this photograph in one vivid sentence suitable as alt text. Be concrete about subject, light, and mood.",
          max_tokens: 64,
        });
        const caption = (out.description || out.response || "").trim();
        log({ feature: "workers-ai", stem, chars: caption.length, ms: Date.now() - t0 });
        return json({ ok: true, stem, caption });
      }

      // Feature #3 — Browser Rendering: headless-Chromium screenshot
      if (path === "/garage/cf/screenshot") {
        let target = url.searchParams.get("url") || ORIGIN;
        // SSRF guard: only screenshot aadhar.sh itself
        if (!/^https:\/\/(www\.)?aadhar\.sh(\/|$)/.test(target)) target = ORIGIN;
        const shot = (async () => {
          const puppeteer = (await import("@cloudflare/puppeteer")).default;
          const browser = await puppeteer.launch(env.BROWSER);
          try {
            const page = await browser.newPage();
            await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
            await new Promise((r) => setTimeout(r, 1200)); // brief paint settle
            return await page.screenshot({ type: "png" });
          } finally { try { await browser.close(); } catch {} }
        })();
        // hard ceiling so a non-provisioning browser can't hang the request
        const png = await Promise.race([
          shot,
          new Promise((_, rej) => setTimeout(() => rej(new Error("browser timed out (25s) — Browser Rendering may need enabling on the zone")), 25000)),
        ]);
        log({ feature: "browser-rendering", target, bytes: png.length, ms: Date.now() - t0 });
        return new Response(png, {
          headers: {
            "content-type": "image/png",
            "access-control-allow-origin": ORIGIN,
            "cache-control": "public, max-age=300",
          },
        });
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
