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
// WHY ITS OWN WORKER: bundle size, and the margin is smaller than it was.
// Readability needs a DOM `Document`; Workers have HTMLRewriter. Supplying one
// cost linkedom 94.6 KB gzip, then 65.27 after the 2026-08-20 parser
// alignment, against a site Worker budget of 204.24 KiB already in breach.
//
// src/dom.ts replaced linkedom on 2026-08-23 with a first-party DOM over the
// same htmlparser2, and this Worker went 80.57 -> 46.18 KiB gzip. The DOM is no
// longer most of it: the parser is ~26.6 and the extractor ~11.6, so the split
// now rests on adding ~46 KiB to a budget that is still in breach. If the site
// Worker ever comes back under budget, re-open this rather than assuming it is
// settled.
//
// `run_worker_first`'s 100-row cap (gotcha 26) is no reason to keep the split.
// /lens/read sits under the site's /lens/* row, and this Worker claims it with
// a zone route (cloudflare.config.ts), so folding it back adds no row.
//
// This module is the ENTRYPOINT and nothing else. Everything testable lives in
// reader.ts, because workerd rejects a named value export from an entrypoint;
// reader.ts's header quotes the error.
import { EXTRACTOR, READER_LIMIT_PER_MIN, READER_NOTE, ReaderError, read } from "./reader.ts";
import { jsonResponse } from "../../src/worker/lib/http.ts";
import { validateLensTarget } from "../../src/worker/lib/public-fetch.ts";
import { overBudget, rateLimitPolicy, rateLimitedHeaders } from "../../src/worker/lib/ratelimit.ts";

// The site's own per-caller limiter (lib/ratelimit.ts), on this Worker's binding.
// The 429 message quotes READER_LIMIT_PER_MIN, which a contract test pins to the
// ceiling declared in cloudflare.config.ts.
const READER_BUDGET = { binding: "READER_RL", max: READER_LIMIT_PER_MIN };

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

    if (await overBudget(READER_BUDGET, request, env)) {
      return json({ ok: false, error: `Reader extraction is limited to ${READER_LIMIT_PER_MIN} per minute per visitor. Try again shortly.` }, 429, rateLimitedHeaders("reader", READER_LIMIT_PER_MIN));
    }

    try {
      return json(await read(target.url), 200, { "ratelimit-policy": rateLimitPolicy("reader", READER_LIMIT_PER_MIN) });
    } catch (error) {
      // Only ReaderError messages are published (reader.ts says why). The
      // generic arm still says whose fault it probably was, because "the reader
      // failed" with no attribution is exactly the ambiguity this whole pane
      // exists to remove. The real error goes to Workers Logs, where it is
      // readable by the owner and by nobody else.
      if (error instanceof ReaderError) return json({ ok: false, error: error.message }, 502);
      console.error("lens-reader: unhandled failure", error);
      return json({ ok: false, error: "The reader could not process that page. This one is on us, not the target." }, 500);
    }
  },
};

function json(body, status = 200, extra: Readonly<Record<string, string>> = {}) {
  return jsonResponse(body, status, {
    ...extra,
    // Third-party page content keyed by a visitor-supplied URL: private, the
    // same rule /lens/fetch follows.
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex",
  }, { pretty: false });
}
