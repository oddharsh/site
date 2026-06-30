# code mode for the Serendipity MCP (a spike)

A try at Cloudflare's [code mode](https://blog.cloudflare.com/code-mode/) against the
live [Serendipity MCP](https://aadhar.sh/serendipity/mcp). The bet behind code mode:
LLMs write code far better than they chain tool calls, so instead of exposing MCP
tools as direct tool-calls, you hand the model a typed API and let it write a program
that calls it. Intermediate results stay in the sandbox instead of being copied back
through the model between every step.

## What's here

- **`codegen.mjs`** fetches the live MCP's `tools/list` and generates a typed client:
  `serendipity-api.mjs` (runnable) plus `serendipity-api.d.ts` (the types the model
  reads). One documented function per tool, straight from the real JSON Schemas. This
  is the half of code mode that needs no special runtime.
- **`serendipity-api.{mjs,d.ts}`** the generated output (10 tools: `list_events`,
  `get_event`, `search_people`, `frequent_people`, `co_attendees`, `connections`,
  `shared_events`, `stats`, `list_contributors`, `contributor_events`).
- **`run.mjs`** the stand-in for the production sandbox. It runs a 3-step relational
  query (`stats` -> `connections` -> `co_attendees`) as one program, branching on each
  result locally. In real code mode an LLM writes this body from the `.d.ts`; here it
  runs in Node against the live, read-only, public endpoint.

## Run it

```
node codemode/codegen.mjs   # regenerate the typed client from the live schema
node codemode/run.mjs       # run the multi-step query against the live MCP
```

Sample output: the tightest co-attendance pair in the pool (13 shared events), then
who else the first person crosses paths with most. Three tool calls, one round of
code, zero model round-trips between them.

## What's real vs gated

The codegen and the composition pattern work today. The production piece, running the
model's code in a fresh isolated **Worker Loader** V8 isolate with the MCP bound by
RPC (so the code never gets raw network access or sees keys), is in Cloudflare's
**closed beta**; only local `workerd`/wrangler can run it right now. This spike uses
Node as the sandbox stand-in to prove the rest.

## Why it fits Serendipity

The pool is relational: events, people, and who-overlaps-with-whom. The interesting
questions are multi-hop ("find the tightest pair, then who else each of them sees,
then the events they share"), which is exactly where chained tool-calling wastes
tokens copying rosters back and forth and where a few lines of code do not. The tools
are read-only and public, so the sandbox needs no secrets, which is the easy case for
code mode. When Worker Loader opens up, the move is to bind this generated client into
a loader isolate and let an agent write the query.
