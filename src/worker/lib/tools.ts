import { readAroundChanges } from "../around.ts";
import { getPublicAvailability } from "../../../cal/src/slots.ts";
import { LENS_COMPARE, LENS_INSPECT, lensObservationSummary } from "../lens.ts";
import type { LensOutcome } from "../lens-pipeline.ts";
import { queryPhotos } from "../photos.ts";
import { currentPlaylistId, getTracksSWR } from "../rn.ts";
import { NLWEB_MODES, nlwebAsk, parseAskRequest } from "../nlweb.ts";
import { searchSite } from "../search.ts";
import { mcpTool } from "./mcp-tools.ts";
import { ASK_LIMITS, CHANGE_RADAR_LIMITS, PHOTO_QUERY_LIMITS, SEARCH_LIMITS } from "./api-limits.ts";
// holding -> serendipity, which is the reverse of the established direction
// (serendipity already imports lib/desktop.js, lib/crawl.js, lib/mcp-protocol.js).
// It is not a cycle: nothing under serendipity/ imports this registry. It is also
// node-safe, which is the constraint that actually bites here — contract-tests.mjs
// imports BOTH this file and serendipity.js under plain node, so a `cloudflare:`
// import appearing in either would take the whole suite down at link time
// (gotcha 16).
import { serendipityFindEvents } from "../../../serendipity/serendipity.ts";
import { EVENT_FORMATS, EVENT_TOPICS } from "../../../serendipity/event-tags.ts";
import { asRecord, asText } from "./parse.ts";

export function toolError(message) { return { _error: String(message).slice(0, 400) }; }

function lensToolResult<V>(o: LensOutcome<V>, map: (value: V) => Record<string, any> = (v) => v as Record<string, any>): Record<string, any> {
  if (o.kind === "ok") return map(o.value);
  return toolError(o.kind === "failed" ? asText(o.payload.error) ?? "The lens failed." : o.error);
}

const DATA_TOOL_DEFINITIONS = [
  {
    name: "ask",
    description: "Ask aadhar.sh a natural-language question and get NLWeb-shaped results: for each match a url, name, site, score (0-100), description, and a schema.org schema_object. Retrieval is lexical over the site's own corpus and descriptions are extractive, so this returns the passages that answer the question rather than a written answer. mode=summarize and mode=generate are refused by name: this origin runs no language model.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "the question, in natural language" },
      site: { type: "string", description: "NLWeb site token; this origin serves one site, so \"aadhar.sh\" or \"all\"" },
      mode: { type: "string", enum: NLWEB_MODES.known, description: "list (the only one served here); summarize and generate are refused rather than degraded" },
      prev: { type: "array", items: { type: "string" }, description: "previous queries. Received and NOT resolved, since decontextualization needs a model; send decontextualized_query instead" },
      decontextualized_query: { type: "string", description: "the fully self-contained form of a follow-up question. When present this is what gets searched" },
      top_k: { type: "integer", minimum: 1, maximum: ASK_LIMITS.topKMax },
    }, required: ["query"] },
  },
  {
    name: "search_site",
    description: "Search the public pages, writing, garage notes, and utility descriptions on aadhar.sh.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "case-insensitive search query" }, limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMITS.limitMax } }, required: ["q"] },
  },
  {
    name: "now_playing",
    description: "Read the cached current rn playlist and its tracks. A cold cache may refresh from the public Spotify embed using AadharshBot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "photo_query",
    description: "Query the published photo archive by caption, camera, lens, film simulation, film-recipe setting, or date range. `q` is free text scored per term across the caption, the EXIF and an offline term expansion, so \"classic chrome bridge\" matches the film simulation AND the subject; the named parameters stay exact filters. Results are ranked and carry `score` and `matched` (which fields answered). `ranking.mode` says whether every term was covered (all-terms), only some (partial), or none (no-match), and `ranking.dropped` / `ranking.common` name terms ignored as stopwords or as too widespread to tell photos apart. Each result carries a `recipe` card naming the in-camera settings the shot was made with, so a look can be read back and re-shot. GPS and unlisted EXIF fields are never returned.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "free-text query, ranked; multiple words are scored independently" }, camera: { type: "string" }, lens: { type: "string" }, film: { type: "string", description: "film simulation name, e.g. \"Classic Chrome\", \"Nostalgic Neg\", \"Acros\"" }, recipe: { type: "string", description: "substring match anywhere in the recipe card, e.g. \"DR400\", \"Clarity: -2\", \"Grain Effect: Strong, Large\", \"+2 Red\"" }, from: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, to: { type: "string", description: "inclusive YYYY-MM-DD prefix" }, limit: { type: "integer", minimum: 1, maximum: PHOTO_QUERY_LIMITS.limitMax }, offset: { type: "integer", minimum: 0, maximum: PHOTO_QUERY_LIMITS.offsetMax } } },
  },
  {
    name: "coffee_availability",
    description: "Read bookable coffee slots in the host timezone. If the calendar is stale or unavailable, the result is explicitly unavailable and contains no slots.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "change_radar",
    description: "Read the bounded historical diff of the latest AadharshBot neighborhood observations. Raw crawled bodies are not stored or returned.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: CHANGE_RADAR_LIMITS.limitMax } } },
  },
  {
    name: "lens_inspect",
    description: "Inspect one public HTTP(S) URL through Lens and return a compact agent-readiness observation. Private, local, and non-HTTP targets are rejected.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "lens_page",
    description: "Read one public URL and return only what derives from the page's own bytes: anatomy, structured data, a markdown rendering, and what it costs an agent to ingest. Skips the origin-level fan-out entirely, so it is far cheaper and far faster than lens_inspect. Readiness, agent doors and terms are ABSENT from the result (not zero) because they were not checked; `phases.discovery` is false. Use lens_inspect when you need those.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "lens_compare",
    description: "Inspect two public HTTP(S) URLs and compare status, content, readiness, spectrum, agent doors, and discovery surfaces.",
    inputSchema: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] },
  },
  {
    name: "find_events",
    description: "Search the Serendipity event pool (community events worth going to, and who's RSVP'd) by keyword. Returns events the pool's contributors actually said yes to; pass rsvp:\"all\" to include events that were only browsed.",
    inputSchema: { type: "object", properties: {
      q: { type: "string", description: "optional keyword filter on event name, place, or contributor" },
      when: { type: "string", enum: ["upcoming", "past", "all"], description: "defaults to upcoming" },
      rsvp: { type: "string", enum: ["going", "all", "discovered"], description: "defaults to going (the events with real rosters)" },
      topic: { type: "string", enum: [...EVENT_TOPICS], description: "optional: only events classified as this topic; unclassified events are counted in `untagged`" },
      format: { type: "string", enum: [...EVENT_FORMATS], description: "optional: only events classified as this format (talks, meal, social, ...)" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    } },
  },
];

