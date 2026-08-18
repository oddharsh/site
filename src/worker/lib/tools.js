// lib/tools.js — the site's tool registry: what a caller can ASK this origin to
// do, and the one function that does it.
//
// Extracted from mcp.js when /ask arrived. There are now TWO doors onto
// the same seven tools — JSON-RPC at /mcp, and the natural-language loop at
// /ask, which hands these very schemas to a model as its function
// catalog — and a second copy of the list would have drifted the first time one
// description was reworded. Same argument as site-manifest.json: one registry,
// projected outward, never transcribed.
//
// Deliberately only the DATA tools. The three frame-returning terminal_* tools
// stay declared in mcp.js, because they are implemented in terminal.js and
// pulling them in here would make lib/tools.js -> terminal.js -> ask.js ->
// lib/tools.js a cycle. The ask loop has no use for them either: it wants
// records to reason over, not a rendered 80-column screen.
import { readAroundChanges } from "../around.js";
import { readCoffeeAvailability } from "../coffee.js";
import { LENS_BUDGETS, compareLensTargets, lensInspect, lensObservationSummary, overLensBudget, validateLensTarget } from "../lens.js";
import { queryPhotos } from "../photos.js";
import { RN_FALLBACK, getTracksSWR } from "../rn.js";
import { searchSite } from "../search.js";
import { mcpTool } from "./mcp-tools.js";
// holding -> serendipity, which is the reverse of the established direction
// (serendipity already imports lib/desktop.js, lib/crawl.js, lib/mcp-protocol.js).
// It is not a cycle: nothing under serendipity/ imports this registry. It is also
// node-safe, which is the constraint that actually bites here — contract-tests.mjs
// imports BOTH this file and serendipity.js under plain node, so a `cloudflare:`
// import appearing in either would take the whole suite down at link time
// (gotcha 16).
import { serendipityFindEvents } from "../../../serendipity/serendipity.js";
import { asRecord } from "./parse.js";

export function toolError(message) { return { _error: String(message).slice(0, 400) }; }

// The crawl tools bill against the SAME per-IP buckets as their HTTP twins
// (lens.js LENS_BUDGETS), not a private one. A separate bucket let a caller
// stack budgets: 30 inspections via /lens/fetch AND another 8 here, and
// lens_compare was metered at 8/min through JSON-RPC while /lens/compare allows
// 4, so the cheaper door was the expensive operation. One bucket, one ceiling,
// whichever door you knock on — and /ask, being a third door onto the
// same functions, inherits that property for free by calling through here.
const DATA_TOOL_DEFINITIONS = [
  {
    name: "search_site",
    description: "Search the public pages, writing, garage notes, and utility descriptions on aadhar.sh.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "case-insensitive search query" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["q"] },
  },
  {
    name: "now_playing",
    description: "Read the cached current rn playlist and its tracks. A cold cache may refresh from the public Spotify embed using AadharshBot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "photo_query",
    description: "Query the published photo archive by caption, camera, lens, film simulation, film-recipe setting, or date range. `q` is free text scored per term across the caption, the EXIF and an offline term expansion, so \"classic chrome bridge\" matches the film simulation AND the subject; the named parameters stay exact filters. Results are ranked and carry `score` and `matched` (which fields answered). `ranking.mode` says whether every term was covered (all-terms), only some (partial), or none (no-match), and `ranking.dropped` / `ranking.common` name terms ignored as stopwords or as too widespread to tell photos apart. Each result carries a `recipe` card naming the in-camera settings the shot was made with, so a look can be read back and re-shot. GPS and unlisted EXIF fields are never returned.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "free-text query, ranked; multiple words are scored independently" }, camera: { type: "string" }, lens: { type: "string" }, film: { type: "string", description: "film simulation name, e.g. \"Classic Chrome\", \"Nostalgic Neg\", \"Acros\"" }, recipe: { type: "string", description: "substring match anywhere in the recipe card, e.g. \"DR400\", \"Clarity: -2\", \"Grain Effect: Strong, Large\", \"+2 Red\"" }, from: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, to: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 10000 } } },
  },
  {
    name: "coffee_availability",
    description: "Read bookable coffee slots in the host timezone. If the calendar is stale or unavailable, the result is explicitly unavailable and contains no slots.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "change_radar",
    description: "Read the bounded historical diff of the latest AadharshBot neighborhood observations. Raw crawled bodies are not stored or returned.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
  },
  {
    name: "lens_inspect",
    description: "Inspect one public HTTP(S) URL through Lens and return a compact agent-readiness observation. Private, local, and non-HTTP targets are rejected.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    // The cheap tier. One subrequest instead of twenty-eight, for a caller that
    // wants what the page itself says and not what its origin advertises. The
    // discovery-derived fields come back ABSENT rather than zero, and `phases`
    // says so, because "no agent doors" and "nobody looked" are different claims.
    name: "lens_page",
    description: "Read one public URL and return only what derives from the page's own bytes: anatomy, structured data, a markdown rendering, and what it costs an agent to ingest. Skips the origin-level fan-out entirely, so it is far cheaper and far faster than lens_inspect. Readiness, agent doors and terms are ABSENT from the result (not zero) because they were not checked; `phases.discovery` is false. Use lens_inspect when you need those.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "lens_compare",
    description: "Inspect two public HTTP(S) URLs and compare status, content, readiness, spectrum, agent doors, and discovery surfaces.",
    inputSchema: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] },
  },
  // The one tool here whose data lives in the OTHER MCP server on this origin.
  // It is hoisted because a browser-side agent never gets to choose a door: the
  // WebMCP bridge Cloudflare injects reads `/mcp` and registers what it finds, so
  // /serendipity/mcp's tools are invisible from the page. This used to be a
  // hand-rolled `navigator.modelContext` block in index.html, which was worse
  // three ways — homepage only, on the API Chrome 146 replaced with
  // `document.modelContext`, and a second schema to keep in step with the pool.
  {
    name: "find_events",
    description: "Search the Serendipity event pool (community events worth going to, and who's RSVP'd) by keyword. Returns events the pool's contributors actually said yes to; pass rsvp:\"all\" to include events that were only browsed.",
    inputSchema: { type: "object", properties: {
      q: { type: "string", description: "optional keyword filter on event name, place, or contributor" },
      when: { type: "string", enum: ["upcoming", "past", "all"], description: "defaults to upcoming" },
      rsvp: { type: "string", enum: ["going", "all", "discovered"], description: "defaults to going (the events with real rosters)" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    } },
  },
];

