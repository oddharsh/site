// check-agent.mjs — is this site agent-accessible IN PRACTICE?
//
// Every other agent check here reads a declaration: the route oracle sweeps
// routes, gen-mcp-cards diffs a card against tools/list, build.mjs counts the
// Markdown twins. All of them passed on 2026-08-12 while an agent browser was
// getting a homepage with 12 blank squares and a script that threw on every
// page. A declaration cannot catch that, because the defect is in what an
// ENGINE does with bytes that are themselves correct.
//
// So this drives the engine. Cloudflare's Kitesurf is the one agents actually
// run when they drive Cloudflare's stack, and it ships roughly 97% of the DOM,
// which is the interesting part: the missing 3% is where a page breaks for
// every agent while staying perfect in Chrome.
//
//     pnpm run agent:check                  # the sample, against Kitesurf
//     pnpm run agent:check --all            # every page in site-manifest.json
//     pnpm run agent:check --control        # add the Chrome control (see below)
//     pnpm run agent:check --json           # machine output
//
// ── cost ──────────────────────────────────────────────────────────────────
// FREE, and deliberately so. This talks to the public Kitesurf playground at
// wss://kitesurf.cloudflare.app/devtools/browser, which takes no account and no
// token, so it spends none of the 10 browser-minutes a day that /lens/shot and
// /lens/browser share. That is the whole reason this is runnable at all: the
// same sweep through the account's Browser Run binding would black out the
// browser lenses for the rest of the day on its first run.
//
// ── the control, and why it is not optional in spirit ─────────────────────
// gotcha 15 and gotcha 33 in CLAUDE.md are both the same lesson learned the
// expensive way: an instrument that reports a browser feature as missing is
// usually broken itself. A CDP-attached trace reported Cloudflare's own origin
// as ignoring Early Hints, and an agent-driven tab reported a working
// speculation rule as dead. So a Kitesurf-only defect means nothing until the
// identical script passes in Chrome. `--control` runs it and prints the
// comparison; without the flag the report says the control did not run rather
// than implying one did.
//
// ── what it does NOT do ───────────────────────────────────────────────────
// It does not gate CI. This reaches a third-party playground over the network
// on every run, so as a required check it would redden PRs on somebody else's
// outage. It is a workstation control in the same idiom as kitesurf:check and
// bun:check. Run it when touching client JavaScript, the photo pipeline, or
// anything the shell projects into every document.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

import { executionChecks } from "../src/worker/lib/agent-execution.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ORIGIN = process.env.AGENT_CHECK_ORIGIN || "https://aadhar.sh";
const KITESURF_WS = "wss://kitesurf.cloudflare.app/devtools/browser";

const WANT_ALL = process.argv.includes("--all");
const WANT_CONTROL = process.argv.includes("--control");
const WANT_JSON = process.argv.includes("--json");

// The sample. One page per rendering path rather than one per section, because
// what varies here is HOW a document is produced: baked static, worker-rendered,
// client-hydrated, and the two consoles that build their own DOM.
const SAMPLE = ["/", "/writing", "/garage", "/garage/horizon", "/terminal", "/lens", "/coffee", "/around"];

const log = (m) => { if (!WANT_JSON) console.log(m); };

/**
 * Words a plain GET yields, with scripts and styles removed and tags stripped.
 *
 * The closers are `<\/tag\b[^>]*>` rather than `<\/tag>` because an end tag may
 * carry attributes: `</script bar>` and `</script >` both close a script element
 * as surely as `</script>` does. Spelling it the short way hands the whole body
 * through, and every word of it lands in the count this feeds. Same fix and same
 * reasoning as #347, which closed this class across the tree; lens.js carries the
 * long version of the argument beside its own strippers.
 */
export function httpWords(html) {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

const head = async (url) => {
  try {
    const r = await fetch(url, { redirect: "follow" });
    return { ok: r.ok, status: r.status, type: r.headers.get("content-type") || "" };
  } catch { return { ok: false, status: 0, type: "" }; }
};

/** The site-wide discovery probes. These are per-ORIGIN, so they run once. */
async function probeDeclared() {
  const [llms, card, mcpCard, sitemap] = await Promise.all([
    head(`${ORIGIN}/llms.txt`),
    head(`${ORIGIN}/.well-known/agent-card.json`),
    head(`${ORIGIN}/.well-known/mcp/server-card.json`),
    head(`${ORIGIN}/sitemap.xml`),
  ]);
  let mcp = false;
  try {
    const r = await fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { protocolVersion: "2026-07-28", clientCapabilities: {} } }),
    });
    const j = await r.json();
    mcp = Array.isArray(j?.result?.tools) && j.result.tools.length > 0;
  } catch { mcp = false; }

  let robotsAllowsAgents = null;
  try {
    const r = await fetch(`${ORIGIN}/robots.txt`);
    if (r.ok) {
      const t = await r.text();
      // A crude but honest read: a global disallow-everything with no allow.
      robotsAllowsAgents = !/^\s*disallow:\s*\/\s*$/im.test(t) || /^\s*allow:/im.test(t);
    }
  } catch { /* leave null: unread is not the same as hostile */ }

  return { llmsTxt: llms.ok, agentCard: card.ok && mcpCard.ok, mcp, sitemap: sitemap.ok, robotsAllowsAgents };
}

