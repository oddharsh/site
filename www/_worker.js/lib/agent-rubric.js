// lib/agent-rubric.js — the agent-readiness rubric, in ONE place.
//
// Two callers score against this and they must not drift:
//   - scripts/check-agent.mjs drives Cloudflare's Kitesurf against THIS site's
//     routes and fails when a dimension regresses.
//   - /lens scores whatever URL a visitor points it at, out of the evidence its
//     eight machine tabs already collected.
//
// Same weights, same thresholds, same words for the verdict, so "our own site
// scores 82" and "theverge.com scores 41" are the same claim. This module is
// PURE for the reason lib/tui.js is pure: one definition has to answer a Node
// script, an HTTP response and `node --test` without caring which is asking.
//
// ── the rule that makes the number honest ─────────────────────────────────
// A dimension nobody measured is UNMEASURED, never zero. The photo pipeline has
// had this discipline since it was written (every field nullable, skip the line
// rather than fabricate it) and a score is where the temptation is worst: a
// missing probe silently becomes an accusation, and the site being scored has
// no way to answer it. So `score` is computed over the dimensions that carry
// evidence, `max` shrinks to match, and `unmeasured` is published beside the
// number rather than folded into it.
//
// ── where the weights come from ───────────────────────────────────────────
// Measured against aadhar.sh on 2026-08-12, which is the run this file exists
// because of. Every one of the site's declared agent surfaces answered 200
// (llms.txt, the Markdown twins, both MCP cards, the agent card, tools/list),
// and the two real defects were invisible to all of them: 12 of 12 photo tiles
// failed to decode in an agent browser, and nav.js threw on all six pages
// tested. So BROWSER carries the heaviest weight (25) and DECLARED carries 20.
// The layer everyone builds first was already perfect and was not the problem.

/** Weight per dimension. These sum to 100 when every dimension is measured. */
export const WEIGHTS = {
  reachable: 15,
  legible: 20,
  browser: 25,
  declared: 20,
  describable: 10,
  cheap: 10,
};

/** Verdict bands, applied to the percentage a page earned of what it was scored on. */
const BANDS = [
  [90, "excellent"],
  [75, "good"],
  [55, "workable"],
  [35, "poor"],
  [0, "hostile"],
];

export function band(pct) {
  for (const [floor, label] of BANDS) if (pct >= floor) return label;
  return "hostile";
}

/** Clamp a 0..1 ratio into points, rounding to a whole point. */
const pts = (ratio, weight) => Math.round(Math.max(0, Math.min(1, ratio)) * weight);

/**
 * Score one page. Every field of `ev` is optional: pass what you measured and
 * the rubric scores that, reporting the rest as unmeasured.
 *
 * @param {object} ev evidence
 * @param {{status?:number, words?:number, robotsAllowsAgents?:boolean|null}} [ev.http]
 *   what a plain GET returned, with no JavaScript run.
 * @param {{words?:number, consoleErrors?:number, pageErrors?:number,
 *          brokenImages?:number, totalImages?:number, imagesWithAlt?:number,
 *          engine?:string}} [ev.rendered]
 *   what an AGENT BROWSER got. Kitesurf here, because that is the engine an
 *   agent driving Cloudflare's stack actually runs.
 * @param {{llmsTxt?:boolean, markdownTwin?:boolean, agentCard?:boolean,
 *          mcp?:boolean, sitemap?:boolean}} [ev.declared]
 * @param {{requests?:number, transferBytes?:number, thirdPartyShare?:number}} [ev.wire]
 * @param {{kept?:number, source?:number}} [ev.reader] reader-mode extraction.
 */
