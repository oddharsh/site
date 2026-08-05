// lwe-ask — live "ask a follow-up" for the Learning With Errors explainers,
// gated by a homemade photo-CAPTCHA ("click the cars") built from the author's
// own pictures, with ground truth from the accessibility alt-text.
//
//   GET  /lwe/ask/challenge -> { stems[9], exp, token }   (no answer leaked)
//   POST /lwe/ask/verify    { stems, exp, token, selected[] } -> { ok, askToken, askExp }
//   POST /lwe/ask           { question, concept?, askToken, askExp } -> { answer, sources[] }
//   POST /lwe/ask/search    { question } -> best-matching concept page (Search Companion)
//   POST /lwe/ask/reindex   (gated by REINDEX_SECRET) -> embeds + upserts passages
//
// Verification is stateless: the challenge token is HMAC(secret, stems|exp|CORRECT
// indices) but the correct indices are NEVER sent to the client. To pass, the
// client must submit a selection that reproduces the HMAC — which it can only do
// by actually picking the cars. A pass mints a short-lived askToken that /ask
// requires. No KV, no third-party widget — the lightest possible Turnstile.

import { PASSAGES, SOURCE_URL, SOURCE_TITLE, CORPUS_VERSION } from "./passages.js";
import { CAR_STEMS, NONCAR_STEMS } from "./captcha-data.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JSON_HEADERS });
const enc = new TextEncoder();
// route Workers AI through the "lwe" AI Gateway: response caching (24h), request
// logging, and rate-limiting, all configured in the dashboard. cacheTtl enables +
// sets per-request caching; after a /reindex the cache may serve <=24h-stale answers.
const GATEWAY = { id: "lwe", cacheTtl: 86400 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET"  && url.pathname === "/lwe/ask/challenge") return await challenge(env);
      if (req.method === "POST" && url.pathname === "/lwe/ask/verify")    return await verifyCaptcha(req, env);
      if (req.method === "POST" && url.pathname === "/lwe/ask/reindex")   return await reindex(req, env);
      if (req.method === "POST" && url.pathname === "/lwe/ask/search")    return await search(req, env);
      if (req.method === "POST" && url.pathname === "/lwe/ask")           return await ask(req, env);
      return json({ error: "not found" }, 404);
    } catch (e) {
      // `detail` used to carry e.message straight to the client, uncapped. The
      // three things that throw under here are env.AI.run (whose message names
      // the model id held in EMBED_MODEL / GEN_MODEL and the "lwe" gateway),
      // env.VECTORIZE (which names the index and the metadata filter), and the
      // HMAC when SIGNING_SECRET is missing — all internal configuration a
      // caller has no other way to learn. It goes to Workers Logs instead.
      console.error("lwe-ask unhandled", url.pathname, String((e && e.stack) || e));
      return json({ error: "something broke" }, 500);
    }
  },
};

// ── HMAC (Web Crypto) ─────────────────────────────────────────────────────────
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function sample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// ── CAPTCHA: challenge ────────────────────────────────────────────────────────
async function challenge(env) {
  const nCars = 2 + Math.floor(Math.random() * 3); // 2–4 cars per grid
  const tiles = sample(CAR_STEMS, nCars).map(s => ({ s, car: true }))
    .concat(sample(NONCAR_STEMS, 9 - nCars).map(s => ({ s, car: false })));
  // shuffle tile order
  for (let i = tiles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tiles[i], tiles[j]] = [tiles[j], tiles[i]]; }
  const stems = tiles.map(t => t.s);
  const correct = tiles.map((t, i) => (t.car ? i : -1)).filter(i => i >= 0).sort((a, b) => a - b);
  const exp = Date.now() + 90_000;
  const token = await hmac(env.SIGNING_SECRET, stems.join(",") + "|" + exp + "|" + correct.join(","));
  return json({ stems, exp, token });
}

// ── CAPTCHA: verify selection, mint askToken ──────────────────────────────────
async function verifyCaptcha(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400); }
  const stems = Array.isArray(b.stems) ? b.stems.map(String) : [];
  const exp = +b.exp;
  if (!stems.length || !Number.isFinite(exp) || !b.token) return json({ ok: false, error: "bad request" }, 400);
  if (Date.now() > exp) return json({ ok: false, error: "expired", expired: true });
  const sel = [...new Set((b.selected || []).map(Number))].filter(n => n >= 0 && n < stems.length).sort((a, b) => a - b);
  const candidate = await hmac(env.SIGNING_SECRET, stems.join(",") + "|" + exp + "|" + sel.join(","));
  if (!timingSafeEq(candidate, String(b.token))) return json({ ok: false, error: "not quite — pick exactly the cars" });
  const askExp = Date.now() + 600_000; // 10 min of asking per solve
  const askToken = await hmac(env.SIGNING_SECRET, "ask|" + askExp);
  return json({ ok: true, askToken, askExp });
}
async function validAsk(env, token, exp) {
  exp = +exp;
  if (!token || !Number.isFinite(exp) || Date.now() > exp) return false;
  return timingSafeEq(String(token), await hmac(env.SIGNING_SECRET, "ask|" + exp));
}

// ── embeddings ────────────────────────────────────────────────────────────────
// embeddings are corpus-independent + model-deterministic, so the cache key is just
// the text — it never needs busting on reindex (only an EMBED_MODEL change would).
async function embed(env, text) { return (await env.AI.run(env.EMBED_MODEL, { text: [text] }, { gateway: { ...GATEWAY, cacheKey: "lwe-emb:" + text } })).data[0]; }

