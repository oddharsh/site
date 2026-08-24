// lens-reader — the Reader lens behind /lens/read.
//
// WHAT THIS IS. /lens shows a page the way a machine receives it. This Worker
// shows the same page the way a READER-MODE EXTRACTOR thinks of it, using
// Readability (mozilla/readability, the engine behind Firefox Reader View). The
// two answers are deliberately different, and the DIFFERENCE is the artifact: an
// extractor is guessing which part of a document is the article, and on a
// landing page it guesses badly in a way that is invisible unless you put the
// two side by side. Measured 2026-08-14 on stripe.com, Readability dropped the
// hero headline entirely and reported 671 words against the served page's
// 1,875. That is the lesson the lens exists to teach.
//
// So the response NEVER claims to be what the machine got. It reports the
// extractor by name and version, what it kept, and what it threw away.
//
// WHY ITS OWN WORKER, and this is the load-bearing part. Readability needs a DOM
// `Document`; Workers have HTMLRewriter. Supplying one used to cost linkedom at
// 94.6 KB gzip, against a site Worker budget of 204.24 KiB that was already in
// breach, so this cannot live there. A second Worker on a zone route costs it
// nothing.
//
// Worth seeing plainly after the 2026-08-14 extractor swap: even after aligning
// linkedom's parser stack removed 32.74 KiB gzip on 2026-08-20, the DOM remains
// most of this 80.56 KiB Worker rather than the extraction policy. A DOM-free
// extractor would collapse the split entirely.
//
// The SECOND reason this comment used to give has EXPIRED. `run_worker_first`
// capped at 100 rules with the repo at exactly 100 (CLAUDE.md gotcha 26), but
// folding the eight exact /lens rows to /lens + /lens/* dropped it to 94. The
// size argument is carrying this alone now; do not cite the cap again.
//
// This module is the ENTRYPOINT and nothing else. Everything testable lives in
// reader.js, because a Worker entrypoint may export only the default handler
// and Durable Object / Workflow classes — workerd rejects a named value export
// with "Incorrect type for map entry '<name>': the provided value is not of
// type 'function or ExportedHandler'", which is how that rule was learned here.
import { EXTRACTOR, READER_LIMIT_PER_MIN, READER_NOTE, ReaderError, read } from "./reader.ts";
import { validateLensTarget } from "../../src/worker/lib/crawl.ts";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The published description of what this lens is, so a reader (or an agent)
    // can learn what the numbers mean without running an extraction. Same idea
    // as /lens/browser?recipes=1 publishing its allowlist.
    if (url.pathname === "/lens/read/about") {
      return json({ ok: true, extractor: EXTRACTOR, limitPerMin: READER_LIMIT_PER_MIN, note: READER_NOTE });
    }
    if (request.method !== "GET") return json({ ok: false, error: "GET only." }, 405);

    const target = validateLensTarget(url.searchParams.get("url") || "");
    if (!target.ok) return json({ ok: false, error: target.error }, 400);

    const over = await overBudget(env, request);
    if (over) return json({ ok: false, error: over }, 429);

    try {
      return json(await read(target.url));
    } catch (error) {
      // Only messages WE wrote for the visitor get published. Everything else is
      // an internal failure whose text is not ours to hand to an unauthenticated
      // caller — CodeQL flagged the old blanket `error.message` return as
      // information exposure through a stack trace, and it was right.
      //
      // The generic arm still says whose fault it probably was, because "the
      // reader failed" with no attribution is exactly the ambiguity this whole
      // pane exists to remove. The real error goes to Workers Logs, where it is
      // readable by the owner and by nobody else.
      if (error instanceof ReaderError) return json({ ok: false, error: error.message }, 502);
      console.error("lens-reader: unhandled failure", error);
      return json({ ok: false, error: "The reader could not process that page. This one is on us, not the target." }, 500);
    }
  },
};

async function overBudget(env, request) {
  const limiter = env && env.READER_RL;
  // Binding capability probe, and this Worker is outside the site tree with its
  // own dependency set, so it cannot import _worker.js/lib/parse.js.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!limiter || typeof limiter.limit !== "function") return null;
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  try {
    const { success } = await limiter.limit({ key: ip });
    // The message quotes READER_LIMIT_PER_MIN, which a contract test pins to the
    // ceiling declared in wrangler.toml — same discipline as LENS_BUDGETS on the
    // site Worker, where a message outliving its limit is the failure mode.
    return success ? null : `Reader extraction is limited to ${READER_LIMIT_PER_MIN} per minute per visitor. Try again shortly.`;
  } catch (_e) {
    return null;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Third-party page content keyed by a visitor-supplied URL: private, the
      // same rule /lens/fetch follows.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}
