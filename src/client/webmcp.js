// webmcp.js — first-party WebMCP registration for this origin.
//
// Until now the site's browser-local tool catalog came entirely from the edge:
// Cloudflare injects `/.webmcp/bridge.js`, which reads `/mcp` and registers what
// it finds into `document.modelContext`. That was free and it is no longer
// enough, for three measured reasons (Chrome 152, 2026-08-25):
//
// 1. IT IS OFF ON THE HOMEPAGE. `/` registers 0 tools while `/whoareyou`
//    registers 25, on the same injected tag. The homepage navigation reconstructs
//    from a dcz delta (transferSize 300, decodedBodySize 37769 against an origin
//    body of 37831) and the injected script is in the 62 bytes that go missing,
//    because HTMLRewriter at the edge cannot rewrite a zstd delta. Gotcha 20
//    inverted: there, an edge rewrite invalidated something derived from the
//    Worker; here a Worker feature silently deletes the edge rewrite. It fails
//    on returning visitors, on the busiest page, with nothing logged.
//
// 2. THE BROWSER DROPS MOST ANNOTATIONS, which the earlier note in this repo
//    blamed on the bridge. Measured by passing all five and reading them back:
//    `readOnlyHint` survives, `destructiveHint`, `idempotentHint`,
//    `openWorldHint` and `title` are discarded, and Chrome adds
//    `untrustedContentHint`, which is not an MCP annotation at all. So the
//    decoration in lib/mcp-tools.ts cannot reach a page-driven agent, and
//    `representation_capture` (which INSERTs a D1 row) is indistinguishable from
//    `now_playing`. There is no standard channel that says "this one writes".
//
// 3. A SERVER REGISTRY CANNOT HOLD A PAGE TOOL. Everything the bridge registers
//    would work identically as a plain HTTP endpoint with no browser involved.
//    The tools worth having here read what is on the screen.
//
// So this module owns registration instead, and carries the safety information
// through the one channel the browser leaves intact: the description text an
// agent actually reads. Where the standard cannot express consent, this asks the
// human directly (see gate() below).
//
// Loaded on idle from nav.js, so it costs nothing on the critical path, and
// deliberately NOT content-hashed: like hoist.js it is reached through an
// `import()` specifier, which the /a/ repointer is attribute-scoped and would
// never rewrite.

/** @type {ModelContext | null} */
const MC = (globalThis.document && globalThis.document.modelContext) || null;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

// ---- the audit log --------------------------------------------------------
//
// A consent dialog somebody answers once and never sees again is a dialog they
// will click through. The log is the other half: what was asked for, what ran,
// and what they refused. It is per-document and in memory on purpose. Nothing
// here is reported anywhere and a reload clears it, because this records what
// an agent did to THIS page in front of THIS person rather than building a
// profile of either.

/** @type {Array<{ name: string, at: number, ms: number, outcome: "ok" | "refused" | "failed", gated: boolean }>} */
const audit = [];
/** @type {Set<() => void>} */
const listeners = new Set();
let registered = 0;
let seq = 0;

function record(name, started, outcome, gated) {
  audit.push({ name, at: started, ms: Date.now() - started, outcome, gated });
  for (const fn of listeners) {
    // A broken listener must never break a tool call. The tray is an observer.
    try { fn(); } catch (error) { /* ignored on purpose */ }
  }
}

/** Is there a WebMCP implementation on this page at all? */
export function available() { return MC !== null; }

/** Every tool call this page has served this session, newest last. */
export function callLog() { return audit.slice(); }

/**
 * Subscribe to registration and to every tool call. Returns an unsubscribe.
 * @param {() => void} fn
 */
export function onActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What the tray reads: the tally, plus the last few calls. */
export function summary() {
  const counted = (outcome) => audit.filter((c) => c.outcome === outcome).length;
  return {
    registered,
    calls: audit.length,
    ok: counted("ok"),
    refused: counted("refused"),
    failed: counted("failed"),
    gated: audit.filter((c) => c.gated).length,
    recent: audit.slice(-6).reverse(),
  };
}

/** The names currently in the browser-local catalog, whoever registered them. */
export async function catalog() {
  if (!MC) return [];
  return (await MC.getTools()).map((t) => t.name);
}

// ---- the annotation channel -------------------------------------------------
//
// Chrome keeps `readOnlyHint` and throws the rest away, so the rest is restated
// as prose on the end of the description. It reads as a sentence to a model and
// it is the only place the information survives. Kept short on purpose: this is
// appended to 25 descriptions and a paragraph each would crowd out the tool.

