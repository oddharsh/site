// lib/agent-execution.ts — what an agent BROWSER does with the page.

export const EXECUTION_META = {
  agentScripts: { category: "execution", label: "Scripts survive the engine" },
  agentMedia: { category: "execution", label: "Media decodes" },
};

export function executionChecks(ev) {
  if (!ev || ev.ran !== true) {
    const detail = "no agent-browser render in this scan (run the wire lens to measure)";
    return { agentScripts: { status: "neutral", detail }, agentMedia: { status: "neutral", detail } };
  }
  const engine = ev.engine ? ` in ${ev.engine}` : "";

  const errs = (Number(ev.consoleErrors) || 0) + (Number(ev.pageErrors) || 0);
  const agentScripts = errs === 0
    ? { status: "pass", detail: `no uncaught script errors${engine}` }
    : { status: "fail", detail: `${errs} uncaught script error${errs === 1 ? "" : "s"}${engine}${ev.firstError ? ": " + ev.firstError : ""}` };

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
