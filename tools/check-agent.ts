// check-agent.mjs — is this site agent-accessible IN PRACTICE?
//
// ── the control, and why it is not optional in spirit ─────────────────────
// gotcha 15 and gotcha 33 in CLAUDE.md are both the same lesson learned the
// expensive way: an instrument that reports a browser feature as missing is
// usually broken itself. A Playwright harness reported Cloudflare's own origin
// as ignoring Early Hints, and an agent-driven tab reported a working
// speculation rule as dead. So a Kitesurf-only defect means nothing until the
// identical script passes in Chrome. `--control` runs it and prints the
// comparison; without the flag the report says the control did not run rather
// than implying one did.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { chromeChannel } from "./lib/browser-channel.ts";

import { executionChecks } from "../src/worker/lib/agent-execution.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ORIGIN = process.env.AGENT_CHECK_ORIGIN || "https://aadhar.sh";
const KITESURF_WS = "wss://kitesurf.cloudflare.app/devtools/browser";

const WANT_ALL = process.argv.includes("--all");
const WANT_CONTROL = process.argv.includes("--control");
const WANT_JSON = process.argv.includes("--json");

const SAMPLE = ["/", "/writing", "/garage", "/garage/horizon", "/lens", "/coffee", "/around"];

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
      robotsAllowsAgents = !/^\s*disallow:\s*\/\s*$/im.test(t) || /^\s*allow:/im.test(t);
    }
  } catch {}

  return { llmsTxt: llms.ok, agentCard: card.ok && mcpCard.ok, mcp, sitemap: sitemap.ok, robotsAllowsAgents };
}

async function renderOnce(page, url) {
  const errs = [];
  const onConsole = (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); };
  const onPageError = (e) => errs.push("pageerror: " + String(e).slice(0, 160));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    const r = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const dom = await page.evaluate(() => {
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const imgs = [...document.querySelectorAll("img")];
      const win = document.querySelector(".window,.np-window");
      const maxBtn = document.querySelector(".max");
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
    cbrowser = await chromium.launch({ channel: chromeChannel(), headless: true });
    cpage = await (await cbrowser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  }

  const rows = [];
  let failures = 0;

  for (const route of routes) {
    const url = `${ORIGIN}${route}`;
    const raw = await fetch(url).then((r) => r.text()).catch(() => "");
    const k = await renderOnce(kpage, url);
    const c = cpage ? await renderOnce(cpage, url) : null;

    const twinUrl = route === "/" ? `${ORIGIN}/index.md` : `${ORIGIN}${route.replace(/\/$/, "")}.md`;
    const twin = await head(twinUrl);

    const checks = executionChecks({ ran: !k.failed, engine: "kitesurf", ...k });
    const hw = httpWords(raw);
    const legible = k.words ? Math.round((Math.min(hw, k.words) / k.words) * 100) : null;

    const notes: string[] = [];
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

if (import.meta.main) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
  });
}
