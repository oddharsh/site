// run.mjs — code mode, step 2 (the local stand-in for the Worker Loader sandbox).
//
//   node codemode/run.mjs
//
// In production code mode, an LLM reads serendipity-api.d.ts and WRITES the body of
// task() below, which then runs in a fresh Worker Loader V8 isolate with `api` bound
// by RPC (closed beta). Here the same code runs in Node against the live, read-only,
// public endpoint. The point it demonstrates: a four-step question is answered by
// ONE round of code. Each tool's output feeds the next locally, instead of being
// copied back through an LLM between every call.
import * as api from "./serendipity-api.mjs";

async function task() {
  // 1. pool overview
  const pool = await api.stats();
  // 2. the tightest co-attendance pairs in the pool (real people who keep crossing paths)
  const pairs = (await api.connections({ min_shared: 3, limit: 5 })).pairs || [];
  const lead = pairs[0];
  const a = lead && lead.a && lead.a.name, b = lead && lead.b && lead.b.name;
  // 3. chained on that pair: for person A, who ELSE do they see most? (filter out B)
  const co = a ? ((await api.co_attendees({ q: a, limit: 6 })).co_attendees || []) : [];
  return {
    pool,
    tightest_pair: lead ? { a, b, shared_count: lead.shared, sample_events: (lead.shared_events || []).slice(0, 3) } : null,
    [`${a || "lead"}_also_sees`]: co.filter((c) => c.name !== b).slice(0, 4).map((c) => ({ who: c.name, shared: c.shared })),
  };
}

console.log("running a 4-step code-mode query against the live Serendipity MCP...\n");
task().then(
  (r) => console.log(JSON.stringify(r, null, 2)),
  (e) => { console.error("task failed:", e.message); process.exit(1); }
);
