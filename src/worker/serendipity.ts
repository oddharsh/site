import { json, withSiteHeaders } from "./http.ts";

type Row = Record<string, unknown>;

const tools = [
  { name: "list_events", title: "List events", description: "List upcoming, past, or all public events in the Serendipity pool.", inputSchema: { type: "object", properties: { when: { type: "string", enum: ["upcoming", "past", "all"], default: "upcoming" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_event", title: "Get event", description: "Open one public event and its attendee list.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "search_people", title: "Search people", description: "Find public attendees by name.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "stats", title: "Pool statistics", description: "Count events and public attendees.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
] as const;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function externalUrl(value: unknown): string | null {
  try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

async function all(statement: D1PreparedStatement): Promise<Row[]> {
  return (await statement.all<Row>()).results;
}

async function eventRows(env: Env): Promise<Row[]> {
  try {
    return await all(env.SERENDIPITY_DB.prepare(
      `SELECT e.id, e.name, e.description, e.start_at, e.end_at, e.location, e.url, e.user_status,
              (SELECT COUNT(*) FROM event_attendees ea WHERE ea.event_id=e.id AND ea.is_host=0) AS attendee_count,
              (SELECT COUNT(*) FROM event_attendees ea WHERE ea.event_id=e.id AND ea.is_host=1) AS host_count
         FROM events e ORDER BY e.start_at ASC`,
    ));
  } catch (error) {
    if (/no such table|does not exist/i.test(String(error))) return [];
    throw error;
  }
}

function eventSummary(row: Row): Row {
  return { id: row.id, name: row.name, description: row.description || null, start_at: row.start_at || null, end_at: row.end_at || null, location: row.location || null, url: externalUrl(row.url), rsvp: row.user_status || "unknown", going: Number(row.attendee_count || 0), hosts: Number(row.host_count || 0) };
}

function dateTime(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.valueOf())) return "Date to be announced";
  return date.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}

function eventCards(rows: Row[]): string {
  return `<ul class="event-list">${rows.map((row) => `<li><a href="/serendipity/event/${encodeURIComponent(String(row.id))}"><strong>${escapeHtml(row.name)}</strong><span class="event-meta">${escapeHtml(dateTime(row.start_at))}${row.location ? ` · ${escapeHtml(row.location)}` : ""}</span><span class="event-badges"><span>${Number(row.attendee_count || 0)} going</span>${Number(row.host_count || 0) ? `<span>${Number(row.host_count)} host${Number(row.host_count) === 1 ? "" : "s"}</span>` : ""}${row.user_status !== "going" ? "<span>browsed</span>" : ""}</span></a></li>`).join("")}</ul>`;
}

function poolHtml(rows: Row[]): string | null {
  if (!rows.length) return null;
  const now = Date.now();
  const upcoming = rows.filter((row) => !row.start_at || new Date(String(row.start_at)).valueOf() >= now);
  const past = rows.filter((row) => row.start_at && new Date(String(row.start_at)).valueOf() < now).sort((a, b) => new Date(String(b.start_at)).valueOf() - new Date(String(a.start_at)).valueOf()).slice(0, 30);
  return `${upcoming.length ? `<section class="event-group"><h2>Upcoming</h2>${eventCards(upcoming)}</section>` : ""}${past.length ? `<section class="event-group"><h2>Recently past</h2>${eventCards(past)}</section>` : ""}`;
}

export async function serendipityPage(request: Request, env: Env): Promise<Response> {
  const [response, rows] = await Promise.all([env.ASSETS.fetch(request), eventRows(env)]);
  const html = poolHtml(rows);
  const transformed = html ? new HTMLRewriter().on("#event-pool", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response) : response;
  return withSiteHeaders(transformed, request);
}

async function attendees(env: Env, eventId: string): Promise<Row[]> {
  return all(env.SERENDIPITY_DB.prepare(
    `SELECT a.name, a.bio_short, a.times_seen, a.website, a.twitter_handle, a.linkedin_handle, a.instagram_handle,
            ea.is_host, en.company, en.role, en.bio AS enriched_bio, en.location, en.linkedin_url
       FROM event_attendees ea JOIN attendees a ON a.id=ea.attendee_id
       LEFT JOIN enrichments en ON en.attendee_id=a.id WHERE ea.event_id=?
       ORDER BY ea.is_host DESC, a.times_seen DESC, a.name ASC`,
  ).bind(eventId));
}

async function eventRecord(env: Env, id: string): Promise<{ event: Row; attendees: Row[] } | null> {
  try {
    const event = await env.SERENDIPITY_DB.prepare("SELECT id,name,description,start_at,end_at,location,url,user_status FROM events WHERE id=?").bind(id).first<Row>();
    return event ? { event, attendees: await attendees(env, id) } : null;
  } catch (error) {
    if (/no such table|does not exist/i.test(String(error))) return null;
    throw error;
  }
}

function socialLinks(person: Row): string {
  const links = [
    [externalUrl(person.website), "website"],
    [person.twitter_handle ? `https://x.com/${String(person.twitter_handle).replace(/^@/, "")}` : null, "x"],
    [externalUrl(person.linkedin_url) || (person.linkedin_handle ? `https://linkedin.com/in/${person.linkedin_handle}` : null), "linkedin"],
    [person.instagram_handle ? `https://instagram.com/${String(person.instagram_handle).replace(/^@/, "")}` : null, "instagram"],
  ].filter(([href]) => href);
  return links.length ? ` · ${links.map(([href, label]) => `<a href="${escapeHtml(href)}" rel="external noopener">${label}</a>`).join(" · ")}` : "";
}

export async function serendipityEvent(request: Request, env: Env, id: string): Promise<Response> {
  const record = await eventRecord(env, id);
  const shell = await env.ASSETS.fetch(new Request(new URL("/serendipity", request.url), request));
  const body = record ? `<header><p class="eyebrow">Serendipity · Event</p><h1>${escapeHtml(record.event.name)}</h1><p class="lede">${escapeHtml(dateTime(record.event.start_at))}${record.event.location ? ` · ${escapeHtml(record.event.location)}` : ""}</p></header><article class="event-detail">${record.event.description ? `<p class="event-description">${escapeHtml(record.event.description)}</p>` : ""}${externalUrl(record.event.url) ? `<p><a class="native-button" href="${escapeHtml(externalUrl(record.event.url))}" rel="external noopener">Open the event page</a></p>` : ""}<h2>${record.attendees.length} public attendee${record.attendees.length === 1 ? "" : "s"}</h2>${record.attendees.length ? `<ul class="attendee-list">${record.attendees.map((person) => `<li><strong>${escapeHtml(person.name)}</strong>${person.is_host ? " · host" : ""}${person.role || person.company ? `<p>${escapeHtml([person.role, person.company].filter(Boolean).join(" at "))}</p>` : ""}${person.bio_short || person.enriched_bio ? `<p>${escapeHtml(person.bio_short || person.enriched_bio)}</p>` : ""}<p class="event-meta">Seen at ${Number(person.times_seen || 1)} event${Number(person.times_seen || 1) === 1 ? "" : "s"}${socialLinks(person)}</p></li>`).join("")}</ul>` : `<p class="empty-state">No public attendee list is attached.</p>`}</article>` : `<header><p class="eyebrow">Serendipity · Event</p><h1>Event not found</h1><p class="lede">This record is absent or no longer public.</p></header>`;
  const transformed = new HTMLRewriter().on(".document", { element(element) { element.setInnerContent(body, { html: true }); } }).transform(shell);
  const secured = withSiteHeaders(transformed, request); secured.headers.set("cache-control", "public, max-age=0, s-maxage=60");
  return new Response(secured.body, { status: record ? 200 : 404, headers: secured.headers });
}

export async function serendipityEventsJson(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url); const when = url.searchParams.get("when") ?? "all"; const query = (url.searchParams.get("q") ?? "").toLowerCase().slice(0, 120); const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const now = Date.now();
  const rows = (await eventRows(env)).filter((row) => (when === "upcoming" ? !row.start_at || new Date(String(row.start_at)).valueOf() >= now : when === "past" ? row.start_at && new Date(String(row.start_at)).valueOf() < now : true)).filter((row) => !query || `${row.name} ${row.description} ${row.location}`.toLowerCase().includes(query)).slice(0, limit).map(eventSummary);
  return json({ events: rows, returned: rows.length, when }, { headers: { "cache-control": "public, max-age=60", "x-robots-tag": "noindex" } });
}

function rpcResult(id: unknown, result: unknown): Row { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: unknown, code: number, message: string): Row { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

async function callTool(env: Env, name: string, args: Row): Promise<Row> {
  if (name === "list_events") {
    const request = new Request(`https://aadhar.sh/serendipity/events.json?when=${encodeURIComponent(String(args.when || "upcoming"))}&q=${encodeURIComponent(String(args.query || ""))}&limit=${Math.min(100, Math.max(1, Number(args.limit) || 25))}`);
    return await (await serendipityEventsJson(env, request)).json<Row>();
  }
  if (name === "get_event") {
    const record = await eventRecord(env, String(args.id || ""));
    return record ? { event: eventSummary(record.event), attendees: record.attendees.map((person) => ({ name: person.name, role: person.role || null, company: person.company || null, location: person.location || null, bio: person.bio_short || person.enriched_bio || null, times_seen: Number(person.times_seen || 1), is_host: Boolean(person.is_host) })) } : { error: "event not found" };
  }
  if (name === "search_people") {
    const query = `%${String(args.query || "").replace(/[\\%_]/g, "\\$&")}%`; const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
    const people = await all(env.SERENDIPITY_DB.prepare(`SELECT a.name,a.bio_short,a.times_seen,a.website,a.twitter_handle,a.linkedin_handle,a.instagram_handle,en.company,en.role,en.location,en.linkedin_url FROM attendees a LEFT JOIN enrichments en ON en.attendee_id=a.id WHERE a.name LIKE ? ESCAPE '\\' ORDER BY a.times_seen DESC,a.name ASC LIMIT ?`).bind(query, limit));
    return { query: args.query, returned: people.length, people: people.map((person) => ({ name: person.name, role: person.role || null, company: person.company || null, location: person.location || null, bio: person.bio_short || null, times_seen: Number(person.times_seen || 1) })) };
  }
  if (name === "stats") {
    const [events, people] = await Promise.all([eventRows(env), env.SERENDIPITY_DB.prepare("SELECT COUNT(*) AS n FROM attendees").first<{ n: number }>().catch(() => null)]); const now = Date.now();
    return { events_total: events.length, events_upcoming: events.filter((event) => !event.start_at || new Date(String(event.start_at)).valueOf() >= now).length, events_past: events.filter((event) => event.start_at && new Date(String(event.start_at)).valueOf() < now).length, people: Number(people?.n || 0) };
  }
  return { error: `unknown tool: ${name}` };
}

async function handleRpc(env: Env, message: unknown): Promise<Row | null> {
  if (!message || typeof message !== "object") return rpcError(null, -32600, "Invalid Request");
  const rpc = message as Row; const hasId = "id" in rpc; const id = rpc.id;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return hasId ? rpcError(id, -32600, "Invalid Request") : null;
  if (String(rpc.method).startsWith("notifications/")) return null;
  if (rpc.method === "server/discover") return rpcResult(id, { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "serendipity", title: "Serendipity", version: "3.0.0" }, instructions: "Read-only access to the public Serendipity event pool." });
  if (rpc.method === "initialize") return rpcResult(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "serendipity", title: "Serendipity", version: "3.0.0" }, instructions: "Read-only access to the public Serendipity event pool." });
  if (rpc.method === "ping") return rpcResult(id, {});
  if (rpc.method === "tools/list") return rpcResult(id, { tools });
  if (rpc.method === "resources/list") return rpcResult(id, { resources: [] });
  if (rpc.method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
  if (rpc.method === "prompts/list") return rpcResult(id, { prompts: [] });
  if (rpc.method === "tools/call") {
    const params = (rpc.params && typeof rpc.params === "object" ? rpc.params : {}) as Row; const name = String(params.name || ""); const output = await callTool(env, name, (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Row); const failed = "error" in output;
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output, ...(failed ? { isError: true } : {}) });
  }
  return hasId ? rpcError(id, -32601, `Method not found: ${rpc.method}`) : null;
}

export async function serendipityMcp(request: Request, env: Env): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-method, mcp-name", "access-control-max-age": "86400" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Use POST with JSON-RPC 2.0." }, { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  if (Number(request.headers.get("content-length") || 0) > 32 * 1024) return json(rpcError(null, -32600, "Request too large"), { status: 413, headers: cors });
  let payload: unknown; try { payload = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), { headers: cors }); }
  const output = Array.isArray(payload) ? (await Promise.all(payload.map((item) => handleRpc(env, item)))).filter(Boolean) : await handleRpc(env, payload);
  return output === null || (Array.isArray(output) && !output.length) ? new Response(null, { status: 202, headers: { ...cors, "cache-control": "no-store" } }) : json(output, { headers: { ...cors, "cache-control": "no-store" } });
}

export function retiredSerendipityWrite(): Response {
  return json({ error: "gone", note: "The blank-slate Serendipity service no longer accepts third-party session cookies or exposes remote sync triggers. Submit a public event link through /serendipity/contribute." }, { status: 410, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
