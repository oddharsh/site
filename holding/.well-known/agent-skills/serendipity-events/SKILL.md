---
name: serendipity-events
description: Query the Serendipity event pool on aadhar.sh, a public read-only MCP server. Use it to find community-curated events worth going to, see who is going, and look people up by name. Read-only, no auth, public data only.
---

# Serendipity events

Serendipity is a public, collective database of events worth going to and who is
showing up, hosted at https://aadhar.sh/serendipity. It speaks MCP, so an agent
can query it directly instead of scraping the page.

## Connect

Point an MCP client at the Streamable-HTTP endpoint:

    https://aadhar.sh/serendipity/mcp

Transport is Streamable HTTP (JSON-RPC 2.0 over POST). There is no
authentication and there are no write tools. It exposes only the public surface
the website itself renders: names, roles, companies, and public social links. It
never returns private contact details (emails and phone numbers stay in the
database).

## Tools

- `list_events` lists events in the pool, each with a head count of who is
  going and an RSVP tier. The pool mixes events a contributor actually RSVP'd
  to / hosts (first-class, with real rosters) and events synced from just
  browsing a Luma feed (second-class, no roster). By default it returns only
  the RSVP'd events plus a `discovered_hidden` count; pass `rsvp: "all"` to
  include the browsed ones (first-class first) or `rsvp: "discovered"` for only
  them. Each event carries `attending` (bool) + `rsvp` (raw status), plus a
  `vibe` (a one-line characterization) and `tags` (crowd / domain / format) once
  it has been characterized from its description and who is coming. Args:
  `when` (`upcoming` | `past` | `all`, default `upcoming`), `rsvp`
  (`going` | `all` | `discovered`, default `going`), `q` (filter on name,
  location, or contributor), `limit`.
- `get_event` returns one event in full: description, `vibe` + `tags`, hosts, the
  guest list (who is going, each with an `rsvp_status` when it is not the default
  going/approved — for events a contributor hosts the roster spans all statuses),
  and which contributors added it. Args: `id` (from `list_events`).
- `search_people` finds people by name. It returns role, company, and socials
  when known, plus their events split into `going_to` (upcoming) and `been_to`
  (past). Args: `q`, `limit`.
- `list_contributors` lists the people feeding the pool: a label, an 8-char id
  prefix, and how many events each has fed in.
- `contributor_events` takes one contributor (a cookie id / `user_key`, an id
  prefix, or a label) and returns their whole event footprint, split into
  `going_to` and `been_to`. Args: `contributor`.
- `frequent_people` lists the people who show up across the most events (who
  you are seeing a lot), each with an event count. Args: `when`, `limit`.
- `co_attendees` takes a person by name and returns who they cross paths with
  most, with the names of the shared events. Pass your own name to answer "who
  am I seeing a lot". Args: `q`, `limit`.
- `connections` returns the tightest co-attendance pairs in the whole pool (who
  is seeing who), with shared counts and event names. Args: `min_shared`, `limit`.
- `shared_events` takes two people by name and returns the events they both
  attended. Args: `a`, `b`.
- `mutual_events` takes a person and (optionally) a contributor and returns the
  events that person is at which the contributor also fed into the pool — "where
  do we cross paths with them". It also returns `luma_event_together_count`,
  Luma's own count of events they attended together. Args: `person`,
  `contributor` (optional). Omit `contributor` for overlap with the whole pool.
- `stats` returns a pool overview: event counts, distinct people, contributors.

## Typical flow

1. Call `stats` or `list_events` to see what is in the pool.
2. Drill into an event with `get_event`, passing an `id` from `list_events`.
3. Find a person and the events they go to with `search_people`, or pivot on a
   contributor's whole footprint with `list_contributors` then
   `contributor_events`.

Human-readable docs live at https://aadhar.sh/serendipity/mcp-info, and the
machine server card is at https://aadhar.sh/.well-known/mcp.json.
