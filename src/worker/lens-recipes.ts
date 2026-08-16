// lens-recipes.js — the fixed, published set of things /lens will do to a page
// before it looks at it, and the plumbing that keeps the page from lying about
// what happened.
//
// /lens/browser renders after JavaScript and reports the word gap against the
// raw HTTP fetch. What it could not show is what a machine sees AFTER
// interaction: after a consent overlay is gone, after a collapsed disclosure is
// open. Those are the two places a page's visible text and its machine-readable
// text diverge hardest, and the lens had nothing to say about either.
//
// ── measured, not assumed (2026-08-08, wrangler dev --remote, real binding) ─
// `env.BROWSER.quickAction` ACCEPTS `addScriptTag`, and the capture happens
// after the injected script's synchronous mutations. Worth measuring rather
// than reading off the docs, because the binding's payload schema is CLOSED —
// the Kitesurf probe got {"code":"unrecognized_keys","keys":["browser"]} for a
// key the REST docs describe — so "documented" does not imply "accepted here".
// Against https://aadhar.sh/garage/horizon: `acted: 7, scanned: 8`, and the
// returned HTML carried 8 of 8 <details> open, with no receipt and no injected
// script left in `content`.
//
// STILL UNMEASURED: whether `waitForTimeout` is accepted and whether it delays
// capture past an injection's ASYNC work. Nothing shipping needs it (both
// recipes below are synchronous, and v1 sends `addScriptTag` alone), but any
// future async recipe does. tools/lens-inject-probe.mjs cases 3 and 4 are
// that question, and they need a REST token.
//
// ── why this is a fixed allowlist and always will be ──────────────────────
// These scripts reach the page through Browser Run's `addScriptTag`, which runs
// arbitrary JavaScript in the target document. A `js=` parameter, or a
// `selector=` parameter (the same hole one step removed: selector →
// querySelectorAll → .click() on anything), would turn /lens into an open,
// unauthenticated remote-code-execution proxy — attacker JS running against
// arbitrary third-party origins, from Cloudflare IPs, under this account's
// browser identity. Cross-origin credentials are not sent; attribution is.
//
// So a caller picks an id off this list and nothing else. `lensRecipeScript()`
// is the only function that assembles what gets injected, and a contract test
// asserts no caller bytes survive into the payload outside `url`.
//
// ── why nothing here clicks ───────────────────────────────────────────────
// Two recipes ship, both synchronous, and neither actuates a control. `consent`
// REMOVES an overlay from the browser's own copy of the DOM; it does not press
// the button. That distinction is the whole ethical argument: removal sets no
// cookie, records no consent choice, and transmits nothing to the origin, while
// clicking "Accept all" from a Cloudflare IP would be this site manufacturing a
// consent record on somebody else's page. A site that ships a "Who's allowed"
// lens and honours robots.txt cannot also ship a one-click consent clicker.
//
// Corollary worth stating because it decides a question that would otherwise
// recur: neither recipe issues a single additional request to the origin, so
// this changes the crawl footprint by exactly zero against the plain render
// that already happens. That is why there is no robots.txt gate here. Adding
// one to the interaction path while the plain render has none would be
// incoherent. A future recipe that DOES cause fetches (a scroll that loads
// images, a click that pages in content) changes that argument and has to
// re-open it rather than inherit this paragraph.
//
// ── the receipt, and why it is a <script> ─────────────────────────────────
// The injected code runs in the page, so its result has to come home inside
// `result.content`. It writes one node:
//
//   <script type="application/lens-receipt" id="lens-recipe-receipt">{…}</script>
//
// A <script> with a non-JS type never executes and never renders. More usefully,
// `documentTally()`'s `stripped()` in lens-render.js already deletes <script>
// bodies before it counts words, so the receipt CANNOT inflate the word delta
// by construction rather than by convention. That property is the reason to
// pick this node over a <div> or a data- attribute on <html>.
//
// Two hard rules on what may travel in it:
//
//   1. Integers and a fixed enum, never page-derived strings. A selector or an
//      overlay's text would be far better UI copy and would also be the one
//      place attacker-controlled bytes could ride back into our JSON. Closed
//      outright, so no escaping question ever arises.
//   2. A per-run nonce. Without one, a hostile page ships its own
//      <script type="application/lens-receipt">{"acted":9999}</script> and lies
//      to /lens about what /lens just did to it. Forty bytes to close.
//
// ── what the nonce is worth, stated honestly ──────────────────────────────
// It stops a page that plants a receipt blindly, which is the only version of
// this attack anyone would actually write. It does NOT stop a page that targets
// this feature specifically: a MutationObserver sees our <script> node arrive,
// and its mutation record still holds the node after we remove it, so the text
// (and the nonce inside it) is recoverable. Scoping the nonce inside the IIFE
// rather than leaving it on `window` closes the free read; it cannot close that
// one, and no in-page value can, because everything we hand the page is
// readable by the page.
//
// That is survivable because the receipt is NOT the load-bearing number. The
// claim the UI makes ("the page went from 210 to 1,840 words") is computed
// server-side by documentTally() over the HTML the page returned, and a page
// cannot inflate that without actually serving the words. The receipt only says
// how many elements we touched. A forged one is caught, reported as
// "forged-receipt", and its counts discarded; a perfectly forged one costs a
// wrong element count beside a true word delta.

