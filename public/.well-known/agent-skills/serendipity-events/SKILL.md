---
name: serendipity-events
description: Query the public, read-only Serendipity event pool on aadhar.sh over MCP. Use it to find events, inspect one event, search public attendees, or count the pool.
---

# Serendipity events

Connect an MCP client to `https://aadhar.sh/serendipity/mcp`. The endpoint is
stateless, anonymous, and read-only. It exposes public event and attendee data;
it never returns private contact details or third-party session credentials.

## Tools

- `list_events`: list `upcoming`, `past`, or `all` events; optionally pass
  `query` and `limit`.
- `get_event`: read one event and its public attendees by `id`.
- `search_people`: find public attendees by `query`; optionally pass `limit`.
- `stats`: count events and public attendees.

Human documentation is at `https://aadhar.sh/serendipity/mcp-info`. The server
card is at `https://aadhar.sh/.well-known/mcp/serendipity.json`.
