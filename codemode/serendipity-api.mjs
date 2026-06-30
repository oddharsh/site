// AUTO-GENERATED from https://aadhar.sh/serendipity/mcp (tools/list). Regenerate: node codemode/codegen.mjs
// A code-mode client: each MCP tool is a normal async function. Write code against
// these and intermediate results stay local instead of round-tripping an LLM.
const ENDPOINT = "https://aadhar.sh/serendipity/mcp";
let _id = 0;
async function call(name, args) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method: "tools/call", params: { name, arguments: args || {} } }),
  });
  const t = await r.text();
  const env = t.startsWith("data:") ? JSON.parse(t.replace(/^data:\s*/, "")) : JSON.parse(t);
  if (env.error) throw new Error("MCP " + name + ": " + (env.error.message || JSON.stringify(env.error)));
  const parts = (env.result && env.result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try { return JSON.parse(parts); } catch { return parts; }
}

/** List events in the Serendipity pool, each with a head count of who's going and an RSVP tier. The pool mixes events a contributor actually RSVP'd to or hosts (rsvp:"going" — first-class, the ones with real rosters) with events synced from just browsing a Luma feed (rsvp:"invited"/"pending"/etc — no roster, second-class). By default only the going (RSVP'd) events are returned, with a discovered_hidden count noting how many browsed events were omitted; pass rsvp:"all" to include them (first-class first) or rsvp:"discovered" for only the browsed ones. Each event carries attending (bool) + rsvp (raw status). Defaults to upcoming, soonest first. */
export function list_events(args) { return call("list_events", args); }

/** Full detail for one event by id: description, time, location, Luma link, hosts, the guest list (who's going, with role/company/socials when known), and which contributors added it. */
export function get_event(args) { return call("get_event", args); }

/** Search people across all events by name. Returns who they are (role/company/socials when known), how many events they've turned up at, and their events split into going_to (upcoming) and been_to (past), so you see both trajectory and reach. */
export function search_people(args) { return call("search_people", args); }

/** List the contributors feeding the pool (the people who synced a Luma feed): their label, an 8-char id prefix, and how many events each has fed in. Use the label or id prefix with contributor_events. */
export function list_contributors() { return call("list_contributors"); }

/** Given a contributor (their cookie id / user_key, an id prefix, or their label), return every event they fed into the pool, split into going_to (upcoming) and been_to (past). This is one contributor's whole event footprint. */
export function contributor_events(args) { return call("contributor_events", args); }

/** The people who show up across the most events in the pool (who you're seeing a lot), each with an event count. Optionally restrict the count to upcoming or past. */
export function frequent_people(args) { return call("frequent_people", args); }

/** Given a person by name, who they cross paths with most: the people most often at the same events, with a shared-event count and the names of those shared events. Pass your own name to answer "who am I seeing a lot". */
export function co_attendees(args) { return call("co_attendees", args); }

/** The tightest co-attendance pairs in the whole pool (who's seeing who): pairs of people who keep turning up at the same events, with the shared count and the shared event names. The relationship graph's strongest edges. */
export function connections(args) { return call("connections", args); }

/** Given two people by name, the events they both attended (did these two cross paths, and where). */
export function shared_events(args) { return call("shared_events", args); }

/** Overview of the pool: upcoming/past event counts, distinct people seen, and active contributors. */
export function stats() { return call("stats"); }

