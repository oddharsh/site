// lens-webmcp.js — the lightweight WebMCP catalog for /lens.
//
// Discovery must happen before a person touches the page, but discovery does
// not need the 80+ KiB Lens application. This module registers the six stable
// definitions while the server-rendered shell is idle. A call crosses the
// explicit LensWebMcp handoff below, hydrates lens.js, and only then reaches the
// handler that owns the live pane state.

const VIEWS = Object.freeze(["both", "human", "machine", "browser", "delta"]);
const OPT_IN = Object.freeze(["reader", "wire", "tools", "nlweb", "markdown"]);
const SWITCHES = Object.freeze(["markdown", "semantic", "contract", "authority", "receipt", "dictionary", "ech"]);

/** @type {null | (() => Promise<unknown>)} */
let loadClient = null;
/** @type {null | Record<string, (args: any) => unknown>} */
let handlers = null;

/** The full client installs its closure-backed handlers here after hydration. */
export function installHandlers(next) {
  handlers = next;
}

// The full client is deliberately still a classic IIFE. This is its one narrow
// browser boundary, matching the lazy LensBrowser/LensReader islands: the
// registrar owns definitions and safety; lens.js owns mutable screen state.
window.LensWebMcp = Object.freeze({ installHandlers, views: VIEWS, optIn: OPT_IN, switches: SWITCHES });

async function execute(name, args) {
  if (!loadClient) throw new Error("The Lens client loader is unavailable.");
  await loadClient();
  const handler = handlers && handlers[name];
  if (!handler) throw new Error("The Lens client did not publish the " + name + " handler.");
  return handler(args);
}

const proxy = (name) => (args) => execute(name, args);

/** Register the catalog without hydrating the full Lens application. */
export async function boot(load) {
  loadClient = load;
  const wm = await import("/webmcp.js");
  if (!wm.available()) return;

  // The server-rendered tab row is the source of truth for which lenses this
  // document exposes. Reading it keeps the early schema aligned without
  // copying LENS_TAB_LABELS into a third client module.
  const tabs = [...document.querySelectorAll(".lx-tab")]
    .map((tab) => tab.getAttribute("data-lens"))
    .filter((tab) => tab);

  const defs = [
    {
      name: "lens_scan",
      description:
        "Scan a URL in the Lens window on this page, the one the person is watching. The panes repaint as it runs and this returns once the scan has settled. Prefer lens_inspect when you only want the data: that one answers you privately and leaves the screen alone. Use this one when the person should SEE what you found.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "an absolute http(s) URL" } }, required: ["url"] },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      writes: false,
      execute: proxy("lens_scan"),
    },
    {
      name: "lens_compare_onscreen",
      description:
        "Put two URLs through the same rubric side by side, in the Lens window on this page. Returns the comparison and leaves it on screen. The head-to-head costs a tighter per-visitor budget than a single scan, so do not loop it.",
      inputSchema: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      writes: false,
      execute: proxy("lens_compare_onscreen"),
    },
    {
      name: "lens_show",
      description:
        "Change what the Lens window is displaying. `pane` picks the split (" + VIEWS.join(", ") + ") and `tab` picks which machine lens is open (" + tabs.join(", ") + "). This only moves the view. Five tabs hold nothing until somebody pays for the fetch, so follow it with lens_run_tab when the pane comes back empty.",
      inputSchema: { type: "object", properties: { pane: { type: "string", enum: VIEWS }, tab: { type: "string", enum: tabs } } },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      writes: false,
      execute: proxy("lens_show"),
    },
    {
      name: "lens_run_tab",
      description:
        "Pay for one of the opt-in machine tabs and wait for it: reader (a third-party extractor's guess at the article), wire (every request the page makes, through a real browser), tools (the MCP catalog the origin advertises), nlweb (ask the origin's own /ask endpoint a question), markdown (replay the Accept header each named agent client sends, and report which representation each one gets). Each one is a fresh fetch of somebody else's site from this visitor's budget, which is why none of them run on their own. Needs a scan on screen first.",
      inputSchema: {
        type: "object",
        properties: {
          tab: { type: "string", enum: OPT_IN },
          query: { type: "string", description: "nlweb only: the question to ask the origin" },
        },
        required: ["tab"],
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      writes: false,
      execute: proxy("lens_run_tab"),
    },
    {
      name: "lens_read_screen",
      description:
        "Read what the Lens window is showing right now: the URL that was scanned, its status, which pane and machine tab are open, the agent-readiness score, which Delta switches are flipped, and which opt-in tabs already hold data. The one tool here that changes nothing. Call it to find out what the person is looking at before you touch anything.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      writes: false,
      execute: proxy("lens_read_screen"),
    },
    {
      name: "lens_delta",
      description:
        "Flip one of the Delta counterfactual switches and repaint. Each switch simulates a fix the scanned site has not made (" + SWITCHES.join(", ") + ") and shows what it would have bought. Nothing is sent anywhere: the whole simulation is arithmetic on the scan already on screen.",
      inputSchema: {
        type: "object",
        properties: {
          "switch": { type: "string", enum: SWITCHES },
          on: { type: "boolean", description: "omit to toggle" },
        },
        required: ["switch"],
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      writes: false,
      execute: proxy("lens_delta"),
    },
  ];

  // Sequential, because each registration reads the shared catalog to check
  // the name is free and a parallel burst races itself for it.
  for (const def of defs) await wm.registerTool(def);
}