export function scoreAgentReadiness(ev = {}) {
  const dims = [];
  const unmeasured = [];
  const add = (id, label, points, max, evidence) => dims.push({ id, label, points, max, evidence, pct: max ? Math.round((points / max) * 100) : 0 });
  const skip = (id, why) => unmeasured.push({ id, why });

  // ── 1. reachable ────────────────────────────────────────────────────────
  // A machine has to get the bytes before anything else is worth asking. This
  // scores the front door only: the status code, and whether robots.txt lets an
  // identified agent in at all.
  if (ev.http && typeof ev.http.status === "number") {
    const okStatus = ev.http.status >= 200 && ev.http.status < 300;
    const robots = ev.http.robotsAllowsAgents;
    // robots is deliberately worth a third rather than a veto. Disallowing
    // crawlers is a legitimate choice and says nothing about whether the page
    // is legible to an agent a human pointed at it.
    const ratio = (okStatus ? 0.67 : 0) + (robots === false ? 0 : 0.33);
    add("reachable", "Reachable", pts(ratio, WEIGHTS.reachable), WEIGHTS.reachable, [
      `HTTP ${ev.http.status}`,
      robots === false ? "robots.txt disallows identified agents" : robots === true ? "robots.txt admits identified agents" : "robots.txt posture unread",
    ]);
  } else skip("reachable", "no HTTP status recorded");

  // ── 2. legible without JavaScript ───────────────────────────────────────
  // The word delta between a plain GET and a rendered page. A page whose prose
  // only exists after hydration costs every agent a full browser render, which
  // is the single most expensive thing an agent can be made to do.
  const hw = ev.http?.words;
  const rw = ev.rendered?.words;
  if (typeof hw === "number" && typeof rw === "number" && rw > 0) {
    const ratio = Math.min(1, hw / rw);
    add("legible", "Legible without JavaScript", pts(ratio, WEIGHTS.legible), WEIGHTS.legible, [
      `${hw} words over HTTP against ${rw} rendered (${Math.round(ratio * 100)}%)`,
    ]);
  } else skip("legible", "needs both an HTTP word count and a rendered one");

  // ── 3. survives an agent browser ────────────────────────────────────────
  // THE dimension nothing else here could see, and the reason this file exists.
  // An agent browser is not Chrome: Kitesurf ships ~97% of the DOM and omits
  // real things, so a page can be perfect over HTTP, perfect in Chrome, and
  // broken for every agent that renders it. Three measurements, because the two
  // defects found on 2026-08-12 were one of each of the first two.
  const r = ev.rendered;
  if (r && (typeof r.consoleErrors === "number" || typeof r.brokenImages === "number")) {
    const parts = [];
    let earned = 0;
    let of = 0;

    // scripts: any uncaught error costs the whole third. A throw does not stop
    // where it happened, it takes out the rest of its caller, and the blast
    // radius is not something a score can estimate from outside.
    if (typeof r.consoleErrors === "number" || typeof r.pageErrors === "number") {
      const errs = (r.consoleErrors || 0) + (r.pageErrors || 0);
      of += 1;
      earned += errs === 0 ? 1 : 0;
      parts.push(errs === 0 ? "no uncaught script errors" : `${errs} uncaught script error(s)`);
    }
    // media: the share of images an agent browser could actually decode.
    if (typeof r.brokenImages === "number" && typeof r.totalImages === "number") {
      of += 1;
      const okShare = r.totalImages ? (r.totalImages - r.brokenImages) / r.totalImages : 1;
      earned += okShare;
      parts.push(r.totalImages ? `${r.totalImages - r.brokenImages}/${r.totalImages} images decoded` : "no images");
    }
    if (r.engine) parts.push(`engine: ${r.engine}`);
    add("browser", "Survives an agent browser", pts(of ? earned / of : 0, WEIGHTS.browser), WEIGHTS.browser, parts);
  } else skip("browser", "no agent-browser render recorded");

  // ── 4. declared surfaces ────────────────────────────────────────────────
  // The layer everyone builds first. Worth 20 and not 40: aadhar.sh scored full
  // marks here on the same run that turned up both real defects, so a perfect
  // score on this dimension alone predicts very little.
  const d = ev.declared;
  if (d && Object.keys(d).length) {
    const checks = [
      ["llmsTxt", "llms.txt"],
      ["markdownTwin", "Markdown twin"],
      ["agentCard", "agent card"],
      ["mcp", "MCP endpoint"],
      ["sitemap", "sitemap"],
    ].filter(([k]) => typeof d[k] === "boolean");
    const hit = checks.filter(([k]) => d[k]);
    add("declared", "Declared agent surfaces", pts(checks.length ? hit.length / checks.length : 0, WEIGHTS.declared), WEIGHTS.declared,
      [checks.length ? `${hit.length}/${checks.length}: ${checks.map(([k, l]) => (d[k] ? l : `no ${l}`)).join(", ")}` : "nothing probed"]);
  } else skip("declared", "no discovery probes recorded");

  // ── 5. describable ──────────────────────────────────────────────────────
  // Alt text is what saved the homepage on 2026-08-12: all 12 tiles failed to
  // decode and all 12 carried a real caption, so a text-reading agent lost
  // nothing while a screenshotting one lost the whole grid. Reader-mode
  // retention rides here too when /lens has run its extractor.
  const parts5 = [];
  let e5 = 0;
  let o5 = 0;
  if (r && typeof r.imagesWithAlt === "number" && typeof r.totalImages === "number" && r.totalImages > 0) {
    o5 += 1;
    e5 += r.imagesWithAlt / r.totalImages;
    parts5.push(`${r.imagesWithAlt}/${r.totalImages} images carry alt text`);
  }
  if (ev.reader && typeof ev.reader.kept === "number" && typeof ev.reader.source === "number" && ev.reader.source > 0) {
    o5 += 1;
    e5 += Math.min(1, ev.reader.kept / ev.reader.source);
    parts5.push(`reader mode keeps ${Math.round((ev.reader.kept / ev.reader.source) * 100)}% of the words`);
  }
  if (o5) add("describable", "Describable to a text agent", pts(e5 / o5, WEIGHTS.describable), WEIGHTS.describable, parts5);
  else skip("describable", "no alt-text or reader-extraction evidence");

  // ── 6. cheap ────────────────────────────────────────────────────────────
  // What an agent pays to read the page. Thresholds are generous on purpose:
  // this is a tax, not a defect, and the /lens wire tab already reports the
  // absolute numbers for anyone who wants to argue with the curve.
  const w = ev.wire;
  if (w && typeof w.transferBytes === "number") {
    const mb = w.transferBytes / 1_000_000;
    // 1 MB or under is full marks, 8 MB or over is none, linear between.
    const sizeRatio = mb <= 1 ? 1 : mb >= 8 ? 0 : 1 - (mb - 1) / 7;
    const third = typeof w.thirdPartyShare === "number" ? 1 - Math.min(1, w.thirdPartyShare) : null;
    const ratio = third === null ? sizeRatio : (sizeRatio + third) / 2;
    add("cheap", "Cheap to read", pts(ratio, WEIGHTS.cheap), WEIGHTS.cheap, [
      `${mb.toFixed(2)} MB over ${w.requests ?? "?"} requests`,
      third === null ? "third-party share unmeasured" : `${Math.round((w.thirdPartyShare || 0) * 100)}% of bytes third-party`,
    ]);
  } else skip("cheap", "no request waterfall recorded");

  const earned = dims.reduce((a, x) => a + x.points, 0);
  const max = dims.reduce((a, x) => a + x.max, 0);
  const pct = max ? Math.round((earned / max) * 100) : 0;
  return { score: earned, max, pct, verdict: band(pct), dimensions: dims, unmeasured };
}

/** One-line summary, used by the CLI and by the /lens header. */
export function summarise(result) {
  const cover = result.unmeasured.length ? `, ${result.unmeasured.length} dimension(s) unmeasured` : "";
  return `${result.score}/${result.max} (${result.pct}%, ${result.verdict}${cover})`;
}
