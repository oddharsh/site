// csp-scan.ts — what the hashed CSP needs to know about one staged document:
// which inline scripts the browser will EXECUTE (so their sha256 belongs in the
// header), and whether any inline event-handler attribute is present (which a
// hash policy structurally cannot cover, so the build stops on one).
//
// THE PARSER IS THE POINT. This was a hand-rolled tag walker inside build.ts,
// correct only because it had been patched three times against the served bytes.
// minify-html unquotes attributes and decodes character references inside quoted
// values, so a scanner written against the AUTHORED HTML reads the MINIFIED HTML
// wrong, and this build has now caught three naive scanners on its own output: a
// `<script` search that read /garage/horizon's XSS demo payload as two real
// scripts, a link scanner that found 33 refs where there were 2645, and an
// attribute scanner that had to learn quotes for the same reason.
//
// HTMLRewriter is lol-html, the SAME ENGINE src/worker/ runs, so the build reads
// a document the way the Worker does. lib/link-integrity.ts made this exact move
// on 2026-08-20 and this is the last hand-rolled scanner in the HTML passes.
//
// It is a bun global with no node equivalent, which is why the requirement is
// stated by name rather than left to fail on an undefined symbol.
import { createHash } from "node:crypto";

// A `<script>` is CSP-checked when the browser would EXECUTE it. That covers the
// JavaScript types and, verified in a real browser, `speculationrules`. It does
// NOT cover data blocks (application/json for the quiz payloads, ld+json), which
// are parsed as data and never reach script-src. 31 of this site's inline blocks
// are data, so getting this wrong in either direction is 31 wrong answers.
const JAVASCRIPT_TYPES = ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"];
export const EXECUTABLE_EXTRA = new Set(["speculationrules"]);
const isExecutableType = (type: string) => !type || JAVASCRIPT_TYPES.includes(type) || EXECUTABLE_EXTRA.has(type);

const HANDLER_ATTR = /^on[a-z]+$/;

// The browser resolves character references in an attribute value exactly once on
// its way to the srcdoc document's source text, and the hash is taken over THAT
// text. HTMLRewriter hands back the raw attribute, so the decode still belongs
// here. In practice the staged copy already carries raw `<`, because minify-html
// decodes entities inside quoted attribute values (gotcha 20a), which makes this
// a no-op today and correct if that ever changes.
const NAMED_REFS: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: "\u00a0", amp: "&" };
const decodeCharRefs = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    const key = ref.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return key in NAMED_REFS ? NAMED_REFS[key] : whole;
  });

export const PARSER_MISSING =
  "csp-scan: this build step needs HTMLRewriter, which is a bun global with no node equivalent. Run the build with bun (`bun run build`).";

export function requireParser() {
  if (!("HTMLRewriter" in globalThis)) throw new Error(PARSER_MISSING);
}

export type ScanResult = { hashes: string[]; handlers: string[] };

/**
 * One document. Returns hashes in DOCUMENT ORDER, which is load-bearing: the map
 * is serialised into lib/csp-hashes.ts, so a reordering is a changed Worker
 * bundle for nothing.
 *
 * An `srcdoc` document INHERITS the embedding page's CSP, so its scripts are
 * hashed HERE, in the position the iframe sits at. The old walker stepped over
 * the whole attribute, which is what kept its inner `<script>` from reading as a
 * real one, so without this the hashes were silently short by exactly the
 * scripts nobody can see. Found in production 2026-08-16: /garage/horizon's
 * `#mb-frame` uptime counter is the proof that moveBefore() reparents without
 * reloading, and enforcing the policy would have frozen it at 0 with nothing
 * logged.
 *
 * Async because HTMLRewriter streams; the caller awaits per document.
 */
export async function scanDocument(source: string, label: string): Promise<ScanResult> {
  requireParser();

  type Item = { hash: string } | { srcdoc: string; label: string };
  const items: Item[] = [];
  const handlers: string[] = [];
  let capture: string[] | null = null;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      // Attributes are PARSED rather than regexed off the raw tag, because
      // garage/horizon.html carries `value="&lt;img src=x onerror=alert(1)&gt;"`
      // as demo TEXT. To a parser that is an attribute VALUE and can never be
      // read as a handler; to a naive /\son\w+=/ it is one, and it sends you
      // refactoring a string literal.
      for (const [name] of el.attributes) {
        const lower = name.toLowerCase();
        if (HANDLER_ATTR.test(lower)) handlers.push(`${label}: <${tag} ${lower}=…>`);
      }

      const srcdoc = el.getAttribute("srcdoc");
      if (srcdoc) items.push({ srcdoc: decodeCharRefs(srcdoc), label: `${label}: <${tag} srcdoc>` });

      if (tag !== "script") return;
      if (el.getAttribute("src") !== null) return;      // external: covered by 'self'
      if (!isExecutableType((el.getAttribute("type") || "").toLowerCase())) return;

      const body: string[] = [];
      capture = body;
      // Fires for an empty <script></script> too, which is why this hangs off the
      // END TAG rather than off the last text chunk: an empty executable block
      // still needs the hash of the empty string, and it has no text node.
      el.onEndTag(() => {
        items.push({ hash: createHash("sha256").update(body.join(""), "utf8").digest("base64") });
        capture = null;
      });
    },
    text(chunk) {
      // Raw-text content arrives in chunks split on `<`, undecoded, so joining
      // reproduces the source bytes the browser hashes. Probed rather than
      // assumed: `&amp;` inside a script body survives as `&amp;`.
      if (capture) capture.push(chunk.text);
    },
  });

  await rewriter.transform(new Response(source)).text();

  // The old walker threw on an unterminated <script>. Keep that loud: a dropped
  // block is a page that silently keeps 'unsafe-inline'.
  if (capture !== null) throw new Error(`csp-scan: unterminated <script> in ${label}`);

  const hashes: string[] = [];
  for (const item of items) {
    if ("hash" in item) { hashes.push(item.hash); continue; }
    const inner = await scanDocument(item.srcdoc, item.label);
    hashes.push(...inner.hashes);
    handlers.push(...inner.handlers);
  }
  return { hashes, handlers };
}
