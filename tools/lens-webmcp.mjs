#!/usr/bin/env node
// Probe a URL in a Cloudflare Browser Run Chrome-beta lab session.
//
// This is intentionally a local/owner workflow. Browser Run's lab pool is
// experimental and is not currently available through the Workers browser
// binding. The script discovers WebMCP tools without executing them, prints a
// short-lived Live View URL, and closes the session unless --keep-open is set.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { wranglerCommand } from "./lib/wrangler-bin.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const keepOpen = args.includes("--keep-open");
const target = args.find((arg) => !arg.startsWith("--"));
const keepAlive = Number((args.find((arg) => arg.startsWith("--keep-alive=")) || "").split("=")[1] || 300);

if (!target) fail("Usage: node tools/lens-webmcp.mjs https://example.com [--keep-open] [--keep-alive=300]");
let url;
try { url = new URL(target); }
catch { fail("Target must be an absolute http(s) URL."); }
if (!/^https?:$/.test(url.protocol)) fail("Target must use http or https.");
if (!Number.isInteger(keepAlive) || keepAlive < 60 || keepAlive > 600) fail("--keep-alive must be an integer from 60 to 600 seconds.");

let sessionId = null;
try {
  const created = await createSession(keepAlive);
  sessionId = created.sessionId;
  const targetInfo = (created.targets || []).find((item) => item.type === "page") || created.targets?.[0];
  if (!targetInfo?.webSocketDebuggerUrl) fail("Browser Run created a session without a page target.");

  const webmcp = await probePage(targetInfo.webSocketDebuggerUrl, url.toString());
  const report = {
    ok: true,
    target: url.toString(),
    sessionId,
    liveView: targetInfo.devtoolsFrontendUrl || null,
    webmcp,
    keptOpen: keepOpen,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  fail(error && error.message ? error.message : String(error));
} finally {
  if (sessionId && !keepOpen) {
    try { await execFileAsync(...wranglerCommand(["browser", "close", sessionId]), { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 }); }
    catch (error) { process.stderr.write("Could not close Browser Run session " + sessionId + ": " + (error.message || error) + "\n"); }
  }
}

async function createSession(seconds) {
  const { stdout } = await execFileAsync(...wranglerCommand([
    "browser", "create", "--lab", "--keepAlive", String(seconds), "--open", "false", "--json",
  ]), { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Wrangler did not return Browser Run session JSON.");
  return JSON.parse(stdout.slice(start, end + 1));
}

async function probePage(wsUrl, targetUrl) {
  const cdp = await connectCdp(wsUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const load = waitForEvent(cdp, "Page.loadEventFired", 12000);
    await cdp.send("Page.navigate", { url: targetUrl });
    await load;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const evaluated = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => (async () => {
        const api = navigator.modelContextTesting;
        if (!api || typeof api.listTools !== "function") {
          return { status: "unavailable", detail: "navigator.modelContextTesting.listTools() is unavailable." };
        }
        try {
          const tools = await api.listTools();
          return { status: "available", tools: Array.isArray(tools) ? tools : [] };
        } catch (error) {
          return { status: "error", detail: String(error && error.message || error) };
        }
      })())()`,
    });
    if (evaluated.exceptionDetails) return { status: "error", detail: "Runtime evaluation failed." };
    return evaluated.result?.result?.value || { status: "unavailable", detail: "No runtime result returned." };
  } finally {
    cdp.close();
  }
}

function waitForEvent(cdp, method, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cdp.removeListener(method, onEvent); resolve(undefined); }, timeoutMs);
    function onEvent(value) {
      clearTimeout(timer);
      cdp.removeListener(method, onEvent);
      resolve(value);
    }
    cdp.addListener(method, onEvent);
  });
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to the Browser Run CDP target.")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "CDP command failed."));
      else resolve(message);
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params);
    }
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    addListener(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
    },
    removeListener(method, listener) {
      listeners.get(method)?.delete(listener);
    },
    close() {
      for (const { reject } of pending.values()) reject(new Error("CDP connection closed."));
      pending.clear();
      socket.close();
    },
  };
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
  throw new Error(message);
}