// ── /lwe/ask — gated RAG, grounded only in retrieved passages ─────────────────
async function ask(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: "expected JSON" }, 400); }
  if (b.website) return json({ grounded: false, answer: "thanks!", sources: [] }); // honeypot
  if (!(await validAsk(env, b.askToken, b.askExp))) return json({ error: "verify you're human first", needCaptcha: true }, 403);

  const question = (b.question || "").toString().trim().slice(0, +env.MAX_Q_LEN || 400);
  // keep digits: concept slugs like "utf8" carry them, and passages are indexed
  // with the digit intact — stripping it (was /[^a-z]/) filtered to a slug that
  // matches nothing, so utf8's ask always fell through to the "not covered" reply.
  const concept = (b.concept || "").toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (question.length < 3) return json({ error: "ask a real question" }, 400);

  const res = await env.VECTORIZE.query(await embed(env, question), {
    topK: +env.TOP_K || 4, returnMetadata: "all", filter: concept ? { concept } : undefined,
  });
  const matches = (res.matches || []).filter(m => m.score > 0.35);
  if (!matches.length) return json({
    grounded: false,
    answer: "That isn't something this page's sources cover, so I can't answer it from them. Try asking about what the page actually explains.",
    sources: [],
  });

  const context = matches.map((m, i) => `[${i + 1}] ${m.metadata.text}`).join("\n\n");
  const system = "You are a teaching assistant for an interactive explainer. " +
    "Answer the user's question USING ONLY the numbered source passages provided (each is sourced and shown to the reader). " +
    "Be concise (2-4 sentences), plain and conversational, like a knowledgeable friend on a chat. Cite passages inline as [1], [2]. " +
    "If the passages do not contain the answer, say plainly the sources don't cover it, and never invent facts, numbers, or names.";
  // temperature 0: deterministic, grounded answers (and identical repeats cache cleanly).
  // cacheKey folds in CORPUS_VERSION, so a reindex (corpus change -> new version) busts
  // every stale generation; it also keys on concept+question, so a cache hit is
  // order-independent of how Vectorize happened to rank the passages.
  const gen = await env.AI.run(env.GEN_MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content: `Question: ${question}\n\nSource passages:\n${context}` }],
    max_tokens: 320, temperature: 0,
  }, { gateway: { ...GATEWAY, cacheKey: `lwe-gen:${CORPUS_VERSION}:${concept}:${question}` } });
  return json({
    grounded: true, answer: (gen.response || "").trim(),
    sources: matches.map(m => ({ text: m.metadata.text, concept: m.metadata.concept, score: +m.score.toFixed(3), url: m.metadata.source || SOURCE_URL, title: m.metadata.title || SOURCE_TITLE })),
  });
}

// ── /lwe/ask/search — Search Companion: semantic search over the indexed corpus ─
// Returns the best-matching concept page per query. One cached embed + one Vectorize
// query, no generation, so it is cheap enough to leave ungated.
async function search(req, env) {
  let b; try { b = await req.json(); } catch { return json({ error: "expected JSON" }, 400); }
  const q = (b.query || "").toString().trim().slice(0, 200);
  if (q.length < 2) return json({ results: [] });
  const res = await env.VECTORIZE.query(await embed(env, q), { topK: 16, returnMetadata: "all" });
  const byConcept = new Map();
  for (const m of (res.matches || [])) {
    if (m.score < 0.30) continue;
    const concept = m.metadata.concept; if (!concept) continue;
    const cur = byConcept.get(concept);
    if (!cur || m.score > cur.score) byConcept.set(concept, {
      concept, url: "/lwe/" + concept, score: m.score,
      title: (m.metadata.title || "").replace(/^aadhar\.sh:\s*/, "") || concept,
      snippet: (m.metadata.text || "").slice(0, 150),
    });
  }
  const results = [...byConcept.values()].sort((a, b) => b.score - a.score).slice(0, 5)
    .map((r) => ({ concept: r.concept, url: r.url, title: r.title, snippet: r.snippet, score: +r.score.toFixed(3) }));
  return json({ results });
}

// ── /lwe/ask/reindex — embed + upsert the corpus ──────────────────────────────
async function reindex(req, env) {
  if (!env.REINDEX_SECRET || !timingSafeEq(req.headers.get("x-reindex-secret") || "", env.REINDEX_SECRET)) return json({ error: "unauthorized" }, 401);
  // Batch the embeddings: the model takes an array of texts per call, so a per-passage
  // loop fires ~80 Workers AI requests and trips the rate limit (2003). ~25 per call keeps
  // it to a handful. Direct env.AI.run, not the per-text gateway cache, since this is a
  // one-shot bulk embed.
  const BATCH = 25, vectors = [];
  for (let i = 0; i < PASSAGES.length; i += BATCH) {
    const chunk = PASSAGES.slice(i, i + BATCH);
    const { data } = await env.AI.run(env.EMBED_MODEL, { text: chunk.map((p) => p.text) });
    chunk.forEach((p, j) => vectors.push({
      id: p.id, values: data[j],
      metadata: { concept: p.concept, text: p.text, ...(p.source ? { source: p.source } : {}), ...(p.title ? { title: p.title } : {}) },
    }));
  }
  return json({ ok: true, upserted: vectors.length, mutation: await env.VECTORIZE.upsert(vectors) });
}
