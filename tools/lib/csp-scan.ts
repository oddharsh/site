// csp-scan.ts — what the hashed CSP needs to know about one staged document:
// which inline scripts the browser will EXECUTE (so their sha256 belongs in the
// header), and whether any inline event-handler attribute is present (which a
// hash policy structurally cannot cover, so the build stops on one).
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
// here. In practice the staged copy already carries raw `<`, because the HTML minifier
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

export async function scanDocument(source: string, label: string): Promise<ScanResult> {
  requireParser();

  type Slot = { body: string[] } | { srcdoc: string; label: string };
  const items: Slot[] = [];
  const handlers: string[] = [];
  let current: { body: string[] } | null = null;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        for (const [name] of el.attributes) {
          const lower = name.toLowerCase();
          if (HANDLER_ATTR.test(lower)) handlers.push(`${label}: <${tag} ${lower}=…>`);
        }

        const srcdoc = el.getAttribute("srcdoc");
        if (srcdoc) items.push({ srcdoc: decodeCharRefs(srcdoc), label: `${label}: <${tag} srcdoc>` });

        if (tag !== "script") return;
        if (el.getAttribute("src") !== null) return;
        if (!isExecutableType((el.getAttribute("type") || "").toLowerCase())) return;

        // Reserved here, so an EMPTY <script></script> still gets its slot and
        // hashes the empty string. Probed rather than assumed: an empty script
        // emits no text chunk at all, so anything that waited for one would drop
        // the block and leave that page needing a hash the header never carries.
        current = { body: [] };
        items.push(current);
      },
    })
    .on("script", {
      text(chunk) {
        // Scoped to `script` rather than `*` on purpose. A `*` text handler would
        // hand an empty script the whitespace that follows its close tag, since
        // that is the next text the stream produces.
        //
        // Raw-text content arrives in chunks split on `<`, undecoded, so joining
        // reproduces the source bytes the browser hashes. Probed: `&amp;` inside
        // a script body survives as `&amp;`.
        if (!current) return;
        current.body.push(chunk.text);
        if (chunk.lastInTextNode) current = null;
      },
    });

  await rewriter.transform(new Response(source)).text();

  const hashes: string[] = [];
  for (const item of items) {
    if ("body" in item) {
      hashes.push(createHash("sha256").update(item.body.join(""), "utf8").digest("base64"));
      continue;
    }
    const inner = await scanDocument(item.srcdoc, item.label);
    hashes.push(...inner.hashes);
    handlers.push(...inner.handlers);
  }
  return { hashes, handlers };
}
