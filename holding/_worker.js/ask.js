// ask.js — the natural-language door onto this site's tools.
//
// You type a sentence; something picks tools, calls them, and answers from what
// came back. That is exactly what an external agent pointed at this origin does,
// so the console runs the same loop and SHOWS ITS WORK: every tool it chose,
// the arguments it chose, and the request an agent would have made to do the
// same thing by hand. The answer is the smaller half of the output. Watching a
// machine decide which of seven doors to knock on is the part worth seeing, and
// it is the part every other agent surface on this site hides.
//
// ── grounding ─────────────────────────────────────────────────────────────
// The model may only speak from tool results. It gets no free-text knowledge of
// this site baked into the prompt, no retrieved prose, and no license to fill a
// gap from whatever it happens to know about a person with this name. When the
// tools return nothing, the honest answer is that the site does not say — and
// the frame prints the empty result alongside it, so a reader can see that the
// nothing was real. Same discipline as the photo pipeline's nullable fields:
// never fabricate, and show the gap rather than paper over it.
//
// ── a bounded catalog, not a shell ────────────────────────────────────────
// The console this answers into LOOKS like shell access, and it deliberately is
// not. The model may call seven declared tools and nothing else: a name outside
// the catalog is refused rather than dispatched, the arguments go through each
// tool's own JSON Schema, and every call is printed in the frame. That is the
// case for tool catalogs over command execution — they are auditable, and here
// the audit is the primary output rather than a log nobody reads.
//
// It is also why the catalog is worth reusing rather than reinventing: the same
// seven schemas are what /mcp advertises, so the blast radius of an ask is
// exactly the blast radius of the public MCP surface. Widening one widens the
// other, visibly, in one file.
//
// ── bounds ────────────────────────────────────────────────────────────────
// This is the one public route on the site that spends money per request, so it
// is bounded on four axes rather than one: query length, tool calls per ask,
// model rounds, and per-IP rate. A public LLM endpoint with none of those is a
// bill somebody else gets to write.
import { DATA_TOOLS, DATA_TOOL_NAMES, callDataTool, toolError } from "./lib/tools.js";

// callDataTool can THROW: a tool whose binding is missing (coffee with no
// BOOKINGS KV) or whose upstream is down raises rather than returning a value.
// /mcp survives that because JSON-RPC catches at the envelope and answers
// -32603, but an ask has no envelope — an uncaught throw here is a 500 for the
// whole question, and the other tools that succeeded go down with it. So every
// call in this file goes through here.
async function safeCall(name, args, request, env, ctx) {
  try { return await callDataTool(name, args, request, env, ctx); }
  catch { return toolError(`${name} is unavailable right now.`); }
}

export const ASK_BUDGET = { binding: "ASK_RL", max: 10 };

export const ASK_LIMITS = {
  query: 240,      // characters
  calls: 4,        // tool calls per ask, across all rounds
  rounds: 2,       // model turns that may request tools
  results: 2600,   // characters of tool JSON handed back to the model per call
};

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM = [
  "You are a research agent pointed at aadhar.sh, the personal site of Aadharsh Pannirselvam.",
  "Answer ONLY from the results of the tools you call. You have no other knowledge of this person or this site.",
  "If the tools return nothing relevant, say plainly that the site does not answer that. Never guess, never fill a gap from general knowledge, and never invent a photo, a note, a track, or a date.",
  "Call a tool when one can answer. Prefer search_site for anything about opinions, writing, or topics.",
  "Keep the final answer under 90 words, plain prose, no markdown, no bullet lists.",
].join(" ");

/**
 * The keyword router: what answers when no model is bound.
 *
 * Local dev and CI have no AI binding, and rather than 503 there, an ask still
 * runs — it just picks its one tool by keyword instead of by reasoning. That
 * keeps the route testable offline and keeps the console useful when the model
 * is unavailable, and the frame says WHICH mode produced the answer so the
 * difference is never silently glossed.
 *
 * Ordered, first match wins. search_site is the fallthrough because it is the
 * only tool that can say something about an arbitrary subject.
 */
const ROUTES = [
  [/\bhttps?:\/\/\S+/i, (q) => ["lens_inspect", { url: q.match(/\bhttps?:\/\/\S+/i)[0] }]],
  [/\b(coffee|bagel|meet|meeting|book|available|availability|calendar|schedule)\b/i, () => ["coffee_availability", {}]],
  [/\b(listen|listening|music|playing|song|songs|track|tracks|playlist|spotify|album|artist)\b/i, () => ["now_playing", {}]],
  [/\b(photo|photos|photograph|shot|shots|camera|lens|film|fuji|leica|acros|chrome|iso|aperture|recipe)\b/i, photoArgs],
  [/\b(neighbou?rhood|neighbors?|around|crawl|changed?|radar|vc|funds?)\b/i, () => ["change_radar", { limit: 10 }]],
];