/** Evidence one engine produces for one URL. */
async function renderOnce(page, url) {
  const errs = [];
  const onConsole = (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); };
  const onPageError = (e) => errs.push("pageerror: " + String(e).slice(0, 160));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const r = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    // The shell wires itself in a rAF pass, so a load event is too early to
    // judge whether it finished. This is the same reason the speculation probe
    // dwells rather than sampling immediately.
    await page.waitForTimeout(1500);
    const dom = await page.evaluate(() => {
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const imgs = [...document.querySelectorAll("img")];
      const win = document.querySelector(".window,.np-window");
      const maxBtn = document.querySelector(".max");
      // A behavioural probe, because "the script threw" and "the page is fine"
      // are not mutually exclusive and the difference is what a user touches.
      let maximize = "absent";
      if (maxBtn && win) {
        const before = win.classList.contains("axp-max");
        maxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const moved = win.classList.contains("axp-max") !== before;
        if (moved) maxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        maximize = moved ? "wired" : "dead";
      }
      return {
        words: txt.split(/\s+/).filter(Boolean).length,
        totalImages: imgs.length,
        brokenImages: imgs.filter((i) => i.naturalWidth === 0).length,
        // Three states, not two. alt="" is a DECISION (this image is
        // decorative) and a missing alt attribute is an omission; collapsing
        // them scores correct markup as a defect.
        imagesWithAlt: imgs.filter((i) => (i.getAttribute("alt") || "").trim().length > 0).length,
        imagesDecorative: imgs.filter((i) => i.hasAttribute("alt") && !(i.getAttribute("alt") || "").trim()).length,
        imagesMissingAlt: imgs.filter((i) => !i.hasAttribute("alt")).length,
        brokenSrc: imgs.filter((i) => i.naturalWidth === 0).map((i) => (i.currentSrc || i.src || "").split("/").pop()).slice(0, 4),
        maximize,
      };
    });
    return { status: r?.status() ?? 0, ...dom, consoleErrors: errs.length, errors: [...new Set(errs)].slice(0, 4) };
  } catch (e) {
    return { status: 0, failed: String(e).slice(0, 200), consoleErrors: errs.length, errors: errs.slice(0, 4) };
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

async function main() {
  let routes = SAMPLE;
  if (WANT_ALL) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, "config/site-manifest.json"), "utf8"));
    routes = manifest.surfaces.filter((s) => s.kind === "page" && s.path.startsWith("/")).map((s) => s.path);
  }

  log(`agent readiness: ${ORIGIN}, ${routes.length} route(s), engine Kitesurf (free public playground)`);
  log(WANT_CONTROL ? "control: local Chrome, same script\n" : "control: NOT RUN (pass --control before trusting any Kitesurf-only defect)\n");

  const declared = await probeDeclared();

  // One browser, one context, one page, navigated in turn. Playwright asserts
  // "Duplicate target" against Kitesurf if you open a context per URL, and
  // ctx.newCDPSession() trips the same assert, so screenshots need raw CDP.
  // Reusing one page avoids both and is faster anyway.
  const kite = await chromium.connectOverCDP(KITESURF_WS);
  const kctx = kite.contexts()[0] || (await kite.newContext());
  const kpage = kctx.pages()[0] || (await kctx.newPage());
  await kpage.setViewportSize({ width: 1280, height: 900 });

  let cbrowser = null;
  let cpage = null;
  if (WANT_CONTROL) {
    cbrowser = await chromium.launch({ channel: "chrome", headless: true });
    cpage = await (await cbrowser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  }

  const rows = [];
  let failures = 0;

  for (const route of routes) {
    const url = `${ORIGIN}${route}`;
    const raw = await fetch(url).then((r) => r.text()).catch(() => "");
    const k = await renderOnce(kpage, url);
    const c = cpage ? await renderOnce(cpage, url) : null;

    // The Markdown twin is the one discovery surface that is PER ROUTE, so it
    // is probed here rather than with the site-wide four. `/` publishes its
    // hand-written twin at /index.md; everything else appends .md.
    const twinUrl = route === "/" ? `${ORIGIN}/index.md` : `${ORIGIN}${route.replace(/\/$/, "")}.md`;
    const twin = await head(twinUrl);

    // The SAME two checks /lens scores, off the same module. This CLI
    // deliberately publishes no overall score of its own: /lens already owns
    // that number across twenty declared checks plus these two, and a second
    // 0-100 in this repo would be two definitions of one claim.
    const checks = executionChecks({ ran: !k.failed, engine: "kitesurf", ...k });
    const hw = httpWords(raw);
    const legible = k.words ? Math.round((Math.min(hw, k.words) / k.words) * 100) : null;

    // A defect COUNTS only when the control disagrees, or when no control ran
    // and the failure is unambiguous (a broken image is a decode result, not an
    // instrument artefact). A script error with a clean Chrome control is the
    // strongest signal this script produces.
    const notes = [];
    if (k.failed) notes.push(`navigation failed: ${k.failed}`);
    if (k.consoleErrors) notes.push(c && c.consoleErrors === 0 ? `${k.consoleErrors} script error(s), Chrome control CLEAN` : `${k.consoleErrors} script error(s)${c ? ", control also errored" : ", no control"}`);
    if (k.brokenImages) notes.push(c && c.brokenImages === 0 ? `${k.brokenImages}/${k.totalImages} images failed to decode, Chrome control decoded all` : `${k.brokenImages}/${k.totalImages} images failed to decode`);
    if (k.maximize === "dead") notes.push(c && c.maximize === "wired" ? "window controls DEAD, wired in Chrome control" : "window controls dead");

    const bad = Boolean(k.failed) || checks.agentScripts.status === "fail" || checks.agentMedia.status === "fail";
    if (bad) failures += 1;
    const twinOk = twin.ok && /markdown/.test(twin.type);
    if (!twinOk) notes.push("no Markdown twin at " + twinUrl.replace(ORIGIN, ""));
    rows.push({ route, checks, kitesurf: k, control: c, notes, bad, legible, twin: twinOk, declared });

    if (!WANT_JSON) {
      const status = [checks.agentScripts, checks.agentMedia].map((x) => x.status[0].toUpperCase()).join("");
      console.log(`${bad ? "FAIL" : "ok  "}  ${route.padEnd(18)} scripts:${checks.agentScripts.status.padEnd(7)} media:${checks.agentMedia.status.padEnd(7)} legible:${legible === null ? "?" : legible + "%"}${twinOk ? "" : "  no-twin"}`);
      void status;
      for (const n of notes) console.log(`        ${n}`);
      if (k.brokenSrc?.length) console.log(`        first broken: ${k.brokenSrc.join(", ")}`);
      for (const e of k.errors || []) console.log(`        ${e}`);
    }
  }

  await kite.close();
  if (cbrowser) await cbrowser.close();

  if (WANT_JSON) {
    console.log(JSON.stringify({ origin: ORIGIN, declared, rows }, null, 2));
    process.exit(failures ? 1 : 0);
  }

  const scriptFails = rows.filter((r) => r.checks.agentScripts.status === "fail").length;
  const mediaFails = rows.filter((r) => r.checks.agentMedia.status === "fail").length;
  const noTwin = rows.filter((r) => !r.twin).length;
  console.log(`\n${rows.length} route(s): ${scriptFails} with script failures, ${mediaFails} with undecodable media, ${noTwin} with no Markdown twin`);
  console.log(`declared surfaces: llms.txt ${declared.llmsTxt ? "yes" : "NO"}, agent card ${declared.agentCard ? "yes" : "NO"}, MCP ${declared.mcp ? "yes" : "NO"}, sitemap ${declared.sitemap ? "yes" : "NO"}`);
  console.log("\nthe /lens Agent-ready? tab scores these same two checks, plus twenty declared ones, for any URL.");
  console.log(failures ? `\n${failures} route(s) with a real defect. See the notes above.` : "\nno defects on any route.");
  process.exit(failures ? 1 : 0);
}

// Guarded so the contract suite can import httpWords without launching a browser
// and scanning production. The behavioural test is the point: an earlier version
// of this stripper passed a source-shape assertion while still leaking script
// bodies into the word count.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
  });
}
