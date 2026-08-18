#!/usr/bin/env node
// lens-seed.mjs — render the /lens demo URLs on THIS machine and write the
// results into the same KV entries Browser Run would have filled.
//
// WHY THIS EXISTS, and how it differs from lens-warm.mjs. That script spends the
// budget early by performing real Browser Run calls ahead of an audience, which
// is the right tool and the first one to reach for. It cannot help once the
// account-wide allowance is gone: 10 browser-minutes a day, shared across
// /lens/shot, /lens/browser and /lens/wire, resetting at 00:00 UTC. A demo that
// lands after that ceiling has no budget left to spend early.
//
// So this drives real headless Chrome locally (playwright-core, channel chrome,
// the same launch the OG-card generator uses), captures the same four formats
// the Quick Action returns, and writes them to the same cache keys. The demo
// then reads from KV and bills nothing.
//
// WHAT IS AND IS NOT BEING FAKED, because this is /lens and that distinction is
// the whole product. Every byte here comes from a real browser really loading
// the real URL. What changes is WHERE the browser ran: a workstation rather than
// Cloudflare's edge. That is a difference the reader can see, because the
// snapshot carries `engine: "chromium-local-capture"` and the pane prints the
// engine under every comparison it draws. Nothing claims to be a fresh Browser
// Run: the server already labels a cache read as "KV cache". Do not relabel
// these as chromium-binding to make the caption tidier.
//
// Two fields are honestly derived rather than captured, and both are marked:
// `markdown` comes from this repo's own HTML-to-Markdown converter run over the
// RENDERED DOM (Browser Run makes its own, and we have no way to ask for it),
// and `accessibilityTree` is rebuilt from CDP's flat AX node list.
//
//   node tools/lens-seed.mjs --dry-run     # capture, write nothing, print sizes
//   node tools/lens-seed.mjs               # capture and seed production KV
//   node tools/lens-seed.mjs --ttl 43200   # shorter life than the 24h default
//   node tools/lens-seed.mjs https://foo/  # specific URLs instead of the chips
//
// TO UNDO, delete the keys it prints, or wait out the TTL. The site returns to
// live Browser Run renders the moment these expire, which is why the TTL is a
// day and not a week: a stale local capture outliving the outage it covered is
// the failure mode to avoid.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { lensChipTargets } from "./lib/lens-chips.mjs";
import { readDocument } from "./lib/html-to-md.mjs";
import { documentTally } from "../src/worker/lens-render.ts";
import { WIRE_TIMING, summariseWire } from "../src/worker/lens-wire.ts";
import { BOT_UA } from "../src/worker/lib/botauth.ts";
import { EXECUTION_PROBE } from "../src/worker/lib/agent-execution.ts";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const DRY = has("--dry-run");
const ORIGIN = (valueOf("--origin", "https://aadhar.sh") || "").replace(/\/+$/, "");
const NAMESPACE = valueOf("--namespace-id", "3cb8a107c58e47dc9244e75b33401f36"); // RN_KV, wrangler.jsonc
const TTL = Number(valueOf("--ttl", "86400"));
const SHOTS = !has("--no-shot");
const WIRE = !has("--no-wire");

// Mirrors LENS_GOTO and the Quick Action payload in src/worker/lens.ts. The
// viewport matters more than it looks: a different width renders a different
// page, and the whole pane is a comparison.
const VIEWPORT = { width: 1280, height: 800 };
const GOTO_MS = 18_000;

// The server's own ceilings, applied here so a capture cannot produce a payload
// the live route would have refused to build.
const CONTENT_MAX = 120_000;
const MARKDOWN_MAX = 60_000;
const SHOT_MAX = 6_000_000;      // base64 chars, LENS_BROWSER_SHOT_MAX
const KV_MAX = 20_000_000;       // LENS_BROWSER_KV_MAX
// Not a server limit. CDP hands back every node in the tree and a news homepage
// runs to tens of thousands, which serves nobody inside a <pre>.
const AX_NODE_MAX = 4_000;

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const short = (u) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

