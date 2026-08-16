// cf-garage — backend for the /garage/cloudflare demo. Exercises four free-tier
// Cloudflare platform features live, one endpoint each. Routed at
// aadhar.sh/garage/cf/* (ahead of the site Worker). Every request logs a
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

// ── custom-span helpers (Workers tracing) ─────────────────────────────────
// ctx.tracing.enterSpan(name, fn) records a span (with parent-child nesting)
// when tracing is enabled in wrangler.toml; the span lands in the Observability
// trace viewer. We degrade to running fn with a no-op span if the API isn't
// present, and we time every span locally too — so /garage/cf/trace can return
// the waterfall and the demo page can draw it without the dashboard.
async function inSpan(tr, name, fn) {
  // Capability probe on the injected tracer (gotcha 16's seam). This Worker is
  // deployed on its own and does not import the site tree.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (tr && typeof tr.enterSpan === "function") return tr.enterSpan(name, fn);
  return fn({ setAttribute() {}, isTraced: false });
}
async function timedSpan(tr, name, t0, spans, fn) {
  const start = Date.now() - t0;
  try { return await inSpan(tr, name, fn); }
  finally { spans.push({ name, start, dur: Date.now() - t0 - start }); }
}

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
        const img = await fetch(`${ORIGIN}/images/${stem}.jpg`);
        if (!img.ok) { log({ feature: "workers-ai", err: "thumb-missing" }); return json({ ok: false, error: "thumbnail not found" }, 404); }
        const bytes = [...new Uint8Array(await img.arrayBuffer())];
        // ?mode=alt → tight, factual alt text (used to bake <img alt> for the grid).
        // default → the vivid demo caption. alt text shouldn't editorialize or guess.
        const prompt = url.searchParams.get("mode") === "alt"
          ? "Write alt text for this photo: one plain, factual sentence naming only what is clearly visible (main subject and setting). No mood, no interpretation, no guessing, no 'image of'. Under 16 words."
          : "Describe this photograph in one vivid sentence suitable as alt text. Be concrete about subject, light, and mood.";
        // routed through the AI Gateway named in AI_GATEWAY (see wrangler.toml), which
        // is what buys the per-model token counts and cost attribution the Workers Logs
        // line below cannot express: `log()` knows how long the call took, never what it
        // cost. DELIBERATELY no cacheTtl. This endpoint's default request is byte-identical
        // on every click, so any cache would make the demo a replay after the first
        // visitor — the same caption forever, and a neuron counter that never moves.
        // The button promises the model runs fresh, so it runs fresh.
        const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: bytes,
          prompt,
          max_tokens: 64,
        }, env.AI_GATEWAY ? { gateway: { id: env.AI_GATEWAY } } : undefined);
        let caption = (out.description || out.response || "").trim()
          .replace(/^(an? |the )?(image|photo|photograph|picture) (of|shows|depicts|captures)\s*/i, "")
          .replace(/\s+/g, " ").trim();
        if (caption) caption = caption[0].toUpperCase() + caption.slice(1);
        log({ feature: "workers-ai", stem, mode: url.searchParams.get("mode") || "demo", chars: caption.length, ms: Date.now() - t0 });
        return json({ ok: true, stem, caption });
      }

      // Feature #3 — Browser Run quick-action screenshot. PARKED (see
      // /garage/cloudflare). A bare GET no-ops WITHOUT launching, so crawlers,
      // prerenders, and cache-busted probes can't burn the free 10-min/day budget —
      // only ?go=1 drives a real browser. The binding owns the session lifecycle and
      // applies the explicit navigation/action bounds below, so this one operation
      // does not need Puppeteer's general-purpose CDP client in the Worker bundle.
      if (path === "/garage/cf/screenshot") {
        if (url.searchParams.get("go") !== "1") {
          log({ feature: "browser-rendering", step: "parked-noop", ms: Date.now() - t0 });
          return json({ ok: false, parked: true,
            error: "Browser Run is parked — append ?go=1 to actually launch a browser. See /garage/cloudflare." }, 503);
        }
        let target = url.searchParams.get("url") || ORIGIN;
        if (!/^https:\/\/(www\.)?aadhar\.sh(\/|$)/.test(target)) target = ORIGIN; // SSRF guard
        let screenshot;
        try {
          screenshot = await env.BROWSER.quickAction("screenshot", {
            url: target,
            viewport: { width: 900, height: 600, deviceScaleFactor: 1 },
            gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
            waitForTimeout: 800,
            actionTimeout: 10000,
            cacheTTL: 0,
          });
        } catch (e) {
          log({ feature: "browser-rendering", step: "screenshot-error", ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) });
          return json({ ok: false, error: "the browser did not complete the screenshot" }, 502);
        }
        if (!screenshot.ok) {
          log({ feature: "browser-rendering", step: "screenshot-error", status: screenshot.status, ms: Date.now() - t0 });
          return json({ ok: false, error: "the browser did not complete the screenshot" }, 502);
        }
        const bytes = Number(screenshot.headers.get("content-length")) || undefined;
        log({ feature: "browser-rendering", target, bytes, ms: Date.now() - t0 });
        return new Response(screenshot.body, {
          headers: {
            "content-type": screenshot.headers.get("content-type") || "image/png",
            "access-control-allow-origin": ORIGIN,
            "cache-control": "public, max-age=300",
          },
        });
      }

      // Feature #5 — Workers tracing: custom spans around our OWN logic.
      // Auto-tracing already captures platform calls (fetch/KV/DO); enterSpan
      // lets us name + time our application steps, nested correctly, so they
      // show in the same trace waterfall. We run a 3-step pipeline (a DO peek,
      // a subrequest, a compute loop), each in its own span with attributes,
      // and return the locally-timed waterfall for the demo page to render.
      if (path === "/garage/cf/trace") {
        const tr = ctx && ctx.tracing;                 // present when the runtime supports it
  // Capability probe on the injected tracer; separate Worker, own bundle.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
        const available = !!(tr && typeof tr.enterSpan === "function");
        const tt = Date.now();
        const spans = [];
        const facts = {};
        const out = await inSpan(tr, "handleTrace", async (root) => {
          if (root.setAttribute) root.setAttribute("url.path", path);
          // 1 — Durable Object peek (read-only, no increment)
          facts.counter = await timedSpan(tr, "do.counter.peek", tt, spans, async (s) => {
            if (s.setAttribute) s.setAttribute("do.name", "garage-global");
            const r = await env.COUNTER.get(env.COUNTER.idFromName("garage-global")).fetch("https://do/?peek=1");
            const { n } = await r.json();
            if (s.setAttribute) s.setAttribute("counter.value", n);
            return n;
          });
          // 2 — a real subrequest
          facts.bytes = await timedSpan(tr, "fetch.llms_txt", tt, spans, async (s) => {
            const r = await fetch(`${ORIGIN}/llms.txt`, { cf: { cacheTtl: 60 } });
            const txt = await r.text();
            if (s.setAttribute) { s.setAttribute("http.status", r.status); s.setAttribute("bytes", txt.length); }
            return txt.length;
          });
          // 3 — pure compute, no IO (shows a non-network span in the waterfall)
          facts.checksum = await timedSpan(tr, "compute.checksum", tt, spans, async (s) => {
            let acc = 0;
            for (let i = 0; i < 250000; i++) acc = (acc + i * 2654435761) % 4294967296;
            if (s.setAttribute) s.setAttribute("iterations", 250000);
            return acc >>> 0;
          });
          return { traced: !!root.isTraced };
        });
        const total = Date.now() - tt;
        log({ feature: "tracing", available, traced: out.traced, spans: spans.length, ms: total });
        return json({ ok: true, available, traced: out.traced, total, spans, facts });
      }

      log({ feature: "none", status: 404 });
      return json({ ok: false, error: "unknown endpoint" }, 404);
    } catch (e) {
      // graceful per-feature failure (e.g. a binding not yet enabled on the zone).
      // The real message goes to Workers Logs and NOT to the client: this handler
      // wraps a Durable Object call, env.AI.run with a model id, and a subrequest,
      // and each of those throws with internal names in the text (the DO class,
      // the model, the upstream URL). The demo is about the features working, so
      // the failure line only has to say which one didn't.
      log({ path, error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 });
      return json({ ok: false, error: "this feature failed — the details are in Workers Logs" }, 502);
    }
  },
};
