// csp-scan.mjs — what the hashed CSP needs to know about one staged document:
// which inline scripts the browser will EXECUTE (so their sha256 belongs in the
// header), and whether any inline event-handler attribute is present (which a
// hash policy structurally cannot cover, so build.mjs stops on one).
//
// THE PARSER IS THE POINT. This used to be a hand-rolled tag walker in
// build.mjs, correct only because it had been patched three times against the
// served bytes: minify-html unquotes attributes and decodes character
// references inside quoted values, so a scanner written against the authored
// HTML reads the minified HTML wrong. The record is in CLAUDE.md — a `<script`
// search that read /garage/horizon's XSS demo payload as two real scripts, a
// link scanner that found 33 refs where there were 2645, and an attribute
// scanner that had to learn quotes for the same reason.
//
// HTMLRewriter is lol-html, the SAME ENGINE src/worker/ already runs, so the
// build now reads a document the way the Worker does and the way the browser
// computing these hashes does. Measured over the 48 served pages: 35ms.
//
// It is a bun global with no node equivalent, which is why build.mjs states the
// requirement by name rather than failing on an undefined symbol.
import { createHash } from "node:crypto";

// A `<script>` is CSP-checked when the browser would EXECUTE it. That covers the
// JavaScript types and, verified in a real browser, `speculationrules`. It does
// not cover data blocks (application/json for the quiz payloads, ld+json), which
// are parsed as data and never reach script-src. 31 of the 128 inline blocks on
// this site are data, so getting this wrong in either direction is 31 wrong
// answers.
const JAVASCRIPT_TYPES = ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"];
export const EXECUTABLE_EXTRA = new Set(["speculationrules"]);
const isExecutableType = (type) => !type || JAVASCRIPT_TYPES.includes(type) || EXECUTABLE_EXTRA.has(type);

const HANDLER_ATTR = /^on[a-z]+$/;

// The browser resolves character references in an attribute value exactly once
// on its way to the srcdoc document's source text, and the hash is taken over
// THAT text. HTMLRewriter hands back the raw attribute (probed: `srcdoc` comes
// out as `&lt;script&gt;…`), so the decode still belongs here. In practice the
// staged copy already carries raw `<`, because minify-html decodes entities
// inside quoted attribute values, which makes this a no-op today and correct if
// that ever changes.
const NAMED_REFS = { lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: "\u00a0", amp: "&" };
const decodeCharRefs = (value) =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref) => {
    const key = ref.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return key in NAMED_REFS ? NAMED_REFS[key] : whole;
  });

export const PARSER_MISSING =
  "csp-scan: this build step needs HTMLRewriter, which is a bun global with no node equivalent. Run the build with bun (`bun run build`).";

export function requireParser() {
  // Presence of the global, asked as a property of the environment rather than
  // as a typeof on a value: this is an I/O-boundary question about the runtime,
  // which is exactly what anti-slop(no-runtime-typeof) is pointing at.
  if (!("HTMLRewriter" in globalThis)) throw new Error(PARSER_MISSING);
}

// One document. Returns hashes in DOCUMENT ORDER, which is load-bearing: the map
// is serialised into csp-hashes.ts, so a reordering is a changed Worker bundle
// and a re-minted URL for nothing. An `srcdoc` document INHERITS the embedding
// page's CSP, so its scripts are hashed HERE, in the position the iframe sits at.
export async function scanDocument(source, label) {
  requireParser();

  const items = [];
  const handlers = [];
  let capture = null;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      // Attributes are parsed rather than regexed off the raw tag, because
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

      const body = [];
      capture = body;
      // Fires for an empty <script></script> too, which is the reason this hangs
      // off the end tag rather than off the last text chunk: an empty executable
      // block still needs the hash of the empty string, and it has no text node.
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

  const hashes = [];
  for (const item of items) {
    if (item.hash) { hashes.push(item.hash); continue; }
    const inner = await scanDocument(item.srcdoc, item.label);
    hashes.push(...inner.hashes);
    handlers.push(...inner.handlers);
  }
  return { hashes, handlers };
}
