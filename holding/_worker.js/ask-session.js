// ask-session.js — conversation memory for /terminal/ask, and ONLY for that.
//
// ── why this one thing gets a Durable Object ──────────────────────────────
// Everything else in /terminal keeps its state in the URL, and should: a pane
// and a cursor are small and addressable, so `?pane=writing&cursor=3` IS the
// state, which buys forking, bookmarking, replay, and a pure function the tests
// can call without a harness. Nothing about `finger` wants a server to remember
// it.
//
// A conversation is the case where that stops working, and it is not a judgement
// call — a transcript does not fit in a URL. The practical ceiling is ~2KB, which
// holds a cursor forever and holds a three-turn exchange never. `ask` was
// single-shot for exactly that reason: you could not say "what about the other
// one?", because there was nowhere for the other one to live.
//
// So the split is by SHAPE OF STATE, not by taste. Small and addressable stays in
// the URL. Growing and opaque gets a DO. Reaching for a DO across the whole
// surface would have bought `finger` nothing and cost it everything above.
//
// Latency, honestly: the counter DO's measured 185-630ms is a SINGLE GLOBAL
// INSTANCE, hit from everywhere. This one is per-session and lands near whoever
// opened it, so it is tens of ms, and it is paid once per ask — next to a model
// call, it is noise. That earlier number was misapplied when it was used to
// argue against DOs generally.
//
// Hand-rolled rather than extending DurableObject, for the same reason counter.js
// is: only _worker.js/index.js may import `cloudflare:workers`, because every
// other module here is also imported by contract-tests.mjs under plain node,
// which rejects that scheme at link time and takes the whole suite down with it.

// Bounds. A conversation nobody ends is a conversation that grows forever.
export const SESSION_LIMITS = {
  messages: 12,        // ~6 exchanges; older turns fall off the front
  chars: 24000,        // total stored transcript
  ttlMs: 30 * 60_000,  // idle life; the alarm below actually deletes it
};

export class AskSession {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const now = Date.now();
    const stored = (await this.state.storage.get("session")) || null;
    // Expiry is enforced on READ, not only by the alarm. An alarm can be delayed
    // or lost; a timestamp comparison cannot, and a resurrected transcript is
    // exactly the thing that must not happen — it would carry a taint flag back
    // from a session the caller believes ended.
    const live = stored && stored.expiresAt > now ? stored : null;

    if (request.method === "GET") {
      return Response.json(live || { messages: [], tainted: false, turns: 0 });
    }

    const patch = await request.json();
    const messages = trimTranscript(
      Array.isArray(patch.messages) ? patch.messages : (live?.messages || []),
    );
    const next = {
      messages,
      // Taint is STICKY and can only ever be set, never cleared. Once
      // third-party text has entered a transcript, every later turn in that
      // transcript is downstream of it — clearing the flag on a subsequent
      // same-origin question would hand tools back to a context that still
      // contains the injected instruction.
      tainted: !!(live?.tainted || patch.tainted),
      turns: (live?.turns || 0) + 1,
      expiresAt: now + SESSION_LIMITS.ttlMs,
    };
    await this.state.storage.put("session", next);
    await this.state.storage.setAlarm(next.expiresAt);
    return Response.json(next);
  }

  // Storage costs money and a transcript nobody returns to is garbage. The
  // read-side expiry above is the correctness guarantee; this is the cleanup.
  async alarm() {
    const stored = await this.state.storage.get("session");
    if (stored && stored.expiresAt > Date.now()) return this.state.storage.setAlarm(stored.expiresAt);
    await this.state.storage.deleteAll();
  }
}

/** Keep the newest turns under both ceilings, oldest dropped first. */
export function trimTranscript(messages) {
  let kept = messages.slice(-SESSION_LIMITS.messages);
  while (kept.length > 2 && JSON.stringify(kept).length > SESSION_LIMITS.chars) kept = kept.slice(1);
  return kept;
}

/**
 * Read and advance one session.
 *
 * Returns a null-ish session when the binding is absent, which is what local dev
 * and the contract tests get. `ask` then behaves exactly as it did before this
 * file existed: single-shot, no memory. Degrading to the previous product rather
 * than to an error is the same choice the model path makes.
 */
export async function readSession(env, id) {
  if (!env.ASK_SESSION || !id) return { messages: [], tainted: false, turns: 0, available: false };
  try {
    const stub = env.ASK_SESSION.get(env.ASK_SESSION.idFromName(id));
    const state = await (await stub.fetch("https://do/")).json();
    return { ...state, available: true };
  } catch {
    return { messages: [], tainted: false, turns: 0, available: false };
  }
}

export async function writeSession(env, id, messages, tainted) {
  if (!env.ASK_SESSION || !id) return null;
  try {
    const stub = env.ASK_SESSION.get(env.ASK_SESSION.idFromName(id));
    return await (await stub.fetch("https://do/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, tainted }),
    })).json();
  } catch { return null; }
}

/**
 * Session ids are MINTED SERVER-SIDE and handed back in the frame.
 *
 * A caller-chosen id would let anyone address anyone else's transcript by
 * guessing a short string, and while everything in these transcripts is a
 * question about public data, "your session is whatever you typed" is a
 * confused-deputy waiting to happen. A v4 UUID is not guessable.
 */
export const mintSessionId = () => crypto.randomUUID();