// CDP returns a FLAT node list with parent pointers. Rebuild the nested
// {role, name, children} shape the pane walks, dropping ignored nodes but
// keeping their children, so a wrapper marked ignored does not orphan a subtree.
function axTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const kids = new Map();
  let root = null;
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId).push(n);
    } else if (!root) root = n;
  }
  let budget = AX_NODE_MAX;
  const convert = (node) => {
    const children = [];
    for (const child of kids.get(node.nodeId) || []) {
      if (budget <= 0) break;
      const built = child.ignored ? null : convert(child);
      if (built) children.push(built);
      else for (const hoisted of convert(child).children || []) children.push(hoisted);
    }
    budget--;
    const out = { role: node.role?.value ?? "unknown" };
    const name = node.name?.value;
    if (name) out.name = name;
    if (children.length) out.children = children;
    return out;
  };
  return root ? convert(root) : null;
}

// The Wire tab, and the reason this is not a second reimplementation. /lens/wire
// drives raw CDP over the Browser Run binding, and its whole payload is built by
// summariseWire(events, url) from the events that session collected. Those events
// are ordinary CDP frames, so a local session produces the same ones and the
// PRODUCTION summariser turns them into the payload.
//
// That is worth the plumbing: the summariser owns real judgement calls (a
// loadingFailed carrying a status is `aborted` rather than `failed`, wire bytes
// come off loadingFinished and not off the response, a redirect is a second
// requestWillBeSent on one id), and a hand-rolled copy here would drift from all
// three silently. Nothing about the shape is being guessed.
//
// Playwright's CDPSession emits per method rather than a wildcard, so the list
// below is explicit. It carries everything summariseWire switches on plus the
// two error channels the execution probe reads.
const WIRE_EVENTS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.requestServedFromCache",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
];

async function captureWire(browser, url) {
  const context = await browser.newContext({ userAgent: BOT_UA, viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const started = Date.now();
  try {
    const cdp = await context.newCDPSession(page);
    const events = [];
    for (const method of WIRE_EVENTS) cdp.on(method, (params) => events.push({ method, params }));
    // Enabled BEFORE the navigation, or the whole point of the lens (what the
    // page asked for on its way up) is already over by the time we are listening.
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    let loadFired = true;
    try {
      await page.goto(url, { waitUntil: "load", timeout: WIRE_TIMING.navigateMs });
    } catch (e) {
      if (!/Timeout/i.test(e.message)) throw e;
      // A page that never fires load is a real page with a real waterfall, and
      // the route reports it rather than throwing the observation away. Same here.
      loadFired = false;
    }
    // The settle window is what catches the analytics beacons that fire ON load,
    // which are most of what this lens exists to show.
    await new Promise((r) => setTimeout(r, WIRE_TIMING.settleAfterLoadMs));

    let execution = null;
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: EXECUTION_PROBE, returnByValue: true, awaitPromise: false });
  // CDP frame off the wire; this script is a one-shot seeder outside the Worker
  // bundle, so it carries the check inline rather than importing the parse layer.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
      const raw = r?.result && typeof r.result.value === "string" ? JSON.parse(r.result.value) : null;
      if (raw && !raw.probeError) {
        const thrown = events.filter((e) => e.method === "Runtime.exceptionThrown");
        const logged = events.filter((e) => e.method === "Log.entryAdded" && e.params?.entry?.level === "error");
        const first = thrown[0]
          ? String(thrown[0].params?.exceptionDetails?.text || "").slice(0, 120)
          : logged[0] ? String(logged[0].params.entry.text || "").slice(0, 120) : "";
        execution = { ran: true, engine: "chromium-local-cdp", pageErrors: thrown.length, consoleErrors: logged.length, firstError: first || undefined, ...raw };
      }
    } catch { /* no execution evidence is null, never a zero that reads as a clean page */ }

    return {
      ok: true,
      url,
      fetchedBy: "Local headless Chrome over CDP (Cloudflare Browser Run budget exhausted)",
      engine: "chromium-local-cdp",
      navMs: Date.now() - started,
      loadFired,
      identifiedAs: BOT_UA,
      execution,
      capturedAt: new Date().toISOString(),
      ...summariseWire(events, url),
    };
  } finally {
    await context.close();
  }
}

