# Events

Serendipity is a public, collective database of events worth going to and who's
showing up, fed by anyone who contributes their Luma feed. Each event links to
its guest list.

**This twin describes the dashboard rather than mirroring it, because the pool
changes every time a contributor's feed syncs.** The page is built once per
deploy, and the event list arrives after load from `/serendipity/events.html`,
an HTML fragment with one card per event: its title, when and where, and a head
count of who's going. `/serendipity/event/<id>` is one event's page with its
guest list.

## The better door for an agent: MCP

The pool is queryable directly, so an agent doesn't have to read cards:

- MCP server: `https://aadhar.sh/serendipity/mcp`. Its card is at `https://aadhar.sh/.well-known/mcp/serendipity.json`, and
  `https://aadhar.sh/serendipity/mcp-info` lists the tools for a human.
- Tools: `list_events`, `get_event`, `search_people`, `list_contributors`, `contributor_events`, `frequent_people`, `co_attendees`, `connections`, `shared_events` and `stats`.
- `find_events` is also served by the site's own MCP server at
  `https://aadhar.sh/mcp`, for an agent that only knocks on one door.
- A skill describing how to use the pool lives at
  `https://aadhar.sh/.well-known/agent-skills/serendipity-events/SKILL.md`.

## Where the data comes from

Every event and guest list comes from a contributor's own Luma feed, synced on a
schedule. The pool is only as complete as the feeds people have contributed, so
an event missing from it says nothing about whether the event exists.
