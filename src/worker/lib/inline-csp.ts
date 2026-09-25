// lib/inline-csp.ts — a hashed script-src for a page the Worker renders at
// request time.
//
// Built documents get their hashes from build step 7c (lib/csp-hashes.ts). A page
// rendered per request never reached that map, so every one of them shipped
// `script-src 'self' 'unsafe-inline'` (gotcha 17). The open follow-up there was a
// per-response nonce. This is the simpler door: lunaPage already holds the whole
// document as one string before it builds the Response, so it can hash the
// inline scripts in it and name them. A cached render stores the header beside
// the bytes it describes, so the two cannot drift apart.
//
// THE SCANNER READS OUR OWN OUTPUT, never a stranger's HTML, and that is what
// makes a scanner this small acceptable. Every value lunaPage interpolates goes
// through lib/html.ts's escaping, so a `<script` or a `>` can only appear in the
// markup a page author wrote. The build's scanner (tools/lib/csp-scan.ts) is a
// real parser because it reads minified bytes, where minify-html unquotes
// attributes and decodes entities; nothing here is minified. The contract test
// holds the two scanners together on rendered pages and on adversarial markup.
//
// It FAILS OPEN TO THE OLD POLICY, never closed. Anything a hash cannot cover
// (an inline event handler, a javascript: URL, an srcdoc document that would
// inherit this policy) makes it return null, and the page keeps the loose
// policy it had yesterday. A false alarm therefore costs nothing that shipped
// before; a missed script would break the page, and that direction is the one
// the test hunts.
import { cspHashed } from "./csp-policy.ts";
import { sha256Base64 } from "./sha256.ts";

// Mirrors tools/lib/csp-scan.ts: the JavaScript types plus speculationrules are
// executed and CSP-checked; data blocks (application/json, ld+json) are not.
const EXECUTABLE = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module", "speculationrules"]);

// The HTML tokenizer ends a script at `</script` followed by whitespace, `/` or
// `>`, case-insensitively, and the hash covers exactly the text in between.
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script[\s/>]/gi;
const ATTR = (name: string) => new RegExp(`(?:^|\\s)${name}(?=[\\s=/>]|$)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`, "i");

const RAW_TEXT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1[\s/>]/gi;

// What a hash policy structurally cannot express. Deliberately wide: a match
// inside an attribute VALUE is a false alarm, and a false alarm only means the
// page keeps the loose policy.
const UNHASHABLE = [
  /<[a-z][^>]*\son[a-z]+\s*=/i,            // an inline event handler
  /=\s*["']?\s*javascript:/i,               // a javascript: URL
  /<[a-z][^>]*\ssrcdoc\s*=/i,               // a document that inherits this policy
];

/** The sha256 of every inline script the browser would execute, in document
 *  order and de-duplicated; or null when the page carries something a hash
 *  cannot cover. */
export function inlineScriptHashes(doc: string): string[] | null {
  // The markup alone: script and style BODIES are raw text, where `i<n` followed
  // by `el.onload =` reads exactly like an event-handler attribute and is not one.
  const markup = doc.replace(RAW_TEXT, "<$1></$1>");
  if (UNHASHABLE.some((re) => re.test(markup))) return null;
  const hashes: string[] = [];
  for (const m of doc.matchAll(SCRIPT)) {
    const attrs = m[1];
    if (ATTR("src").test(attrs)) continue;                 // external: 'self' covers it
    const t = attrs.match(ATTR("type"));
    const type = t ? (t[1] ?? t[2] ?? t[3] ?? "").trim().toLowerCase() : "";
    if (!EXECUTABLE.has(type)) continue;
    const h = sha256Base64(m[2]);
    if (!hashes.includes(h)) hashes.push(h);
  }
  return hashes;
}

/** The whole Content-Security-Policy for `doc`, or null to keep the default. */
export function inlineScriptPolicy(doc: string): string | null {
  const hashes = inlineScriptHashes(doc);
  return hashes ? cspHashed(hashes) : null;
}