async function capture(browser, url) {
  const context = await browser.newContext({ userAgent: BOT_UA, viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const started = Date.now();
  try {
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: "networkidle", timeout: GOTO_MS });
    } catch (e) {
      // networkidle never settles on a page holding a socket open, which is most
      // news sites. A load-state fallback is what Browser Run's networkidle2
      // effectively degrades to, and a captured page beats a refused one.
      if (!/Timeout/i.test(e.message)) throw e;
      response = await page.goto(url, { waitUntil: "load", timeout: GOTO_MS }).catch(() => null);
    }

    const content = await page.content();
    const title = await page.title().catch(() => "");
    const finalUrl = page.url() || url;

    let tree = null;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Accessibility.enable");
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      tree = axTree(nodes || []);
    } catch { /* a tree we could not build is absent, never invented */ }

    const png = SHOTS ? await page.screenshot({ fullPage: true, type: "png" }).catch(() => null) : null;
    const b64 = png ? png.toString("base64") : "";
    const shotTooBig = b64.length > SHOT_MAX;

    // The site's own converter, over the RENDERED DOM rather than the HTTP body.
    // That is the axis the pane cares about, and it is why this is not simply
    // the Markdown twin of the same URL.
    let markdown = "";
    try { markdown = (readDocument(content, { origin: new URL(finalUrl).origin }).body || ""); } catch { /* leave empty */ }

    return {
      ok: true,
      url,
      finalUrl,
      status: response ? response.status() : null,
      title,
      content: content.slice(0, CONTENT_MAX),
      contentTruncated: content.length > CONTENT_MAX,
      markdown: markdown.slice(0, MARKDOWN_MAX),
      accessibilityTree: tree,
      screenshot: b64 && !shotTooBig ? "data:image/png;base64," + b64 : null,
      screenshotDropped: shotTooBig ? Math.round(b64.length * 0.75) : 0,
      webmcp: { status: "lab-required", detail: "Runtime WebMCP listing requires the local Browser Run Chrome-beta lab. Use tools/lens-webmcp.mjs." },
      // Both of these are read by a human deciding how much to trust the pane, so
      // neither one pretends this came off the edge.
      fetchedBy: "Local headless Chrome (Cloudflare Browser Run budget exhausted)",
      engine: "chromium-local-capture",
      capturedAt: new Date().toISOString(),
      tally: documentTally(content),
      tallyTruncated: content.length > CONTENT_MAX,
      elapsedMs: Date.now() - started,
      _png: png,
    };
  } finally {
    await context.close();
  }
}

// THE KEY MUST HASH WHAT THE PANE WILL ASK FOR, which is not always what you
// typed. The Browser pane requests /lens/browser with the HTTP scan's
// `finalUrl`, so a URL that redirects lands on a different cache key than its
// chip, and the seed silently misses every time. Ask the live scan instead of
// reasoning about it: /lens/fetch is rate-limited 30/min and spends no browser
// budget, so this costs nothing that matters.
//
// Falls back to the input when the scan is unreachable, since a key derived
// from the typed URL is right far more often than it is wrong.
async function keyUrl(url) {
  try {
    const res = await fetch(`${ORIGIN}/lens/fetch?url=${encodeURIComponent(url)}`, {
      headers: { "user-agent": "lens-seed (workstation)" },
    });
    const body = await res.json();
    if (body && body.ok !== false && (body.finalUrl || body.url)) return body.finalUrl || body.url;
  } catch { /* fall through */ }
  return url;
}

function kvPut(key, file, label) {
  const argv = ["x", "--no-install", "wrangler", "kv", "key", "put", key, "--path", file,
    "--namespace-id", NAMESPACE, "--remote", "--ttl", String(TTL)];
  execFileSync("bun", argv, { stdio: ["ignore", "ignore", "inherit"] });
  process.stdout.write(`      wrote ${label} -> ${key}\n`);
}