// The enum a receipt's `note` may carry. Anything else becomes "unknown"
// server-side rather than being echoed, because echoing is the injection.
import { asRecord, asText } from "./lib/parse.ts";

const RECIPE_NOTES = new Set(["acted", "none-found", "blocked", "threw"]);

// Counts above this are a forgery or a bug, never an observation — no real page
// has a hundred thousand consent overlays. Clamped rather than rejected so a
// weird page still reports honestly.
const RECIPE_COUNT_MAX = 100000;

export const LENS_RECEIPT_ID = "lens-recipe-receipt";
export const LENS_RECEIPT_TYPE = "application/lens-receipt";

// The harness every recipe body runs inside. It supplies __receipt(), removes
// our own <script> element from the page's copy of the DOM, and guarantees that
// a throwing recipe still reports rather than vanishing — a recipe that dies
// silently is indistinguishable from an engine that never ran it, and those two
// need very different copy in front of the reader.
// The nonce arrives as an IIFE ARGUMENT, never as a top-level `var`. A `var` at
// the top of an injected script lands on `window`, where any setTimeout on the
// page reads it for free and forges a receipt that passes the check. Measured in
// Chromium 2026-08-08: `typeof window.__LENS_N` came back "string".
function harness(nonce, body) {
  return `(function(__LENS_N){var __me=document.currentScript;`
    + `function __receipt(r){try{var s=document.createElement("script");`
    + `s.type=${JSON.stringify(LENS_RECEIPT_TYPE)};s.id=${JSON.stringify(LENS_RECEIPT_ID)};`
    + `s.textContent=JSON.stringify({v:1,n:__LENS_N,acted:r.acted|0,scanned:r.scanned|0,note:r.note});`
    + `document.documentElement.appendChild(s);}catch(e){}}`
    + `try{${body}}catch(e){__receipt({acted:0,scanned:0,note:"threw"});}`
    + `if(__me&&__me.parentNode)__me.parentNode.removeChild(__me);})(${JSON.stringify(nonce)});`;
}

// Ordered: this array IS the chip order in the UI.
export const LENS_RECIPES = Object.freeze([
  Object.freeze({
    id: "expand",
    label: "Open collapsed sections",
    claim: "Opens every <details> disclosure widget, then re-reads the page.",
    // Pure DOM, synchronous, no heuristics, no network. This is the control
    // recipe: if it does not work, nothing here works, which is why the probe
    // fixture is built around it.
    script: `var n=0,seen=0;`
      + `document.querySelectorAll("details").forEach(function(d){seen++;if(!d.open){d.open=true;n++;}});`
      + `__receipt({acted:n,scanned:seen,note:n?"acted":"none-found"});`,
  }),
  Object.freeze({
    id: "consent",
    label: "Remove the consent overlay",
    claim: "Removes large fixed overlays whose text reads like a consent or newsletter wall. Presses nothing.",
    // Structural, deliberately NOT a vendor list — OneTrust/Quantcast/Didomi
    // selector lists rot within months and fail closed in the least visible
    // way. Four conditions, all required: pinned to the viewport, stacked above
    // the page, big enough to be a wall rather than a badge, and worded like
    // consent. `scanned` counts every pinned element examined, because that
    // number is what makes "found nothing" read as a finding rather than a bug.
    script: `var n=0,seen=0,W=innerWidth*innerHeight;`
      + `var RE=/cookie|consent|privacy|gdpr|tracking|newsletter|subscribe/i;`
      + `Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function(el){`
      + `var cs;try{cs=getComputedStyle(el);}catch(e){return;}`
      + `if(cs.position!=="fixed"&&cs.position!=="sticky")return;seen++;`
      + `if((parseInt(cs.zIndex,10)||0)<1000)return;`
      + `var r=el.getBoundingClientRect();if(!W||(r.width*r.height)/W<0.25)return;`
      + `if(!RE.test(el.innerText||""))return;`
      + `if(el.parentNode){el.parentNode.removeChild(el);n++;}});`
      // A wall usually locks the scroll and hides the document from a11y trees
      // on its way in. Removing the node without undoing those leaves a page
      // that reads as empty to exactly the machine this lens is imitating.
      + `[document.documentElement,document.body].forEach(function(e){if(e&&e.style)e.style.overflow="";});`
      + `var m=document.querySelector("main");`
      + `if(m){m.removeAttribute("inert");m.removeAttribute("aria-hidden");}`
      + `__receipt({acted:n,scanned:seen,note:n?"acted":"none-found"});`,
  }),
]);

