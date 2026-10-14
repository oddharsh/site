// lens-recipes.ts — the fixed, published set of things /lens will do to a page
// before it looks at it, and the plumbing that keeps the page from lying about
// what happened.
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

import { asRecord, asText } from "./lib/parse.ts";

const RECIPE_NOTES = new Set(["acted", "none-found", "blocked", "threw"]);

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

export const LENS_RECIPES = Object.freeze([
  Object.freeze({
    id: "expand",
    label: "Open collapsed sections",
    claim: "Opens every <details> disclosure widget, then re-reads the page.",
    script: `var n=0,seen=0;`
      + `document.querySelectorAll("details").forEach(function(d){seen++;if(!d.open){d.open=true;n++;}});`
      + `__receipt({acted:n,scanned:seen,note:n?"acted":"none-found"});`,
  }),
  Object.freeze({
    id: "consent",
    label: "Remove the consent overlay",
    claim: "Removes large fixed overlays whose text reads like a consent or newsletter wall. Presses nothing.",
    script: `var n=0,seen=0,W=innerWidth*innerHeight;`
      + `var RE=/cookie|consent|privacy|gdpr|tracking|newsletter|subscribe/i;`
      + `Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function(el){`
      + `var cs;try{cs=getComputedStyle(el);}catch(e){return;}`
      + `if(cs.position!=="fixed"&&cs.position!=="sticky")return;seen++;`
      + `if((parseInt(cs.zIndex,10)||0)<1000)return;`
      + `var r=el.getBoundingClientRect();if(!W||(r.width*r.height)/W<0.25)return;`
      + `if(!RE.test(el.innerText||""))return;`
      + `if(el.parentNode){el.parentNode.removeChild(el);n++;}});`
      + `[document.documentElement,document.body].forEach(function(e){if(e&&e.style)e.style.overflow="";});`
      + `var m=document.querySelector("main");`
      + `if(m){m.removeAttribute("inert");m.removeAttribute("aria-hidden");}`
      + `__receipt({acted:n,scanned:seen,note:n?"acted":"none-found"});`,
  }),
]);

const BY_ID = new Map(LENS_RECIPES.map((r) => [r.id, r] as const));

export function lensRecipe(id) {
  return (asText(id) !== null && BY_ID.get(id)) || null;
}

export function lensRecipeIds() {
  return LENS_RECIPES.map((r) => r.id);
}

export function lensRecipeNonce() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return b.toHex();
}

export function lensRecipeScript(recipe, nonce) {
  return harness(nonce, recipe.script);
}

export function lensRecipeCatalog() {
  return LENS_RECIPES.map((r) => ({ id: r.id, label: r.label, claim: r.claim, script: r.script }));
}

const RECEIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']?${LENS_RECEIPT_ID}["']?[^>]*>([\\s\\S]*?)</script\\s*>`,
  "i",
);

const clampCount = (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RECIPE_COUNT_MAX) : 0);

export function lensRecipeReceipt(html, nonce) {
  const source = String(html || "");
  const match = source.match(RECEIPT_RE);
  const stripped = match ? source.replace(RECEIPT_RE, "") : source;
  if (!match) return { receipt: null, html: stripped };

  let parsed;
  try { parsed = JSON.parse(match[1]); } catch (_e) { return { receipt: null, html: stripped }; }
  if (!asRecord(parsed)) return { receipt: null, html: stripped };

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