const urls = args.filter((a) => /^https?:\/\//.test(a));
const targets = urls.length ? urls : lensChipTargets();

console.log(`${DRY ? "capturing (dry run)" : "capturing and seeding"} ${targets.length} URL(s)`);
console.log(`engine label: chromium-local-capture${DRY ? "" : `  ttl: ${TTL}s (${(TTL / 3600).toFixed(0)}h)  namespace: ${NAMESPACE}`}\n`);

const scratch = mkdtempSync(join(tmpdir(), "lens-seed-"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars"] });
let failed = 0;

try {
  for (const url of targets) {
    // Resolved BEFORE the capture, so the browser renders the same resource the
    // key names and the two cannot disagree.
    const target = await keyUrl(url);
    process.stdout.write(`  ${short(target).padEnd(38)}`);
    let snap;
    try {
      snap = await capture(browser, target);
    } catch (e) {
      failed++;
      process.stdout.write(`FAILED  ${(e && e.message) || e}\n`);
      continue;
    }
    const png = snap._png;
    delete snap._png;
    const json = JSON.stringify(snap);
    const words = snap.tally ? snap.tally.words : 0;
    process.stdout.write(`${String(snap.status ?? "?").padEnd(4)} ${String(words).padStart(6)} words  ${bytes(json.length).padStart(9)}  ${snap.elapsedMs} ms\n`);

    if (json.length > KV_MAX) {
      failed++;
      process.stdout.write(`      SKIPPED: ${bytes(json.length)} is over the ${bytes(KV_MAX)} KV ceiling the live route enforces.\n`);
      continue;
    }
    if (DRY) {
      if (WIRE) {
        try {
          const wire = await captureWire(browser, target);
          process.stdout.write(`      wire: ${wire.requests} reqs, ${bytes(wire.bytes)}, ${wire.hostTotal} hosts, ${wire.thirdParty.bytesPct}% third-party\n`);
        } catch (e) { process.stdout.write(`      wire FAILED: ${(e && e.message) || e}\n`); failed++; }
      }
      continue;
    }

    const hash = sha256(target);
    const jsonFile = join(scratch, `${hash}.json`);
    writeFileSync(jsonFile, json);
    kvPut(`lens:browser:${hash}`, jsonFile, "render");
    if (png) {
      const pngFile = join(scratch, `${hash}.png`);
      writeFileSync(pngFile, png);
      kvPut(`lens:shot:${hash}`, pngFile, `shot (${bytes(png.length)})`);
    }

    // A SECOND page load, deliberately. The render capture above reads the page
    // after JavaScript; the wire capture watches it being assembled, and the two
    // want different instrumentation on the session from the first byte. Reusing
    // one load would mean enabling Network for a capture that does not read it
    // and settling for one that does.
    if (WIRE) {
      try {
        const wire = await captureWire(browser, target);
        const wireFile = join(scratch, `${hash}.wire.json`);
        writeFileSync(wireFile, JSON.stringify(wire));
        kvPut(`lens:wire:${hash}`, wireFile,
          `wire (${wire.requests} reqs, ${bytes(wire.bytes)}, ${wire.thirdParty.bytesPct}% third-party)`);
      } catch (e) {
        // The render is the load-bearing half and it is already seeded. A wire
        // capture that fails costs one tab, not the URL.
        process.stdout.write(`      wire FAILED: ${(e && e.message) || e}\n`);
        failed++;
      }
    }
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? `\nall ${targets.length} URL(s) captured${DRY ? "" : " and seeded"}.`
    : `\n${failed} of ${targets.length} URL(s) did not complete.`,
);
if (!DRY) console.log(`entries live ${(TTL / 3600).toFixed(0)}h. After that /lens goes back to live Browser Run renders.`);
process.exit(failed === 0 ? 0 : 1);