export const DATA_TOOLS = DATA_TOOL_DEFINITIONS.map((tool) => mcpTool(tool));

export const DATA_TOOL_NAMES = new Set(DATA_TOOLS.map((t) => t.name));

export async function callDataTool(name, args, request, env, ctx): Promise<Record<string, any>> {
  args = asRecord(args) || {};
  if (name === "ask") {
    const parsed = parseAskRequest(new URL("https://aadhar.sh/ask"), args);
    if (!parsed.ok) return toolError(parsed.error.error);
    return nlwebAsk(env, parsed.params, request);
  }
  if (name === "search_site") return searchSite(env, args.q, args.limit);
  if (name === "photo_query") return queryPhotos(env, args, ctx);
  if (name === "coffee_availability") return getPublicAvailability(env, ctx);
  if (name === "change_radar") {
    try { return await readAroundChanges(env, args.limit); }
    catch { return toolError("change history is temporarily unavailable"); }
  }
  if (name === "now_playing") {
    const pid = await currentPlaylistId(env);
    try {
      const tracks = await getTracksSWR(env, ctx, pid, { buildOnMiss: true });
      return tracks || { available: false, playlist_id: pid, tracks: [] };
    } catch { return toolError("the playlist is temporarily unavailable"); }
  }
  if (name === "lens_inspect") {
    return lensToolResult(await LENS_INSPECT.run({ url: args.url, skipBotViews: true }, request, env, ctx), lensObservationSummary);
  }
  if (name === "lens_page") {
    return lensToolResult(await LENS_INSPECT.run({ url: args.url, phases: ["page"] }, request, env, ctx), lensObservationSummary);
  }
  if (name === "lens_compare") {
    return lensToolResult(await LENS_COMPARE.run({ left: args.left, right: args.right }, request, env, ctx));
  }
  if (name === "find_events") {
    try { return await serendipityFindEvents(env, args); }
    catch { return toolError("the event pool is temporarily unavailable"); }
  }
  return { _unknown: true };
}