/**
 * Two different things get called "not read-only" and collapsing them is what
 * would make the gate useless. A page tool that repaints the Lens window really
 * does modify its environment, so `readOnlyHint: false` is the honest annotation
 * for it, and stopping to ask permission for a repaint would train the person to
 * click through the dialog that matters. The line the gate draws is narrower:
 * does the effect OUTLIVE the session and can the person see it happen. A
 * repaint is visible and reversible. A D1 row is neither.
 *
 * @param {Record<string, unknown>} a
 * @param {boolean} writes
 * @returns {string}
 */
function safetyNote(a, writes) {
  const parts = [];
  if (writes) parts.push("WRITES DATA on this origin");
  else if (a.readOnlyHint === false) parts.push("changes what is on the person's screen, and nothing else");
  else parts.push("read-only");
  if (a.destructiveHint === true) parts.push("destructive");
  if (a.idempotentHint === false) parts.push("repeat calls repeat the effect");
  if (a.openWorldHint === true) parts.push("fetches from the public internet");
  const tail = writes ? " This page asks the person to confirm before it runs." : "";
  return " [safety: " + parts.join("; ") + "." + tail + "]";
}

// ---- the consent gate -------------------------------------------------------
//
// The standard has no way to tell an agent a tool is destructive, so it equally
// has no way for an agent to ask about one. That leaves the page as the only
// party in the room able to check, and the person as the only party able to say
// yes. A tool whose annotations say it writes gets a real dialog before it runs.
//
// This is deliberately NOT a `confirm()`. A native confirm is modal to the whole
// tab and gives no room to show what the agent actually asked for, and the
// arguments are the entire question: "capture a representation" is fine and
// "capture a representation of <someone else's URL>" may not be.

/** @type {HTMLDialogElement | null} */
let dialog = null;

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<boolean>}
 */
function gate(name, args) {
  if (!globalThis.document || !document.body) return Promise.resolve(false);
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "webmcp-consent";
    dialog.setAttribute("aria-labelledby", "webmcp-consent-h");
    dialog.style.cssText = "padding:0;border:2px outset #d4d0c8;background:#ece9d8;color:#000;font:11px var(--font-ui,Tahoma,Verdana,sans-serif);max-width:30rem;box-shadow:2px 2px 8px rgba(0,0,0,.4)";
    document.body.appendChild(dialog);
  }
  const d = dialog;
  let body = "";
  try { body = JSON.stringify(args, null, 1); } catch (e) { body = String(args); }
  d.innerHTML = "";
  const wrap = document.createElement("div");
  const bar = document.createElement("div");
  bar.id = "webmcp-consent-h";
  bar.textContent = "An agent wants to change something";
  bar.style.cssText = "background:linear-gradient(#3f8bdc,#2d78bd);color:#fff;font-weight:700;padding:4px 8px";
  const inner = document.createElement("div");
  inner.style.cssText = "padding:10px 12px";
  const p = document.createElement("p");
  p.style.cssText = "margin:0 0 8px";
  p.textContent = "The tool " + name + " writes data on aadhar.sh. WebMCP has no way to tell your agent that, so this page is asking you instead.";
  const pre = document.createElement("pre");
  pre.textContent = body;
  pre.style.cssText = "margin:0 0 10px;padding:6px;background:#fff;border:1px solid #7f9db9;max-height:9rem;overflow:auto;font:11px var(--font-mono,\"Courier New\",monospace);white-space:pre-wrap;word-break:break-word";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const no = document.createElement("button");
  no.textContent = "Refuse";
  const yes = document.createElement("button");
  yes.textContent = "Allow once";
  for (const b of [no, yes]) b.style.cssText = "min-width:5.5rem;padding:3px 10px;font:11px var(--font-ui,Tahoma,Verdana,sans-serif);border:2px outset #d4d0c8;background:#ece9d8;cursor:pointer";
  row.append(no, yes);
  inner.append(p, pre, row);
  wrap.append(bar, inner);
  d.appendChild(wrap);

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      d.close();
      resolve(ok);
    };
    no.addEventListener("click", () => finish(false));
    yes.addEventListener("click", () => finish(true));
    // Esc, backdrop dismissal, and anything else that closes it all mean no.
    d.addEventListener("close", () => finish(false), { once: true });
    d.showModal();
    no.focus();
  });
}

// ---- registration -----------------------------------------------------------
//
// Four traps live in here, all measured rather than read from a spec:
//
//  - registerTool returns a Promise and REJECTS ASYNCHRONOUSLY, so a synchronous
//    try/catch reports success on a registration that never happened.
//  - inputSchema is asymmetric: it must be passed as an object and reads back as
//    a JSON string, so a schema round-tripped through getTools() cannot be
//    re-registered without parsing it first.
//  - duplicate names are rejected outright and there is NO unregisterTool and no
//    working AbortSignal, so the catalog is append-only for the document's life.
//    Registration checks the catalog first and still catches the race.
//  - a throwing execute rejects the caller with a generic message, so a tool that
//    wants to explain itself has to return isError instead of throwing.

