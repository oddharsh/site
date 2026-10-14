#!/usr/bin/env node
// lens-seed.mjs — render the /lens demo URLs on THIS machine and write the
// results into the same KV entries Browser Run would have filled.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromeChannel } from "./lib/browser-channel.ts";
import { cf } from "./lib/cf.ts";
import { lensChipTargets } from "./lib/lens-chips.ts";
import { asText } from "../src/worker/lib/parse.ts";
import { readDocument } from "./lib/html-to-md.ts";
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
const NAMESPACE = valueOf("--namespace-id", "3cb8a107c58e47dc9244e75b33401f36");
const TTL = Number(valueOf("--ttl", "86400"));
const SHOTS = !has("--no-shot");
const WIRE = !has("--no-wire");

const VIEWPORT = { width: 1280, height: 800 };
const GOTO_MS = 18_000;

const CONTENT_MAX = 120_000;
const MARKDOWN_MAX = 60_000;
const SHOT_MAX = 6_000_000;
const KV_MAX = 20_000_000;
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
  const convert = (node): { role: any; name?: any; children?: any[] } => {
    const children: any[] = [];
    for (const child of kids.get(node.nodeId) || []) {
      if (budget <= 0) break;
      const built = child.ignored ? null : convert(child);
      if (built) children.push(built);
      else for (const hoisted of convert(child).children || []) children.push(hoisted);
    }
    budget--;
    const out: { role: any; name?: any; children?: any[] } = { role: node.role?.value ?? "unknown" };
    const name = node.name?.value;
    if (name) out.name = name;
    if (children.length) out.children = children;
    return out;
  };
  return root ? convert(root) : null;
}

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
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    let loadFired = true;
    try {
      await page.goto(url, { waitUntil: "load", timeout: WIRE_TIMING.navigateMs });
    } catch (e) {
      if (!/Timeout/i.test(e.message)) throw e;
      loadFired = false;
    }
    await new Promise((r) => setTimeout(r, WIRE_TIMING.settleAfterLoadMs));

    let execution = null;
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: EXECUTION_PROBE, returnByValue: true, awaitPromise: false });
      const value = asText(r?.result?.value);
      const raw = value === null ? null : JSON.parse(value);
      if (raw && !raw.probeError) {
        const thrown = events.filter((e) => e.method === "Runtime.exceptionThrown");
        const logged = events.filter((e) => e.method === "Log.entryAdded" && e.params?.entry?.level === "error");
        const first = thrown[0]
          ? String(thrown[0].params?.exceptionDetails?.text || "").slice(0, 120)
          : logged[0] ? String(logged[0].params.entry.text || "").slice(0, 120) : "";
        execution = { ran: true, engine: "chromium-local-cdp", pageErrors: thrown.length, consoleErrors: logged.length, firstError: first || undefined, ...raw };
      }
    } catch {}

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
    } catch {}

    const png = SHOTS ? await page.screenshot({ fullPage: true, type: "png" }).catch(() => null) : null;
    const b64 = png ? png.toString("base64") : "";
    const shotTooBig = b64.length > SHOT_MAX;

    let markdown = "";
    try { markdown = (readDocument(content, { origin: new URL(finalUrl).origin }).body || ""); } catch {}

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
      webmcp: { status: "lab-required", detail: "Runtime WebMCP listing requires the local Browser Run Chrome-beta lab. Use tools/lens-webmcp.ts." },
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

async function keyUrl(url) {
  try {
    const res = await fetch(`${ORIGIN}/lens/fetch?url=${encodeURIComponent(url)}`, {
      headers: { "user-agent": "lens-seed (workstation)" },
    });
    const body = await res.json();
    if (body && body.ok !== false && (body.finalUrl || body.url)) return body.finalUrl || body.url;
  } catch {}
  return url;
}

async function kvPut(key, file, label) {
  await cf(["kv", "keys", "put", key, "--namespace-id", NAMESPACE,
    "--expiration-ttl", String(TTL), "--file", file]);
  process.stdout.write(`      wrote ${label} -> ${key}\n`);
}

const urls = args.filter((a) => /^https?:\/\//.test(a));
const targets = urls.length ? urls : lensChipTargets();

console.log(`${DRY ? "capturing (dry run)" : "capturing and seeding"} ${targets.length} URL(s)`);
console.log(`engine label: chromium-local-capture${DRY ? "" : `  ttl: ${TTL}s (${(TTL / 3600).toFixed(0)}h)  namespace: ${NAMESPACE}`}\n`);

const scratch = mkdtempSync(join(tmpdir(), "lens-seed-"));
const browser = await chromium.launch({ channel: chromeChannel(), headless: true, args: ["--hide-scrollbars"] });
let failed = 0;

try {
  for (const url of targets) {
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
    await kvPut(`lens:browser:${hash}`, jsonFile, "render");
    if (png) {
      const pngFile = join(scratch, `${hash}.png`);
      writeFileSync(pngFile, png);
      await kvPut(`lens:shot:${hash}`, pngFile, `shot (${bytes(png.length)})`);
    }

    if (WIRE) {
      try {
        const wire = await captureWire(browser, target);
        const wireFile = join(scratch, `${hash}.wire.json`);
        writeFileSync(wireFile, JSON.stringify(wire));
        await kvPut(`lens:wire:${hash}`, wireFile,
          `wire (${wire.requests} reqs, ${bytes(wire.bytes)}, ${wire.thirdParty.bytesPct}% third-party)`);
      } catch (e) {
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
