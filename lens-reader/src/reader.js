// lens-reader/src/reader.js — the extraction itself, kept free of any Worker
// entrypoint concern so `node --test` can import it directly.
//
// The split is not stylistic. A Worker entrypoint module may export ONLY the
// default handler and Durable Object / Workflow classes: workerd rejects a
// named value export outright with
//
//   Uncaught TypeError: Incorrect type for map entry 'READER_LIMIT_PER_MIN':
//   the provided value is not of type 'function or ExportedHandler'.
//
// so the constants and helpers the contract tests assert against cannot live
// beside `export default { fetch }`. Same shape as lib/tui.js: pure module,
// three callers (the Worker, the tests, and anything that wants the numbers).
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { privateHostBlocked, validateLensTarget } from "../../www/_worker.js/lib/crawl.js";

// Errors whose MESSAGE is deliberately written for the visitor. Everything else
// that escapes `read()` is an internal failure whose text is not ours to publish:
// CodeQL flagged the old `String(error.message)` return as information exposure
// through a stack trace, and it was right — a fetch or parse failure carries
// runtime detail, and this route answers an unauthenticated public request.
//
// The distinction is not cosmetic. The pane's whole job is naming WHOSE fault a
// failure was, so collapsing everything to "something went wrong" would cost the
// feature its point; publishing raw internals would cost more.
export class ReaderError extends Error {
  constructor(message) { super(message); this.name = "ReaderError"; this.visitorFacing = true; }
}

export const BOT_UA = "AadharshBot/1.0 (+https://aadhar.sh/bot)";
export const EXTRACTOR = { name: "readability", version: "0.6.0" };
export const READER_LIMIT_PER_MIN = 10;
export const FETCH_TIMEOUT_MS = 8000;
export const BODY_CAP = 2 * 1024 * 1024;   // same 2MB ceiling /lens/fetch reads to
export const MARKDOWN_CAP = 120 * 1024;    // same cap the Browser view puts on content

export const READER_NOTE =
  "Readability is a third-party extractor (Apache-2.0, mozilla/readability), the engine behind " +
  "Firefox Reader View. What it returns is its OPINION of which part of the page is the article, " +
  "never what the server sent. /lens's Machine view is the served bytes; this pane is the reading " +
  "view, and the gap between them is the point.";

// ── the read ────────────────────────────────────────────────────────────────