// The film simulations actually in the archive. Named here because photo_query
// matches `film` as its own field, and routing "photos on classic chrome" to a
// free-text q instead would find nothing at all — see the note on photoArgs.
const FILMS = ["classic chrome", "nostalgic neg", "classic negative", "reala ace", "acros", "eterna", "provia", "velvia", "astia", "sepia", "monochrome"];

/**
 * photo_query matches `q` as ONE substring across the whole haystack, so a
 * multi-word phrase is almost guaranteed to miss: "photos shot classic chrome"
 * is not a substring of any caption. Two fixes, in order of precision: a named
 * film simulation goes to the `film` field where it belongs, and anything else
 * falls back to the single longest keyword rather than the whole phrase.
 * Measured before this: "photos shot on classic chrome" returned 0 of 42.
 */
function photoArgs(query) {
  const lower = String(query).toLowerCase();
  const film = FILMS.find((name) => lower.includes(name));
  if (film) return ["photo_query", { film, limit: 8 }];
  const words = keywords(query).split(" ").filter((w) => !/^photos?$|^shots?$|^photographs?$/.test(w));
  const best = words.sort((a, b) => b.length - a.length)[0] || "";
  return ["photo_query", best ? { q: best, limit: 8 } : { limit: 8 }];
}

// Strip the interrogative scaffolding so a whole question does not become the
// search term. "what photos did he shoot on acros" has to reach the index as
// "photos shoot acros", because these are substring matches over captions and
// metadata, not a search engine.
const STOP = new Set(("what whats whose which who where when why how is are was were do does did has have had "
  + "a an the of on in at to for with from about by and or any some show me tell find get list all your you "
  + "his him he her she they them i my this that these those can could would should will").split(" "));
function keywords(query) {
  return String(query).toLowerCase().split(/[^\p{L}\p{N}+-]+/u)
    .filter((word) => word.length > 1 && !STOP.has(word)).slice(0, 6).join(" ");
}

function routeByKeyword(query) {
  for (const [pattern, pick] of ROUTES) if (pattern.test(query)) return pick(query);
  return ["search_site", { q: keywords(query) || query.slice(0, 60), limit: 8 }];
}

/** Returns true when the caller is already over their per-minute ask budget. */
export async function overAskBudget(request, env) {
  const limiter = env && env[ASK_BUDGET.binding];
  if (!limiter || typeof limiter.limit !== "function") return false;
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  try { return !(await limiter.limit({ key: ip })).success; }
  catch { return false; }   // a limiter blip costs the limit, never the route
}

/**
 * A one-line human summary of a tool result, for the trace.
 *
 * Deliberately COUNTS rather than content. The trace's job is to show what the
 * agent did and how much it got back; the content belongs in the answer, and
 * repeating it twice in one frame makes an 80-column screen unreadable.
 */
function summarize(name, out) {
  if (!out || out._error) return out?._error || "failed";
  if (out._unknown) return "no such tool";
  const n = (v) => (Array.isArray(v) ? v.length : null);
  if (name === "search_site") return `${out.total ?? 0} match${out.total === 1 ? "" : "es"}`;
  if (name === "photo_query") return `${out.total ?? 0} frame${out.total === 1 ? "" : "s"}`;
  if (name === "now_playing") return out.available === false ? "playlist unavailable" : `${n(out.tracks) ?? 0} tracks`;
  if (name === "coffee_availability") return out.available ? `${n(out.slots) ?? 0} slots` : "unavailable (fails closed)";
  if (name === "change_radar") return `${n(out.changes) ?? 0} observations`;
  if (name === "lens_inspect") return `${out.status ?? "?"} · ${out.levelName || "?"} · ${out.doors ?? 0} doors`;
  if (name === "lens_compare") return "compared";
  return "ok";
}

/** What an agent would send to do this by hand — the reproducible form. */
export const asAgentCall = (name, args) =>
  `curl -sX POST aadhar.sh/mcp -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}'`;

// Workers AI wants JSON-Schema function definitions, which is what the MCP tool
// catalog already is. Reusing it rather than writing a second description of the
// same seven tools is the entire reason lib/tools.js exists.
const asFunctions = () => DATA_TOOLS.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
}));

