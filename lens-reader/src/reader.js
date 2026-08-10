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
import Defuddle from "defuddle";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { privateHostBlocked, validateLensTarget } from "../../holding/_worker.js/lib/crawl.js";

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
export const EXTRACTOR = { name: "defuddle", version: "0.19.2" };
export const READER_LIMIT_PER_MIN = 10;
export const FETCH_TIMEOUT_MS = 8000;
export const BODY_CAP = 2 * 1024 * 1024;   // same 2MB ceiling /lens/fetch reads to
export const MARKDOWN_CAP = 120 * 1024;    // same cap the Browser view puts on content

export const READER_NOTE =
  "Defuddle is a third-party extractor (MIT, kepano/defuddle). What it returns is its OPINION " +
  "of which part of the page is the article, never what the server sent. /lens's Machine view " +
  "is the served bytes; this pane is the reading view, and the gap between them is the point.";

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
      source: shape(html),
      ms: { fetch: fetchMs },
    };
  }

  const t1 = Date.now();
  const { document } = parseHTML(html);
  const parseMs = Date.now() - t1;

  const t2 = Date.now();
  const result = new Defuddle(document, { url: finalUrl }).parse();
  const extractMs = Date.now() - t2;

  const contentHtml = String(result.content || "");
  const t3 = Date.now();
  const markdown = toMarkdown(contentHtml);
  const markdownMs = Date.now() - t3;

  // BOTH word counts come from the same function on the same request. Comparing
  // this against a number lens.js computed would be comparing two codebases'
  // definitions of "word" and calling the difference an extraction loss.
  const source = shape(html);
  const kept = { words: countWords(textOf(contentHtml)), bytes: contentHtml.length };

  return {
    ok: true,
    url: targetUrl, finalUrl, status: response.status, contentType,
    redirected: finalUrl !== targetUrl,
    extractor: EXTRACTOR,
    note: READER_NOTE,
    title: str(result.title, 300),
    author: str(result.author, 200),
    published: str(result.published, 100),
    site: str(result.site, 200),
    source,
    kept,
    dropped: {
      words: Math.max(0, source.words - kept.words),
      pct: source.words ? Math.round(((source.words - kept.words) / source.words) * 100) : null,
    },
    // The readout this lens exists for, beyond the word gap. Defuddle keeps
    // `<button>` TEXT on purpose (dist/markdown.js: addRule('button',
    // replacement: content => content)), so a live demo's control labels arrive
    // as prose. On /garage/horizon that is 13 of 25 distinct labels. An agent
    // reading the output has no way to tell a label from a sentence, which is
    // exactly the failure `scripts/lib/html-to-md.mjs` rule 2 refuses.
    controls: countControls(document, contentHtml),
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
// `input.cloneNode(true)` for anything that is not a string — so linkedom parses
// and turndown only ever walks a tree. No globals, no shim, no `document`.
export function toMarkdown(contentHtml) {
  if (!contentHtml) return "";
  const { document } = parseHTML("<div id=\"lens-root\"></div>");
  const root = document.getElementById("lens-root");
  root.innerHTML = contentHtml;
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.remove(["script", "style"]);
  return service.turndown(root).trim();
}

// ── shape + counting ────────────────────────────────────────────────────────

export function shape(html) {
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