export async function read(targetUrl) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(targetUrl, {
      headers: {
        "user-agent": BOT_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    // The two failures a visitor can actually cause, named rather than leaked.
    if (error && error.name === "AbortError") {
      throw new ReaderError(`That page did not respond within ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    throw new ReaderError("That URL could not be fetched (DNS, TLS, or the host refused the connection).");
  } finally {
    clearTimeout(timer);
  }

  const finalUrl = response.url || targetUrl;
  // A redirect can land somewhere the first check passed but the second would
  // not. `fetch` followed it for us, so re-check where we ACTUALLY are before
  // reading a byte of the body.
  const landed = validateLensTarget(finalUrl);
  if (!landed.ok || privateHostBlocked(new URL(finalUrl).hostname)) {
    throw new ReaderError("That URL redirected somewhere this reader will not follow.");
  }

  const contentType = response.headers.get("content-type") || "";
  const html = await readCapped(response, BODY_CAP);
  const fetchMs = Date.now() - t0;

  if (!/html|xml/i.test(contentType)) {
    // An extractor has nothing to say about JSON or plain text. Refusing is more
    // honest than running the heuristic over a body it was never meant for.
    return {
      ok: true, url: targetUrl, finalUrl, status: response.status, contentType,
      extractor: EXTRACTOR, note: READER_NOTE,
      skipped: "not-html",
      source: tally(html),
      ms: { fetch: fetchMs },
    };
  }

  // TWO parses, and the second one is not redundant. Readability REWRITES the
  // document it is given (it strips, unwraps and re-parents nodes in place), so
  // a single shared parse would hand `countControls` a corpse: the <button>
  // census below would run over whatever survived extraction and report every
  // page as leaking zero controls. `document` is the untouched copy the census
  // reads; `working` is the one Readability is allowed to destroy.
  const t1 = Date.now();
  const { document } = parseHTML(html);
  const { document: working } = parseHTML(html);
  const parseMs = Date.now() - t1;

  const t2 = Date.now();
  let articleNode;
  const result = new Readability(working, {
    charThreshold: 500,
    // Readability calls its serializer with the finished article node. Keep that
    // node while returning the same innerHTML its default serializer returns, so
    // the public `content` contract does not move and Markdown can skip reparsing
    // the exact HTML Readability just serialized.
    serializer(element) {
      articleNode = element;
      return element.innerHTML;
    },
  }).parse() || {};
  const extractMs = Date.now() - t2;

  const contentHtml = String(result.content || "");
  const t3 = Date.now();
  const markdown = toMarkdown(articleNode || contentHtml);
  const markdownMs = Date.now() - t3;

  // BOTH word counts come from the same function on the same request. Comparing
  // this against a number lens.js computed would be comparing two codebases'
  // definitions of "word" and calling the difference an extraction loss.
  const source = tally(html);
  const kept = { words: countWords(textOf(contentHtml)), bytes: contentHtml.length };
  const title = str(result.title, 300);
  const controls = countControls(document, contentHtml);
  const recovery = scoreExtraction({ source, kept, controls, title, markdown });

  return {
    ok: true,
    url: targetUrl, finalUrl, status: response.status, contentType,
    redirected: finalUrl !== targetUrl,
    extractor: EXTRACTOR,
    note: READER_NOTE,
    title,
    author: str(result.byline, 200),
    published: str(result.publishedTime, 100),
    site: str(result.siteName, 200),
    source,
    kept,
    dropped: {
      words: Math.max(0, source.words - kept.words),
      pct: source.words ? Math.round(((source.words - kept.words) / source.words) * 100) : null,
    },
    // The readout this lens exists for, beyond the word gap. An extractor that
    // hands a live demo's control labels over as prose gives an agent no way to
    // tell a label from a sentence, which is exactly the failure
    // `scripts/lib/html-to-md.mjs` rule 2 refuses.
    //
    // Measured 2026-08-14 over the same five-page corpus, this is where the
    // extractor swap paid: on /garage/horizon Defuddle leaked 14 of 26 distinct
    // control labels and Readability leaks 3. It is NOT a uniform win, which is
    // why this number stays on the payload rather than being retired as solved:
    // on stripe.com Readability leaks 5 where Defuddle leaked 2.
    controls,
    recovery,
    markdown: markdown.slice(0, MARKDOWN_CAP),
    markdownTruncated: markdown.length > MARKDOWN_CAP,
    ms: { fetch: fetchMs, parse: parseMs, extract: extractMs, markdown: markdownMs },
  };
}

// ── markdown, without a global document ─────────────────────────────────────

// Turndown wants `document.implementation.createHTMLDocument` plus a doc that
// supports open/write/close, and linkedom supplies none of the three, so the
// obvious `turndown(htmlString)` throws in workerd. Shimming those globals is a
// dead end (measured 2026-08-09: three successive shims, three further misses).
//
// Passing a NODE skips the parser entirely — turndown's RootNode does
// `input.cloneNode(true)` for anything that is not a string — so read() keeps
// the finished article node from Readability's serializer hook. The string path
// remains for isolated callers and tests; it is the fallback, not the hot path.
export function toMarkdown(content) {
  if (!content) return "";
  let root = content;
  if (!content.nodeType) {
    const { document } = parseHTML("<div id=\"lens-root\"></div>");
    root = document.getElementById("lens-root");
    root.innerHTML = content;
  }
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.remove(["script", "style"]);
  return service.turndown(root).trim();
}

// ── tally + counting ────────────────────────────────────────────────────────

export function tally(html) {
  const body = String(html).match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const text = textOf(body ? body[1] : String(html));
  return { words: countWords(text), bytes: String(html).length };
}

export function textOf(html) {
  return String(html)
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
}

export function countWords(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

// Counts the interactive-control labels the extraction KEPT: labels present in
// the source's controls that also survive into the extracted text. Substring
// matching over-counts a label that is also ordinary prose ("Close"), so the
// number is reported as an upper bound and the pane says so.
export function countControls(document, contentHtml) {
  let labels = [];
  try {
    labels = [...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]
      .map((node) => String(node.textContent || node.getAttribute("value") || "").trim())
      .filter((text) => text.length > 3 && text.length < 60);
  } catch (_e) {
    return { total: 0, kept: 0, note: "controls could not be counted" };
  }
  const unique = [...new Set(labels)];
  const extracted = textOf(contentHtml);
  const kept = unique.filter((label) => extracted.includes(label));
  return {
    total: unique.length,
    kept: kept.length,
    examples: kept.slice(0, 6),
    note: "upper bound: a label that is also ordinary prose counts as kept",
  };
}

// Lens's score, derived from Readability's output. Readability does not publish
// a readability grade, so calling this "Readability's score" would give borrowed
// authority to a number it never made. Four binary checks keep the calculation
// legible enough to audit from the pane itself.
export function scoreExtraction({ source, kept, controls, title, markdown }) {
  const sourceWords = Math.max(0, Number(source && source.words) || 0);
  const keptWords = Math.max(0, Number(kept && kept.words) || 0);
  const threshold = sourceWords < 40 ? Math.max(1, Math.ceil(sourceWords * 0.5)) : 40;
  const controlTotal = Math.max(0, Number(controls && controls.total) || 0);
  const controlKept = Math.max(0, Number(controls && controls.kept) || 0);
  const controlRatio = controlTotal ? controlKept / controlTotal : 0;
  const checks = [
    {
      key: "body", label: "usable body recovered",
      pass: sourceWords > 0 && keptWords >= threshold,
      detail: `${keptWords} words kept; ${threshold} required for this source`,
    },
    {
      key: "title", label: "title recovered",
      pass: !!String(title || "").trim(),
      detail: title ? "Readability returned a title" : "no title returned",
    },
    {
      key: "controls", label: "control-label purity",
      pass: controlRatio <= 0.25,
      detail: controlTotal ? `${controlKept} of ${controlTotal} control labels survived` : "no source controls to leak into prose",
    },
    {
      key: "markdown", label: "Markdown produced",
      pass: !!String(markdown || "").trim(),
      detail: markdown ? `${String(markdown).length} characters produced` : "the extraction was empty",
    },
  ];
  const passed = checks.filter((check) => check.pass).length;
  return {
    overall: Math.round((passed / checks.length) * 100),
    passed,
    counted: checks.length,
    checks,
    scoringNote: "Lens computes four equally weighted checks from Readability's output; Readability itself does not publish this score.",
  };
}

// ── plumbing ────────────────────────────────────────────────────────────────

async function readCapped(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= maxBytes) { try { await reader.cancel(); } catch (_e) {} break; }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    merged.set(chunk.subarray(0, merged.length - offset), offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function str(value, cap) {
  const s = String(value == null ? "" : value).trim();
  return s ? s.slice(0, cap) : null;
}