/**
 * One model turn, over the Cloudflare REST API rather than the `ai` binding.
 *
 * The binding is the obvious way to do this and is what lwe-ask uses. It cannot
 * be used HERE: Workers AI has no local emulation, so wrangler opens a remote
 * proxy session for the binding at boot, `npm run routes:check` boots this
 * config, and a remote session needs a write-capable token that CI does not and
 * must not have. Measured 2026-08-05 — 106 routes green without the binding,
 * boot failure with it. The REST call needs no binding, so the oracle stays
 * green and the credential stays a Worker secret.
 *
 * Same shape as /ledger's Analytics Engine reads: CF_ACCOUNT_ID as a var, the
 * token as a secret, and the whole feature degrading rather than erroring when
 * the secret is absent.
 *
 * SCOPES: `Workers AI - Read` AND `Workers AI - Edit`, both account-level.
 * Inference is a POST and Cloudflare classes running a model as a write, so Read
 * alone 403s here — the dashboard's "Workers AI" token template sets both and is
 * the path to use. That makes this the first Worker secret on this site carrying
 * an Edit scope; ANALYTICS_READ_TOKEN and BILLING_READ_TOKEN are both Read-only.
 * The Edit is confined to Workers AI, which is its own permission: it cannot
 * publish a Worker, and it cannot reach KV, R2, or D1, each of which has its own
 * Read/Edit pair. And it never goes near GitHub — CLAUDE.md's rule is that the
 * CI token stays six reads, and this one lives on the Worker alone.
 */
async function callModel(env, body) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${env.ASK_MODEL || DEFAULT_MODEL}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.WORKERS_AI_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      // A model that hangs must not hold the console open. The router below is
      // a fine answer; a spinner is not.
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!res.ok) throw new Error(`workers-ai ${res.status}`);
  const payload = await res.json();
  return payload?.result || {};
}

const modelAvailable = (env) => !!(env && env.WORKERS_AI_TOKEN && env.CF_ACCOUNT_ID);

async function runModelLoop(query, request, env, ctx, steps) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: query }];

  for (let round = 0; round < ASK_LIMITS.rounds; round++) {
    const reply = await callModel(env, { messages, tools: asFunctions(), max_tokens: 512 });
    const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
    if (!calls.length) return String(reply?.response || "").trim();

    for (const call of calls) {
      if (steps.length >= ASK_LIMITS.calls) break;
      // Workers AI has shipped both shapes across model families: a flat
      // {name, arguments} and OpenAI's nested {function:{name, arguments}},
      // with arguments as either an object or a JSON string. Normalizing here
      // rather than trusting one shape is what stops a model swap from
      // silently turning every ask into a no-tool answer.
      const name = call?.function?.name || call?.name;
      const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
      let args = rawArgs;
      if (typeof rawArgs === "string") { try { args = JSON.parse(rawArgs); } catch { args = {}; } }
      if (!DATA_TOOL_NAMES.has(name)) { steps.push({ tool: String(name).slice(0, 40), args: {}, summary: "no such tool", refused: true }); continue; }

      const out = await safeCall(name, args, request, env, ctx);
      steps.push({ tool: name, args, summary: summarize(name, out) });
      messages.push({ role: "assistant", content: "", tool_calls: [call] });
      messages.push({ role: "tool", name, content: JSON.stringify(out).slice(0, ASK_LIMITS.results) });
    }
    if (steps.length >= ASK_LIMITS.calls) break;
  }

  // Out of rounds with tools still pending: ask once more for prose only, so a
  // model that would happily keep calling tools forever still produces an answer.
  const final = await callModel(env, {
    messages: [...messages, { role: "user", content: "Answer now, from the tool results above only." }],
    max_tokens: 512,
  });
  return String(final?.response || "").trim();
}

/**
 * Run one ask. Never throws: every failure becomes a mode the frame can print,
 * because this route is reached from a console where a stack trace is worse
 * than a sentence.
 */
export async function runAsk(query, request, env, ctx) {
  const question = String(query || "").trim().slice(0, ASK_LIMITS.query);
  if (!question) return { question: "", mode: "empty", steps: [], answer: "" };

  if (await overAskBudget(request, env)) {
    return { question, mode: "limited", steps: [], answer: `Asks are rate-limited to ${ASK_BUDGET.max}/min per address. The tools underneath are not — call them directly at /mcp.` };
  }

  const steps = [];
  if (modelAvailable(env)) {
    try {
      const answer = await runModelLoop(question, request, env, ctx, steps);
      if (answer) return { question, mode: "model", steps, answer };
      // A model that answered with nothing is a failure, not an empty answer.
      // Fall through to the router rather than print a blank frame.
    } catch {
      // and likewise for a model that errored mid-loop: the tools still work.
    }
  }

  const [tool, args] = routeByKeyword(question);
  const out = await safeCall(tool, args, request, env, ctx);
  steps.push({ tool, args, summary: summarize(tool, out) });
  return {
    question,
    mode: modelAvailable(env) ? "router-fallback" : "router",
    steps,
    answer: "",
    result: out,
  };
}
