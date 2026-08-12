// lib/agent-execution.js — what an agent BROWSER does with the page.
//
// /lens has scored agent readiness since it was built, and every one of those
// twenty checks is a declaration audit: does robots.txt exist, does the sitemap
// parse, does the MCP server card have the right shape. That layer is worth
// scoring and it is not the whole story. Measured 2026-08-12 against this very
// site: all twenty declared surfaces answered, the rubric would have called it
// near-perfect, and an actual agent browser was getting a homepage with twelve
// blank squares and a script that threw on every page.
//
// So this module is the EXECUTION half, and it is deliberately small. Two
// questions a declaration structurally cannot answer:
//
//   agentScripts — did the page's own JavaScript survive the engine?
//   agentMedia   — could the engine decode the images the page served?
//
// Both come from the CCDP session /lens/wire already opens, so they cost no
// extra browser instance and no extra minute of the 10-a-day account ceiling.
//
// ── why an agent browser is not Chrome ────────────────────────────────────
// Kitesurf ships ~97% of the DOM per Web Platform Tests, and the missing 3% is
// exactly where this bites. It has a `navigation` object carrying entries() and
// currentEntry and nothing else, so `if (window.navigation)` passes and
// `navigation.addEventListener` throws. It cannot decode AVIF, so a page that
// dropped its <picture> fallback because "every browser we target decodes AVIF"
// serves blank squares to every agent that renders it. Neither failure is
// visible over HTTP, neither is visible in Chrome, and neither moves any
// declared-surface check.
//
// ── neutral until measured ────────────────────────────────────────────────
// A render is rate-limited and capped account-wide, so most scans will never
// have this evidence. `neutral` is the existing /lens status for a check that
// is shown and excluded from the score, which is the only honest default: a
// site must not be marked down because our browser budget ran out. The checks
// flip to pass or fail, and start counting, once a run actually happened.

/** Label and category for each execution check, in the shape LENS_READINESS_META wants. */
export const EXECUTION_META = {
  agentScripts: { category: "execution", label: "Scripts survive the engine" },
  agentMedia: { category: "execution", label: "Media decodes" },
};

/**
 * Turn one agent-browser observation into check statuses.
 *
 * @param {null|undefined|{ran?:boolean, engine?:string, consoleErrors?:number,
 *   pageErrors?:number, totalImages?:number, brokenImages?:number,
 *   imagesWithAlt?:number, imagesDecorative?:number, imagesMissingAlt?:number,
 *   firstError?:string, brokenSample?:string[]}} ev
 * @returns {{agentScripts:{status:string,detail:string}, agentMedia:{status:string,detail:string}}}
 */
export function executionChecks(ev) {
  if (!ev || ev.ran !== true) {
    const detail = "no agent-browser render in this scan (run the wire lens to measure)";
    return { agentScripts: { status: "neutral", detail }, agentMedia: { status: "neutral", detail } };
  }
  const engine = ev.engine ? ` in ${ev.engine}` : "";

  // Scripts. Any uncaught error fails, because a throw does not stop where it
  // happened: it takes out the rest of its caller, and the blast radius is not
  // something an outside observer can estimate. On this site one TypeError
  // inside a requestAnimationFrame pass cost every window its maximize control.
  const errs = (Number(ev.consoleErrors) || 0) + (Number(ev.pageErrors) || 0);
  const agentScripts = errs === 0
    ? { status: "pass", detail: `no uncaught script errors${engine}` }
    : { status: "fail", detail: `${errs} uncaught script error${errs === 1 ? "" : "s"}${engine}${ev.firstError ? ": " + ev.firstError : ""}` };

  // Media. Scored on DECODE rather than on transfer: the AVIF tiles that broke
  // this site all returned 200, so a request-level view calls them healthy.
  const total = Number(ev.totalImages) || 0;
  const broken = Number(ev.brokenImages) || 0;
  let agentMedia;
  if (total === 0) {
    agentMedia = { status: "neutral", detail: "the page served no images" };
  } else if (broken === 0) {
    agentMedia = { status: "pass", detail: `all ${total} images decoded${engine}` };
  } else {
    const sample = Array.isArray(ev.brokenSample) && ev.brokenSample.length ? ` (${ev.brokenSample.slice(0, 3).join(", ")})` : "";
    agentMedia = { status: "fail", detail: `${broken} of ${total} images failed to decode${engine}${sample}` };
  }
  return { agentScripts, agentMedia };
}

/**
 * The DOM census, as a string, because it has to run inside the page through
 * CDP's Runtime.evaluate rather than being called here.
 *
 * ALT TEXT IS THREE STATES, NOT TWO, and getting that wrong was this feature's
 * own first bug: counting non-empty alt against ALL images scored a page 1/10
 * when fourteen of its sixteen images were taskbar sprites carrying a
 * deliberate alt="". An empty alt is a DECISION that the image owes no
 * description. Only a missing attribute is an omission.
 *
 * Returns a JSON string so the caller parses one value rather than trusting
 * CDP's object serialization across engines.
 */
export const EXECUTION_PROBE = `(() => {
  try {
    var imgs = Array.prototype.slice.call(document.querySelectorAll("img"));
    var broken = imgs.filter(function (i) { return i.complete && i.naturalWidth === 0; });
    return JSON.stringify({
      totalImages: imgs.length,
      brokenImages: broken.length,
      brokenSample: broken.slice(0, 3).map(function (i) {
        return String(i.currentSrc || i.src || "").split("/").pop().slice(0, 48);
      }),
      imagesWithAlt: imgs.filter(function (i) { return (i.getAttribute("alt") || "").trim().length > 0; }).length,
      imagesDecorative: imgs.filter(function (i) { return i.hasAttribute("alt") && !(i.getAttribute("alt") || "").trim(); }).length,
      imagesMissingAlt: imgs.filter(function (i) { return !i.hasAttribute("alt"); }).length
    });
  } catch (e) { return JSON.stringify({ probeError: String(e && e.message || e).slice(0, 120) }); }
})()`;