export const DATA_TOOLS = DATA_TOOL_DEFINITIONS.map((tool) => mcpTool(tool));

export const DATA_TOOL_NAMES = new Set(DATA_TOOLS.map((t) => t.name));

export async function callDataTool(name, args, request, env, ctx) {
  args = asRecord(args) || {};
  if (name === "search_site") return searchSite(env, args.q, args.limit);
  if (name === "photo_query") return queryPhotos(env, args, ctx);
  if (name === "coffee_availability") return readCoffeeAvailability(env, ctx);
  if (name === "change_radar") return readAroundChanges(env, args.limit);
  if (name === "now_playing") {
    const playlistId = env.RN_KV ? await env.RN_KV.get("playlist-id") : null;
    const pid = /^[0-9A-Za-z]{22}$/.test(playlistId || "") ? playlistId : RN_FALLBACK.split("/").pop();
    try {
      const tracks = await getTracksSWR(env, ctx, pid, { buildOnMiss: true });
      return tracks || { available: false, playlist_id: pid, tracks: [] };
    } catch { return toolError("the playlist is temporarily unavailable"); }
  }
  if (name === "lens_inspect") {
    const target = validateLensTarget(args.url || "");
    if (!target.ok) return toolError(target.error);
    if (await overLensBudget(LENS_BUDGETS.inspect, request, env)) return toolError("Lens lookups are rate-limited to 30/min, shared with /lens/fetch.");
    try { return lensObservationSummary(await lensInspect(target.url, env, { skipBotViews: true })); }
    catch { return toolError("Lens inspection failed."); }
  }
  if (name === "lens_page") {
    const target = validateLensTarget(args.url || "");
    if (!target.ok) return toolError(target.error);
    if (await overLensBudget(LENS_BUDGETS.inspect, request, env)) return toolError("Lens lookups are rate-limited to 30/min, shared with /lens/fetch.");
    try { return lensObservationSummary(await lensInspect(target.url, env, { phases: ["page"] })); }
    catch { return toolError("Lens inspection failed."); }
  }
  if (name === "lens_compare") {
    const left = validateLensTarget(args.left || "");
    const right = validateLensTarget(args.right || "");
    if (!left.ok) return toolError(`left: ${left.error}`);
    if (!right.ok) return toolError(`right: ${right.error}`);
    if (await overLensBudget(LENS_BUDGETS.compare, request, env)) return toolError("Lens comparisons are rate-limited to 4/min, shared with /lens/compare.");
    try { return await compareLensTargets(left.url, right.url, env); }
    catch { return toolError("Lens comparison failed."); }
  }
  if (name === "find_events") {
    try { return await serendipityFindEvents(env, args); }
    catch { return toolError("the event pool is temporarily unavailable"); }
  }
  return { _unknown: true };
}