// Keyed by plain string, deliberately wider than the two literal ids: lensRecipe()
// is handed unvalidated caller input and has to be able to MISS.
const BY_ID = new Map(/** @type {[string, (typeof LENS_RECIPES)[number]][]} */ (LENS_RECIPES.map((r) => [r.id, r])));

// Exact match only. No normalising, no trimming, no case folding: a caller that
// sends "EXPAND" or " expand" gets a 400 naming the real ids, which is more
// useful than silently guessing and far less surprising than a near-miss that
// works.
export function lensRecipe(id) {
  return (asText(id) !== null && BY_ID.get(id)) || null;
}

export function lensRecipeIds() {
  return LENS_RECIPES.map((r) => r.id);
}

// 16 hex chars from the runtime CSPRNG. Not a secret and not a signature — it
// only has to be unguessable by a page that is being rendered right now.
export function lensRecipeNonce() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function lensRecipeScript(recipe, nonce) {
  return harness(nonce, recipe.script);
}

// The public disclosure payload. Carries the VERBATIM script, so a reader can
// check what ran against what we say ran; a contract test pins the two together
// so the published copy cannot drift from the executed one.
export function lensRecipeCatalog() {
  return LENS_RECIPES.map((r) => ({ id: r.id, label: r.label, claim: r.claim, script: r.script }));
}

const RECEIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']?${LENS_RECEIPT_ID}["']?[^>]*>([\\s\\S]*?)</script\\s*>`,
  "i",
);

const clampCount = (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RECIPE_COUNT_MAX) : 0);

// Pull the receipt out of the rendered HTML and hand back the html WITHOUT it.
//
// Both halves matter and the order they are used in matters more. The caller
// must strip before it calls documentTally() and before it applies the 120KB
// content cap: count first and `shape` counts our own injected script, cap first
// and the receipt falls off the end of a large page and vanishes. The existing
// `__lens_webmcp_runtime__` assertion is the precedent for this exact bug class.
export function lensRecipeReceipt(html, nonce) {
  const source = String(html || "");
  const match = source.match(RECEIPT_RE);
  // Strip unconditionally: a receipt we refuse to trust must still not reach the
  // reader's `content` field, or a forged one becomes visible page text.
  const stripped = match ? source.replace(RECEIPT_RE, "") : source;
  if (!match) return { receipt: null, html: stripped };

  let parsed;
  try { parsed = JSON.parse(match[1]); } catch (_e) { return { receipt: null, html: stripped }; }
  if (!asRecord(parsed)) return { receipt: null, html: stripped };

  // The nonce check. A page that shipped its own receipt is REPORTED rather than
  // ignored, because "this page tried to spoof the instrument" is a genuinely
  // interesting thing for a lens about machine-readability to have noticed.
  if (parsed.n !== nonce) {
    return { receipt: { ran: false, acted: 0, scanned: 0, note: "forged-receipt" }, html: stripped };
  }
  const note = RECIPE_NOTES.has(parsed.note) ? parsed.note : "unknown";
  return {
    receipt: {
      ran: note !== "threw",
      acted: clampCount(parsed.acted),
      scanned: clampCount(parsed.scanned),
      note,
    },
    html: stripped,
  };
}