/**
 * @param {{ name: string, description: string, inputSchema?: unknown, annotations?: Record<string, unknown>, writes?: boolean, execute: (args: any) => unknown }} def
 * @returns {Promise<"registered" | "taken" | "unsupported" | "failed">}
 */
export async function registerTool(def) {
  if (!MC) return "unsupported";
  const annotations = def.annotations || { readOnlyHint: true };
  // Default to the server reading: a /mcp tool that is not read-only is one that
  // persists something. A page tool that only drives the UI passes writes:false
  // explicitly and keeps its honest readOnlyHint:false.
  const writes = def.writes === undefined ? annotations.readOnlyHint === false : def.writes === true;

  let schema = def.inputSchema;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- this IS the I/O
     boundary. inputSchema arrives as an object from /mcp and as a JSON string
     from getTools(), and telling those apart is the whole job of this branch. */
  if (typeof schema === "string") {
    // A schema read back out of getTools() is a JSON string. Re-registering one
    // without this throws "Failed to convert value to 'object'".
    try { schema = JSON.parse(schema); } catch (e) { schema = undefined; }
  }

  /** @type {Record<string, unknown>} */
  const tool = {
    name: def.name,
    description: def.description + safetyNote(annotations, writes),
    annotations: { readOnlyHint: annotations.readOnlyHint !== false },
    execute: async (/** @type {any} */ args) => {
      const started = Date.now();
      let gated = false;
      try {
        if (writes) {
          gated = true;
          const allowed = await gate(def.name, args || {});
          if (!allowed) {
            record(def.name, started, "refused", gated);
            // isError rather than throw: a throw reaches the agent as "the script
            // function threw an error", which loses the one fact that matters.
            return { content: [{ type: "text", text: "Refused by the person at the keyboard. This tool writes data, so it needs their consent and did not get it." }], isError: true };
          }
        }
        const out = await def.execute(args || {});
        record(def.name, started, "ok", gated);
        return out;
      } catch (error) {
        record(def.name, started, "failed", gated);
        const message = (error && /** @type {Error} */ (error).message) || String(error);
        return { content: [{ type: "text", text: "Tool failed: " + message }], isError: true };
      }
    },
  };
  if (schema) tool.inputSchema = schema;

  try {
    const taken = (await MC.getTools()).some((t) => t.name === def.name);
    if (taken) return "taken";
    await MC.registerTool(/** @type {any} */ (tool));
    registered += 1;
    return "registered";
  } catch (error) {
    // The catalog is shared with whatever the edge injected, so losing a race
    // for a name is an expected outcome rather than a fault.
    const message = (error && /** @type {Error} */ (error).message) || "";
    return /Duplicate tool name/i.test(message) ? "taken" : "failed";
  }
}

// ---- the site's own /mcp tools ----------------------------------------------

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function callSiteTool(name, args) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Both framings, because a Streamable HTTP server may answer either and
      // some refuse a JSON-only Accept outright. Same reasoning as doors.ts.
      accept: "application/json, text/event-stream",
      "Mcp-Method": "tools/call",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args || {}, _meta: META } }),
  });
  const payload = await response.json();
  if (payload && payload.error) {
    return { content: [{ type: "text", text: String(payload.error.message || "the server refused the call") }], isError: true };
  }
  return payload ? payload.result : { content: [], isError: true };
}

/**
 * Register every tool `/mcp` advertises, carrying the annotations the browser
 * would otherwise drop. Returns a per-outcome tally.
 * @returns {Promise<{ registered: string[], taken: string[], failed: string[] }>}
 */
export async function registerSiteTools() {
  /** @type {{ registered: string[], taken: string[], failed: string[] }} */
  const out = { registered: [], taken: [], failed: [] };
  if (!MC) return out;
  let tools = [];
  try {
    const response = await fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/list", params: { _meta: META } }),
    });
    const payload = await response.json();
    tools = (payload && payload.result && payload.result.tools) || [];
  } catch (error) {
    return out;
  }
  for (const tool of tools) {
    const outcome = await registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations || {},
      execute: (args) => callSiteTool(tool.name, args),
    });
    if (outcome === "registered") out.registered.push(tool.name);
    else if (outcome === "taken") out.taken.push(tool.name);
    else if (outcome === "failed") out.failed.push(tool.name);
  }
  return out;
}

/** Idle entry point. nav.js calls this once per document. */
export async function boot() {
  if (!MC) return null;
  return registerSiteTools();
}
