import { BOT_UA, botHeaders } from "./lib/botauth.ts";
import { cachedRender } from "./lib/cache.ts";
import { CANONICAL_HOST } from "./lib/const.ts";
import { fetchFollowingPublicRedirects, privateHostBlocked, readResponseCapped, validateLensTarget } from "./lib/crawl.ts";
import { unsafeHtml } from "./lib/html.ts";
import { lensParseRobots, lensPathMatch, lensRobotsVerdict } from "./lib/robots.ts";
import { lunaPage } from "./lib/chrome.ts";
import { escAttr, escHtml, jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { documentTally, hasRenderEngine, runBrowserAction } from "./lens-render.ts";
import { lensRecipe, lensRecipeCatalog, lensRecipeIds, lensRecipeNonce, lensRecipeReceipt, lensRecipeScript } from "./lens-recipes.ts";
import { EXECUTION_META, executionChecks } from "./lib/agent-execution.ts";
import { asRecord, asText, isCallable } from "./lib/parse.ts";
import { overBudget } from "./lib/ratelimit.ts";

// The glossary. This page's whole subject is protocol names, which is fine for
// the audience that already has them and a wall for the audience that doesn't.
// Every definition here is written for someone who has never read a spec: plain
// sentence first, and a definition may lean only DOWNWARD, on the umbrella terms
// below (structured data, entity, markup, parser). Two schemes must never
// explain each other, because a reader meeting one of them has met neither.
//
// `plain` is the one-liner. `more` is the second sentence the hover adds, and
// is optional — several terms are genuinely one sentence and padding them would
// be worse. Keys are stable ids, so the same definition can be attached from the
// worker's SSR and from the client's rendered checks without a second copy.
export const LENS_GLOSSARY = {
  "llms-txt": {
    label: "llms.txt",
    plain: "A plain-text file a site publishes to tell AI models what it is about and where its real content lives.",
    more: "A welcome sign written for machines instead of people. About 1 in 18 of the top sites has one.",
  },
  mcp: {
    label: "MCP",
    plain: "Model Context Protocol: a common plug shape that lets an AI assistant use an outside tool or data source.",
    more: "It won the tool layer the way USB won cables. One protocol, and everything speaks it.",
  },
  x402: {
    label: "x402",
    plain: "A way for software to pay software, a few cents at a time.",
    more: "It revives an unused \"payment required\" code from the early web, so a bot can pay for a page instead of being blocked.",
  },
  "robots-txt": {
    label: "robots.txt",
    plain: "A file at the root of a site listing which automated visitors may fetch what.",
    more: "A posted rule, not a lock. Polite crawlers obey it; rude ones ignore it and nothing stops them.",
  },
  sitemap: {
    label: "sitemap.xml",
    plain: "A machine-readable table of contents listing every page a site wants found.",
  },
  "dns-aid": {
    label: "DNS-AID",
    plain: "A proposed way to announce, in the internet's phone book, that a domain offers services built for AI agents.",
    more: "Proposed in 2026 and barely deployed anywhere, so a site failing this check is in almost everyone's company.",
  },
  "link-headers": {
    label: "Link headers",
    alt: ["Link relations"],
    plain: "Pointers a server attaches to a response saying \"the site map is here, the docs are there.\"",
    more: "A machine reads them without downloading or parsing the page itself.",
  },
  "md-nego": {
    label: "Markdown negotiation",
    alt: ["text/markdown"],
    plain: "Serving the same page as clean, plain text when a machine asks for it, while people still get the normal page.",
    more: "Far cheaper for a model to read, and much harder for it to misread.",
  },
  "content-signals": {
    label: "Content Signals",
    alt: ["Content-Signal"],
    plain: "Lines in a site's robots file saying what a crawler may DO with the content: train on it, answer questions with it, or only index it.",
  },
  dnssec: {
    label: "DNSSEC",
    plain: "Cryptographic signing for the internet's phone book, so the answer you get back cannot be forged along the way.",
  },
  token: {
    label: "tokens",
    plain: "The unit AI models read and bill by, roughly three-quarters of a word.",
    more: "Messy HTML burns far more of them than clean text, which is why the same page can cost wildly different amounts to read.",
  },
  agent: {
    label: "agent",
    plain: "Software that acts on your behalf rather than just showing you a page: it reads, decides, and does.",
  },
  bot: {
    label: "bots",
    alt: ["bot", "crawlers", "crawler"],
    plain: "Automated visitors. They request pages like a browser does, but nobody is watching the screen.",
    more: "They are feeding a search index or an AI model. As of 2026 they make more of the web's requests than people do.",
  },
  "browser-run": {
    label: "Browser Run",
    plain: "This page's own term: fetching the URL with a real headless Chrome, so the site's JavaScript actually runs.",
    more: "A plain fetch sees only the file the server sent. Many sites look empty until the JavaScript fills them in.",
  },

  // ── the umbrella terms ────────────────────────────────────
  // These sit ABOVE the schemes below, and they were the gap: someone meeting
  // "JSON-LD" cold has usually never met "structured data" or "entity" either,
  // so the scheme definitions were leaning on vocabulary the reader was missing.
  // Defining the umbrella once lets each scheme stay one sentence about what
  // makes IT different, which is the shape those definitions already wanted.
  "semantic-web": {
    label: "semantic web",
    alt: ["semantic-web"],
    plain: "The 2000s project to have every site publish its facts in one shared format, so software could answer questions across the whole web.",
    more: "It asked publishers to do the work up front. Most never did, and models now read the human page and pay the difference.",
  },
  "structured-data": {
    label: "structured data",
    plain: "Facts a page states about itself in a fixed format, instead of leaving a reader to work them out from the writing.",
    more: "The price, the author, the date. A person picks those out of the layout; software needs them written down separately.",
  },
  entity: {
    label: "entity",
    alt: ["entities"],
    plain: "A specific thing a page is about: a person, a product, an event, a place.",
    more: "Naming one outright is what lets software tell two people with the same name apart.",
  },
  rdf: {
    label: "RDF",
    alt: ["RDF triples", "triples"],
    plain: "A way of writing every fact as three parts: a thing, one of its properties, and the value.",
    more: "\"This page, author, Ada\" is one triple. Chain enough of them and the result is something software can query.",
  },
  markup: {
    label: "markup",
    plain: "The tags wrapped around a page's words saying what each part is: a heading, a link, an image, a paragraph.",
    more: "It carries no meaning of its own. A heading is marked as a heading whether it says anything or not.",
  },
  parser: {
    label: "parser",
    plain: "The piece of software that reads a file and works out its structure before anything else can use it.",
  },
  w3c: {
    label: "W3C",
    plain: "The World Wide Web Consortium, the body that has published the web's core standards since 1994.",
    more: "It writes the specification. Whether browsers and sites then implement it is a separate question, and often the answer is no.",
  },
  "meta-tags": {
    label: "meta tags",
    alt: ["meta tag"],
    plain: "Lines in a page's header that describe it to software: a summary, an author, instructions for search engines.",
    more: "Invisible on screen, and still the first thing most automated visitors read.",
  },
  "rich-results": {
    label: "rich results",
    plain: "Search listings that show more than a blue link: star ratings, prices, cooking times, event dates.",
    more: "They are the payoff that got publishers to mark their pages up at all.",
  },
  indieweb: {
    label: "IndieWeb",
    plain: "A loose movement of people who publish on their own domains and wire the pieces together with small agreed conventions.",
    more: "It favors what one person can ship this weekend over what a committee can ratify.",
  },

  // ── the tagging schemes ─────────────────────────────────────────────────
  // Four ways to say the same thing, which is most of why none of them won.
  // Each definition stands alone rather than describing itself against the
  // others, because a reader meeting "RDFa" for the first time has not met
  // JSON-LD either.
  "json-ld": {
    label: "JSON-LD",
    plain: "A block of machine-readable facts a page carries about itself: who wrote it, what it sells, when it was published.",
    more: "A parser reads those facts straight off the page instead of inferring them from the prose around them.",
  },
  "schema-org": {
    label: "Schema.org",
    plain: "The shared vocabulary most structured data uses, so a recipe on one site and a recipe on another describe themselves the same way.",
    more: "Google, Microsoft, Yahoo and Yandex agreed on it in 2011, which is most of why it stuck.",
  },
  microdata: {
    label: "microdata",
    plain: "An older way of tagging facts by adding attributes to the page's existing HTML rather than shipping a separate block.",
    more: "It survives on plenty of older pages, and few new sites add it.",
  },
  rdfa: {
    label: "RDFa",
    plain: "Another in-page tagging scheme, from the era when the web tried to describe itself in one formal language.",
    more: "Rare on new pages and still common across academic and government sites.",
  },
  microformats: {
    label: "microformats",
    plain: "Ordinary CSS class names, agreed by convention, that mark a person, an event, or a link so software can pick it out.",
    more: "The lightest of the schemes here: no extra block, no vocabulary to look up.",
  },
  "open-graph": {
    label: "Open Graph",
    alt: ["Twitter card"],
    plain: "The handful of tags deciding what a link looks like when somebody pastes it into a chat app.",
    more: "The one piece of the semantic web nearly everybody shipped, because the payoff showed up the same afternoon.",
  },

  // ── the doors ───────────────────────────────────────────────────────────
  openapi: {
    label: "OpenAPI",
    plain: "A written description of a web API: every operation it offers, what each one takes, and what it gives back.",
    more: "Built so developers could generate client code from it. Models now read it to work out what they are allowed to call.",
  },
  "agent-card": {
    label: "agent card",
    alt: ["agent-card"],
    plain: "A small file at a known address describing what an automated service can do and how to talk to it.",
    more: "A business card left at the front door, so visiting software has something to read before it starts guessing.",
  },
  a2a: {
    label: "A2A",
    plain: "Agent2Agent: a protocol for two pieces of autonomous software to find each other and split a task between them.",
    more: "Announced in 2025 with 50-odd organizations behind it, and still far smaller in practice than the tool-calling layer.",
  },
  nlweb: {
    label: "NLWeb",
    plain: "A proposal that a site answer questions about itself in plain language, instead of making software read its pages first.",
  },
  webmcp: {
    label: "WebMCP",
    plain: "A way for a page to hand the browser a list of things it can do, so an assistant working in that tab can use them.",
    more: "The tools live inside the page the visitor already has open, rather than on a server somewhere else.",
  },
  "api-catalog": {
    label: "API catalog",
    alt: ["linkset"],
    plain: "A published index of every API a site offers, at a fixed address, so software can find them without being told where to look.",
  },

  // ── identity, permission, cost ──────────────────────────────────────────
  oauth: {
    label: "OAuth",
    plain: "The sign-in handoff where you approve one app to do specific things on your behalf, and can withdraw that later.",
    more: "It is what turns \"this software can act as me\" into a decision somebody made on purpose.",
  },
  "web-bot-auth": {
    label: "Web Bot Auth",
    plain: "A way for a bot to cryptographically prove it is the bot it claims to be, so a site can trust the name on the request.",
    more: "Without it, anything can call itself Googlebot, and plenty of things do.",
  },
  "user-agent": {
    label: "user agent",
    // The page's own prose spells it hyphenated everywhere ("six representative
    // crawler user-agents"), so the unhyphenated label alone never once matched
    // and this definition had been unreachable since it was written.
    alt: ["user-agents", "user-agent"],
    plain: "The name a visitor's software gives when it asks for a page. A browser, a crawler, or a model can each set its own.",
    more: "Nothing checks it, so an unverified name is a claim rather than evidence.",
  },
  "third-party": {
    label: "third-party",
    plain: "Everything a page loads from somebody other than the site you visited: ad networks, analytics, fonts, trackers.",
    more: "On a typical commercial page that is most of the weight and none of the words.",
  },

  // ── how the page is actually read ───────────────────────────────────────
  "reader-mode": {
    label: "reader mode",
    alt: ["Readability", "extractor"],
    plain: "Software that guesses which part of a page is the article and throws away everything else.",
    more: "It does well on a news story and badly on anything that is not one, which is what makes the gap worth measuring.",
  },
  cdp: {
    label: "CDP",
    alt: ["Chrome DevTools Protocol"],
    plain: "The control channel Chrome's own developer tools speak, which lets software drive a browser and watch every request it makes.",
  },
  ech: {
    label: "ECH",
    plain: "Encrypted Client Hello: it hides which site you asked for from anyone watching the connection being set up.",
    more: "Without it the site's name travels in the clear even though everything after it is encrypted.",
  },
  "compression-dictionary": {
    label: "compression dictionary",
    plain: "A file the browser already holds that a server can compress against, so the next version arrives as a small patch.",
    more: "A repeat visit downloads the parts that changed rather than the whole page again.",
  },
};

// Wrap known glossary terms in the hover markup. Input MUST already be escaped:
// this inserts real tags, and it is only safe because escHtml has already
// removed every < and > the source string could have carried.
//
// First occurrence per term per string, longest spelling first so "llms.txt" is
// never eaten by a shorter overlapping match. A term may carry `alt` spellings,
// because the checks say "Link relations" where the glossary says "Link headers"
// and one definition should serve both.
//
// Boundaries are hand-rolled: \b is useless against labels carrying dots, digits
// and slashes (llms.txt, x402, text/markdown). Leading guard is "not a word char,
// dot or dash". Trailing is TWO lookaheads, both load-bearing and both learned
// from a failing case:
//   (?!\w)    refuses llms.txtfoo, but must NOT include "-", or "DNSSEC-signed"
//             stops matching DNSSEC. A term used as a compound modifier is still
//             the term.
//   (?!\.\w)  refuses sitemap.xml.gz while still letting "robots.txt." at the end
//             of a sentence through, which the naive version got wrong.
const LENS_SPELLINGS = Object.keys(LENS_GLOSSARY)
  .flatMap((key) => [LENS_GLOSSARY[key].label, ...(LENS_GLOSSARY[key].alt || [])].map((s) => [key, s]))
  .sort((a, b) => b[1].length - a[1].length);

// ONE LEFT-TO-RIGHT PASS OVER THE SOURCE, and that is the load-bearing part
// rather than a style preference. The old version looped the terms and re-matched
// against its own accumulating OUTPUT, so every tag it inserted became fair game
// for the next term. That was harmless only while no term's spelling appeared
// inside another term's markup, and it stopped being harmless the moment
// "agent-card" joined a glossary that already had "agent": the emitted
// data-t="agent-card" contains "agent", the leading guard admits a quote and the
// trailing one deliberately admits a hyphen, so the second pass wrapped a fragment
// of the first pass's attribute and produced nested garbage on screen.
//
// Matching against `src` and emitting into `out` makes that structurally
// impossible: nothing this function writes is ever read back. Attribute VALUES
// are equally safe, which matters because a definition can name another term.
//
// Semantics kept: one definition per key per string, leftmost match wins, and on
// a tie the longer spelling wins (LENS_SPELLINGS is sorted longest-first, so the
// longer one claims the position before the shorter one is tried).
export function glossify(escaped, only?) {
  const src = String(escaped);
  const pairs = only
    ? LENS_SPELLINGS.filter(([key]) => only.indexOf(key) !== -1)
    : LENS_SPELLINGS;
  const seen = new Set();
  let out = "";
  let pos = 0;
  for (;;) {
    let best: { key: any, spelling: string, index: number, m: RegExpMatchArray } | null = null;
    for (const [key, spelling] of pairs) {
      if (seen.has(key)) continue;       // one definition per string, not one per spelling
      const re = new RegExp("(^|[^\\w.-])(" + spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?!\\w)(?!\\.\\w)");
      const m = src.slice(pos).match(re);
      if (!m) continue;
      const at = pos + m.index + m[1].length;
      if (!best || at < best.at) best = { at, key, text: m[2] };
    }
    if (!best) break;
    seen.add(best.key);
    // The title is the no-JS / touch fallback and what a screen reader reads.
    // On a hover-capable pointer the client strips it the moment the richer
    // surface is live, so the two tips never stack on one word.
    out += src.slice(pos, best.at) +
      '<abbr class="lx-term" data-t="' + escAttr(best.key) + '" title="' + escAttr(LENS_GLOSSARY[best.key].plain) + '">' + best.text + "</abbr>";
    pos = best.at + best.text.length;
  }
  return out + src.slice(pos);
}

// Per-IP crawl budgets, one place. These used to be inlined at each call site,
// which was fine until /mcp grew tools that call the same crawler: sharing one
// counter is the whole point, because a second unmetered door (30 via
// /lens/fetch AND unlimited via JSON-RPC) is not a rate limit.
//
// `max` is duplicated from wrangler.jsonc's `ratelimits` on purpose: it is the
// number the 429 message quotes, and a message that disagrees with the ceiling
// is worse than no message. A contract test pins the two together so they cannot
// drift, which is the only reason duplicating it is safe.
// How many bytes of a document lens will PARSE, as distinct from how many it
// will fetch (2MB, above). See the measured table at the parse phase: the
// regex chains run ~32ms/MB, so this constant is the single knob that decides
// whether a scan fits a CPU ceiling.
//
// 256 KB (~8ms) bounds the worst case without touching the median page. Drop it
// to 64 KB (~3.2ms) to fit the Workers FREE plan's 10ms-per-invocation ceiling,
// which leaves headroom for everything else in the request.
export const LENS_PARSE_CAP = 256 * 1024;

// Browser Run's FREE plan allows one Quick Action every 10 seconds ACCOUNT-WIDE
// (6/min), 3 concurrent browsers, and 10 minutes of browser time a day.
// Measured 2026-08-06: two Quick Actions ~2s apart, and the second came back
// 429. The per-IP ceilings below were written against no such limit — `shot`
// alone allowed 8/min to a SINGLE visitor, so one person could spend the whole
// account's minute and the next visitor got a failure that read like a bug.
export const BROWSER_FREE_PLAN = { perMinute: 6, perDayMinutes: 10, concurrent: 3 };

export const LENS_BUDGETS = {
  inspect: { binding: "LENS_RL_INSPECT", max: 30 },
  shot:    { binding: "LENS_RL_SHOT",    max: 3  },
  compare: { binding: "LENS_RL_COMPARE", max: 4  },
  browser: { binding: "LENS_RL_BROWSER", max: 3  },
  wire:    { binding: "LENS_RL_WIRE",    max: 2  },
  tools:   { binding: "LENS_RL_TOOLS",   max: 10 },
  // Tighter than the catalogue read it sits beside, and deliberately so: a
  // catalogue read costs a foreign server a lookup, and an /ask costs it a
  // retrieval and possibly a model call.
  nlweb:   { binding: "LENS_RL_NLWEB",   max: 4  },
  // Ten plain GETs of one URL per run, deduped by Accept string. No browser
  // and no model, so it is cheaper than the tabs above it on OUR side; what it
  // spends is somebody else's bandwidth, ten times over, on one page. Sat
  // between the catalogue read and the /ask question for that reason.
  markdown: { binding: "LENS_RL_MARKDOWN", max: 4 },
  // The shared ceiling. Keyed on a CONSTANT rather than the caller's IP, so
  // every browser-consuming route bills against one bucket and no single
  // visitor can spend the account's allowance.
  //
  // Honest about what this is: the Rate Limiting binding counts per COLO, so a
  // fixed key buys per-colo-global, not truly account-wide. Traffic spread over
  // N colos can still total N x max. That is a large improvement over per-IP and
  // is not a guarantee — the guarantee is the 429 handling below, which treats
  // an upstream refusal as a normal outcome rather than a fault.
  browserAll: { binding: "LENS_RL_BROWSER_ALL", max: 4, key: "browser-run" },
};

// Returns true when the caller is already over their per-minute budget.
//
// The implementation moved to lib/ratelimit.ts when /mcp and /webmention became
// the second and third surfaces to need it. Re-exported under the lens name
// because twenty call sites across eight modules read
// `overLensBudget(LENS_BUDGETS.x, ...)`, and renaming those is a sweep rather
// than part of moving the function.
export const overLensBudget = overBudget;

// ── /lens — "the other web" -----------------------------------------------
// A URL goes in; what a MACHINE sees comes out, across five lenses: page
// anatomy (raw HTML, headers, headings, stripped text), structured/semantic
// data (JSON-LD, microdata, RDFa, microformats, OG/Twitter), the LLM/AI view
// (a markdown rendering + crawler directives), the TERMS the site sets for
// machines (per-bot robots verdicts, Content-Signal, price + enforcement,
// the open → signaled → enforced → paid spectrum), and site-level discovery
// files (robots.txt, sitemap.xml, llms.txt, feeds). The fetch is server-side
// (CORS blocks the browser), guarded against SSRF, capped in time + size, and
// made honestly as AadharshBot. Engine here; the /lens page (handleLens) is the UI.

// /lens — the SSR shell: IE6 address bar, a Human/Machine view toggle, the
// six lens tabs, two panes, seeded examples. The renderer lives in /lens.js
// (a real static file, cached like nav.js) so it can use normal JS without
// fighting this template literal's ${} and backticks.
// the /lens shell is static when it has no target. A shareable ?url= request is
// intentionally inspected server-side and seeded with the same HTML floor as
// /lens/fetch, so no-JS visitors still get a useful result. The empty shell is
// keyed on the bare path and remains cacheable; targeted inspections are
// private because they spend the crawler budget and contain third-party data.
export async function handleLens(request, env, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const vs = url.searchParams.get("vs");
  if (target && vs) {
    // Head-to-head: ?url=A&vs=B renders both sites through one rubric, SSR'd
    // for the same reason single scans are — a shared compare link should show
    // its result without JavaScript. Same budget as /lens/compare (they are
    // the same two full inspections).
    const result = await compareLensRequest(request, env, ctx, target, vs);
    const response = renderLensShell(null, lensState(url), target, { vsValue: vs, payload: result.payload });
    response.headers.set("cache-control", "no-store, must-revalidate");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }
  if (target) {
    const result = await inspectLensRequest(request, env, ctx);
    const response = renderLensShell(result.payload, lensState(url), target);
    response.headers.set("cache-control", "no-store, must-revalidate");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }
  // Keep a route-local shell key: the production runtime may not expose
  // CF_VERSION_METADATA, so a deploy can otherwise leave an older shell in
  // the edge cache while the separately served lens.js has already changed.
  return cachedRender(request, ctx, () => renderLensShell(), "/lens-shell-v4", env);
}

// One label per lens, shared by the SSR tabs, the SSR machine header, and the
// client (LENS_LABEL in lens.js must match). These are phrased as the question
// each lens answers, not practitioner nouns, so a first-time visitor can read
// the tab row as a menu of questions. Change here + in src/client/lens.js together.
const LENS_TAB_LABELS = {
  readiness: "Agent-ready?",
  anatomy: "Raw response",
  reader: "Reader's guess",
  wire: "What it costs",
  structured: "What it claims",
  ai: "Model cost",
  terms: "Who's allowed",
  discovery: "Agent doors",
  tools: "What it accepts",
  nlweb: "What it answers",
  markdown: "What agents get",
};

// Tab ORDER is evidence to verdict: raw observation first (the default lens, so
// the first tab is the selected one on load), Agent-ready? last as the capstone.
// `reader` sits second on purpose — it is one reader-mode extractor's opinion of
// the very bytes the tab before it just showed, and the pairing is what makes
// the gap between them legible. The tab strip renders from this array, so the
// order lives in one place rather than in eight hand-written buttons.
//
// `tools` sits directly after `discovery` for the same pairing reason: discovery
// KNOCKS on /mcp and infers a verdict from a status code, and tools walks
// through and reads the catalogue. Door then room.
//
// `wire` sits third for the same pairing reason one step out. The first two tabs
// argue about what the DOCUMENT is; wire is the first tab that is not about the
// document at all, and putting it directly after them is what makes "all of that
// argument was 4% of what the page actually cost you" land.
//
// `nlweb` completes that pairing rather than starting a new one. `discovery`
// knocks on /ask and reads a status code, `tools` walks through /mcp, and this
// walks through /ask: door, room, room. It sits last before the capstone because
// it is the only tab that asks the origin a QUESTION, which is also why it is
// the only one that never fires on its own.
// `markdown` closes the same door-then-room run. The discovery tier already
// knocks on Markdown negotiation and keeps ONE boolean from it: `lensProbeMdNego`
// reads the content-type and cancels the body without ever looking at what came
// back. This walks through, replays the Accept header seven named agent clients
// actually send, and reports which representation each one got. The boolean and
// the tab disagree often enough to be worth both: an origin can flip its
// content-type for a bare `text/markdown` and still hand Claude Code HTML.
export const LENS_TAB_ORDER = ["anatomy", "reader", "wire", "structured", "ai", "terms", "discovery", "tools", "nlweb", "markdown", "readiness"];

function lensState(url) {
  const validViews = ["both", "human", "machine", "browser", "delta"];
  const validLenses = LENS_TAB_ORDER;
  const view = validViews.includes(url.searchParams.get("view")) ? url.searchParams.get("view") : "both";
  // Default lens is the raw observation, not the readiness report. Compare's
  // premise is "one URL, three readers", and the middle pane defaulting to a
  // report card made it page | analysis | render. The score still leads: it
  // rides the verdict strip above the pane. Must match lens.js.
  const lens = validLenses.includes(url.searchParams.get("lens")) ? url.searchParams.get("lens") : "anatomy";
  const counterfactuals = {};
  for (const key of (url.searchParams.get("cf") || "").split(",")) {
    if (["markdown", "semantic", "contract", "authority", "receipt", "dictionary", "ech"].includes(key)) counterfactuals[key] = true;
  }
  return { view, lens, counterfactuals };
}

function lensScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function lensHttpText(status) {
  if (status >= 200 && status < 300) return "OK";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 402) return "Payment Required";   // the x402 chip's whole point; a bare "client error" is the least useful label for the demo the page ships to showcase 402
  if (status === 404) return "Not Found";
  if (status >= 400 && status < 500) return "client error";
  if (status >= 500) return "server error";
  return "";
}

function lensReaderFragment(data, note?) {
  if (!data || !data.ok) return '<div class="lx-empty">' + escHtml((data && data.error) || "No page to show.") + "</div>";
  const a = data.anatomy;
  let out = note ? '<div class="lx-fallback-note">' + escHtml(note) + "</div>" : "";
  if (!a) return out + '<div class="lx-empty">No readable text either.</div>';
  const title = data.structured && data.structured.title || "";
  if (title) out += '<div class="lx-h-title">' + escHtml(title) + "</div>";
  if (a.headings && a.headings.length) {
    out += '<div class="lx-h-outline"><b>Document outline</b><br>';
    for (const h of a.headings.slice(0, 60)) {
      out += '<div style="padding-left:' + ((h.level - 1) * 12) + 'px"><span style="color:#9aa">h' + h.level + "</span> " + escHtml(h.text) + "</div>";
    }
    out += "</div>";
  }
  return out + '<div class="lx-h-text">' + escHtml(a.text || "(no extractable text)") + "</div>";
}

function lensHumanFragment(data) {
  if (!data || !data.ok) return lensReaderFragment(data);
  if (data.framable) {
    return '<iframe class="lx-frame" src="' + escAttr(data.finalUrl) +
      '" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"' +
      ' referrerpolicy="no-referrer-when-downgrade" loading="lazy"></iframe>';
  }
  return lensReaderFragment(data, (data.frameReason ? "Framing refused (" + data.frameReason + ")." : "Embedding is blocked.") + " JavaScript can request a machine's render to stand in; this is the readable fallback.");
}

function lensMachineFragment(data, state) {
  if (!data || !data.ok) return '<div class="lx-empty">' + escHtml((data && data.error) || "No evidence yet.") + "</div>";
  const a = data.anatomy || {};
  const s = data.structured || {};
  const d = data.discovery || {};
  const ag = data.agent || {};
  const rows = [
    ["url", data.finalUrl || data.url],
    ["title", s.title || "(untitled)"],
    ["response", data.status + " " + lensHttpText(data.status)],
    ["Lens field evidence", data.readiness && data.readiness.field && data.readiness.field.overall != null ? data.readiness.field.overall + "/100" : "unknown"],
    ["local standards mirror", data.readiness && data.readiness.overall != null ? data.readiness.overall + "/100" : "unknown"],
    ["content-type", data.contentType || "(none)"],
    ["payload", (a.rawBytes || 0) + " B" + (data.truncated ? " (capped)" : "")],
    ["headings", a.headings ? a.headings.length : 0],
    ["fetched as", data.fetchedBy || "identified bot"],
  ].map(row => '<tr><td>' + escHtml(row[0]) + '</td><td>' + escHtml(row[1]) + "</td></tr>").join("");
  const doors = ag.strategy && ag.strategy.verdict || "unknown";
  const files = [
    d.robotsTxt && d.robotsTxt.ok ? "robots.txt" : "",
    // Same rule the readiness check uses: an HTML page answering 200 at the
    // sitemap URL is not a sitemap, so it does not get listed as one here.
    lensSitemapVerdict(d.sitemapXml).valid ? "sitemap.xml" : lensSitemapVerdict(d.sitemapDeclared).valid ? "sitemap (declared in robots.txt)" : "",
    d.llmsTxt && d.llmsTxt.ok ? "llms.txt" : "",
  ].filter(Boolean);
  return '<div class="lx-brief-lede"><b>Server-rendered machine summary.</b> JavaScript can enhance this into the full selected lens; this fragment is the no-script evidence floor.</div>' +
    '<div class="lx-sec"><div class="lx-sec-h">Observed document <span class="lx-badge ok">observed</span></div>' +
    '<div class="lx-cap">The minimum contract a machine can recover from this response.</div><table class="lx-kv">' + rows + "</table></div>" +
    '<div class="lx-sec"><div class="lx-sec-h">Available surfaces <span class="lx-badge">' + escHtml(doors) + "</span></div>" +
    '<div class="lx-cap">Evidence found during the server-side inspection.</div><div class="lx-tags">' +
    (files.length ? files.map(file => '<span class="lx-tag">' + escHtml(file) + "</span>").join("") : '<span class="lx-none">no discovery files found</span>') +
    "</div></div>" +
    '<div class="lx-sec"><div class="lx-sec-h">Selected state <span class="lx-badge">' + escHtml(state.lens) + "</span></div>" +
    '<div class="lx-cap">View: ' + escHtml(state.view) + ". The browser enhancement can open the complete lens without changing the URL.</div></div>";
}

function lensBrowserFragment(data) {
  if (!data || !data.ok) {
    return '<div class="lx-browser-intro"><b>Browser Run view.</b> Ask Cloudflare to open this URL in a real headless browser and return the rendered page, screenshot, Markdown, accessibility tree, and a clear WebMCP lab boundary.' +
      '<div class="lx-cap">This is opt-in: browser execution is slower and can run page JavaScript. Runtime WebMCP discovery is reported separately and requires the Chrome-beta lab.</div>' +
      '<button class="lx-browser-run" type="button" id="lx-browser-run">Run Browser Run snapshot</button></div>';
  }
  return '<div class="lx-browser-intro"><b>Browser Run snapshot ready.</b> The Browser pane is a rendered observation, separate from AadharshBot\'s HTTP fetch and the visitor\'s Human view.' +
    '<div class="lx-cap">Switch back to Browser and run again to refresh this snapshot.</div>' +
    // The floor states what it cannot do rather than omitting it. The chips are
    // buttons that fetch, so interaction genuinely needs JavaScript, and a
    // reader with it off should learn that from the page instead of from its
    // absence.
    '<div class="lx-cap">Reading a page <i>after</i> interaction (opening collapsed sections, removing a consent overlay) needs JavaScript in your own browser. The scripts Lens is willing to run are published at <a href="/lens/browser?recipes=1">/lens/browser?recipes=1</a>.</div></div>';
}

function lensStatusFragment(data, state) {
  if (!data || !data.ok) return '<span class="err">Failed:</span> <span>' + escHtml((data && data.error) || "unknown error") + "</span>";
  return '<span><b>' + data.status + "</b> " + lensHttpText(data.status) + "</span>" +
    '<span>' + escHtml(state.view === "both" ? "Compare" : state.view.charAt(0).toUpperCase() + state.view.slice(1)) + "</span>" +
    '<span>' + escHtml(data.contentType || "?") + "</span>" +
    (data.anatomy ? '<span>' + data.anatomy.rawBytes + " B</span>" : "") +
    '<span>' + escHtml(String(data.elapsedMs || 0)) + " ms</span>" +
    (data.redirected ? '<span>&rarr; ' + escHtml(data.finalUrl) + "</span>" : "") +
    '<span style="margin-left:auto">fetched as ' + escHtml(data.fetchedBy || "identified bot") + "</span>";
}

// ── the head-to-head fragment ------------------------------------------------
// Two sites through one rubric, rendered from the same summaries /lens/compare
// serves. This is the page's strongest single exhibit (a 13 next to a 93 does
// more explaining than either scan alone), so it gets a real UI instead of
// living as JSON only. Mirrored by renderVs() in src/client/lens.js — the SSR copy
// is the no-JS floor for a shared ?url=&vs= link, the client copy is what the
// vs form renders without a round-trip through this template.
const LENS_VS_SURFACES = [
  ["llms", "llms.txt"], ["markdown", "markdown negotiation"], ["mcp", "MCP"],
  ["agentCard", "an agent card"], ["apiCatalog", "an API catalog"],
];

function lensVsHost(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); }
}

function lensVsBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function lensVsColumn(s) {
  const host = lensVsHost(s.finalUrl || s.url);
  const levelKind = s.level >= 5 ? "ok" : s.level >= 3 ? "" : "warn";
  const pub = LENS_VS_SURFACES.filter(([key]) => s.surfaces && s.surfaces[key])
    .map(([, label]) => '<span class="lx-tag">' + escHtml(label) + "</span>").join("");
  const cost = s.cost
    ? "~" + (s.cost.tokens >= 1000 ? (s.cost.tokens / 1000).toFixed(1) + "k" : s.cost.tokens) + " tokens &middot; $" + s.cost.usdPerRead.toFixed(s.cost.usdPerRead >= 0.1 ? 2 : 4) + "/read"
    : "no cost model (non-HTML)";
  const rows = [
    ["response", (s.status == null ? "?" : s.status) + " " + lensHttpText(s.status || 0)],
    ["terms", s.tier || "unknown"],
    ["agent doors", String(s.doors || 0)],
    ["one model read", null],   // placeholder; cost carries markup, rendered below
    ["payload", lensVsBytes(s.bytes)],
    ["words", String(s.wordCount || 0)],
  ].map((row) => "<tr><td>" + escHtml(row[0]) + "</td><td>" + (row[1] == null ? cost : escHtml(row[1])) + "</td></tr>").join("");
  return '<div class="lx-vs-col"><div class="lx-vs-h"><span>' + escHtml(host) + '</span><a href="/lens?url=' + escAttr(encodeURIComponent(s.url)) + '">full scan &rarr;</a></div>' +
    '<div class="lx-vs-body"><div class="lx-vs-score"><b>' + (s.readiness == null ? "?" : escHtml(s.readiness)) + "<span>/100</span></b>" +
    '<span class="lx-badge ' + levelKind + '"' + (s.levelNote ? ' title="' + escAttr(s.levelNote) + '"' : "") + ">Level " + (s.level == null ? "?" : escHtml(s.level)) + "</span> <span>" + escHtml(s.levelName || "") + "</span></div>" +
    '<table class="lx-kv">' + rows + "</table>" +
    '<div class="lx-tags" style="margin-top:6px">' + (pub || '<span class="lx-none">no machine surfaces published</span>') + "</div></div></div>";
}

export function lensVsFragment(payload) {
  if (!payload || !payload.ok) {
    return '<div class="lx-empty">' + escHtml((payload && payload.error) || "The comparison did not run.") + "</div>";
  }
  const L = payload.left, R = payload.right;
  let headline = "";
  if (L && R && L.readiness != null && R.readiness != null) {
    const win = L.readiness >= R.readiness ? L : R;
    const lose = win === L ? R : L;
    const extras = LENS_VS_SURFACES.filter(([key]) => win.surfaces && win.surfaces[key] && !(lose.surfaces && lose.surfaces[key])).map(([, label]) => label);
    const spread = win.readiness === lose.readiness
      ? "<b>" + escHtml(win.readiness) + " apiece.</b> Same score, one rubric."
      : "<b>" + escHtml(lensVsHost(win.finalUrl || win.url)) + " " + escHtml(win.readiness) + ", " + escHtml(lensVsHost(lose.finalUrl || lose.url)) + " " + escHtml(lose.readiness) + ".</b>";
    headline = '<div class="lx-vs-headline">' + spread +
      (extras.length ? " The gap is published surfaces: " + escHtml(extras.join(", ")) + "." : " Both publish the same surfaces; the gap sits in the individual checks.") +
      "</div>";
  }
  return '<div class="lx-vs-note">Two sites, one rubric, same evidence rules. Every number here links back to a full scan.</div>' +
    '<div class="lx-vs-grid">' + lensVsColumn(L || {}) + lensVsColumn(R || {}) + "</div>" + headline;
}


async function inspectLensRequest(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return { status: 400, payload: { ok: false, error: v.error } };

  // best-effort per-IP rate limit so the proxy can't be turned into a firehose.
  // Shared with /mcp's lens_inspect tool (same bucket, see LENS_BUDGETS).
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env)) {
    return { status: 429, payload: { ok: false, error: "Slow down — 30 lookups a minute. Try again shortly." } };
  }

  // ?phases=page returns only what derives from the page's own bytes: one
  // subrequest instead of twenty-eight. The UI asks for this first so readiness
  // paints at ~29ms rather than behind a 656ms fan-out, then asks for the rest.
  const phases = new URL(request.url).searchParams.get("phases") === "page"
    ? ["page"]
    : undefined;

  try {
    return { status: 200, payload: await lensInspect(v.url, env, phases ? { phases } : {}) };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "The site took too long to answer (8s timeout)." : (e && e.message) || String(e);
    return { status: 502, payload: { ok: false, error: msg } };
  }
}

// A dated, source-linked exhibit of where the machine web actually stands, so a
// cold visitor reads every per-URL verdict as a claim about the web, not one
// site's laziness. Hand-maintained; each fact carries a "checked" date and a
// source. Update the dates when you refresh the numbers.
//
// One array, two surfaces. `rail` is the always-visible one-liner under the lede
// (lensStateOfWebRail); the full sourced cards live in the dialog behind its "?"
// (lensStateOfWebPanel). Facts without a `rail` key appear in the dialog only, so
// the rail stays one line. Deriving both from the same array is the point: the
// headline number and the sourced claim cannot drift apart.
const LENS_SOW_MONTH = "2026-08";
const LENS_SOW_CHECKED = "checked " + LENS_SOW_MONTH;
const LENS_SOW_FACTS = [
  {
    stat: "56.0%",
    rail: "of HTML requests are bots",
    claim: "Automated clients sent 56.0% of HTML page requests in Cloudflare's latest published window: 47.2% from non-AI bots, 5.8% from AI bots, and 3.0% from mixed-purpose bots.",
    src: "Cloudflare Radar", href: "https://radar.cloudflare.com/ai-insights?dateStart=2026-04-10&dateEnd=2026-07-28",
  },
  {
    stat: "10.0% / 9.7%",
    railStat: "10.0%",
    rail: "of desktop pages have llms.txt",
    claim: "HTTP Archive found an llms.txt file on 10.0% of desktop pages and 9.7% of mobile pages in June 2026. Both shares were about 4.7 times their July 2025 level.",
    src: "HTTP Archive", href: "https://httparchive.org/reports/search-engine-optimization",
  },
  {
    stat: ">10k servers",
    railStat: ">10k",
    rail: "public MCP servers",
    claim: "More than 10,000 MCP servers had been published when MCP joined the Linux Foundation's Agentic AI Foundation in December 2025.",
    src: "Linux Foundation", href: "https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation",
  },
  {
    stat: "100+ agent skills",
    claim: "Google Workspace's CLI ships more than 100 agent skills, returns structured JSON, and builds its command surface from Google's Discovery Service at runtime.",
    src: "Google Workspace CLI", href: "https://github.com/googleworkspace/cli",
  },
  {
    stat: "2 pay-per-use partners",
    claim: "Cloudflare is testing pay per use with Ceramic.ai and You.com, tying payment to content appearing in results instead of the number of times a crawler fetches it.",
    src: "Cloudflare", href: "https://blog.cloudflare.com/making-ai-search-smarter/",
  },
  {
    stat: "$898.13K / 9.04M txns",
    railStat: "$898K",
    rail: "in x402 volume over 30 days",
    claim: "x402scan recorded $898.13K of volume across 9.04 million transactions over the past 30 days. That is about $0.10 per transaction on average.",
    src: "x402scan", href: "https://www.x402scan.com/",
  },
];

// The compact form: a status strip of the four headline numbers, always on the
// page, with one Luna "?" button opening the sourced panel. This is what the
// dialog used to do by popping itself open on arrival, minus the interruption.
function lensStateOfWebRail() {
  // Past the first two, facts drop out under 560px rather than turning the strip
  // into a five-line block above the address bar. The "?" holds all six anyway.
  // The rail is the first screen, and it opens on llms.txt / MCP / x402 — three
  // terms that lose a non-technical reader in the first four seconds. glossify
  // makes each one hoverable in place rather than rewriting the fact around it.
  const items = LENS_SOW_FACTS.filter((f) => f.rail).map((f, i) =>
    '<span class="lx-sow-i' + (i > 1 ? " lx-sow-i-x" : "") + '"><b>' + escHtml(f.railStat || f.stat) + "</b> " + glossify(escHtml(f.rail)) + "</span>"
  ).join("");
  return '<div class="lx-sow-rail">' +
    '<span class="lx-sow-facts">' +
    '<span class="lx-sow-rail-k">The machine web, ' + LENS_SOW_MONTH + ":</span>" +
    items + "</span>" +
    '<button class="xp-button lx-sow-q" type="button" data-sow-open title="The state of the machine web" aria-label="The state of the machine web: six sourced facts">?</button>' +
    "</div>";
}

function lensStateOfWebPanel() {
  const cards = LENS_SOW_FACTS.map((f) =>
    '<div class="lx-sow-card"><div class="lx-sow-stat">' + escHtml(f.stat) + "</div>" +
    '<div class="lx-sow-claim">' + escHtml(f.claim) + "</div>" +
    '<div class="lx-sow-src"><a href="' + escAttr(f.href) + '" target="_blank" rel="noopener">' + escHtml(f.src) + "</a> &middot; " + LENS_SOW_CHECKED + "</div></div>"
  ).join("");
  // closedby="any" is the native light-dismiss (click-outside plus Esc) where it
  // exists; lens.js keeps a backdrop-click listener for browsers that lack it.
  return '<dialog class="lx-sow-dialog" id="lx-sow-dialog" closedby="any" aria-labelledby="lx-sow-title">' +
    '<div class="lx-sow-tb"><span class="lx-sow-kicker" id="lx-sow-title">The state of the machine web</span>' +
    '<button class="lx-sow-x" type="button" id="lx-sow-close" title="Close" aria-label="Close"></button></div>' +
    '<div class="lx-sow-inner">' +
    '<div class="lx-sow-grid">' + cards + "</div>" +
    '<div class="lx-sow-foot">A page\'s second life as data is now the busier one. Whether a machine can actually <b>read</b>, <b>understand</b>, and <b>act</b> on a page — not just fetch it — is what the lenses here measure. Paste a URL to see one site\'s answer, or watch the movement over time in <a href="/lens/census">the weekly census</a> of 16 representative sites.</div>' +
    "</div></dialog>";
}

// The About dialog: the page's argument, stated once, in order. Everything on
// /lens is evidence for a three-act story about machine access to the web (the
// semantic web asked publishers first; models now brute-force the human page
// and pay the difference; the open question is acting, not reading), but the
// acts were scattered across lens captions where only a completionist would
// assemble them. This panel is the assembly, with a jump into the lens that
// proves each act live. Same dialog chrome as the machine-web panel; opened
// from the footer's own self-description.
const LENS_ERAS = [
  {
    era: "Past", years: "1995-2011", label: "The semantic web asked first.",
    claim: "Publishers marked meaning up front: meta tags (1995), microformats (2005), RDFa (2008), microdata (2009), Open Graph (2010), and JSON-LD (2011). These layers let machines read facts instead of guessing from prose. The ones that delivered visible traffic, especially link previews, survived; the rest mostly fossilized in place.",
    jumps: [{ lens: "structured" }, { lens: "anatomy" }],
  },
  {
    era: "Present", years: "2022-now", label: "Models pay the difference.",
    claim: "Models changed the bargain. They scrape pages built for people and pay the difference in tokens, so publishers no longer have to mark everything up first. Sites answer that appetite with crawler rules, AI-use signals, bot challenges, and pay-per-crawl.",
    jumps: [{ lens: "ai" }, { lens: "terms" }],
  },
  {
    era: "Future", years: "2024-on", label: "From reading to acting.",
    claim: "The next question is action. Can a site publish tools, identity, payment, and instructions that let an agent do something without driving a human interface? Lens probes those surfaces and lets you switch the missing ones on as counterfactuals.",
    jumps: [{ lens: "discovery" }, { lens: "readiness" }, { view: "delta", label: "Delta" }],
  },
];

function lensAboutPanel() {
  const eras = LENS_ERAS.map((e) => {
    const jumps = e.jumps.map((j) => j.view
      ? '<button class="lx-chip lx-goto" type="button" data-goto-view="' + escAttr(j.view) + '">' + escHtml(j.label || j.view) + "</button>"
      : '<button class="lx-chip lx-goto" type="button" data-goto-lens="' + escAttr(j.lens) + '">' + escHtml(LENS_TAB_LABELS[j.lens] || j.lens) + "</button>"
    ).join(" ");
    return '<div class="lx-abt-era"><div class="lx-abt-when"><b>' + escHtml(e.era) + "</b><span>" + escHtml(e.years) + "</span></div>" +
      '<div><div class="lx-abt-label">' + escHtml(e.label) + "</div>" +
      '<div class="lx-abt-claim">' + glossify(escHtml(e.claim)) + "</div>" +
      '<div class="lx-abt-jumps"><span>See it live:</span> ' + jumps + "</div></div></div>";
  }).join("");
  return '<dialog class="lx-sow-dialog" id="lx-abt-dialog" closedby="any" aria-labelledby="lx-abt-title">' +
    '<div class="lx-sow-tb"><span class="lx-sow-kicker" id="lx-abt-title">About The Other Web</span>' +
    '<button class="lx-sow-x" type="button" id="lx-abt-close" title="Close" aria-label="Close"></button></div>' +
    '<div class="lx-sow-inner">' +
    '<div class="lx-abt-thesis">Every page now has two audiences: people, and the machines reading over their shoulders. This instrument watches the second one. Its story runs in three acts, and each act opens the evidence beneath it.</div>' +
    eras +
    '<div class="lx-abt-rules"><b>How this instrument behaves</b><ul class="lx-why">' +
    "<li>Every fetch is identified and cryptographically signed as AadharshBot, apart from the bot-view samples, which are the one disclosed exception.</li>" +
    "<li>A bot-view sample sends one crawler's published user-agent, read-only and unsigned, to record what that identity gets served. Chrome and curl ride along as controls, because a 403 on every crawler says nothing until something proves the door opens at all.</li>" +
    "<li>Every verdict stays pinned to evidence you can open. A probe that never answered reads as unknown, never as a fail.</li>" +
    "<li>Absent metadata renders as absent. Nothing is guessed or backfilled.</li>" +
    "<li>Delta's simulations stay amber. Green is reserved for signals actually observed.</li>" +
    "<li>One fetch per ask, server-side, with no logging.</li>" +
    "</ul></div>" +
    '<div class="lx-cf-credit">Rubric after IsItAgentReady. Pedagogy after Seymour Papert\'s micro-worlds and <a href="https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck" target="_blank" rel="noopener">Geoffrey Litt</a>. Window chrome after Redmond, 2001.</div>' +
    "</div></dialog>";
}

export function renderLensShell(initial?, state?, inputValue?, compare?) {
  // defaults must match the client (lens.js) and lensState(), or a plain /lens
  // SSRs one tab and the deferred script silently flips to another on hydrate.
  state = state || { view: "both", lens: "anatomy", counterfactuals: { markdown: false, semantic: false, contract: false, authority: false, receipt: false, dictionary: false, ech: false } };
  const seeded = initial && initial.ok;
  // vs mode: the single-scan toolbar and panes stay in the DOM but hidden
  // (.lx-off), so the client can drop back to a normal scan without rebuilding
  // them; #lx-vs holds the head-to-head fragment in their place.
  const vsActive = !!(compare && compare.vsValue);
  const vsValue = (compare && compare.vsValue) || "";
  // Delta is the one stateful view (it holds flipped switches), so its segment
  // carries an amber count of the switches currently on. The client keeps the
  // same span current via updateDeltaCount().
  const cfOn = Object.keys(state.counterfactuals || {}).filter((k) => state.counterfactuals[k]).length;
  const value = inputValue || (seeded ? initial.finalUrl || initial.url : "");
  const humanHeader = seeded && !initial.framable
    ? 'Human view <span class="lx-mode">Reader</span> <span class="lx-mode-sub">server-rendered readable fallback</span>'
    : "Human view &middot; the live page";
  // The header no longer repeats the lens name: the tab strip sits inside the
  // pane now, so the active tab IS the lens label. Must match renderMachine()
  // and updateModeUi() in src/client/lens.js or the header rewrites on hydrate.
  const machineHeader = state.view === "delta" ? "Delta view &middot; What changes" : "Machine view";
  const browserHeader = "Browser Run &middot; Rendered";
  // Mode notes coach, they don't caption: each one asks for a prediction the
  // pane will then confirm or correct. Keep the strings byte-identical to
  // MODE_NOTE in src/client/lens.js or the note visibly rewrites on hydrate.
  const modeNote = state.view === "human"
    ? "Human is the page as a person receives it. Every other view subtracts the person."
    : state.view === "machine"
      ? "Machine is an evidence-first briefing. Read claims first, then check each against its evidence."
      : state.view === "browser"
        ? "Browser Run renders after JavaScript beside HTTP. Disagreement reveals a JS dependency."
      : state.view === "delta"
        ? "Delta toggles hypothetical infrastructure. Predict, flip, check."
        : "Compare puts Human, HTTP Machine, and Browser Run side by side. Predict the machine pane; the miss is the lesson.";
  const initialScript = initial ? '<script type="application/json" id="lx-initial-data">' + lensScriptJson(initial) + "</script>" : "";
  const lensDescription = "Paste any URL and compare the human page with observed bot access, Cloudflare's standards level, Readability content recovery, raw HTML, structured data, machine terms, and agent doors.";
  return lunaPage({
    title: "The Other Web · aadhar.sh",
    path: "The Other Web",
    route: "/lens",
    width: 980,
    description: lensDescription,
    // Link unfurls. The card is pre-baked by gen-og-cards.mjs (OG_ONLY=lens):
    // a live scan of stripe.com with the dollar verdict and the 29pt readiness
    // score visible, floated on Bliss like every other card on the site. The
    // scanned ?url= variants share the shell card — a per-scan card would need
    // an on-the-fly render, and X's fetcher hits once, caches, and won't wait.
    // Absolute URLs because card fetchers don't resolve relative ones.
    head: unsafeHtml(`<meta property="og:type" content="website">
<meta property="og:site_name" content="aadhar.sh">
<meta property="og:title" content="The Other Web: how machines read a URL">
<meta property="og:description" content="${escAttr(lensDescription)}">
<meta property="og:url" content="https://${CANONICAL_HOST}/lens">
<meta property="og:image" content="https://${CANONICAL_HOST}/og/lens.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A Windows XP browser window showing one URL three ways at once: the page a person sees, the evidence a machine can recover, and a rendered snapshot.">
<meta name="twitter:card" content="summary_large_image">
`),
    // The bare shell is the site's flagship machine-web page and should be
    // indexable — an agent reading llms.txt now finds /lens listed there. Only a
    // targeted ?url= scan gets x-robots-tag: noindex (handleLens sets it), since
    // that response spends the crawl budget and carries third-party data.
    robots: "index, follow",
    css: `
h1 { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:13pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 2px; font-weight:bold; }
.lx-lede { margin:0 0 10px; color:oklch(40% 0 0); font-size:10pt; }
.lx-lede a { color:oklch(42.61% 0.2353 263.74); }

/* glossary terms. A dotted underline has meant "this word carries a definition"
   since IE rendered <abbr> that way, so the affordance is both period-correct
   and the one a modern reader still knows. text-decoration rather than a border
   so it wraps with the word. The surface is hover-only (hoist.js bails on touch),
   which is why the markup is <abbr>: the title attribute is the honest fallback
   and screen readers announce it either way. */
.lx-term { text-decoration:underline dotted oklch(60% 0.09 258); text-underline-offset:2px; text-decoration-thickness:1px; cursor:help; }
.lx-term:focus-visible { outline:1px dotted oklch(42.61% 0.2353 263.74); outline-offset:2px; }

/* the definition surface. XP's info tip: pale yellow, hairline black border, one
   hard offset shadow. Cursor-following, so it hard-snaps (no transition on the
   transform) and clamps against its own size against the viewport, exactly like
   the homepage's .xp-tooltip. /lens keeps its route-specific .lx-tip rules here;
   luna.css carries the shared homepage island under its own class. */
.lx-tip { position:fixed; inset:auto; top:0; left:0; margin:0; padding:6px 9px; max-width:290px; z-index:10000; pointer-events:none; display:none;
  transform:translate(clamp(4px, calc(var(--x) + 16px), calc(100vw - 100% - 8px)), clamp(4px, calc(var(--y) + 16px), calc(100vh - 100% - 8px)));
  font:11px/1.5 Tahoma,Verdana,Geneva,sans-serif; color:oklch(20% 0 0); background:oklch(98.92% 0.0398 96.79); border:1px solid oklch(15% 0 0); box-shadow:2px 2px 0 oklch(15% 0 0 / .15); }
.lx-tip b { display:block; margin-bottom:2px; font-family:"Trebuchet MS",Verdana,sans-serif; font-size:11.5px; color:oklch(33% 0.10 263); }
.lx-tip i { display:block; margin-top:4px; font-style:normal; color:oklch(42% 0 0); }
.lx-tip.anchored { position-anchor:--lx-tip; position-area:bottom span-right; top:auto; left:auto; transform:none; margin:6px 0 0; position-try-fallbacks:flip-block,flip-inline; }
@supports selector(:popover-open){
  .lx-tip:popover-open { display:block; }
  .lx-tip.anchored:popover-open { transition:opacity 120ms ease-out; }
  @starting-style { .lx-tip.anchored:popover-open { opacity:0; } }
}
@media (prefers-reduced-motion:reduce){ .lx-tip.anchored:popover-open { transition:none; } }

/* IE6 address bar */
.lx-addr { display:flex; align-items:center; gap:6px; background:oklch(94.66% 0.0114 252.09); border:1px solid oklch(72% 0.03 250); border-radius:3px; padding:5px 6px; }
.lx-addr-label { font-size:9pt; color:oklch(45% 0 0); padding:0 2px; }
.lx-globe { width:15px; height:15px; flex:0 0 auto; border-radius:50%; background:radial-gradient(circle at 35% 30%, oklch(78% 0.13 230), oklch(48% 0.16 250)); box-shadow:inset 0 0 0 1px oklch(100% 0 0 / .4); }
.lx-url { flex:1 1 auto; min-width:0; font-family:"Courier New",Courier,monospace; font-size:10pt; padding:3px 6px; border:2px solid; border-color:oklch(55% 0 0) oklch(85% 0 0) oklch(85% 0 0) oklch(55% 0 0); background:#fff; color:oklch(25% 0.02 255); }
.lx-url:focus { outline:1px dotted oklch(42.61% 0.2353 263.74); }
.lx-go, .lx-seg, .lx-tab, .lx-chip { font-family:Tahoma,Verdana,sans-serif; cursor:pointer; }
.lx-go { font-size:9.5pt; font-weight:bold; padding:3px 14px; color:oklch(20% 0 0); background:linear-gradient(180deg,#fdfdfd,#dcdcd2); border:1px solid; border-color:#fff oklch(45% 0 0) oklch(45% 0 0) #fff; border-radius:3px; }
.lx-go:active { border-color:oklch(45% 0 0) #fff #fff oklch(45% 0 0); }

/* example buttons. These are real <button>s, so they carry the same raised
   bevel as .lx-go above (light top-left, dark bottom-right, inverted on
   :active) rather than the flat 10px pill they used to be — which made them the
   only clickable thing on this page that didn't look pressable. Lighter weight
   than .lx-go on purpose: these are suggestions, that one is the action. */
.lx-chips { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:7px 0 9px; }
.lx-chips-label { font-size:9pt; color:oklch(48% 0 0); }
/* 4px vertical padding, not 2px, puts these at 24px tall. XP's own command
   button was 50x14 dialog units = 75x23px at 8pt Tahoma, so the period-correct
   number was already a pixel off WCAG 2.5.8's 24px floor and these were four
   under it. Rounding up to 24 is closer to Luna than what was here. */
.lx-chip { font-size:8.8pt; padding:4px 9px; color:oklch(20% 0 0); background:linear-gradient(180deg,#fdfdfd,#e6e6dd); border:1px solid; border-color:#fff oklch(45% 0 0) oklch(45% 0 0) #fff; border-radius:3px; }
.lx-chip:hover { background:linear-gradient(180deg,#fff,#efefe7); }
.lx-chip:active { border-color:oklch(45% 0 0) #fff #fff oklch(45% 0 0); }
/* the interaction chip row, sunk so it reads as a control strip rather than
   another finding in the report it sits above. */
.lx-browser-do { margin:8px 0 10px; padding:8px 9px; background:oklch(97% 0.004 250); border:1px solid; border-color:oklch(64% 0 0) #fff #fff oklch(64% 0 0); }
.lx-browser-do .lx-chips { margin:6px 0 0; }
/* Two shots side by side, stacking under the pane's own narrow width rather
   than at a viewport breakpoint: this pane is a third of the page in Compare
   and the whole of it in Browser. */
.lx-shot-pair { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:8px; }
.lx-shot-pair figure { margin:0; }
.lx-shot-pair figcaption { font-size:8.5pt; color:oklch(45% 0 0); margin-top:3px; text-align:center; }

/* toolbar: the view switcher stands alone now that the lens tabs live inside
   the Machine pane. The two controls answer different questions (what am I
   looking at vs which report), so they no longer share a row to be confused in. */
.lx-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:4px; }
.lx-view { display:inline-flex; }
.lx-seg { font-size:9pt; padding:3px 11px; color:oklch(28% 0 0); background:linear-gradient(180deg,#fbfbfb,#e3e3da); border:1px solid oklch(55% 0 0); border-right-width:0; }
.lx-seg:first-child { border-radius:3px 0 0 3px; }
.lx-seg:last-child { border-right-width:1px; border-radius:0 3px 3px 0; }
.lx-seg.is-on { color:#fff; background:linear-gradient(180deg, oklch(58% 0.15 255), oklch(44% 0.18 257)); }
/* Delta's switch count. Delta is the one stateful view; amber is already its
   "simulation" color, so the seg wears an amber count while switches are on. */
.lx-seg-n { display:inline-block; margin-left:5px; padding:0 5px; border-radius:7px; font:bold 7.6pt "Courier New",monospace; color:#fff; background:oklch(60% 0.16 50); vertical-align:1px; }
.lx-seg-n[hidden] { display:none; }

/* lens tabs, inside the Machine pane between its header and body. In Compare
   the pane is ~310px wide and six tabs need more, so the strip wraps to two
   rows — the XP property-sheet compromise, and period-correct because of it.
   In full Machine view the pane is wide enough for a single row. */
.lx-lenses { display:flex; flex-wrap:wrap; gap:2px; padding:5px 6px 0; background:oklch(93% 0.015 250); border-bottom:1px solid oklch(70% 0.03 250); }
.lx-tab { font-size:8.6pt; padding:4px 9px 5px; color:oklch(35% 0.04 255); background:linear-gradient(180deg, oklch(96% 0.01 250), oklch(88% 0.02 250)); border:1px solid oklch(60% 0.05 250); border-bottom:none; border-radius:4px 4px 0 0; position:relative; top:1px; }
.lx-tab.is-on { color:oklch(33% 0.10 263); font-weight:bold; background:#fff; }
/* Delta ignores the lens (it runs its own narrative), so the strip hides there.
   Human and Browser hide the whole Machine pane, taking the tabs with it. */
.lx-panes.is-delta .lx-lenses { display:none; }
/* The machine pane scrolls as ONE column rather than pinning a fixed header
   over a scrolling body: the static half is now the whole briefing and is far
   too tall to hold open above the fold. The tab strip goes sticky instead, so
   it pins to the top of the pane once you reach it and the lens report under it
   always has its own controls in view. */
.lx-machine-scroll { flex:1 1 auto; min-height:0; overflow:auto; display:flex; flex-direction:column; }
.lx-machine-scroll > .lx-body { flex:0 0 auto; overflow:visible; }
.lx-machine-scroll > .lx-lenses { position:sticky; top:0; z-index:3; }
/* Compare puts three panes side by side and the shortest must scroll to match
   the tallest, which is what the wrapper's own overflow buys. Alone in the
   window, the pane is as tall as its content and that overflow never engages,
   so it would only CLIP the sticky strip to a box already fully in view.
   Handing those two views the page's scrollport instead is what makes the tabs
   pin at the top of the window while the lens report runs under them. */
.lx-panes.is-machine .lx-machine-scroll, .lx-panes.is-delta .lx-machine-scroll { overflow:visible; }
/* Everything above the tabs: the score strip, the agent trace, and the machine
   briefing. Tinted and rule-separated so the split from the lens report reads
   as two halves of one pane rather than one long scroll. Empty in every view
   but Machine, and an empty slot must not leave a padded gap. */
.lx-machine-top { padding:9px 11px 14px; background:oklch(97.5% 0.005 250); }
.lx-machine-top:empty { display:none; }
.lx-machine-top > .lx-sec:last-child { margin-bottom:9px; }
/* The strip carries the rule between the two halves, and paints its own
   background upward past its border box. Both exist for the pinned state: a
   scroll container paints content inside its padding, so the window's 18px
   band above a pinned strip showed the lens report sliding through it. The
   shadow covers that band, and in the strip's resting position it lands on the
   clearance the padding-bottom above reserves for it, reading as the tab bar's
   shoulder. */
.lx-panes.is-machine .lx-machine-scroll > .lx-lenses { border-top:1px solid oklch(84% 0.03 250); box-shadow:0 -22px 0 oklch(93% 0.015 250); }

/* panes */
.lx-panes { display:flex; gap:8px; margin-top:8px; min-height:560px; }
.lx-panes.is-human .lx-pane-machine, .lx-panes.is-human .lx-pane-browser,
.lx-panes.is-machine .lx-pane-human, .lx-panes.is-machine .lx-pane-browser,
.lx-panes.is-browser .lx-pane-human, .lx-panes.is-browser .lx-pane-machine,
.lx-panes.is-delta .lx-pane-human, .lx-panes.is-delta .lx-pane-browser { display:none; }
.lx-pane { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border:1px solid oklch(70% 0.03 250); border-radius:0 3px 3px 3px; background:#fff; }
.lx-pane-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:#fff; background:linear-gradient(180deg, oklch(56% 0.12 252), oklch(45% 0.15 255)); padding:4px 8px; border-radius:0 2px 0 0; }
.lx-pane-human .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.06 150), oklch(46% 0.09 155)); }
.lx-pane-browser .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.10 205), oklch(45% 0.14 220)); }
.lx-body { flex:1 1 auto; overflow:auto; padding:10px 11px; }
/* Empty states name what this place is and what fills it, rather than only
   naming the action. "Paste a URL to compare the three surfaces" told a stranger
   the mechanic and none of the reason. First line is the instruction, the <span>
   is the payoff, deliberately quieter. */
.lx-empty { color:oklch(45% 0 0); font-size:10pt; padding:18px 14px; text-align:center; text-wrap:pretty; }
.lx-empty span { display:block; max-width:34ch; margin:5px auto 0; font-size:9pt; line-height:1.5; color:oklch(58% 0 0); }
.lx-spin { color:oklch(42.61% 0.2353 263.74); font-size:9.5pt; padding:18px 6px; text-align:center; }
.lx-idle-lens { max-width:620px; margin:22px auto; padding:16px 18px; border:1px solid oklch(78% 0.04 250); border-radius:4px; background:linear-gradient(180deg,#fff,oklch(97% 0.008 250)); color:oklch(31% 0.02 255); }
.lx-idle-kicker { color:oklch(46% 0.13 252); font:9pt Tahoma,Verdana,sans-serif; text-transform:uppercase; letter-spacing:.06em; }
.lx-idle-lens h3 { margin:4px 0 5px; color:oklch(33% 0.10 263); font: bold 13pt "Trebuchet MS",Verdana,sans-serif; }
.lx-idle-lens p { margin:0 0 11px; line-height:1.45; }
.lx-idle-lens ul { margin:0 0 13px 18px; padding:0; line-height:1.5; }
.lx-idle-cta { padding:7px 9px; border-left:3px solid oklch(58% 0.15 255); background:oklch(95% 0.025 250); color:oklch(43% 0 0); font-size:9pt; }
.lx-body.is-bleed { padding:0; }
.lx-frame { width:100%; height:100%; min-height:520px; border:0; display:block; background:#fff; }
.lx-shot { width:100%; height:auto; display:block; }
.lx-browser-shot { width:100%; height:auto; display:block; border:1px solid oklch(82% 0.04 210); background:#fff; }
.lx-fallback-note { font-size:8.8pt; color:oklch(42% 0.11 60); background:oklch(96% 0.045 92); border:1px solid oklch(82% 0.09 80); border-radius:3px; padding:5px 9px; margin:0 0 10px; }
/* Same note, recoloured for work still in flight. Amber says something went
   wrong; a snapshot that has not arrived YET has not. */
.lx-fallback-note.lx-pending { color:oklch(40% 0.10 255); background:oklch(96% 0.03 250); border-color:oklch(80% 0.07 250); }
.lx-mode { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; text-transform:none; letter-spacing:0; color:oklch(38% 0.09 150); background:#fff; border-radius:7px; padding:1px 7px; vertical-align:middle; }
.lx-mode-sub { font-weight:normal; text-transform:none; letter-spacing:0; opacity:.85; font-size:8pt; }
.lx-browser-intro { padding:10px 9px; border:1px solid oklch(78% 0.06 210); background:linear-gradient(180deg,oklch(98% 0.015 210),oklch(94% 0.025 210)); color:oklch(31% 0.04 220); font-size:9pt; line-height:1.45; }
.lx-browser-intro b { color:oklch(34% 0.11 220); }
.lx-browser-run { margin-top:7px; border:1px solid oklch(52% 0.08 220); border-radius:3px; padding:3px 8px; background:linear-gradient(180deg,#fff,oklch(89% 0.025 210)); color:oklch(30% 0.08 220); font:8.4pt Tahoma,Verdana,sans-serif; cursor:pointer; }
.lx-browser-run:hover { background:oklch(91% 0.05 210); }
/* Reader lens. Reuses .lx-browser-run for the opt-in button (same affordance,
   same cost shape: one click spends a real fetch), so this adds only the intro
   block and the credit line. The credit is deliberately quieter than the data. */
.lx-reader-intro { padding:10px 9px; border:1px solid oklch(80% 0.05 95); background:linear-gradient(180deg,oklch(98% 0.02 95),oklch(95% 0.035 95)); color:oklch(32% 0.04 80); font-size:9pt; line-height:1.45; }
.lx-reader-intro b { color:oklch(36% 0.09 80); }
.lx-reader-credit { margin-top:6px; opacity:0.85; }
.lx-reader-credit a { color:oklch(42% 0.12 250); }
.lx-reader-recovery { list-style:none; margin:4px 0 7px; padding:0; display:grid; gap:4px; }
.lx-reader-recovery li { display:grid; grid-template-columns:minmax(120px,.8fr) minmax(150px,1.2fr); gap:8px; padding:5px 7px; border-left:3px solid oklch(70% 0.07 250); background:oklch(98% 0.01 250); font-size:8.3pt; }
.lx-reader-recovery b { color:oklch(35% 0.07 255); }
.lx-reader-recovery span { color:oklch(50% 0 0); }
/* Wire lens. Same opt-in affordance as Reader (.lx-browser-run), warmer hue so
   the two adjacent opt-in tabs are not mistaken for each other at a glance.
   The split bar is the one piece of chart on this page: two spans in a track,
   widths set inline from the percentage, because a 2-segment bar does not earn
   a charting anything and the numbers are printed beside it regardless. */
.lx-wire-intro { padding:10px 9px; border:1px solid oklch(78% 0.06 30); background:linear-gradient(180deg,oklch(98% 0.02 30),oklch(95% 0.04 30)); color:oklch(34% 0.05 25); font-size:9pt; line-height:1.45; }
.lx-wire-intro b { color:oklch(38% 0.11 25); }
.lx-wire-credit { margin-top:6px; opacity:0.85; }
/* ── the Tools lens: a catalogue that opens into a form per tool ──────────
   Sunken fields and a raised add button, the same Luna vocabulary the rest of
   the site uses for forms. The accordion is deliberate: the machine pane is
   ~310px wide in Compare, where the prototype's three columns do not fit. */
.lx-tools-intro { padding:10px 9px; border:1px solid oklch(78% 0.06 265); background:linear-gradient(180deg,oklch(98% 0.02 265),oklch(95% 0.04 265)); color:oklch(32% 0.05 260); font-size:9pt; line-height:1.45; }
.lx-tools-intro b { color:oklch(35% 0.11 262); }
.lx-tools-intro code { font-family:"Courier New",monospace; font-size:8.5pt; }
/* the browser-local catalogue, under the same tab as the server one. Read-vs-write
   is coloured because it is the only safety fact Chrome carries across registration;
   an unstated tool is deliberately neutral rather than green. */
.lx-wmcp-intro { padding:10px 9px; border:1px solid oklch(78% 0.06 300); background:linear-gradient(180deg,oklch(98% 0.02 300),oklch(95% 0.04 300)); color:oklch(32% 0.05 295); font-size:9pt; line-height:1.45; }
.lx-wmcp-intro b { color:oklch(35% 0.11 300); }
.lx-wmcp-intro code, .lx-wmcp-row code { font-family:"Courier New",monospace; font-size:8.5pt; }
.lx-wmcp-row { padding:7px 9px; border:1px solid oklch(88% 0.01 265); border-top:0; font-size:9pt; line-height:1.45; }
.lx-wmcp-row:first-of-type { border-top:1px solid oklch(88% 0.01 265); }
.lx-wmcp-read { color:oklch(48% 0.14 145); font-weight:bold; }
.lx-wmcp-write { color:oklch(52% 0.19 27); font-weight:bold; }
.lx-wmcp-k { color:oklch(52% 0.02 265); }
.lx-tools-fail { padding:6px 8px; border:1px solid oklch(62% 0.16 25); background:oklch(96% 0.03 25); color:oklch(38% 0.12 25); font-size:9pt; }
.lx-tools-fail ul { margin:3px 0 0; padding-left:17px; }
.lx-tools-list { border:1px solid oklch(80% 0.02 260); }
.lx-tool + .lx-tool { border-top:1px solid oklch(88% 0.015 260); }
.lx-tool-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; width:100%; padding:5px 7px; border:0; background:oklch(98% 0.004 260); font:9.5pt "Courier New",monospace; text-align:left; cursor:pointer; }
.lx-tool-head:hover { background:oklch(95% 0.02 262); }
.lx-tool.is-open > .lx-tool-head { background:oklch(93% 0.035 262); }
.lx-tool-name { font-weight:bold; color:oklch(30% 0.09 262); }
.lx-tool-body { padding:8px 9px 10px; background:oklch(99.5% 0.002 260); }
.lx-tool-desc { margin:0 0 6px; font-size:9pt; line-height:1.45; }
.lx-tool-frame, .lx-tool-curl { margin:0 0 6px; padding:7px 8px; background:oklch(24% 0.02 258); color:oklch(92% 0.03 150); font:8.5pt/1.5 "Courier New",monospace; white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:230px; }
.lx-tool-curl { color:oklch(90% 0.04 90); max-height:150px; }
.lx-tool-problems:empty { display:none; }
/* the generated controls */
.lx-tf { margin:0 0 10px; }
.lx-tf-head { display:flex; align-items:baseline; gap:6px; margin-bottom:2px; }
.lx-tf-label { display:flex; align-items:baseline; gap:6px; cursor:pointer; }
.lx-tf-name { font:bold 9.5pt "Courier New",monospace; color:oklch(28% 0.05 260); }
.lx-tf-req { font-size:7.5pt; text-transform:uppercase; letter-spacing:0.04em; color:oklch(52% 0.19 25); }
.lx-tf-kind { margin-left:auto; font:8pt "Courier New",monospace; color:oklch(55% 0.02 260); }
.lx-tf-desc { font-size:8.5pt; color:oklch(45% 0.02 260); margin-bottom:3px; line-height:1.4; }
.lx-tf-cons { font:8.5pt "Courier New",monospace; color:oklch(42% 0.09 262); margin-bottom:3px; }
.lx-tf-warn { font-size:8.5pt; color:oklch(52% 0.13 75); margin-bottom:3px; }
.lx-tf-note { font-size:8.5pt; color:oklch(42% 0.02 260); background:oklch(95% 0.008 260); border:1px solid oklch(85% 0.015 260); padding:4px 7px; margin-bottom:8px; }
.lx-tf-input { box-sizing:border-box; width:100%; font-family:Tahoma,Verdana,sans-serif; font-size:9.5pt; color:oklch(18% 0.01 260); background:oklch(100% 0 0); padding:3px 5px; border-radius:0; border:1px solid oklch(66% 0.04 250); box-shadow:inset 1px 1px 0 oklch(0% 0 0/0.18), inset -1px -1px 0 oklch(100% 0 0); }
.lx-tf-input:focus { outline:none; border-color:oklch(52% 0.16 262); box-shadow:inset 1px 1px 0 oklch(0% 0 0/0.18), 0 0 0 1px oklch(52% 0.16 262); }
.lx-tf-json { font-family:"Courier New",monospace; font-size:9pt; }
.lx-tf-check { display:flex; align-items:center; gap:5px; font-size:9pt; }
.lx-tf-multi { background:oklch(100% 0 0); border:1px solid oklch(66% 0.04 250); box-shadow:inset 1px 1px 0 oklch(0% 0 0/0.18); padding:3px 6px; max-height:130px; overflow:auto; }
/* ── the NLWeb lens: one question, and how much of the answer is usable ────
   Reuses the Tools lens's intro card and opt-in button (.lx-tools-intro,
   .lx-browser-run) because it is the same affordance doing the same job: an
   explanation, then a button that costs somebody else a request. Hue shifts to
   green so the two panes are distinguishable at a glance without being a second
   design. */
.lx-nlweb-ask { display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap; }
.lx-nlweb-ask input { flex:1 1 200px; min-width:0; box-sizing:border-box; font-family:Tahoma,Verdana,sans-serif; font-size:9.5pt; color:oklch(18% 0.01 260); background:oklch(100% 0 0); padding:3px 5px; border:1px solid oklch(66% 0.04 250); box-shadow:inset 1px 1px 0 oklch(0% 0 0/0.18), inset -1px -1px 0 oklch(100% 0 0); }
.lx-nlweb-ask input:focus { outline:none; border-color:oklch(52% 0.16 262); box-shadow:inset 1px 1px 0 oklch(0% 0 0/0.18), 0 0 0 1px oklch(52% 0.16 262); }
.lx-nlweb-ask .lx-browser-run { margin-top:0; }
.lx-nlweb-verdict { padding:6px 8px; margin-bottom:7px; border:1px solid oklch(80% 0.05 150); background:oklch(97% 0.02 150); color:oklch(34% 0.07 150); font-size:9pt; line-height:1.45; }
.lx-nlweb-shut { padding:6px 8px; border:1px solid oklch(80% 0.02 260); background:oklch(97% 0.005 260); color:oklch(40% 0.02 260); font-size:9pt; line-height:1.45; }
.lx-nlweb-cov { width:100%; border-collapse:collapse; font-size:8.6pt; margin-bottom:6px; }
.lx-nlweb-cov th { text-align:left; font-weight:normal; color:oklch(48% 0.02 250); border-bottom:1px solid oklch(85% 0.01 250); padding:2px 6px 3px; }
.lx-nlweb-cov td { padding:3px 6px; border-bottom:1px solid oklch(92% 0.008 250); vertical-align:middle; }
.lx-nlweb-cov code { font:8.4pt "Courier New",monospace; color:oklch(30% 0.07 262); }
.lx-nlweb-n { white-space:nowrap; font-variant-numeric:tabular-nums; }
.lx-nlweb-bar { width:88px; }
.lx-nlweb-bar i { display:block; height:8px; background:linear-gradient(180deg,oklch(78% 0.11 150),oklch(62% 0.14 152)); border:1px solid oklch(70% 0.06 150); }
/* The results can outgrow the pane, so they scroll inside their own box rather
   than widening the window. Site-wide rule. */
.lx-nlweb-results { max-height:360px; overflow:auto; border:1px solid oklch(84% 0.01 250); }
.lx-nlweb-results:empty { display:none; }
.lx-nlweb-row { padding:6px 8px; border-bottom:1px solid oklch(92% 0.008 250); }
.lx-nlweb-row:last-child { border-bottom:0; }
.lx-nlweb-head { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
.lx-nlweb-idx { font:8pt "Courier New",monospace; color:oklch(58% 0.02 250); }
.lx-nlweb-name { font-weight:bold; font-size:9pt; color:oklch(30% 0.07 262); }
.lx-nlweb-url { font:8.2pt "Courier New",monospace; color:oklch(45% 0.09 250); word-break:break-all; margin-top:1px; }
.lx-nlweb-desc { font-size:8.7pt; line-height:1.45; color:oklch(38% 0.015 260); margin-top:3px; }
.lx-nlweb-schema pre { margin:4px 0 0; padding:6px 7px; background:oklch(24% 0.02 258); color:oklch(92% 0.03 150); font:8.2pt/1.45 "Courier New",monospace; white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:170px; }
.lx-nlweb-missing { margin-top:4px; padding:4px 7px; font-size:8.4pt; color:oklch(46% 0.11 45); background:oklch(97% 0.02 60); border:1px solid oklch(82% 0.06 60); }
.lx-md-run { margin-top:8px; }
.lx-md-note { padding:6px 8px; border:1px solid oklch(80% 0.02 260); background:oklch(97% 0.005 260); color:oklch(40% 0.02 260); font-size:9pt; line-height:1.45; }
.lx-md-verdict { padding:6px 8px; margin-bottom:7px; border:1px solid oklch(80% 0.05 150); background:oklch(97% 0.02 150); color:oklch(34% 0.07 150); font-size:9pt; line-height:1.45; }
.lx-md-agents { width:100%; border-collapse:collapse; font-size:8.6pt; margin-bottom:7px; table-layout:fixed; }
.lx-md-agents th { text-align:left; font-weight:normal; color:oklch(48% 0.02 250); border-bottom:1px solid oklch(85% 0.01 250); padding:2px 6px 3px; }
.lx-md-agents td { padding:4px 6px; border-bottom:1px solid oklch(92% 0.008 250); vertical-align:top; }
.lx-md-agents td:first-child { width:23%; }
.lx-md-agents code { font:8pt "Courier New",monospace; color:oklch(30% 0.07 262); word-break:break-word; }
.lx-md-vendor { font-size:8pt; color:oklch(55% 0.02 250); margin-top:2px; }
.lx-md-gets { width:22%; white-space:nowrap; }
/* The row tint is the table's whole point: which clients get Markdown has to be
   readable at a glance, before anybody parses a content-type. */
.lx-md-yes td { background:oklch(98% 0.02 150); }
.lx-md-no td  { background:oklch(98% 0.02 60); }
.lx-md-err td { background:oklch(97% 0.005 260); color:oklch(52% 0.02 260); }
.lx-md-delta { padding:6px 8px; margin-bottom:7px; border:1px solid oklch(84% 0.04 250); background:oklch(97% 0.012 250); font-size:9pt; line-height:1.5; }
.lx-md-delta b { font-size:11pt; color:oklch(38% 0.13 262); }
.lx-md-checks { border:1px solid oklch(84% 0.01 250); }
.lx-md-check { display:flex; gap:7px; align-items:flex-start; padding:5px 8px; border-bottom:1px solid oklch(92% 0.008 250); }
.lx-md-check:last-child { border-bottom:0; }
.lx-md-check code { font:8.4pt "Courier New",monospace; color:oklch(30% 0.07 262); }
.lx-md-detail { font-size:8.7pt; line-height:1.45; color:oklch(38% 0.015 260); margin-top:2px; }
.lx-md-sample { margin:0; padding:6px 7px; background:oklch(24% 0.02 258); color:oklch(92% 0.03 150); font:8.2pt/1.45 "Courier New",monospace; white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:220px; }
.lx-tf-multi-row { display:flex; align-items:center; gap:5px; padding:1px 0; font-size:9pt; }
.lx-tf-row { display:flex; gap:6px; align-items:flex-start; padding:6px; margin-bottom:5px; background:oklch(96% 0.006 260); border:1px solid oklch(84% 0.015 260); }
.lx-tf-row > *:first-child { flex:1; min-width:0; }
.lx-tf-row .lx-tf:last-child { margin-bottom:0; }
.lx-tf-group { padding:7px 8px; background:oklch(96% 0.006 260); border:1px solid oklch(84% 0.015 260); }
.lx-tf-group .lx-tf:last-child { margin-bottom:0; }
.lx-tf-const { font:9pt "Courier New",monospace; color:oklch(45% 0.02 260); }
.lx-tf-add, .lx-tf-kill, .lx-tool-copy { font:8pt Tahoma,Verdana,sans-serif; padding:2px 9px; cursor:pointer; border:1px solid oklch(64% 0.03 255); border-radius:3px; background:linear-gradient(180deg,oklch(100% 0 0),oklch(92% 0.008 255)); color:oklch(20% 0.01 260); }
.lx-tf-add:hover, .lx-tf-kill:hover, .lx-tool-copy:hover { border-color:oklch(70% 0.13 65); }
.lx-tf-kill { flex:none; min-width:22px; padding:1px 6px; }
.lx-wire-split { margin:6px 0 8px; }
.lx-wire-bar { display:flex; height:18px; border:1px solid oklch(62% 0.02 250); background:oklch(94% 0 0); overflow:hidden; }
.lx-wire-bar span { display:block; height:100%; }
.lx-wire-bar .lx-wire-first, .lx-wire-legend i.lx-wire-first { background:linear-gradient(180deg,oklch(74% 0.12 240),oklch(58% 0.15 245)); }
.lx-wire-bar .lx-wire-third, .lx-wire-legend i.lx-wire-third { background:linear-gradient(180deg,oklch(74% 0.14 35),oklch(58% 0.17 30)); }
.lx-wire-legend { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:5px; font-size:8.2pt; color:oklch(42% 0.02 250); }
.lx-wire-legend span { display:flex; align-items:center; gap:5px; }
.lx-wire-legend i { display:inline-block; width:10px; height:10px; border:1px solid oklch(55% 0.02 250); }
.lx-wire-types { list-style:none; margin:4px 0 2px; padding:0; display:grid; gap:3px; }
.lx-wire-types li { display:grid; grid-template-columns:minmax(96px,.6fr) 1fr minmax(96px,auto); align-items:center; gap:8px; font-size:8.3pt; }
.lx-wire-types b { color:oklch(35% 0.05 255); font-weight:normal; }
.lx-wire-track { display:block; height:9px; background:oklch(93% 0 0); border:1px solid oklch(80% 0.01 250); }
.lx-wire-track i { display:block; height:100%; background:linear-gradient(180deg,oklch(76% 0.1 240),oklch(60% 0.13 245)); }
.lx-wire-n { text-align:right; color:oklch(45% 0.02 250); font-variant-numeric:tabular-nums; }
.lx-wire-dot { display:inline-block; width:7px; height:7px; margin-right:5px; border-radius:50%; vertical-align:middle; }
.lx-wire-dot.third { background:oklch(62% 0.17 30); }
.lx-wire-dot.first { background:oklch(64% 0.14 245); }
.lx-wire-hosts td, .lx-wire-list td { font-variant-numeric:tabular-nums; }
.lx-wire-hosts code, .lx-wire-list code { font:8.2pt "Courier New",monospace; }
/* The row list is the one place here that can outgrow the pane, so it scrolls
   inside its own box rather than widening the window (the site-wide rule). */
.lx-wire-scroll { max-height:320px; overflow:auto; border:1px solid oklch(84% 0.01 250); }
.lx-wire-list { width:100%; }
.lx-wire-list thead th { position:sticky; top:0; background:oklch(93% 0.01 250); font-size:8pt; text-align:left; }
.lx-wire-row.is-third td:first-child { border-left:3px solid oklch(70% 0.15 30); }
.lx-wire-row.is-failed { background:oklch(96% 0.04 25); }

/* rendered machine content */
.lx-h-title { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:13pt; font-weight:bold; color:oklch(30% 0.06 255); margin:0 0 8px; }
.lx-h-text { font-size:10pt; line-height:1.55; color:oklch(28% 0 0); white-space:pre-wrap; }
.lx-h-outline { margin:0 0 12px; padding:8px 10px; background:oklch(98% 0.01 250); border:1px solid oklch(90% 0.02 250); border-radius:3px; font-size:9pt; }
.lx-h-outline a { color:oklch(42.61% 0.2353 263.74); text-decoration:none; }
.lx-pre { font-family:"Courier New",Courier,monospace; font-size:8.6pt; line-height:1.45; white-space:pre-wrap; word-break:break-word; background:oklch(20% 0.02 255); color:oklch(92% 0.02 150); padding:9px 10px; border-radius:3px; overflow:auto; max-height:520px; }
.lx-pre-light { background:oklch(98.5% 0.008 250); color:oklch(25% 0.02 255); border:1px solid oklch(90% 0.02 250); }
.lx-sec { margin:0 0 15px; }
.lx-sec-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:10pt; font-weight:bold; color:oklch(33% 0.09 263); margin:0 0 2px; display:flex; align-items:center; gap:7px; }
.lx-badge { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; color:#fff; background:oklch(52% 0.13 255); border-radius:8px; padding:1px 7px; }
.lx-badge.warn { background:oklch(60% 0.16 50); }
.lx-badge.ok { background:oklch(52% 0.13 150); }
.lx-badge.off { background:oklch(60% 0 0); }
.lx-cap { font-size:8.4pt; color:oklch(50% 0 0); margin:0 0 6px; font-style:italic; }
.lx-kv { width:100%; border-collapse:collapse; font-size:8.8pt; }
.lx-kv td { border-bottom:1px solid oklch(93% 0.01 250); padding:3px 6px 3px 0; vertical-align:top; }
.lx-kv td:first-child { font-family:"Courier New",monospace; color:oklch(42% 0.08 255); white-space:nowrap; width:1%; padding-right:12px; }
.lx-kv td:last-child { color:oklch(28% 0 0); word-break:break-word; }
.lx-tags { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 0; }
.lx-tag { font-family:"Courier New",monospace; font-size:8.2pt; color:oklch(33% 0.06 255); background:oklch(95% 0.02 255); border:1px solid oklch(80% 0.03 255); border-radius:3px; padding:1px 6px; }
.lx-none { font-size:8.8pt; color:oklch(58% 0 0); padding:2px 0; }
.lx-ogcard { display:flex; gap:9px; border:1px solid oklch(85% 0.02 250); border-radius:4px; padding:8px; background:oklch(99% 0.004 250); }
.lx-ogcard img { width:96px; height:96px; object-fit:cover; border-radius:3px; flex:0 0 auto; background:oklch(92% 0 0); }
.lx-ogcard .t { font-weight:bold; font-size:9.6pt; color:oklch(28% 0.04 255); }
.lx-ogcard .d { font-size:8.8pt; color:oklch(45% 0 0); margin-top:3px; }
.lx-ogcard .u { font-family:"Courier New",monospace; font-size:8pt; color:oklch(50% 0.05 150); margin-top:4px; }

/* Terms lens: the open → signaled → enforced → paid spectrum + bot scoreboard */
.lx-spectrum { display:flex; border:1px solid oklch(70% 0.03 250); border-radius:3px; overflow:hidden; margin:2px 0 8px; }
.lx-spec { flex:1 1 0; text-align:center; padding:5px 4px 6px; background:oklch(97% 0.005 250); border-right:1px solid oklch(88% 0.01 250); }
.lx-spec:last-child { border-right:none; }
.lx-spec b { display:block; font-size:9.2pt; color:oklch(40% 0.02 255); }
.lx-spec span { font-size:7.8pt; color:oklch(55% 0 0); }
.lx-spec.is-here { background:linear-gradient(180deg, oklch(58% 0.15 255), oklch(44% 0.18 257)); }
.lx-spec.is-here b, .lx-spec.is-here span { color:#fff; }
.lx-why { margin:0 0 4px; padding-left:18px; font-size:8.8pt; color:oklch(35% 0 0); }
.lx-why li { margin:1px 0; }
.lx-bots { width:100%; border-collapse:collapse; font-size:8.8pt; }
.lx-bots td, .lx-bots th { border-bottom:1px solid oklch(93% 0.01 250); padding:3px 8px 3px 0; text-align:left; vertical-align:top; }
.lx-bots th { font-size:7.8pt; font-weight:normal; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.05em; }
.lx-bots .ua { font-family:"Courier New",monospace; color:oklch(30% 0.05 255); white-space:nowrap; }
.lx-bots .rule { font-family:"Courier New",monospace; font-size:8.2pt; color:oklch(48% 0 0); word-break:break-all; }
.lx-bots .who { color:oklch(55% 0 0); font-size:8pt; }
.lx-readiness-hero { display:flex; align-items:center; gap:15px; padding:10px 12px; margin:0 0 9px; border:1px solid oklch(73% 0.06 250); border-radius:4px; background:linear-gradient(105deg,oklch(97% 0.025 250),#fff); }
.lx-readiness-number { font:bold 29pt "Trebuchet MS",Verdana,sans-serif; line-height:1; color:oklch(38% 0.14 255); white-space:nowrap; }
.lx-readiness-number span { font:normal 10pt Tahoma,Verdana,sans-serif; color:oklch(53% 0 0); margin-left:2px; }
.lx-readiness-kicker { font:8pt Tahoma,Verdana,sans-serif; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.06em; }
.lx-readiness-level { display:flex; align-items:center; gap:6px; margin:2px 0 3px; font-size:10pt; color:oklch(30% 0.04 255); }
.lx-composite-hero { border-color:oklch(65% 0.12 255); background:linear-gradient(105deg,oklch(95% 0.045 255),#fff 70%); }
.lx-composite-sources { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin:0 0 7px; }
.lx-composite-source { min-width:0; padding:7px 8px; border:1px solid oklch(82% 0.035 250); border-top:3px solid oklch(55% 0.13 255); border-radius:3px; background:#fff; }
.lx-composite-source.is-waiting { border-top-color:oklch(68% 0.14 85); background:oklch(98% 0.02 85); }
.lx-composite-source.is-missing { border-top-color:oklch(60% 0 0); background:oklch(97% 0 0); }
.lx-composite-source-top { display:grid; grid-template-columns:auto 1fr auto; align-items:baseline; gap:5px; }
.lx-composite-source-top > span { font:7.4pt "Courier New",monospace; color:oklch(58% 0.08 255); }
.lx-composite-source-top b { font-size:8.5pt; color:oklch(32% 0.06 255); }
.lx-composite-source-top strong { font:bold 13pt "Courier New",monospace; color:oklch(40% 0.13 150); white-space:nowrap; }
.lx-composite-source-top strong span { font:7.5pt Tahoma,Verdana,sans-serif; color:oklch(55% 0 0); }
.lx-composite-caption { min-height:34px; margin:5px 0; color:oklch(49% 0 0); font-size:7.9pt; line-height:1.35; }
.lx-composite-caption a { color:oklch(40% 0.14 255); }
.lx-composite-source ul { list-style:none; margin:5px 0 0; padding:5px 0 0; border-top:1px dotted oklch(84% 0.02 250); font-size:7.6pt; color:oklch(45% 0.03 255); }
.lx-composite-source li { margin:2px 0; }
.lx-composite-formula { display:flex; justify-content:center; align-items:baseline; gap:6px; margin:0 0 12px; padding:6px 8px; border:1px solid oklch(82% 0.04 255); background:oklch(97% 0.02 255); font:9pt "Courier New",monospace; color:oklch(44% 0.05 255); }
.lx-composite-formula b { color:oklch(35% 0.11 255); }
.lx-composite-formula span { color:oklch(53% 0 0); }
.lx-composite-formula strong { margin-left:5px; color:oklch(36% 0.14 150); font-size:11pt; }
.lx-local-mirror { display:flex; align-items:center; gap:7px; margin:4px 0 7px; color:oklch(35% 0.05 255); }
.lx-local-mirror > b { font:bold 17pt "Courier New",monospace; color:oklch(39% 0.13 255); }
.lx-level-note { margin:-3px 0 9px; padding:5px 8px; border-left:3px solid oklch(66% 0.13 250); background:oklch(97% 0.02 250); color:oklch(40% 0.05 255); font-size:8.5pt; }
.lx-readiness-cats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; margin:5px 0 12px; }
.lx-readiness-cat { border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:6px 8px; background:#fff; }
.lx-readiness-cat > div { display:flex; justify-content:space-between; gap:7px; font-size:8.4pt; color:oklch(37% 0.04 255); }
.lx-readiness-cat > div span { font:8pt "Courier New",monospace; color:oklch(55% 0 0); white-space:nowrap; }
.lx-readiness-cat strong { display:block; margin-top:2px; font:bold 14pt "Courier New",monospace; color:oklch(43% 0.13 150); }
.lx-readiness-cat.is-skipped strong { color:oklch(58% 0 0); }
.lx-projection { margin:0 0 12px; padding:6px 8px; border-left:3px solid oklch(60% 0.15 50); background:oklch(97% 0.035 75); color:oklch(42% 0.06 50); font-size:8.7pt; }
.lx-projection span { color:oklch(52% 0 0); }
.lx-readiness-checks { display:grid; gap:5px; margin-top:7px; }
.lx-readiness-check { padding:6px 8px; border:1px solid oklch(88% 0.015 250); border-radius:3px; background:#fff; }
.lx-readiness-check-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.lx-readiness-check-top b { font-size:9pt; color:oklch(32% 0.05 255); }
.lx-readiness-detail { margin-top:2px; font-size:8.4pt; color:oklch(52% 0 0); }
.lx-readiness-consume { margin-top:3px; font-size:8pt; color:oklch(46% 0.06 255); border-left:2px solid oklch(78% 0.06 255); padding-left:6px; }
.lx-readiness-fix { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:5px; padding-top:5px; border-top:1px dotted oklch(85% 0.02 250); font-size:8.4pt; color:oklch(42% 0.07 50); }
/* 19 -> 24px tall, and it costs NOTHING: every .lx-readiness-fix row is already
   40-56px because the fix text wraps, so the row was never sized by this button.
   Measured on the live page: all 14 row heights are identical before and after.
   Also lands them on the same 23-24px as .lx-go, .lx-seg and .lx-chip. */
.lx-copy-fix, .lx-copy-all { box-sizing:border-box; min-height:24px; border:1px solid oklch(62% 0.05 250); border-radius:3px; padding:2px 7px; background:linear-gradient(180deg,#fff,oklch(91% 0.012 250)); color:oklch(34% 0.07 255); font:8pt Tahoma,Verdana,sans-serif; cursor:pointer; white-space:nowrap; }
.lx-copy-fix:hover, .lx-copy-all:hover { background:oklch(93% 0.04 250); }
.lx-copy-all { margin:0 0 7px; font-weight:bold; }
.lx-next-actions { display:grid; gap:4px; margin:0 0 9px; }
.lx-next-actions div { display:grid; grid-template-columns:145px 1fr; gap:8px; padding:4px 6px; background:oklch(98% 0.01 250); border-left:3px solid oklch(60% 0.15 50); font-size:8.4pt; }
.lx-next-actions b { color:oklch(34% 0.07 255); }
.lx-next-actions span { color:oklch(46% 0 0); }
.lx-bot-matrix { width:100%; border-collapse:collapse; font-size:8.4pt; }
.lx-bot-matrix td, .lx-bot-matrix th { border-bottom:1px solid oklch(93% 0.01 250); padding:4px 7px 4px 0; text-align:left; vertical-align:top; }
.lx-bot-matrix th { font-size:7.5pt; font-weight:normal; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.04em; }
.lx-bot-matrix .ua { font-family:"Courier New",monospace; color:oklch(30% 0.05 255); white-space:nowrap; }
.lx-bot-matrix .rule { color:oklch(47% 0 0); }
.lx-bot-matrix tr.control td { background:oklch(97.5% 0.012 250); }
.lx-bot-matrix tr.control .ua b { color:oklch(42% 0.03 250); }
.lx-bot-matrix .tag { display:inline-block; margin-left:5px; padding:0 4px; border-radius:2px; font-family:Tahoma,Verdana,sans-serif; font-size:6.8pt; text-transform:uppercase; letter-spacing:.05em; color:oklch(38% 0.04 250); background:oklch(90% 0.03 250); vertical-align:1px; }
.lx-bot-matrix .na { color:oklch(62% 0 0); }
.lx-bot-caveat { margin:0 0 8px; padding:6px 8px; border-left:3px solid oklch(72% 0.15 75); background:oklch(97% 0.03 85); font-size:8.4pt; color:oklch(35% 0.04 60); }
.lx-badge.no { background:oklch(52% 0.17 27); }
.lx-kindrow td { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.6pt; font-weight:bold; color:oklch(38% 0.07 255); padding-top:9px; }
.lx-mult { font-family:"Courier New",monospace; font-size:7.8pt; color:oklch(38% 0.09 150); background:oklch(94% 0.04 150); border:1px solid oklch(80% 0.06 150); border-radius:8px; padding:1px 7px; white-space:nowrap; }
.lx-bots th.num, .lx-bots td.num { text-align:right; font-family:"Courier New",monospace; white-space:nowrap; padding-right:10px; }

/* the dollar-thesis verdict strip, above every scanned lens. This is the one
   claim on the page a non-technical reader repeats afterward, so it is the one
   block sized to be read across a room rather than over a shoulder: 10.6pt
   against the 9.4pt it replaces, which is the largest body text in the pane
   without competing with the readiness score's 29pt hero below it. Deliberately
   NOT a second hero number — two 30pt figures stacked would make neither read. */
.lx-verdict { margin:0 0 11px; padding:9px 12px; border:1px solid oklch(74% 0.09 150); border-left:4px solid oklch(52% 0.14 150); border-radius:3px; background:linear-gradient(180deg,oklch(98% 0.02 150),oklch(96% 0.03 150)); color:oklch(30% 0.03 255); font-size:10.6pt; line-height:1.5; text-wrap:pretty; }
.lx-verdict b { color:oklch(34% 0.13 150); font-family:"Courier New",monospace; font-size:10.2pt; }
/* the readiness score, relocated from the pane body onto the strip: the pane
   below now shows the raw observation, and analysis rides up here with the
   dollars. One anchor number, not a second hero. */
/* a <button> now: the strip says "every check sits under Agent-ready?", so the
   number itself jumps there. Button chrome stripped; hover underlines the /100
   as the affordance. */
.lx-verdict-score { float:left; margin:1px 11px 2px 0; padding:0; border:0; background:none; cursor:pointer; font:bold 21pt "Trebuchet MS",Verdana,sans-serif; line-height:1; color:oklch(38% 0.14 255); white-space:nowrap; }
.lx-verdict-score span { font:normal 9pt Tahoma,Verdana,sans-serif; color:oklch(53% 0 0); }
.lx-verdict-score:hover span { text-decoration:underline; color:oklch(42.61% 0.2353 263.74); }
.lx-verdict-score:focus-visible { outline:1px dotted oklch(42.61% 0.2353 263.74); outline-offset:2px; }
.lx-verdict::after { content:""; display:block; clear:both; }

/* the computed HTTP-vs-rendered disagreement, atop the Browser Run pane */
.lx-browser-delta { margin:0 0 10px; padding:8px 11px; border:1px solid oklch(74% 0.08 210); border-left:4px solid oklch(50% 0.12 215); border-radius:3px; background:linear-gradient(180deg,oklch(98% 0.015 210),oklch(95% 0.025 210)); color:oklch(29% 0.04 220); font-size:9.6pt; line-height:1.5; text-wrap:pretty; }
.lx-browser-delta b { color:oklch(32% 0.11 220); font-family:"Courier New",monospace; }

/* agent trace: an XP console of what an agent would do */
.lx-trace { font-family:"Courier New",Courier,monospace; font-size:8.7pt; line-height:1.5; background:oklch(22% 0.02 255); border-radius:3px; padding:9px 10px; color:oklch(90% 0.02 150); }
.lx-trace-line { display:grid; grid-template-columns:14px 1fr; gap:6px; padding:2px 0; align-items:start; }
.lx-trace-line + .lx-trace-line { border-top:1px solid oklch(30% 0.02 255); }
.lx-trace-g { text-align:center; font-weight:bold; }
.lx-trace-line.ok .lx-trace-g { color:oklch(78% 0.16 150); }
.lx-trace-line.warn .lx-trace-g { color:oklch(80% 0.15 85); }
.lx-trace-line.no .lx-trace-g { color:oklch(72% 0.17 27); }
.lx-trace-line.no span:last-child, .lx-trace-line.warn span:last-child { color:oklch(96% 0.01 150); }

/* Machine briefing + Delta lab */
.lx-mode-note { margin:7px 0 0; padding:5px 8px; border-left:3px solid oklch(55% 0.14 250); background:oklch(97% 0.012 250); color:oklch(42% 0.03 255); font-size:8.7pt; }
.lx-brief-lede { margin:0 0 10px; padding:7px 9px; border:1px solid oklch(82% 0.04 250); background:linear-gradient(180deg,oklch(98% 0.01 250),oklch(94% 0.018 250)); color:oklch(31% 0.04 255); font-size:9pt; line-height:1.45; }
.lx-brief-lede b { color:oklch(35% 0.13 250); }
.lx-focus { margin:0 0 12px; padding:7px 8px 1px; border:1px solid oklch(77% 0.07 250); background:linear-gradient(180deg,oklch(98% 0.018 250),oklch(94% 0.025 250)); box-shadow:inset 0 1px #fff; }
.lx-focus .lx-sec { margin-bottom:7px; }
.lx-focus .lx-sec-h { color:oklch(29% 0.12 250); }
.lx-focus .lx-kv td { border-bottom-color:oklch(88% 0.025 250); }
.lx-delta-intro { margin:0 0 10px; padding:7px 9px; border:1px solid oklch(82% 0.08 75); background:oklch(97% 0.035 85); color:oklch(39% 0.05 60); font-size:9pt; line-height:1.45; }
.lx-cf-credit { margin-top:10px; font-size:8pt; color:oklch(55% 0 0); line-height:1.5; }
.lx-cf-credit a { color:oklch(42.61% 0.2353 263.74); }
/* auto-fill, not a fixed 2: Delta owns the full 980px window now that the
   Human pane no longer rides along, so the cards flow 3-up there and still
   collapse cleanly wherever the grid lands somewhere narrower. */
.lx-cf-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:6px; margin:5px 0 12px; }
.lx-cf-card { border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:7px 8px; background:oklch(99% 0.003 250); }
.lx-cf-card.is-on { border-color:oklch(61% 0.13 150); background:oklch(97% 0.025 150); }
.lx-cf-card h4 { margin:0 0 3px; font-family:"Trebuchet MS",Verdana,sans-serif; font-size:9.1pt; color:oklch(32% 0.07 255); }
.lx-cf-card p { margin:0 0 6px; color:oklch(48% 0 0); font-size:8.3pt; line-height:1.35; }
.lx-cf-toggle { display:inline-flex; align-items:center; gap:5px; border:1px solid oklch(65% 0.03 250); border-radius:3px; padding:2px 6px; background:linear-gradient(180deg,#fff,oklch(91% 0.012 250)); color:oklch(34% 0.06 255); font-family:"Courier New",monospace; font-size:8pt; cursor:pointer; }
.lx-cf-toggle:hover { border-color:oklch(48% 0.12 250); }
.lx-cf-toggle[aria-pressed="true"] { color:#fff; border-color:oklch(43% 0.12 150); background:linear-gradient(180deg,oklch(59% 0.13 150),oklch(45% 0.15 150)); }
.lx-cf-dot { width:7px; height:7px; display:inline-block; border-radius:50%; background:oklch(60% 0 0); }
.lx-cf-toggle[aria-pressed="true"] .lx-cf-dot { background:oklch(88% 0.15 105); }
.lx-path { display:grid; gap:5px; margin-top:4px; }
.lx-stage { display:grid; grid-template-columns:88px 1fr; gap:7px; align-items:start; padding:5px 0; border-bottom:1px solid oklch(93% 0.01 250); font-size:8.6pt; }
.lx-stage:last-child { border-bottom:0; }
.lx-stage-name { font-family:"Courier New",monospace; color:oklch(39% 0.08 255); }
.lx-stage-copy { color:oklch(32% 0 0); }
.lx-stage-copy .lx-badge { margin-right:4px; }
.lx-proof { margin-top:8px; font-size:8.2pt; color:oklch(52% 0 0); }
.lx-proof b { color:oklch(38% 0.06 255); }
@media (max-width:700px){ .lx-composite-sources{ grid-template-columns:1fr; } .lx-composite-caption{ min-height:0; } }
@media (max-width:560px){ .lx-cf-grid{ grid-template-columns:1fr; } .lx-stage{ grid-template-columns:74px 1fr; } .lx-readiness-cats{ grid-template-columns:1fr; } .lx-readiness-hero{ align-items:flex-start; } .lx-next-actions div{ grid-template-columns:1fr; gap:2px; } .lx-bot-matrix{ min-width:620px; } .lx-reader-recovery li{ grid-template-columns:1fr; gap:2px; } }

/* state of the machine web — a compact rail on the page, full sourced cards in
   a dialog the rail's "?" opens (it used to open itself on arrival) */
/* the rail is one line of headline numbers between the lede and the address bar,
   sunken like an XP status strip so it reads as instrumentation, not another
   paragraph. The "?" is pinned to the strip's top-right, so it stays put when
   the facts stack under 560px. */
.lx-sow-rail { display:flex; align-items:flex-start; gap:8px; margin:0 0 9px; padding:4px 6px 4px 8px; font-size:8.5pt; color:oklch(45% 0.02 255); background:oklch(97.5% 0.006 250); border:1px solid; border-color:oklch(80% 0.02 250) oklch(97% 0 0) oklch(97% 0 0) oklch(80% 0.02 250); border-radius:2px; }
.lx-sow-facts { display:flex; align-items:center; flex-wrap:wrap; gap:2px 10px; flex:1 1 auto; min-width:0; }
.lx-sow-rail-k { color:oklch(52% 0 0); }
.lx-sow-i { white-space:nowrap; }
.lx-sow-i b { font-family:"Courier New",monospace; font-size:9pt; color:oklch(40% 0.14 255); }
/* the one control here that does NOT grow: a 24px "?" turns this status strip
   into a toolbar (measured: the rail goes 29px -> 34px). So the face stays
   19x19 and only the TARGET grows, via a transparent ::after. -3.5px, not -3:
   an abs-positioned child insets from the PADDING box, which is 17px once the
   1px borders come off, so 17 + 3.5 + 3.5 = exactly 24. The 8px gap to
   .lx-sow-facts is text rather than a target, so nothing can collide. */
.lx-sow-q { position:relative; flex:0 0 auto; min-width:0; width:19px; height:19px; padding:0; font-weight:bold; font-size:9pt; line-height:17px; color:oklch(35% 0.10 258); }
.lx-sow-q::after { content:''; position:absolute; inset:-3.5px; }
.lx-sow-q:active { padding:0 0 0 1px; }
@media (max-width:560px){ .lx-sow-i-x { display:none; } }
/* the shadow is luna.css's modal idiom verbatim (#axp-run): a hard 4px offset
   with NO blur, plus one tight ambient. XP dialogs really did drop a shadow,
   but it was cast, not diffused — the single 0 10px 40px this replaced read as
   a 2015 elevation surface. */
.lx-sow-dialog { padding:0; margin:auto; width:min(660px,calc(100vw - 26px)); max-height:min(88vh,700px); color:oklch(28% 0.02 255); background:oklch(96% 0.014 250); border:1px solid oklch(44% 0.09 258); border-radius:6px 6px 3px 3px; box-shadow:4px 4px 0 rgba(0,30,160,.35),2px 3px 12px -2px oklch(30% 0.12 263 / .55); overflow:hidden; display:none; flex-direction:column; }
.lx-sow-dialog[open] { display:flex; }
.lx-sow-dialog::backdrop { background:oklch(22% 0.04 258 / .38); }
/* open and close on a short scale-from-the-button, so the panel arrives and
   leaves instead of blinking. display + overlay have to ride along as discrete
   transitions or the exit frame never paints; @starting-style supplies the
   entry frame. The closed display:none is also the hit-testing contract: an
   authored display:flex overrides the browser's dialog:not([open]) rule and
   leaves an invisible window swallowing clicks after close. Reduced motion and
   browsers without discrete transitions get the safe instant swap. */
@media (prefers-reduced-motion:no-preference){
  .lx-sow-dialog { opacity:0; transform:scale(.96); transition:opacity 120ms ease-out, transform 120ms ease-out, overlay 120ms allow-discrete, display 120ms allow-discrete; }
  .lx-sow-dialog[open] { opacity:1; transform:scale(1); }
  @starting-style { .lx-sow-dialog[open] { opacity:0; transform:scale(.96); } }
  .lx-sow-dialog::backdrop { opacity:0; transition:opacity 120ms ease-out, overlay 120ms allow-discrete, display 120ms allow-discrete; }
  .lx-sow-dialog[open]::backdrop { opacity:1; }
  @starting-style { .lx-sow-dialog[open]::backdrop { opacity:0; } }
}
.lx-sow-tb { display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:3px 4px 4px 10px; background:linear-gradient(180deg, oklch(62% 0.16 256), oklch(45% 0.19 260)); }
.lx-sow-kicker { font:bold 10.5pt "Trebuchet MS",Verdana,sans-serif; color:#fff; text-shadow:0 1px 1px oklch(24% 0.1 260 / .6); }
/* 24x24 rather than the ::after trick the other two use, because both pseudos
   here already draw the X. XP's own caption close was 21px tall, so this is
   nearer the real thing than the 20 it replaces; .lx-sow-tb sheds 2px of
   padding so the caption bar grows 2px rather than 4. */
.lx-sow-x { margin-left:auto; width:24px; height:24px; padding:0; overflow:hidden; font-size:0; cursor:pointer; position:relative; border:1px solid #d8401c; border-radius:3px; background-color:#e45f3e; background-image:linear-gradient(180deg,#e8795f,#e45d3d 55%,#ae3110); }
.lx-sow-x:hover, .lx-sow-x:focus-visible { filter:brightness(1.12); outline:none; box-shadow:0 0 4px oklch(70% 0.18 30 / .7); }
.lx-sow-x::before, .lx-sow-x::after { content:''; position:absolute; left:50%; top:50%; width:11px; height:2px; margin:-1px 0 0 -5.5px; background:#fff; }
.lx-sow-x::before { transform:rotate(45deg); } .lx-sow-x::after { transform:rotate(-45deg); }
.lx-sow-inner { padding:11px 13px 13px; overflow:auto; }
.lx-sow-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.lx-sow-card { border:1px solid oklch(86% 0.02 250); border-radius:3px; background:#fff; padding:8px 10px; }
.lx-sow-stat { font:bold 12pt "Courier New",monospace; color:oklch(40% 0.14 255); margin:0 0 3px; line-height:1.1; }
.lx-sow-claim { font-size:8.6pt; line-height:1.42; color:oklch(30% 0.02 255); }
.lx-sow-src { margin-top:4px; font-size:7.8pt; color:oklch(55% 0 0); }
.lx-sow-src a { color:oklch(42.61% 0.2353 263.74); text-decoration:none; }
.lx-sow-foot { margin-top:10px; padding-top:8px; border-top:1px solid oklch(88% 0.02 250); font-size:8.8pt; line-height:1.45; color:oklch(38% 0.02 255); }
.lx-sow-foot b { color:oklch(33% 0.10 263); }
.lx-sow-open { font:inherit; color:oklch(42.61% 0.2353 263.74); background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; }
@media (max-width:520px){ .lx-sow-grid{ grid-template-columns:1fr; } }

/* the About dialog: three eras + the instrument's rules. Shares the sow dialog
   chrome; only the inner layout is its own. */
.lx-abt-thesis { margin:0 0 11px; font-size:9.6pt; line-height:1.5; color:oklch(28% 0.02 255); }
.lx-abt-era { display:grid; grid-template-columns:82px 1fr; gap:10px; padding:9px 0; border-top:1px solid oklch(88% 0.02 250); }
.lx-abt-when b { display:block; font-family:"Trebuchet MS",Verdana,sans-serif; font-size:10pt; color:oklch(33% 0.10 263); }
.lx-abt-when span { font-family:"Courier New",monospace; font-size:7.8pt; color:oklch(55% 0 0); }
.lx-abt-label { font-weight:bold; font-size:9.2pt; color:oklch(30% 0.05 255); margin:0 0 2px; }
.lx-abt-claim { font-size:8.8pt; line-height:1.45; color:oklch(33% 0.01 255); }
.lx-abt-jumps { margin-top:6px; display:flex; align-items:center; flex-wrap:wrap; gap:5px; }
.lx-abt-jumps > span { font-size:8pt; color:oklch(52% 0 0); }
.lx-abt-rules { margin-top:4px; padding:8px 10px; border:1px solid oklch(86% 0.02 250); border-radius:3px; background:#fff; }
.lx-abt-rules > b { display:block; font-family:"Trebuchet MS",Verdana,sans-serif; font-size:9.2pt; color:oklch(33% 0.10 263); margin:0 0 4px; }
@media (max-width:520px){ .lx-abt-era { grid-template-columns:1fr; gap:3px; } }

/* head-to-head (?url=A&vs=B): two sites, one rubric. .lx-off hides the
   single-scan chrome while the DOM stays intact, so leaving vs mode is a class
   flip rather than a rebuild. !important because the toolbar/panes carry their
   own display values that would otherwise beat the [class] toggle. */
.lx-off { display:none !important; }
.lx-addr-vs { margin-top:4px; }
.lx-vs-toggle { font-weight:normal; padding:3px 10px; }
.lx-vs-note { margin:7px 0 0; padding:5px 8px; border-left:3px solid oklch(55% 0.14 250); background:oklch(97% 0.012 250); color:oklch(42% 0.03 255); font-size:8.7pt; }
.lx-vs-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:8px; }
.lx-vs-col { border:1px solid oklch(70% 0.03 250); border-radius:3px; background:#fff; padding:0 0 9px; }
.lx-vs-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:#fff; background:linear-gradient(180deg, oklch(56% 0.12 252), oklch(45% 0.15 255)); padding:4px 8px; border-radius:2px 2px 0 0; display:flex; justify-content:space-between; align-items:center; gap:8px; }
.lx-vs-h span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lx-vs-h a { color:#fff; font-weight:normal; text-transform:none; letter-spacing:0; font-size:8pt; white-space:nowrap; }
.lx-vs-body { padding:8px 10px 0; }
.lx-vs-score { display:flex; align-items:center; gap:8px; margin:2px 0 9px; }
.lx-vs-score b { font:bold 26pt "Trebuchet MS",Verdana,sans-serif; line-height:1; color:oklch(38% 0.14 255); white-space:nowrap; }
.lx-vs-score b span { font:normal 9.5pt Tahoma,Verdana,sans-serif; color:oklch(53% 0 0); }
.lx-vs-score > span:last-child { font-size:9pt; color:oklch(30% 0.04 255); }
.lx-vs-headline { margin-top:8px; padding:9px 12px; border:1px solid oklch(74% 0.09 150); border-left:4px solid oklch(52% 0.14 150); border-radius:3px; background:linear-gradient(180deg,oklch(98% 0.02 150),oklch(96% 0.03 150)); color:oklch(30% 0.03 255); font-size:10.6pt; line-height:1.5; text-wrap:pretty; }
.lx-vs-headline b { color:oklch(34% 0.13 150); font-family:"Courier New",monospace; font-size:10.2pt; }
@media (max-width:640px){ .lx-vs-grid{ grid-template-columns:1fr; } }

/* status bar */
.lx-status { margin-top:9px; border-top:1px solid oklch(86% 0.03 260); padding-top:6px; display:flex; flex-wrap:wrap; gap:5px 14px; font-size:8.6pt; color:oklch(45% 0 0); }
.lx-status b { color:oklch(30% 0.04 255); font-weight:bold; }
.lx-status .err { color:oklch(55% 0.2 27); font-weight:bold; }
footer { text-align:center; font-size:9pt; color:oklch(45% 0 0); margin-top:14px; padding-top:11px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
@media (max-width:720px){ .lx-panes{ flex-direction:column; } .lx-panes.is-both .lx-pane{ min-height:280px; } }
`,
    body: unsafeHtml(`
    <h1>The Other Web</h1>
    <p class="lx-lede">Every page has two audiences: the person looking at it and the machine reading over their shoulder. The semantic web asked publishers to mark meaning; today&rsquo;s models scrape the human page; the next web must decide how machines act. Paste one URL to compare the human page, the HTTP response, and the browser-rendered result. Fetched server-side, honestly, as <a href="/bot">AadharshBot</a>.</p>
    ${lensStateOfWebRail()}
    <!-- both "?" triggers open a <dialog> through script, so with JS off they are
         buttons that do nothing. The rail's numbers are plain SSR'd text and stay.
         Same honesty rule as the homepage's no-JS photo and playlist notes. -->
    <noscript><style>.lx-sow-q,.lx-sow-open{display:none}</style></noscript>

    <form class="lx-addr" id="lx-form" action="/lens" method="get">
      <span class="lx-globe" aria-hidden="true"></span>
      <label class="lx-addr-label" for="lx-url">Address</label>
      <input id="lx-url" class="lx-url" type="text" name="url" value="${escAttr(value)}" inputmode="url" placeholder="https://example.com  —  paste any URL" autocomplete="off" spellcheck="false"
             title="Any http(s) URL. This server fetches it as AadharshBot and shows you what came back.">
      <button class="lx-go" type="submit">Go</button>
      <button class="lx-go lx-vs-toggle" type="button" id="lx-vs-toggle" title="Compare two sites through one rubric" aria-expanded="${vsActive ? "true" : "false"}" aria-controls="lx-addr-vs">vs&hellip;</button>
    </form>
    <!-- the second address row. Its input belongs to the form above
         (form=/name=), so with JS off a filled row still submits ?url=&vs= and
         the server renders the comparison — the same no-JS floor single scans
         get. The toggle button only reveals the row, so it stays JS-gated. -->
    <div class="lx-addr lx-addr-vs${vsActive ? "" : " lx-off"}" id="lx-addr-vs">
      <span class="lx-globe" aria-hidden="true"></span>
      <label class="lx-addr-label" for="lx-url-vs">vs</label>
      <input id="lx-url-vs" class="lx-url" type="text" form="lx-form" name="vs" value="${escAttr(vsValue)}" inputmode="url" placeholder="https://the-other-site.com  —  head-to-head, one rubric" autocomplete="off" spellcheck="false"
             title="A second URL. Both are scanned against one rubric, side by side.">
      <button class="lx-go lx-vs-toggle" type="button" id="lx-vs-close" title="Back to a single scan">&#215;</button>
    </div>
    <div class="lx-chips">
      <span class="lx-chips-label">Try:</span>
      <button class="lx-chip" data-url="https://aadhar.sh/">aadhar.sh</button>
      <button class="lx-chip" data-url="https://daringfireball.net/">a hand-built blog</button>
      <button class="lx-chip" data-url="https://stripe.com/">a modern marketing site</button>
      <button class="lx-chip" data-url="https://en.wikipedia.org/wiki/Semantic_Web">a Wikipedia article</button>
      <button class="lx-chip" data-url="https://www.nytimes.com/">a publisher with AI terms</button>
      <button class="lx-chip" data-url="https://aadhar.sh/llms-full.txt">a bot paywall (x402)</button>
      <button class="lx-chip" data-url="https://example.com/">the bare minimum</button>
      <button class="lx-chip" data-vs-pair="https://stripe.com/|https://aadhar.sh/">stripe.com vs aadhar.sh</button>
    </div>

    <div class="lx-toolbar is-${state.view}${vsActive ? " lx-off" : ""}" id="lx-toolbar">
      <!-- Ordered by DENSITY, cheapest to read first. Compare is last because it
           is three panes at once and reads as a wall to somebody arriving cold;
           it was first here until 2026-08-14. It is still the DEFAULT view
           (view=both), so the selected segment sits at the END of the strip on
           load: order says what to reach for next, not what opens.
           NB: no backticks in this comment. It lives inside a JS template
           literal, so one would end the string mid-file and the build would
           fail on a line that looks fine (CLAUDE.md gotcha 19). -->
      <div class="lx-view" role="radiogroup" aria-label="page mode">
        <button class="lx-seg${state.view === "human" ? " is-on" : ""}" data-view="human" role="radio" aria-checked="${state.view === "human" ? "true" : "false"}" type="button">Human</button>
        <button class="lx-seg${state.view === "machine" ? " is-on" : ""}" data-view="machine" role="radio" aria-checked="${state.view === "machine" ? "true" : "false"}" type="button">Machine</button>
        <button class="lx-seg${state.view === "browser" ? " is-on" : ""}" data-view="browser" role="radio" aria-checked="${state.view === "browser" ? "true" : "false"}" type="button">Browser</button>
        <button class="lx-seg${state.view === "delta" ? " is-on" : ""}" data-view="delta" role="radio" aria-checked="${state.view === "delta" ? "true" : "false"}" type="button">Delta<span class="lx-seg-n" id="lx-delta-n"${cfOn ? "" : " hidden"}>${cfOn || ""}</span></button>
        <button class="lx-seg${state.view === "both" ? " is-on" : ""}" data-view="both" role="radio" aria-checked="${state.view === "both" ? "true" : "false"}" type="button">Compare</button>
      </div>
    </div>
    <div class="lx-mode-note${vsActive ? " lx-off" : ""}" id="lx-mode-note">${modeNote}</div>

    <div class="lx-vs${vsActive ? "" : " lx-off"}" id="lx-vs">${vsActive ? lensVsFragment(compare.payload) : ""}</div>

    <div class="lx-panes is-${state.view}${vsActive ? " lx-off" : ""}" id="lx-panes">
      <section class="lx-pane lx-pane-human" id="lx-human">
        <div class="lx-pane-h" id="lx-human-h">${humanHeader}</div>
        <div class="lx-body" id="lx-human-body">${seeded ? lensHumanFragment(initial) : '<div class="lx-empty">Paste any URL above.<span>You get the page a person sees, the raw file a machine gets instead, and what that difference costs.</span></div>'}</div>
      </section>
      <section class="lx-pane lx-pane-machine" id="lx-machine">
        <div class="lx-pane-h" id="lx-machine-h">${machineHeader}</div>
        <!-- ONE scroller over all three children, so the pane reads top to
             bottom as: everything no tab changes, then the tabs, then only what
             they change. The tab strip is sticky inside it, so it pins to the
             top of the pane the moment you scroll past the static half and the
             lens report never scrolls away from its own controls. -->
        <div class="lx-machine-scroll" id="lx-machine-scroll">
          <!-- The whole machine briefing sits ABOVE the tab strip because no tab
               changes any of it: the score, the agent trace, the observed
               document, the affordance table, the copyable brief and the
               boundaries are one claim about the URL rather than one lens's
               evidence. Under the tabs they read as the pane's body, so
               switching tabs looked like a no-op, with the block they do change
               pushed below several hundred px of unchanging report. Filled by
               renderMachine() in Machine view only; empty (and hidden by
               :empty) everywhere else, including the no-script render. -->
          <div class="lx-machine-top" id="lx-machine-top"></div>
          <!-- The lens tabs live inside the pane they steer. Order is evidence to
               verdict: raw observation first (the default lens, so the first tab is
               the selected one on load), Agent-ready? last as the capstone. -->
          <div class="lx-lenses" role="tablist" aria-label="machine lens">${LENS_TAB_ORDER.map((key) =>
            `<button class="lx-tab${state.lens === key ? " is-on" : ""}" data-lens="${key}" role="tab" aria-selected="${state.lens === key ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS[key]}</button>`
          ).join("")}</div>
          <div class="lx-body" id="lx-machine-body">${seeded ? lensMachineFragment(initial, state) : '<div class="lx-empty">What the machine actually receives.<span>The raw file, the rules it is handed, and the bill for reading them.</span></div>'}</div>
        </div>
      </section>
      <section class="lx-pane lx-pane-browser" id="lx-browser">
        <div class="lx-pane-h" id="lx-browser-h">${browserHeader}</div>
        <div class="lx-body" id="lx-browser-body">${lensBrowserFragment(null)}</div>
      </section>
    </div>

    <div class="lx-status" id="lx-status">${vsActive
      ? (compare.payload && compare.payload.ok
        ? '<span><b>Head-to-head</b></span><span>' + escHtml(lensVsHost(value)) + " vs " + escHtml(lensVsHost(vsValue)) + '</span><span style="margin-left:auto">both fetched server-side as AadharshBot</span>'
        : '<span class="err">Comparison failed:</span> <span>' + escHtml((compare.payload && compare.payload.error) || "unknown error") + "</span>")
      : seeded || (initial && !initial.ok) ? lensStatusFragment(initial, state) : '<span>Idle. Nothing is fetched until you ask, and then just once, server-side, with no logging.</span>'}</div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; <button type="button" class="lx-sow-open" data-abt-open>a research toy about how machines read the web</button> &middot; <button type="button" class="lx-sow-open" data-sow-open>the state of the machine web</button> &middot; fetched by <a href="/bot">AadharshBot</a></footer>
    ${lensStateOfWebPanel()}
    ${lensAboutPanel()}
    <div class="lx-tip" id="lx-tip" popover="manual" role="tooltip"></div>
    <script type="application/json" id="lx-glossary">${lensScriptJson(LENS_GLOSSARY)}</script>
    ${initialScript}
`),
    // The idle shell is complete server-rendered HTML, including a native GET form,
    // so it loads only the tiny interaction bootstrap. build.mjs hashes the full
    // lens client first, rewrites that exact URL into the bootstrap, then hashes the
    // bootstrap itself. A fresh shell therefore cannot pair with either stale layer.
    // The plain files stay served, short-cached, for dev and stale HTML.
    scripts: unsafeHtml(`<script src="/lens-boot.js" defer></script>`),
    cache: "public, max-age=60, s-maxage=300",
    headers: {
      // No x-robots-tag here: the bare shell is meant to be indexed. handleLens
      // adds x-robots-tag: noindex for ?url= scans only.
      // /lens embeds arbitrary sites in the Human view, so it needs a looser
      // policy than the site default (which has no frame-src → falls back to
      // default-src 'self' and blocks every cross-origin iframe). This relaxes
      // ONLY frame-src (any https origin, for the live iframe) and img-src
      // (blob: for the Browser Run screenshot, https: for OG-card art);
      // everything else stays locked down. withSecurityHeaders sees a CSP is
      // already present and leaves it alone. frame-ancestors 'none' keeps OTHER
      // sites from embedding /lens itself.
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; frame-src https:; child-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'",
    },
  });
}

// /lens/fetch?url=… → the stable machine-facing JSON contract.
export async function handleLensFetch(request, env, ctx) {
  if (new URL(request.url).searchParams.get("mode") === "cloudflare") {
    return handleLensCloudflareScore(request, env, ctx);
  }
  const result = await inspectLensRequest(request, env, ctx);
  return jsonResponse(result.payload, result.status);
}

const CLOUDFLARE_AGENT_READINESS_MCP = "https://isitagentready.com/mcp";
const CLOUDFLARE_SCORE_TIMEOUT_MS = 9000;
const CLOUDFLARE_SCORE_BODY_CAP = 192 * 1024;
const CLOUDFLARE_SCORE_TTL = 6 * 60 * 60;

// Cloudflare's public Agent Readiness scanner is an INDEPENDENT input to Lens,
// not a number Lens recreates and then presents as corroboration. The MCP
// answers with Streamable HTTP / SSE today, though JSON is valid too. Parse both
// and retain only the normalized level: a third party's complete report neither
// belongs in our response contract nor in KV.
export function lensParseCloudflareAgentScore(body) {
  const messages: any[] = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { messages.push(JSON.parse(line.slice(5).trim())); } catch (_e) {}
  }
  if (!messages.length) {
    try { messages.push(JSON.parse(String(body || ""))); } catch (_e) {}
  }
  const text = messages.map((message) => {
    const content = message && message.result && message.result.content;
    if (Array.isArray(content)) return content.map((item) => item && item.text || "").join("\n");
    return JSON.stringify(message && (message.result || message) || "");
  }).join("\n");
  const match = text.match(/\bLevel\s+([0-5])\s*\/\s*5(?:\s*(?:--|[-:\u2013\u2014])\s*\**\s*([^\n*]+))?/i);
  if (!match) return null;
  const level = Number(match[1]);
  return {
    available: true,
    level,
    score: level * 20,
    levelName: String(match[2] || "").trim().slice(0, 80) || null,
    source: "Cloudflare Agent Readiness",
    sourceUrl: "https://isitagentready.com/",
  };
}

export async function handleLensCloudflareScore(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env)) {
    return jsonResponse({ ok: false, error: "Slow down — 30 lookups a minute. Try again shortly." }, 429);
  }

  const cacheKey = "lens:cloudflare-score:" + (await lensSha256Hex(v.url));
  if (env && env.RN_KV) {
    try {
      const cached = await env.RN_KV.get(cacheKey, "json");
      if (cached && cached.available) return jsonResponse({ ok: true, cached: true, ...cached });
    } catch (_e) { /* an advisory source must not fail because its cache did */ }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUDFLARE_SCORE_TIMEOUT_MS);
  try {
    const response = await fetch(CLOUDFLARE_AGENT_READINESS_MCP, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": BOT_UA,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "lens-cloudflare-score", method: "tools/call",
        params: { name: "scan_site", arguments: { url: v.url, profile: "all" } },
      }),
      signal: controller.signal,
    });
    const capped = await lensReadCapped(response, CLOUDFLARE_SCORE_BODY_CAP);
    const parsed = response.ok && !capped.truncated ? lensParseCloudflareAgentScore(capped.text) : null;
    if (!parsed) {
      return jsonResponse({
        ok: true, available: false,
        error: response.ok ? "Cloudflare's score could not be read." : "Cloudflare's scanner did not answer.",
      });
    }
    if (env && env.RN_KV) {
      const write = env.RN_KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: CLOUDFLARE_SCORE_TTL });
      if (ctx && isCallable(ctx.waitUntil)) ctx.waitUntil(write);
      else await write;
    }
    return jsonResponse({ ok: true, cached: false, ...parsed });
  } catch (_e) {
    return jsonResponse({ ok: true, available: false, error: "Cloudflare's scanner is unavailable right now." });
  } finally {
    clearTimeout(timer);
  }
}


// How long a render waits for the page to settle, shared by /lens/shot and
// /lens/browser so the two cannot drift into disagreeing about what "rendered"
// means.
//
// `networkidle0` (ZERO in-flight connections for 500ms) was the setting here
// until 2026-08-07, and on a commercial site it is unreachable: an analytics
// beacon, an ad refresh, a websocket or any poll holds the count above zero
// indefinitely. The page paints in a second or two, the wait runs to the full
// timeout regardless, and Cloudflare then answers `422 / code 6002 Navigation
// timeout` and discards the render — the screenshot is lost even though the
// browser had it long before.
//
// Measured against production before this change, same worker build:
// theverge.com failed on BOTH endpoints at ~18.8s, while example.com (static,
// so genuinely idle) passed. Failure tracked the TARGET, never the endpoint,
// which is why the symptom reads as intermittent rather than broken.
//
// `networkidle2` tolerates up to 2 lingering connections, which is where a page
// with live telemetry actually settles, and it is the standard escape from this
// trap. It still waits for JavaScript, which is the whole point of the Browser
// Run view.
//
// The 18s ceiling stays. It is a real cost, since the free plan allows 10
// MINUTES of browser time per day ACCOUNT-WIDE and roughly 33 timeouts exhaust
// it, but shortening it trades that saving against false failures on genuinely
// slow pages. The budget is better defended by making success the common case
// than by capping the loss on each failure.
const LENS_GOTO = { waitUntil: "networkidle2", timeout: 18000 };

// /lens/shot?url=… → a faithful PNG of the page, rendered by Cloudflare
// Browser Run (real headless Chrome, server-side). The Human view uses this
// only when a site forbids live framing.
export async function handleLensShot(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (!env.BROWSER || !isCallable(env.BROWSER.quickAction)) return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);

  // THE CACHE IS READ BEFORE THE BUDGETS, and the order is the point rather than
  // a micro-optimization. Every limit below exists to ration Browser Run: 6 calls
  // a minute account-wide and 10 browser-minutes a day. A cache hit spends
  // exactly none of that, so refusing one protects nothing and costs the reader a
  // 429 for a screenshot this Worker is already holding.
  //
  // It reads as a bug at the worst moment, because the cache is FULLEST exactly
  // when demand is highest: a page everyone is looking at is warm, and warm is
  // the state this ordering punished. Measured 2026-08-15 against a fully warmed
  // cache, one visitor clicking through the seeded chips got 429 on the third,
  // with all seven entries present in KV the whole time.
  //
  // /lens/wire has read cache-first since it was written. This is the older pair
  // catching up to it, not a new policy.
  const cacheKey = "lens:shot:" + (await lensSha256Hex(v.url));
  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "arrayBuffer");
    // a hit emits the same span name as a miss, differing only in lens.cache.
    // Two span names would make the hit RATE a join instead of a group-by.
    if (hit) {
      return span("lens.shot", (s) => {
        s.setAttribute("lens.target_host", safeHost(v.url));
        s.setAttribute("lens.cache", "hit");
        s.setAttribute("lens.png_bytes", hit.byteLength);
        return new Response(hit, { headers: lensPngHeaders(true) });
      });
    }
  }

  // Past here a miss means a real render, so screenshots take the tighter per-IP
  // limit and then the shared one.
  if (await overLensBudget(LENS_BUDGETS.shot, request, env)) {
    return jsonResponse({ ok: false, error: `Snapshots are rate-limited to ${LENS_BUDGETS.shot.max}/min. Hang on a moment.` }, 429);
  }
  // The shared ceiling is checked AFTER the per-caller one, so a single heavy
  // visitor is turned away by their own budget before they can spend everyone's.
  if (await overLensBudget(LENS_BUDGETS.browserAll, request, env)) {
    return jsonResponse({ ok: false, error: "The shared browser budget for this minute is spent. Try again shortly." }, 429);
  }

  // Headless Chrome is by far the most expensive thing this site can be asked to
  // do, and it is the only one with a real external dependency that can be slow
  // without being wrong. The 1h KV cache already reports itself to the client via
  // `x-lens-cache`; the span records the same fact server-side so the hit rate is
  // measurable rather than inferable, and so a slow render is separable from a
  // slow cache read.
  return span("lens.shot", async (s) => {
    s.setAttribute("lens.target_host", safeHost(v.url));
    s.setAttribute("lens.cache", "miss");
    const payload = {
      url: v.url,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      screenshotOptions: { fullPage: true, type: "png" },
      gotoOptions: LENS_GOTO,
      userAgent: BOT_UA,
    };
    let r;
    try {
      r = await span("lens.shot.quick_action", () => env.BROWSER.quickAction("screenshot", payload));
    } catch (e) {
      // the binding threw rather than answering: a 502 to the visitor, and until
      // now the reason existed only inside this string.
      s.setAttribute("lens.outcome", "binding_threw");
      s.setAttribute("lens.error", (e && e.message) || String(e));
      return jsonResponse({ ok: false, error: "Browser Run request failed: " + ((e && e.message) || e) }, 502);
    }
    const ctype = r.headers.get("content-type") || "";
    // Browser Run refusing us is NOT the target site failing, and the old code
    // reported both as a 502. On the free plan that is the single most likely
    // response here — one Quick Action per 10 seconds account-wide — so the
    // common case was being dressed up as an upstream fault, pointing whoever
    // debugged it at the scanned site instead of at our own budget.
    if (r.status === 429) {
      s.setAttribute("lens.outcome", "browser_budget_spent");
      return jsonResponse({
        ok: false,
        error: `Browser Run is rate-limited right now (free plan: ${BROWSER_FREE_PLAN.perMinute}/min account-wide, ${BROWSER_FREE_PLAN.perDayMinutes} min/day). The live frame and every machine lens still work.`,
      }, 429);
    }
    if (!r.ok || !ctype.startsWith("image/")) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 300); } catch (_e) {}
      s.setAttribute("lens.outcome", "not_an_image");
      s.setAttribute("http.response.status_code", r.status);
      return jsonResponse({ ok: false, error: "Browser Run returned " + r.status + ".", detail }, 502);
    }
    const buf = await r.arrayBuffer();
    s.setAttribute("lens.outcome", "ok");
    s.setAttribute("lens.png_bytes", buf.byteLength);
    // 6h, up from 1h. On the free plan a MISS costs a slice of a 6-per-minute,
    // 10-minute-a-day allowance, while a stale screenshot costs a slightly old
    // picture of a page that mostly did not change. The cache is the real budget
    // control here; the rate limits only stop a burst.
    if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, buf, { expirationTtl: 21600 }));
    return new Response(buf, { headers: lensPngHeaders(false) });
  });
}

// Base64 chars, so roughly 4.5 MB of PNG. Chosen to keep the whole snapshot an
// order of magnitude clear of both the KV value cap and the isolate's memory,
// and because an image past this size is not being LOOKED at — it is a 40,000px
// strip of an infinite-scroll page that no pane can usefully render.
const LENS_BROWSER_SHOT_MAX = 6_000_000;
// KV's own ceiling is 25 MB; stopping short leaves room for the cap above to be
// raised without quietly turning every large snapshot into a failed write.
const LENS_BROWSER_KV_MAX = 20_000_000;

// The "before" side of an interaction delta, read out of the plain snapshot the
// Browser pane's auto-run already cached. Deliberately a READ and never a
// render: manufacturing a before would cost a second Quick Action for one
// click, on an account with ten browser-minutes a day. No plain entry means no
// delta is claimed, which is the honest answer rather than a guessed one.
async function plainTally(env, plainKey) {
  if (!env.RN_KV) return null;
  try {
    const hit = await env.RN_KV.get(plainKey, "json");
    return hit && hit.ok && hit.tally ? hit.tally : null;
  } catch (_e) { return null; }
}

// Both sides of the comparison run through the SAME documentTally(), which is
// the only reason the number is claimable. An in-page innerText count and
// stripped() are different counters, and comparing two incompatible counters is
// the bug deltaStrip already carries a bail for.
function buildInteraction(recipe, receipt, before) {
  const base = { id: recipe.id, label: recipe.label, claim: recipe.claim, before, beforeSource: before ? "kv" : "none" };
  // No receipt at all: the script never ran. Common and expected — a page
  // serving `script-src 'self'` refuses an inline injection and Quick Actions
  // expose no bypass. The client says so using the CSP it already scanned.
  if (!receipt) return { ...base, ran: false, acted: 0, scanned: 0, note: "no-receipt", outcome: "no-receipt" };
  if (receipt.note === "forged-receipt") return { ...base, ...receipt, outcome: "forged-receipt" };
  const outcome = receipt.note === "threw" ? "threw"
    : receipt.note === "none-found" ? "nothing-found"
      : receipt.note === "acted" ? "ran" : receipt.note;
  return { ...base, ...receipt, outcome };
}

// `outcome` exists for the span, where it has to stay separable from
// `lens.outcome` ("the render failed") so that "the render succeeded and the
// recipe found nothing" is still a group-by rather than a filter. The response
// carries `note` and does not need a second spelling of it.
function interactionPayload({ outcome: _outcome, ...rest }) { return rest; }

// /lens/browser?url=… → opt-in rendered evidence for the third Lens pane.
// This deliberately stays separate from /lens/fetch: the normal scan is an
// identified HTTP observation, while this path executes page JavaScript in a
// Browser Run instance and returns a rendered snapshot plus browser structure.
export async function handleLensBrowser(request, env, ctx) {
  const params = new URL(request.url).searchParams;

  // The published allowlist, answered without a url and without a render, so
  // anyone can read exactly what this route is willing to run before they let
  // it run anything. Same route rather than a new one: run_worker_first is
  // capped at 100 rules and a query parameter costs none of them.
  if (params.has("recipes")) {
    return jsonResponse({ ok: true, recipes: lensRecipeCatalog() });
  }

  const v = validateLensTarget(params.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  // Resolved BEFORE the engine check, so a typo'd recipe id answers the same
  // 400 on a deployment with no Browser Run as on one with it. Absent `do` is
  // today's path byte for byte.
  //
  // An unknown id is a 400 and not a silent fall-through to the plain render.
  // Falling through would hand back a perfectly good snapshot that the caller
  // believes is post-interaction, which is the one failure mode this whole
  // feature exists to avoid.
  const recipeId = params.get("do");
  const recipe = recipeId == null ? null : lensRecipe(recipeId);
  if (recipeId != null && !recipe) {
    return jsonResponse({ ok: false, error: "Unknown interaction recipe.", recipes: lensRecipeIds() }, 400);
  }

  if (!hasRenderEngine(env)) return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);

  // The plain key keeps its exact legacy shape and a recipe run APPENDS to it.
  // Hashing url+id together would have been tidier and would also have changed
  // every plain key in one deploy, invalidating the namespace and buying a wave
  // of fresh Quick Actions against a 10 min/day budget. An allowlisted [a-z] id
  // on the end is safe, cheap, and greppable in KV.
  const plainKey = "lens:browser:" + (await lensSha256Hex(v.url));
  const cacheKey = recipe ? plainKey + ":" + recipe.id : plainKey;
  if (env.RN_KV) {
    try {
      const hit = await env.RN_KV.get(cacheKey, "json");
      // same span name as the miss path, so the hit rate is one group-by.
      if (hit && hit.ok) {
        return span("lens.browser", (s) => {
          s.setAttribute("lens.target_host", safeHost(v.url));
          s.setAttribute("lens.cache", "hit");
          return jsonResponse({ ...hit, cached: true });
        });
      }
    } catch (_e) { /* a corrupt cache entry is a miss, never a user-visible failure */ }
  }

  // Past here a miss means a real render, so the per-IP ceiling and then the
  // shared one. Both sit BELOW the cache read above for the reason spelled out
  // in handleLensShot: a hit spends no Browser Run allowance, so rationing one
  // refuses a reader a snapshot this Worker already has.
  //
  // The throw-guard that used to be spelled out here now lives inside
  // overLensBudget, and the reason it existed is worth keeping: an unhandled
  // throw on this path does not produce a JSON error, it produces Cloudflare's
  // HTML 1101 page, which the client then tries to JSON.parse.
  if (await overLensBudget(LENS_BUDGETS.browser, request, env)) {
    return jsonResponse({ ok: false, error: `Browser Run snapshots are rate-limited to ${LENS_BUDGETS.browser.max}/min. Hang on a moment.` }, 429);
  }
  // Same shared ceiling as /lens/shot. Two routes drawing on one account-wide
  // allowance have to bill against one bucket, or each stays politely under a
  // limit that the pair of them blows through together.
  if (await overLensBudget(LENS_BUDGETS.browserAll, request, env)) {
    return jsonResponse({ ok: false, error: "The shared browser budget for this minute is spent. Try again shortly." }, 429);
  }

  // Same reasoning as lens.shot, one step heavier: this asks Browser Run for four
  // formats at once (content, screenshot, markdown, accessibility tree) and has
  // FOUR distinct 502 shapes below — binding threw, non-ok status, invalid JSON,
  // and a body that parsed but carried nothing. They are indistinguishable in the
  // client's error string and now separable on the span.
  return span("lens.browser", async (s) => {
  s.setAttribute("lens.target_host", safeHost(v.url));
  s.setAttribute("lens.cache", "miss");
  const started = Date.now();
  // Fresh per request. The page is being rendered right now and must not be
  // able to guess this; it does not have to survive the request.
  const nonce = recipe ? lensRecipeNonce() : "";
  const payload: Record<string, any> = {
    url: v.url,
    formats: ["content", "screenshot", "markdown", "accessibilityTree"],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    screenshotOptions: { fullPage: true, type: "png" },
    // Same object REFERENCE, not a clone: a contract test asserts this route and
    // /lens/shot share one config by identity, and a per-recipe clone would
    // break it. Both shipping recipes are synchronous, so nothing here needs a
    // settle; an async recipe would ride `waitForTimeout` (a sibling key) rather
    // than reach in here.
    gotoOptions: LENS_GOTO,
    userAgent: BOT_UA,
  };
  // The ONLY place caller input reaches the payload is `url`. `content` is
  // assembled from the frozen registry plus a server-generated nonce, and a
  // contract test asserts no caller bytes appear anywhere else.
  if (recipe) payload.addScriptTag = [{ content: lensRecipeScript(recipe, nonce) }];
  if (recipe) s.setAttribute("lens.recipe", recipe.id);

  let response;
  let engine = "chromium-binding";
  try {
    // Routed through the engine seam so Kitesurf can serve this when a REST
    // token is present. Still returns a Response, because the four distinct 502
    // shapes below are the point and must not be flattened into one.
    const run = await span("lens.browser.quick_action", () => runBrowserAction("snapshot", payload, env));
    if (!run) {
      s.setAttribute("lens.outcome", "no_engine");
      return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);
    }
    response = run.response;
    engine = run.engine;
    s.setAttribute("lens.render_engine", engine);
  } catch (e) {
    s.setAttribute("lens.outcome", "binding_threw");
    s.setAttribute("lens.error", (e && e.message) || String(e));
    return jsonResponse({ ok: false, error: "Browser Run request failed: " + ((e && e.message) || e) }, 502);
  }
  // Browser Run refusing US is not the scanned site failing. /lens/shot learned
  // this and /lens/browser did not, which is how production answered a 502
  // carrying {"code":2001,"message":"Rate limit exceeded"} on 2026-08-06 — a
  // bad-gateway status pointing whoever read it at react.dev instead of at our
  // own six-per-minute allowance. On the free plan this is the MOST likely
  // response here, so it is the one that most needs to be itself.
  if (response.status === 429) {
    s.setAttribute("lens.outcome", "browser_budget_spent");
    return jsonResponse({
      ok: false,
      reason: "budget_spent",
      error: `Browser Run is rate-limited right now (free plan: ${BROWSER_FREE_PLAN.perMinute}/min account-wide, ${BROWSER_FREE_PLAN.perDayMinutes} min/day). Every other lens still works.`,
    }, 429);
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 500); } catch (_e) {}
    s.setAttribute("lens.outcome", "upstream_not_ok");
    s.setAttribute("http.response.status_code", response.status);
    return jsonResponse({ ok: false, error: "Browser Run returned " + response.status + ".", detail }, 502);
  }

  let envelope;
  try { envelope = await response.json(); }
  catch (e) {
    s.setAttribute("lens.outcome", "invalid_json");
    s.setAttribute("lens.error", (e && e.message) || String(e));
    return jsonResponse({ ok: false, error: "Browser Run returned invalid JSON: " + ((e && e.message) || e) }, 502);
  }
  const result = envelope && envelope.result ? envelope.result : envelope || {};
  const meta = envelope && envelope.meta ? envelope.meta : {};
  // Strip the receipt FIRST. Everything downstream — documentTally, the 120KB
  // cap, the body the reader sees — has to run on a document that no longer
  // carries our own injected node. Count before stripping and `shape` counts our
  // script; cap before stripping and the receipt falls off the end of a large
  // page and the run reports as "never happened".
  const settled = recipe
    ? lensRecipeReceipt(String(result.content || ""), nonce)
    : { receipt: null, html: String(result.content || "") };
  const rawContent = settled.html;
  const interaction = recipe ? buildInteraction(recipe, settled.receipt, await plainTally(env, plainKey)) : null;
  if (recipe) s.setAttribute("lens.recipe_outcome", interaction.outcome);
  // Every other field on this snapshot is capped; the screenshot was not, and a
  // fullPage PNG has no natural ceiling. Measured 2026-08-04 against production:
  // en.wikipedia.org/wiki/World_War_II returned 24.3 MB of base64 in one
  // response, inside a 128 MB isolate that then stringifies the payload twice
  // (once for the KV write, once for the body) and against a KV value cap of
  // 25 MB. Nothing here fails cleanly at that size: the isolate dies on limits
  // and the client receives Cloudflare's HTML error page instead of JSON.
  const rawShot = String(result.screenshot || "");
  const shotTooBig = rawShot.length > LENS_BROWSER_SHOT_MAX;
  const output: Record<string, any> = {
    ok: true,
    url: v.url,
    finalUrl: meta.url || v.url,
    status: meta.status == null ? null : meta.status,
    title: meta.title || "",
    content: rawContent.slice(0, 120000),
    contentTruncated: rawContent.length > 120000,
    markdown: String(result.markdown || "").slice(0, 60000),
    accessibilityTree: result.accessibilityTree || null,
    screenshot: rawShot && !shotTooBig ? "data:image/png;base64," + rawShot : null,
    // Dropping the image silently would read as "the browser took no shot",
    // which is a different observation. Say which one happened.
    screenshotDropped: shotTooBig ? Math.round(rawShot.length * 0.75) : 0,
    // WebMCP discovery is currently a Chrome-beta lab capability, not a
    // production Browser Run binding capability. The local helper performs
    // the real runtime listing; this field keeps that boundary explicit.
    webmcp: { status: "lab-required", detail: "Runtime WebMCP listing requires the local Browser Run Chrome-beta lab. Use tools/lens-webmcp.ts." },
    fetchedBy: "Cloudflare Browser Run",
    // WHICH engine rendered this. A reader comparing two snapshots needs to know
    // whether they came from the same one, and "Browser Run" alone stopped being
    // a specific enough answer the moment Kitesurf existed.
    engine,
    // Counted from the FULL body, before the 120KB content cap above, so a
    // truncated `content` field cannot quietly shrink the comparison. The
    // client's deltaStrip subtracts this from the HTTP anatomy.
    tally: documentTally(rawContent),
    tallyTruncated: rawContent.length > 120000,
  };
  // Absent entirely on a plain run, so every existing consumer sees the exact
  // response it saw before. `shape` above stays the AFTER; the before lives
  // inside here, next to the count of what the recipe actually touched. Set
  // before `elapsedMs` so the key order of the JSON is what it always was.
  if (interaction) output.interaction = interactionPayload(interaction);
  output.elapsedMs = Date.now() - started;
  s.setAttribute("lens.outcome", "ok");
  s.setAttribute("lens.content_bytes", rawContent.length);
  s.setAttribute("lens.has_screenshot", !!output.screenshot);
  if (shotTooBig) s.setAttribute("lens.shot_dropped_bytes", output.screenshotDropped);
  s.setAttribute("lens.has_a11y_tree", !!result.accessibilityTree);
  if (env.RN_KV) {
    // KV rejects a value over 25 MB, and the put lives in waitUntil, so an
    // oversize snapshot used to throw where nobody was listening — the only
    // symptom being a page that re-rendered from scratch on every visit.
    const serialized = JSON.stringify(output);
    // 6h, up from 15 MINUTES, which was the shortest TTL of the three browser
    // caches while guarding by far the most expensive call. A render costs a
    // slice of a 10-minute-a-day account-wide allowance and takes ~19s; expiring
    // it after a quarter of an hour meant two visitors twenty minutes apart paid
    // twice for the same page, and it made the cache useless as the budget
    // control it exists to be. /lens/shot and /lens/wire both already sit at 6h
    // on exactly this reasoning, and the snapshot labels itself "KV cache" in
    // the summary, so a reader is told what they are looking at.
    if (serialized.length <= LENS_BROWSER_KV_MAX) ctx.waitUntil(env.RN_KV.put(cacheKey, serialized, { expirationTtl: 21600 }));
    else s.setAttribute("lens.cache_skipped", serialized.length);
  }
  return jsonResponse({ ...output, cached: false });
  });
}

export function lensPngHeaders(cached) {
  return { "content-type": "image/png", "cache-control": "public, max-age=3600", "x-robots-tag": "noindex", "x-lens-cache": cached ? "hit" : "miss" };
}

export async function lensSha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// X-Frame-Options / CSP frame-ancestors → can a browser embed this live?
export function lensFramable(headers) {
  const xfo = (headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin") || xfo.includes("allow-from")) {
    return { framable: false, reason: "X-Frame-Options: " + xfo.trim() };
  }
  const csp = headers["content-security-policy"] || "";
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m) {
    const val = m[1].toLowerCase();
    if (/'none'/.test(val)) return { framable: false, reason: "CSP frame-ancestors 'none'" };
    if (!/\*/.test(val)) return { framable: false, reason: "CSP frame-ancestors restricts embedding" };
  }
  return { framable: true, reason: null };
}

// The target allowlist moved to lib/crawl.js, beside the host floor it wraps,
// when `lens-reader/` (a separate Worker) needed the same guard. Re-exported
// here because every existing caller and contract test names it on this module.
export { validateLensTarget };

function lensDoorCount(agent) {
  return ["mcp", "nlweb", "webmcp", "agentCard", "openapi", "apiCatalog"]
    .map((key) => agent?.[key])
    .filter((door) => door && (door.verdict === "yes" || door.verdict === "likely" || door.verdict === "maybe" || door.present || door.found)).length;
}

// Compact, stable Lens output for comparison and machine callers. Full scans
// remain available from /lens/fetch; these helpers deliberately exclude raw
// HTML, headers, and third-party response bodies.
export function lensObservationSummary(result) {
  const readiness = result?.readiness || {};
  const terms = result?.terms || {};
  const spectrum = terms.spectrum || {};
  const anatomy = result?.anatomy || {};
  const structured = result?.structured || {};
  const title = structured.title || result?.title || "";
  return {
    url: result?.url || "",
    finalUrl: result?.finalUrl || result?.url || "",
    redirected: !!result?.redirected,
    status: result?.status ?? null,
    contentType: result?.contentType || "",
    elapsedMs: result?.elapsedMs ?? null,
    truncated: !!result?.truncated,
    title: String(title).slice(0, 240),
    wordCount: anatomy.wordCount ?? 0,
    bytes: anatomy.rawBytes ?? null,
    // A prefix parse must be visible. Silently reporting a 2MB page's first
    // 256KB as its word count and its cost is the same class of error as
    // calling an unreachable door a shut one.
    parsedBytes: anatomy.parsedBytes ?? anatomy.rawBytes ?? null,
    parseTruncated: !!anatomy.parseTruncated,
    readiness: readiness.overall ?? null,
    fieldScore: readiness.field?.overall ?? null,
    level: readiness.level ?? null,
    levelName: readiness.levelName ?? null,
    levelNote: readiness.levelNote ?? null,
    tier: spectrum.tier || "unknown",
    doors: lensDoorCount(result?.agent),
    // The dollar figure the verdict strip states for a single scan, carried
    // into the summary so a head-to-head can price both sides. Additive to the
    // /lens/compare + MCP contract; null for non-HTML bodies, never faked.
    cost: (() => {
      const base = result?.cost?.tiers?.[0];
      const rate = result?.cost?.rates?.[0];
      if (!base || !rate) return null;
      return { tokens: base.tokens, usdPerRead: +(base.tokens / 1e6 * rate.usdPerMtok).toFixed(4), model: rate.model };
    })(),
    // Carried so a caller can tell a zero from an absence. Without it a
    // page-only scan reports `doors: 0` and `readiness: null`, which reads as a
    // verdict rather than as "that phase did not run".
    phases: result?.phases || { page: true, discovery: true, botViews: true },
    surfaces: {
      llms: !!result?.discovery?.llmsTxt?.ok,
      markdown: !!result?.agent?.mdNegotiation?.supported,
      mcp: !!(result?.agent?.mcp && ["yes", "likely"].includes(result.agent.mcp.verdict)),
      agentCard: !!(result?.agent?.agentCard?.present || result?.agent?.agentCard?.found),
      apiCatalog: !!(result?.agent?.apiCatalog?.present || result?.agent?.apiCatalog?.found),
    },
  };
}

export function compareLensObservations(left, right) {
  const fields = [
    ["status", "status"], ["finalUrl", "final URL"], ["contentType", "content type"],
    ["title", "title"], ["wordCount", "word count"], ["bytes", "bytes"],
    ["readiness", "readiness"], ["level", "readiness level"], ["tier", "spectrum tier"],
    ["doors", "agent doors"],
  ];
  const changes = fields.filter(([key]) => left?.[key] !== right?.[key]).map(([key, label]) => ({
    field: key, label, before: left?.[key] ?? null, after: right?.[key] ?? null,
  }));
  for (const key of ["llms", "markdown", "mcp", "agentCard", "apiCatalog"]) {
    if (left?.surfaces?.[key] !== right?.surfaces?.[key]) changes.push({
      field: `surfaces.${key}`, label: `surface: ${key}`,
      before: !!left?.surfaces?.[key], after: !!right?.surfaces?.[key],
    });
  }
  return changes;
}

export async function compareLensTargets(leftUrl, rightUrl, env, opts: { skipBotViews?: boolean } = {}) {
  const [left, right] = await Promise.all([
    lensInspect(leftUrl, env, { skipBotViews: opts.skipBotViews !== false }),
    lensInspect(rightUrl, env, { skipBotViews: opts.skipBotViews !== false }),
  ]);
  const leftSummary = lensObservationSummary(left);
  const rightSummary = lensObservationSummary(right);
  return { left: leftSummary, right: rightSummary, changes: compareLensObservations(leftSummary, rightSummary) };
}

// One validate + budget + inspect path for every compare caller: the JSON
// route below, and the SSR'd ?url=A&vs=B branch of handleLens. Splitting these
// would eventually split the budget, which is the mistake LENS_BUDGETS exists
// to prevent.
export async function compareLensRequest(request, env, ctx, leftRaw, rightRaw) {
  const left = validateLensTarget(leftRaw || "");
  const right = validateLensTarget(rightRaw || "");
  if (!left.ok || !right.ok) {
    return { status: 400, payload: { ok: false, error: left.ok ? `right: ${right.error}` : `left: ${left.error}` } };
  }
  // Shared with /mcp's lens_compare tool (same bucket, see LENS_BUDGETS).
  if (await overLensBudget(LENS_BUDGETS.compare, request, env)) {
    return { status: 429, payload: { ok: false, error: "Lens comparisons are rate-limited to 4/min." } };
  }
  try {
    return { status: 200, payload: { ok: true, comparedAt: new Date().toISOString(), ...(await compareLensTargets(left.url, right.url, env)) } };
  } catch (error) {
    return { status: 502, payload: { ok: false, error: "Lens comparison failed.", detail: String(error?.message || error).slice(0, 240) } };
  }
}

export async function handleLensCompare(request, env, ctx) {
  const url = new URL(request.url);
  const result = await compareLensRequest(request, env, ctx, url.searchParams.get("left"), url.searchParams.get("right"));
  return jsonResponse(result.payload, result.status);
}

// the orchestrator: fetch the target, parse it, then probe the origin's
// site-level files in parallel. returns the full lens envelope.
// TRACING NOTE, because the numbers here disagree on purpose. `out.elapsedMs`
// below is computed the moment the main fetch and body read finish, and it is a
// PUBLIC field of /lens/fetch's JSON, so it keeps meaning exactly that. It has
// never covered the discovery fan-out further down: 28 parallel probes, one of
// which (`botViews`) is itself 6 fetches. So on an HTML target, `elapsedMs`
// routinely describes a fraction of the work the scan actually did, and nothing
// measured the rest.
//
// The `lens.*` spans are that missing measurement. `lens.inspect` is the honest
// total; `lens.inspect.fetch` is what elapsedMs reports; `lens.discovery` is the
// part that was invisible. Every probe inside it is an auto-instrumented child
// fetch named by URL, so a straggler identifies itself without any per-probe
// code here.
export async function lensInspect(targetUrl, env, opts) {
  opts = opts || {};
  return span("lens.inspect", (s) => lensInspectInner(targetUrl, env, opts, s), {
    "lens.target_host": safeHost(targetUrl),
    "lens.skip_bot_views": opts.skipBotViews === true ? true : undefined,
  });
}

// hostname only, never the full URL: a span attribute is the wrong place for a
// third party's query string, which can carry their tokens and identifiers.
function safeHost(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return undefined; }
}

async function lensInspectInner(targetUrl, env, opts, sInspect) {
  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  let res, body = "", truncated = false, ct = "", isTextual = false, isHtml = false, undecodable = "";
  try {
    ({ res, body, truncated, ct, isTextual, isHtml, undecodable } = await span("lens.inspect.fetch", async (s) => {
      const r0 = await lensFetch(targetUrl, env, ctrl.signal);
      const ct0 = r0.headers.get("content-type") || "";
      // A SURVIVING content-encoding means nobody decoded this body, and we cannot.
      // The runtime decodes what it fetches over the wire and strips the header on
      // the way in, so for an external target this is always absent — which is why
      // it is a reliable tripwire rather than a routine case. What it catches is an
      // in-process response (SELF_FETCH) that came back still compressed: the
      // runtime has no brotli decoder, so reading those bytes as UTF-8 yields
      // mojibake that renders as a real page full of garbage.
      //
      // index.js's IDENTITY_BODY is the actual fix and this should never fire. It
      // is here because the failure it guards is SILENT — the bug it was written
      // for shipped mojibake on this site's own front page while every third-party
      // URL looked perfect. Refusing to parse says so; decoding anyway does not.
      const enc0 = (r0.headers.get("content-encoding") || "").trim().toLowerCase();
      const undecodable0 = enc0 && enc0 !== "identity" ? enc0 : "";
      const ct0Textual = ct0 === "" || /text|html|xml|json|javascript|\+xml|\+json/i.test(ct0);
      const isTextual0 = ct0Textual && !undecodable0;
      const isHtml0 = /html/i.test(ct0) && !undecodable0;
      let body0 = "", truncated0 = false;
      // read the body while the abort timer is still armed. clearing it before the
      // read (as this used to) left a slow-drip response unbounded in wall time.
      if (isTextual0) { const r = await lensReadCapped(r0, 2 * 1024 * 1024); body0 = r.text; truncated0 = r.truncated; }
      else if (undecodable0) { try { await r0.body?.cancel(); } catch (_e) {} }
      if (undecodable0) s.setAttribute("lens.undecodable_encoding", undecodable0);
      s.setAttribute("http.response.status_code", r0.status);
      s.setAttribute("lens.content_type", ct0 || undefined);
      s.setAttribute("lens.body_bytes", body0.length);
      s.setAttribute("lens.body_truncated", truncated0);
      s.setAttribute("lens.redirected", (r0.url || targetUrl) !== targetUrl);
      return { res: r0, body: body0, truncated: truncated0, ct: ct0, isTextual: isTextual0, isHtml: isHtml0, undecodable: undecodable0 };
    }));
  } finally { clearTimeout(to); }
  sInspect.setAttribute("http.response.status_code", res.status);
  sInspect.setAttribute("lens.is_html", isHtml);

  const finalUrl = res.url || targetUrl;
  const headers: Record<string, string> = {};
  for (const [k, val] of res.headers) headers[k] = val;

  // ASSEMBLED IN STAGES, which is why the type is open rather than the literal
  // tsc would infer. What follows attaches a dozen optional tiers as each one
  // succeeds or is skipped (bodyUnreadable, framable, anatomy, structured, ai,
  // cost, phases, discovery, wire, agent, botViews, readiness, terms, spectrum),
  // and every one of them is legitimately absent on some target. Declaring the
  // closed literal would mean listing fourteen optional members whose real
  // shapes live in the functions that produce them, which is a second copy that
  // rots; the alternative here is one honest boundary at the accumulator.
  const out: Record<string, any> = {
    ok: true, url: targetUrl, finalUrl, redirected: finalUrl !== targetUrl,
    status: res.status, contentType: ct, binary: !isTextual, truncated,
    elapsedMs: Date.now() - started, fetchedBy: BOT_UA, headers,
  };
  // Name the refusal in the payload, not just in a span. A consumer that sees an
  // empty anatomy deserves the reason, and "the body arrived br-encoded and this
  // runtime cannot decode br" is a fact about the exchange worth reporting.
  if (undecodable) out.bodyUnreadable = { reason: "undecodable-content-encoding", encoding: undecodable };

  // can the browser embed this URL live in an <iframe>, or does the site
  // forbid framing (so the Human view must fall back to a screenshot)?
  var fr = lensFramable(headers);
  out.framable = fr.framable;
  out.frameReason = fr.reason;

  // The parse phase is the one part of a scan that is pure compute: an
  // HTMLRewriter pass over up to 2MB, a full-text extraction, a markdown
  // conversion, and a regex title grab.
  //
  // THIS SPAN READS 0ms AND THAT IS NOT A BUG — do not go looking for the
  // missing time. Measured in production 2026-07-29 against a 752KB Wikipedia
  // page (81KB of markdown out): `lens.inspect` 685ms decomposed as
  // `lens.discovery` 656 + `lens.inspect.fetch` 29 + this span 0. Workers spans
  // inherit the frozen-clock semantics of `Date.now()`: the clock advances across
  // I/O, not during synchronous execution. So a span cannot measure CPU, and the
  // hope that it would was wrong. The span is kept for its `lens.body_bytes` /
  // `lens.word_count` / `lens.markdown_bytes` attributes, which do say how much
  // work this phase was handed. For actual CPU, read `cpuTime` off the tail event.
  if (isHtml && body) {
    await span("lens.inspect.parse", async (s) => {
    s.setAttribute("lens.body_bytes", body.length);
    // ── the parse budget ─────────────────────────────────────────────────
    // This is the one genuinely CPU-BOUND thing lens does, and it was bounded
    // only by the 2MB fetch cap. lensText and lensMarkdown are regex chains —
    // roughly thirty sequential global replaces, each allocating a new string —
    // so cost is linear in bytes handed to them.
    //
    // MEASURED (node, same V8, synthetic HTML): ~32ms per MB.
    //    64 KB → 3.2ms    256 KB →  8.0ms    752 KB → 24.2ms    2 MB → 64.2ms
    // Serialization of the result is noise beside it (0.1–1.1ms).
    //
    // 2MB of parse cannot fit anywhere near the Workers FREE ceiling of 10ms
    // CPU per invocation, and even on Paid it is 64ms spent on a page nobody
    // reads past the first screen of. Capping the PARSE (not the fetch) bounds
    // the worst case without changing the common one: the median page is far
    // under this and is unaffected.
    // Overridable per deployment, so moving lens onto the free plan is a var
    // flip rather than a code change: set LENS_PARSE_KB=64 in wrangler.jsonc.
    //
    // THE DEFAULT ARM HAS TO BE A REAL BRANCH, and writing it as a `||` fallback
    // silently pinned every scan to 8 KB from the day this was written. The old
    // line read `Math.max(8, Number(env?.LENS_PARSE_KB) || 0) * 1024 || LENS_PARSE_CAP`:
    // with the var unset that is `Math.max(8, 0) * 1024`, or 8192, which is
    // TRUTHY, so the `|| LENS_PARSE_CAP` arm was unreachable and the 256 KB
    // constant was dead code. The floor meant to protect a misconfigured override
    // became the cap for everybody.
    //
    // It read as a text bug rather than a truncation bug, which is why it lasted.
    // 8 KB rarely reaches a page's <body>, so `lensText`'s narrowing match fails
    // and it falls back to the whole document; the same cut lands mid-<style> or
    // mid-<script>, so the strip regexes find no closing tag and leave the block
    // in. The reader then showed CSS and feature-flag JSON as the page's "text":
    // github.com came out as `{"locale":"en","featureFlags":[...` and this site's
    // own homepage as its `:root{--font-caption:...` block. Measured against
    // production 2026-08-09: every target reported parsedBytes 8192, including a
    // 1.3 MB cloudflare.com and a 572 KB github.com.
    const overrideKb = Number(env?.LENS_PARSE_KB) || 0;
    const cap = overrideKb > 0 ? Math.max(8, overrideKb) * 1024 : LENS_PARSE_CAP;
    const parseable = body.length > cap ? body.slice(0, cap) : body;
    const parseTruncated = parseable.length < body.length;
    s.setAttribute("lens.parsed_bytes", parseable.length);
    s.setAttribute("lens.parse_truncated", parseTruncated);

    const attrs = await lensExtractAttrs(parseable);
    const jsonld = attrs.jsonld.map(lensParseJsonld);
    const fullText = lensText(parseable);
    out.anatomy = {
      rawHtml: parseable.length > 80000 ? parseable.slice(0, 80000) : parseable,
      // rawBytes stays the TRUE length. We know it from the fetch even when we
      // decline to parse all of it, and reporting the prefix as the page's size
      // would be a straightforward lie about the thing being measured.
      rawBytes: body.length,
      parsedBytes: parseable.length,
      parseTruncated,
      headings: lensHeadings(parseable),
      text: fullText.slice(0, 24000),
      imgTotal: attrs.imgTotal, imgNoAlt: attrs.imgNoAlt,
    };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
    out.structured = {
      title: (parseable.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].replace(/\s+/g, " ").trim(),
      meta: attrs.meta, og: attrs.og, twitter: attrs.twitter, jsonld,
      microdata: { itemtypes: [...attrs.microItemtypes], props: [...attrs.microProps] },
      rdfa: { typeof: [...attrs.rdfaTypeof], properties: [...attrs.rdfaProps] },
      microformats: [...attrs.mf],
      relLinks: attrs.relLinks.map((l) => ({ ...l, href: lensAbs(l.href, finalUrl) })),
    };
    out.ai = { markdown: lensMarkdown(parseable, finalUrl) };
    // context economics: the same page, priced per representation an agent
    // could ingest. Full (unsliced) lengths — the slices above are UI caps.
    // Priced on what was actually parsed, and flagged when that is a prefix.
    // Extrapolating to the full byte count would be inventing a number: token
    // density is not uniform across a document, and the tail of a big page is
    // usually markup rather than prose.
    out.cost = lensCost({ html: parseable.length, text: fullText.length, markdown: out.ai.markdown.length, headings: out.anatomy.headings });
    if (parseTruncated) out.cost.partial = { parsedBytes: parseable.length, rawBytes: body.length };
    s.setAttribute("lens.word_count", out.anatomy.wordCount);
    s.setAttribute("lens.markdown_bytes", out.ai.markdown.length);
    });
  } else if (isTextual && body) {
    // non-HTML text (xml/json/txt/markdown): show it raw, no parsing.
    out.anatomy = { rawHtml: body.slice(0, 80000), rawBytes: body.length, text: lensText(body).slice(0, 24000), headings: [], imgTotal: 0, imgNoAlt: 0 };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
    out.cost = lensCost({ raw: body.length });
  }

  // ── the probe/derive seam ─────────────────────────────────────────────
  // Everything above this line DERIVES from bytes already in hand: anatomy,
  // structured data, markdown, token cost. Zero further network. Everything
  // below needs the fan-out.
  //
  // A caller that only wants the derived half can stop here and pay one
  // subrequest instead of twenty-eight, which is what lets a UI paint readiness
  // immediately and fill the rest in behind it.
  //
  // The fields below are then ABSENT rather than empty. That distinction is the
  // whole reason this is a phase flag and not a filter: a readiness score
  // computed without discovery is not a partial score, it is a WRONG one, and
  // `doors: 0` would read as "this site has no agent doors" when it means
  // "nobody looked". Same rule as lib/doors.js's shut-versus-unread.
  out.phases = { page: true, discovery: false, botViews: false };
  if (opts.phases && !opts.phases.includes("discovery")) return out;

  // site-level discovery — probe the origin's well-known files + agent doors
  // in parallel.
  // re-validate the FINAL url before probing its origin: the input allowlist only
  // vetted the url the user typed, but redirect:"follow" could have landed us on a
  // private/link-local host. a blocked final host skips discovery entirely.
  const origin = (() => {
    try { const u = new URL(finalUrl); return privateHostBlocked(u.hostname.toLowerCase()) ? null : u.origin; }
    catch { return null; }
  })();
  if (origin) {
    // Scanning our OWN /lens route is a fan-out trap. SELF_FETCH dispatches each probe
    // back through route() into handleLens, and every one of those re-runs a COMPLETE
    // inspection of the inner ?url= target: the main fetch, plus markdown negotiation,
    // plus ten bot identities = 12 full nested scans inside one invocation. SELF_FETCH
    // nulls itself one level down, so DEPTH was already bounded; this bounds the WIDTH.
    // Neither probe says anything meaningful about the lens itself anyway.
    const selfLens = (() => {
      try {
        const u = new URL(finalUrl);
        return u.hostname.toLowerCase() === CANONICAL_HOST && /^\/lens(\/|$)/.test(u.pathname);
      } catch { return false; }
    })();
    // THE fan-out: 28 concurrent probes, and `botViews` is 6 fetches on its own,
    // so a full scan of an HTML target makes on the order of 33 outbound requests
    // after the one the visitor asked for. None of it was measured before —
    // `out.elapsedMs` was already fixed above. Each probe shows up as an
    // auto-instrumented child fetch under this span, named by its URL, so "which
    // well-known file is the slow one" answers itself.
    // ── the fan-out, split on the seam that decides its cost ──────────────
    // 26 of these 28 probes depend only on the ORIGIN: robots.txt, llms.txt, the
    // well-known files, the MCP endpoint, DNS-AID. Nothing about them changes
    // with which page you scanned, and they were being re-fetched on every scan
    // anyway — 656ms of a measured 685ms, for answers that were already known.
    //
    // So they move behind an origin-keyed cache (originDiscovery below) and only
    // the genuinely per-URL pair stays live: Markdown negotiation, which is a
    // property of the document rather than the site, and the bot-view sampling,
    // which refetches THIS url as ten identities (eight crawlers, two controls).
    const disco = await originDiscovery(origin, new URL(finalUrl).hostname, env, { selfLens });
    const {
      robots, sitemap, sitemapDeclared, llms, llmsFull, aiTxt, secTxt, tdmrep, agentCard, openapi, aiPlugin,
      apiCatalog, mcp, nlweb, webBotAuth, openidConfig, oauthServer, oauthResource, authMd,
      mcpServerCard, agentSkills, ucp, acp, ap2, agentsMd, dnsAid, ech,
    } = disco;

    const [mdNego, botViews] = await span("lens.discovery.per_url", (s) => {
      s.setAttribute("lens.origin_host", safeHost(origin));
      s.setAttribute("lens.discovery_cached", !!disco.cached);
      return Promise.all([
        isHtml && !selfLens ? lensProbeMdNego(finalUrl, env) : Promise.resolve(null),
        // bot-view sampling is 10 extra fetches per scan (8 crawlers + 2 controls). The census
        // (opts.skipBotViews) only needs tier/score/doors, so it skips them to
        // stay well under the per-invocation subrequest budget when sweeping the
        // whole roster. Its own span because it is the single heaviest entry
        // here and the only one that gets skipped — a scan missing it should
        // look different.
        (selfLens || opts.skipBotViews)
          ? Promise.resolve([])
          : span("lens.discovery.bot_views", () => lensProbeBotViews(finalUrl, env)),
      ]);
    });

    out.phases.discovery = true;
    out.phases.botViews = Array.isArray(botViews) && botViews.length > 0;
    out.phases.discoveryCached = !!disco.cached;

    const feeds = (out.structured?.relLinks || []).filter((l) =>
      /alternate/.test(l.rel) && /(rss|atom|feed|\+xml|\+json)/i.test((l.type || "") + " " + (l.href || "")));
    out.discovery = {
      origin, robotsTxt: robots, sitemapXml: sitemap, sitemapDeclared, llmsTxt: llms, llmsFullTxt: llmsFull,
      aiTxt, securityTxt: secTxt, feeds, dnsAid, agentsMd,
      webBotAuth, oauthDiscovery: { openidConfiguration: openidConfig, oauthAuthorizationServer: oauthServer },
      oauthProtectedResource: oauthResource, authMd, mcpServerCard, agentSkills,
      commerce: { ucp, acp, ap2 },
    };
    // The transport-layer counterfactuals: what the wire carries (a shared
    // dictionary, so a repeat fetch is a delta) and what it hides (ECH, so the
    // destination name isn't in the clear). Both read off signals already gathered.
    out.wire = { dictionary: lensDetectDictionary(headers), ech };
    out.ai = out.ai || {};
    out.ai.llmsTxtPresent = llms.ok;
    out.ai.directives = {
      metaRobots: out.structured?.meta?.robots || null,
      xRobotsTag: headers["x-robots-tag"] || null,
      namesAiCrawlers: robots.ok ? /GPTBot|ClaudeBot|Claude-Web|Google-Extended|CCBot|PerplexityBot|anthropic-ai|OAI-SearchBot|Bytespider|Amazonbot/i.test(robots.body || "") : false,
    };
    out.terms = lensTerms({
      finalUrl, status: res.status, headers, body, robots, tdmrep,
      metaRobots: out.structured?.meta?.robots || null,
    });
    out.agent = lensAgentDoors({
      llmsTxt: llms, mdNego, mcp, nlweb, agentCard, openapi, aiPlugin, apiCatalog,
      webmcp: isHtml ? lensDetectWebmcp(body) : { found: false },
    });
    out.botViews = botViews;
    // finalUrl, status and body used to be passed here and were never read:
    // readiness is judged from the probe RESULTS, each of which carries its own
    // status and body, rather than from the page that prompted the fan-out.
    out.readiness = lensReadiness({
      headers, robots, sitemap, sitemapDeclared, terms: out.terms,
      discovery: out.discovery, agent: out.agent, openapi, botViews,
      // Always null on the initial scan, and that is the design rather than a
      // gap: this pass is 28 cheap HTTP probes, while execution evidence needs a
      // real browser off a 10-minute-a-day account ceiling. The two checks come
      // back neutral here and are filled in by /lens/wire, which already opens
      // the CDP session they ride.
      execution: null,
    });
    out.readiness.field = lensFieldEvidence({
      status: out.status,
      bodyUnreadable: out.bodyUnreadable,
      anatomy: out.anatomy,
      agent: out.agent,
      botViews,
    });
  }
  return out;
}

// honest, identified fetch — AadharshBot UA + a required Web Bot Auth
// signature for external targets, the same identity the rest of the site
// crawls under. Self-dispatch stays local and therefore has no wire signature.
// `accept` override: the md-negotiation and MCP probes speak different Accepts.
export async function lensFetch(targetUrl, env, signal?, accept?) {
  env = env || {};
  const baseHeaders = {
    "user-agent": BOT_UA,
    "accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9",
  };
  let isSelf = false;
  try {
    const u = new URL(targetUrl);
    isSelf = u.hostname.toLowerCase() === CANONICAL_HOST && !!(env.SELF_FETCH || env.ASSETS);
  } catch (_e) {}
  // Self-dispatch never leaves Cloudflare, so it does not need a wire
  // signature. Every external target still requires the real AadharshBot key.
  const headers = await botHeaders(targetUrl, env, { headers: baseHeaders, sign: !isSelf });
  // Fetching our own hostname over the network loops back through this same
  // worker, and Cloudflare kills the loop with a 522 — which is why the featured
  // "Try: aadhar.sh" example (and every self-probe: robots.txt, llms.txt, …) once
  // rendered the site as down. Dispatch through our own router instead
  // (SELF_FETCH, injected in index.js): it returns the REAL response an external
  // agent receives — worker enhancement, markdown negotiation, cache + security
  // headers, all of it — so a self-scan measures the live surface rather than a
  // reimplementation of it.
  //
  // ASSETS is the fallback only. It serves the PRE-enhancement static file, which
  // is right for /robots.txt but wrong for "/": the skeleton carries an empty photo
  // grid and zero alt text, so a self-scan through it under-reported this site's own
  // image accessibility as 0/12 while the live page ships 13 alt texts.
  try {
    const u = new URL(targetUrl);
    if (u.hostname.toLowerCase() === CANONICAL_HOST) {
      const selfReq = new Request(u.toString(), { method: "GET", headers });
      if (env.SELF_FETCH) return await env.SELF_FETCH(selfReq);
      if (env.ASSETS)     return await env.ASSETS.fetch(selfReq);
    }
  } catch (_e) { /* fall through to a normal fetch */ }
  // Per-hop validation, not redirect:"follow". The allowlist vetted the URL the
  // visitor typed; without this, one 302 to a blocked host still got fetched and
  // its body read, and only the discovery fan-out was skipped afterwards. A
  // refused hop reads as an unreachable target, which is what it is.
  const followed = await fetchFollowingPublicRedirects(
    targetUrl,
    { method: "GET", headers, signal, cf: { cacheTtl: 0 } },
    (candidate) => validateLensTarget(candidate),
  );
  if (!followed.ok) return new Response(null, { status: 502, statusText: "Blocked redirect" });
  return followed.response;
}

// read a response body but stop at `max` bytes so a giant page can't blow memory.
export async function lensReadCapped(res, max) {
  const result = await readResponseCapped(res, max);
  return { text: result.text, truncated: result.truncated };
}

// The "wire" counterfactuals in the Delta lab are transport properties, not task
// stages, and both are genuinely observable — no simulation needed to tell whether
// a site already ships them.
//
// A shared compression dictionary shows up in the site's OWN response headers: a
// server that offers one sends `Use-As-Dictionary` and lists `available-dictionary`
// in `Vary` (RFC 9842), and a delta response is tagged `Content-Encoding: dcb|dcz`.
// Lens never sends `Available-Dictionary` on its identified fetch, so it won't see
// the delta encoding itself, but the OFFER (the thing folks don't tend to turn on)
// is right there in the headers it already captured.
function lensDetectDictionary(headers) {
  const offer = headers["use-as-dictionary"] || "";
  const vary = (headers["vary"] || "").toLowerCase();
  const ce = (headers["content-encoding"] || "").toLowerCase();
  const negotiates = /available-dictionary/.test(vary);
  const deltaCoded = ce === "dcb" || ce === "dcz";
  return {
    observed: !!offer || negotiates || deltaCoded,
    offer: offer || null,               // the Use-As-Dictionary match/scope, verbatim
    negotiates,                          // Vary advertises available-dictionary
    activeEncoding: deltaCoded ? ce : null,
  };
}

// Encrypted Client Hello lives in the HTTPS/SVCB DNS record (SvcParamKey 5, `ech`),
// not in any HTTP response, so it takes one DoH lookup. Cloudflare's DNS-JSON returns
// type-65 rdata as RFC 3597 generic form (`\# <len> <hex...>`), so read the SvcParams
// off the wire bytes and look for key 5. A presentation-form answer (`... ech="..."`)
// from some other resolver is caught as a substring fallback.
function svcbHasEch(dataStr) {
  const s = String(dataStr || "").trim();
  if (/(?:^|[\s"])ech=/i.test(s)) return { ech: true, parsed: true };
  const m = s.match(/^\\#\s+\d+\s+([0-9a-fA-F\s]+)$/);
  if (!m) return { ech: false, parsed: false };
  const bytes = m[1].trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (bytes.some((b) => Number.isNaN(b))) return { ech: false, parsed: false };
  let i = 2;                                   // skip 2-byte SvcPriority
  while (i < bytes.length) {                    // skip the TargetName (length-prefixed labels, 0x00-terminated)
    const l = bytes[i];
    if (l === 0) { i += 1; break; }
    i += 1 + l;
  }
  while (i + 4 <= bytes.length) {               // walk SvcParams: key(2) len(2) value(len)
    const key = (bytes[i] << 8) | bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 4;
    if (key === 5) return { ech: true, parsed: true };   // SvcParamKey 5 = ech
    i += len;
  }
  return { ech: false, parsed: true };
}
async function lensProbeEch(hostname) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4500);
  try {
    const url = "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(hostname) + "&type=HTTPS&do=1";
    const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: ctrl.signal, cf: { cacheTtl: 0 } });
    const body = await res.json() as { Answer?: any[]; AD?: boolean };
    const answers = Array.isArray(body.Answer) ? body.Answer : [];
    const https = answers.filter((a) => a.type === 65).map((a) => svcbHasEch(a.data));
    return {
      observed: https.some((r) => r.ech),
      recordPresent: https.length > 0,
      parsed: https.length === 0 || https.some((r) => r.parsed),   // false only when a record exists but no answer parsed
      dnssecValidated: body.AD === true,
    };
  } catch (e) {
    return { observed: false, recordPresent: false, parsed: false, error: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

// DNS-AID is a DNS surface, not an HTTP file. Query the three discovery names
// the scanner recognizes through Cloudflare's DNS-over-HTTPS endpoint and keep
// the result deliberately small: Lens is showing whether a door exists, not
// pretending to be a full DNS debugger.
// ── origin-level discovery, cached ────────────────────────────────────────
// The 26 probes that depend on the ORIGIN and not on which page you scanned.
//
// This is where lens's cost lived. A production trace of a 752KB page measured
// lens.inspect at 685ms, of which lens.discovery was 656 — and every byte of
// that 656ms was re-asking one host the same 26 questions it had already
// answered. Scanning a second page on the same site paid it again in full.
//
// Cached in caches.default rather than KV ON PURPOSE: KV carries a ~10K
// writes/day budget this repo is already careful with, and a scan burst would
// eat it. The Cache API is per-colo and costs nothing, which is the right trade
// for data that is cheap to re-derive on a miss.
//
// Six hours because these files change on the order of deploys, not requests,
// and a stale llms.txt is a far smaller error than a lens nobody can afford to
// run. `fresh` bypasses for a caller that needs the live answer.
//
// That reasoning holds for every origin except THIS one, where "on the order of
// deploys" is the problem rather than the justification: our own deploys are
// exactly what the TTL cannot see. discoveryScope below keys the self blob on
// the Worker version so a release invalidates it at the moment it lands.
const DISCOVERY_TTL = 21600;
// Bodies are capped at 256KB each by lensProbe, so a pathological origin could
// serialize to megabytes. Skip caching rather than truncate: truncating would
// silently change what /lens DISPLAYS, and a cache miss only costs what the old
// code paid every time.
const DISCOVERY_MAX_BYTES = 1_000_000;

const discoveryKey = (origin, scope) =>
  new Request(`https://lens-discovery.invalid/v1/${encodeURIComponent(origin)}${scope ? `/${encodeURIComponent(scope)}` : ""}`);

/**
 * How one origin's discovery blob is scoped in the cache.
 *
 * A FOREIGN origin's answers have nothing to do with which version of this
 * Worker is running, so the origin alone is the key and a deploy must not throw
 * that entry away: refilling it means re-asking a stranger 23 questions, which
 * is both slow and rude.
 *
 * OUR OWN origin is the opposite case, because every probe against it
 * self-dispatches in-process. The answers ARE this Worker, so a deploy changes
 * them at the instant it lands, and the six-hour TTL cannot see the one input
 * that actually invalidated them.
 *
 * Measured 2026-08-19, the day /ask shipped: production answered /ask correctly
 * while this site's own doors row went on reporting `no /ask`. The blob was
 * pre-deploy, and the proof was a field nobody looks at — its cached llms.txt
 * was 12,860 bytes against the 13,946 production was serving, exactly the
 * /ask section missing. Worth keeping, because the VERDICT could not settle
 * this on its own: "no /ask" is what a stale cache and a broken probe both look
 * like, and only a field that must have changed tells them apart.
 *
 * So the version rides in the key for self. A deploy mints a new one, the next
 * self-scan refills once per colo, and every scan after that hits cache exactly
 * as before. Skipping the cache outright was the obvious fix and the wrong one:
 * the self-scan is the first thing anyone tries here, and it would pay the full
 * fan-out every time.
 *
 * With no version to key on there is no safe cache, so it is skipped entirely.
 * That state is local dev, where the fan-out never leaves the isolate and where
 * a stale entry in .wrangler/state is a documented way to lose an afternoon.
 */
export function discoveryScope(origin, env) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return { scope: null, cacheable: true }; }
  if (host !== CANONICAL_HOST) return { scope: null, cacheable: true };
  const version = env?.CF_VERSION_METADATA?.id;
  return version ? { scope: version, cacheable: true } : { scope: null, cacheable: false };
}

// NB: selfLens is PASSED by the /lens scan path and read by nothing in here —
// only opts.fresh is. Typing the bag is what surfaced it. Left in place rather
// than deleted, because an ignored option is either a caller's leftover or a
// scoping intent that was never wired, and those want different fixes.
/**
 * The 27 doors one discovery pass knocks on, named once.
 *
 * This type exists because the two return paths below could not otherwise be
 * one type: the live path returns an object literal of these 27 fields, and the
 * cache path returns a spread of `hit.json()`. TypeScript unions those into a
 * shape carrying none of the fields, so the 27-way destructure in
 * lensInspect() read every door off a type that had no doors. That was
 * invisible while `span()` returned `any`; it is the same finding typing
 * queryBillableUsage's union produced in ledger.ts, one file over.
 *
 * PER-DOOR `any` IS DELIBERATE and adds no looseness that was not already
 * there. Each probe returns a genuinely different shape (a robots read carries
 * rules, a DNS-AID read carries SVCB records, a locked MCP door carries an auth
 * scheme), and pinning 27 of those is a much larger change than this one. What
 * the type buys today is the KEY SET, which is what the destructure needs and
 * what makes the door list greppable in one place instead of being spelled out
 * at three call sites that can drift apart.
 */
export type DiscoveryPayload = {
  robots: any; sitemap: any; sitemapDeclared: any; llms: any; llmsFull: any;
  aiTxt: any; secTxt: any; tdmrep: any; agentCard: any; openapi: any; aiPlugin: any;
  apiCatalog: any; mcp: any; nlweb: any; webBotAuth: any; openidConfig: any;
  oauthServer: any; oauthResource: any; authMd: any; mcpServerCard: any;
  agentSkills: any; ucp: any; acp: any; ap2: any; agentsMd: any; dnsAid: any; ech: any;
};

export async function originDiscovery(
  origin, hostname, env, opts: { fresh?: boolean; selfLens?: boolean } = {},
): Promise<DiscoveryPayload & { cached: boolean }> {
  // `caches` is a Workers global and does not exist under plain node, where the
  // contract tests import this module. Absent cache means every call is a live
  // fan-out, which is exactly the previous behaviour.
  // `caches` is a bare global that may be undeclared; referencing it to hand it
  // to a parser would throw ReferenceError, so typeof is the only operator that
  // can ask. The one class lib/parse.js cannot cover.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const { scope, cacheable } = discoveryScope(origin, env);
  const key = discoveryKey(origin, scope);

  if (cache && cacheable && !opts.fresh) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        // Cast rather than validated, and the cast is honest: this blob is
        // exactly `JSON.stringify(result)` from the live path below, written by
        // this same function. Nothing else writes this key.
        const cached = await hit.json() as DiscoveryPayload;
        return { ...cached, cached: true };
      }
    } catch { /* a cache read must never cost the scan */ }
  }

  const result = await span("lens.discovery", async (s) => {
    s.setAttribute("lens.origin_host", safeHost(origin));
    s.setAttribute("lens.discovery_cached", false);
    const [
      robots, sitemap, llms, llmsFull, aiTxt, secTxt, tdmrep, agentCard, openapi, aiPlugin,
      apiCatalog, mcp, nlweb, webBotAuth, openidConfig, oauthServer, oauthResource, authMd,
      mcpServerCard, agentSkills, ucp, acp, ap2, agentsMd, dnsAid, ech,
    ] = await Promise.all([
      lensProbe(origin + "/robots.txt", env), lensProbe(origin + "/sitemap.xml", env),
      lensProbe(origin + "/llms.txt", env), lensProbe(origin + "/llms-full.txt", env),
      lensProbe(origin + "/ai.txt", env), lensProbe(origin + "/.well-known/security.txt", env),
      lensProbe(origin + "/.well-known/tdmrep.json", env),
      lensProbe(origin + "/.well-known/agent-card.json", env),
      lensProbe(origin + "/openapi.json", env),
      lensProbe(origin + "/.well-known/ai-plugin.json", env),
      lensProbe(origin + "/.well-known/api-catalog", env),
      lensProbeMcp(origin, env),
      lensProbeNlweb(origin, env),
      lensProbe(origin + "/.well-known/http-message-signatures-directory", env),
      lensProbe(origin + "/.well-known/openid-configuration", env),
      lensProbe(origin + "/.well-known/oauth-authorization-server", env),
      lensProbe(origin + "/.well-known/oauth-protected-resource", env),
      lensProbe(origin + "/auth.md", env),
      lensProbe(origin + "/.well-known/mcp/server-card.json", env),
      lensProbe(origin + "/.well-known/agent-skills/index.json", env),
      lensProbe(origin + "/.well-known/ucp", env),
      lensProbe(origin + "/.well-known/acp.json", env),
      lensProbe(origin + "/.well-known/ap2", env),
      lensProbeAgentsMd(origin, env),
      lensProbeDnsAid(hostname),
      lensProbeEch(hostname),
    ]);
    // ONE conditional follow-up, and only when the convention did not deliver:
    // robots.txt names where the sitemap actually is. Sequential because it
    // cannot be known until robots.txt has been read, and skipped entirely on
    // the common path, so the fan-out above keeps its shape for every site
    // whose sitemap sits where the convention says.
    let sitemapDeclared: any = null;
    if (!lensSitemapVerdict(sitemap).valid) {
      const declared = lensSitemapDeclared(robots, origin);
      if (declared) {
        s.setAttribute("lens.sitemap_declared", true);
        const probe: Record<string, any> = await lensProbe(declared, env);
        // Count first, then TRIM. This whole result is cached as one JSON blob
        // under DISCOVERY_MAX_BYTES, and a large sitemap kept whole would push
        // the blob over that ceiling — which does not error, it just stops
        // caching, so the site silently pays 28 probes on every future scan.
        // The shape check only needs the head of the document.
        if (probe.ok && asText(probe.body) !== null) {
          probe.entries = (probe.body.match(/<url>|<sitemap>/gi) || []).length;
          probe.body = probe.body.slice(0, 8 * 1024);
        }
        sitemapDeclared = probe;
      }
    }
    return {
      robots, sitemap, sitemapDeclared, llms, llmsFull, aiTxt, secTxt, tdmrep, agentCard, openapi, aiPlugin,
      apiCatalog, mcp, nlweb, webBotAuth, openidConfig, oauthServer, oauthResource, authMd,
      mcpServerCard, agentSkills, ucp, acp, ap2, agentsMd, dnsAid, ech,
    };
  });

  if (cache && cacheable) {
    try {
      const body = JSON.stringify(result);
      if (body.length <= DISCOVERY_MAX_BYTES) {
        await cache.put(key, new Response(body, {
          headers: { "content-type": "application/json", "cache-control": `max-age=${DISCOVERY_TTL}` },
        }));
      }
    } catch { /* a cache write must never cost the scan either */ }
  }
  return { ...result, cached: false };
}

export async function lensProbeDnsAid(hostname) {
  const names = ["_index._agents.", "_a2a._agents.", "_mcp._agents."].map((prefix) => prefix + hostname);
  try {
    const rows = await Promise.all(names.map(async (name) => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4500);
      try {
        const url = "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(name) + "&type=SVCB&do=1";
        const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: ctrl.signal, cf: { cacheTtl: 0 } });
        const body = await res.json() as { Answer?: any[]; AD?: boolean };
        const answers = Array.isArray(body.Answer) ? body.Answer : [];
        return { name, status: res.status, dnssecValidated: body.AD === true, answers: answers.filter((a) => a.type === 64 || a.type === 65).length };
      } finally { clearTimeout(to); }
    }));
    const records = rows.filter((r) => r.answers > 0);
    return { ok: true, found: records.length > 0, dnssecValidated: records.some((r) => r.dnssecValidated), names, records: rows };
  } catch (e) {
    return { ok: false, found: false, names, error: (e && e.message) || String(e) };
  }
}

// These are representative request identities, not claims about the exact
// implementation each vendor uses. A bot view is a bounded GET observation;
// the policy verdict in Terms remains the source of truth for robots.txt.
//
// The two `role: "control"` rows are the reason this table can be read at all,
// and they were missing until 2026-08-21. A crawler row returning 403 has two
// completely different explanations — the origin refuses that NAME, or the
// origin refuses this instrument (our datacenter IP, our TLS fingerprint, our
// missing cookie) and would refuse anything. Those are indistinguishable from
// a crawler-only sample, so every scan of a hard-walled origin used to render
// as "blocks all AI crawlers" when the honest answer was "we never got in".
// Measured the day they were added: medium.com and quora.com answer 403 to
// Chrome as well, so every AI-crawler row on those hosts is uninterpretable.
//
// Controls are DISPLAYED and never SCORED. `lensFieldEvidence` filters them out
// of `sampledBots`, because counting a browser as a bot identity that received
// an unblocked response would reward exactly the site that serves humans and
// refuses every machine.
const LENS_BOT_VIEWS = [
  { key: "Chrome", label: "Chrome", owner: "a browser", role: "control",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" },
  { key: "curl", label: "curl", owner: "a plain HTTP client", role: "control", ua: "curl/8.7.1" },

  { key: "Googlebot", label: "Googlebot", owner: "Google", role: "search", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { key: "GPTBot", label: "GPTBot", owner: "OpenAI", role: "train", ua: "GPTBot/1.0" },
  { key: "ClaudeBot", label: "ClaudeBot", owner: "Anthropic", role: "train", ua: "ClaudeBot/1.0" },
  { key: "CCBot", label: "CCBot", owner: "Common Crawl", role: "train", ua: "CCBot/2.0" },
  { key: "Google-Extended", label: "Google-Extended", owner: "Google", role: "train", ua: "Google-Extended" },
  { key: "PerplexityBot", label: "PerplexityBot", owner: "Perplexity", role: "answers", ua: "PerplexityBot/1.0" },
  { key: "ChatGPT-User", label: "ChatGPT-User", owner: "OpenAI", role: "answers", ua: "ChatGPT-User/1.0" },
  { key: "Claude-User", label: "Claude-User", owner: "Anthropic", role: "answers", ua: "Claude-User/1.0" },
];

// `accept` defaults to the browser-shaped header every existing caller was
// sending inline, so the bot-views tier is byte-identical. The Markdown lens
// passes its own, because there the Accept header IS the instrument: it replays
// the exact string a named agent client sends and reports which representation
// came back. Both callers share this one function rather than growing a second
// outbound path, for the reason the per-hop redirect check below exists.
export async function lensFetchAsBot(targetUrl, env, signal, userAgent, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7") {
  const headers = new Headers({
    "user-agent": userAgent,
    accept,
    "accept-language": "en-US,en;q=0.9",
  });
  // same self-dispatch rule as lensFetch: route() gives the real response this
  // bot identity would actually receive (the worker's UA-conditional branches
  // included), where ASSETS would hand back the pre-enhancement skeleton and make
  // every bot look identical for the wrong reason.
  try {
    const u = new URL(targetUrl);
    if (u.hostname.toLowerCase() === CANONICAL_HOST) {
      const selfReq = new Request(u.toString(), { method: "GET", headers });
      if (env.SELF_FETCH) return await env.SELF_FETCH(selfReq);
      if (env.ASSETS)     return await env.ASSETS.fetch(selfReq);
    }
  } catch (_e) { /* fall through to a normal fetch */ }
  // Per-hop validation, not redirect:"follow". The allowlist vetted the URL the
  // visitor typed; without this, one 302 to a blocked host still got fetched and
  // its body read, and only the discovery fan-out was skipped afterwards. A
  // refused hop reads as an unreachable target, which is what it is.
  const followed = await fetchFollowingPublicRedirects(
    targetUrl,
    { method: "GET", headers, signal, cf: { cacheTtl: 0 } },
    (candidate) => validateLensTarget(candidate),
  );
  if (!followed.ok) return new Response(null, { status: 502, statusText: "Blocked redirect" });
  return followed.response;
}

export async function lensProbeBotView(targetUrl, env, profile) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await lensFetchAsBot(targetUrl, env, ctrl.signal, profile.ua);
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const cap = await lensReadCapped(res, 2048);
    const challenge = res.headers.get("cf-mitigated") === "challenge" || /challenge-platform|<title>Just a moment/i.test(cap.text);
    return {
      key: profile.key, label: profile.label, owner: profile.owner, role: profile.role || "train", userAgent: profile.ua,
      status: res.status, contentType, sampleBytes: cap.text.length,
      blocked: challenge || [401, 403, 406, 429, 451].includes(res.status), challenge,
      // res.url is "" for a same-origin response built inside the worker (SELF_FETCH /
      // ASSETS), so `res.url !== targetUrl` reported redirected:true for every bot on any
      // aadhar.sh scan. Fall back to targetUrl, matching lensInspect's `res.url || targetUrl`.
      redirected: (res.url || targetUrl) !== targetUrl,
    };
  } catch (e) {
    return { key: profile.key, label: profile.label, owner: profile.owner, role: profile.role || "train", userAgent: profile.ua, status: null, contentType: "", sampleBytes: 0, blocked: false, challenge: false, error: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

export function lensProbeBotViews(targetUrl, env) {
  return Promise.all(LENS_BOT_VIEWS.map((profile) => lensProbeBotView(targetUrl, env, profile)));
}

// small, forgiving probe for a single site-level file.
// `accept` is optional and forwards to lensFetch, which has always taken one.
// lib/doors.js needs it to ask a page for its Markdown twin at the page's own
// URL; every existing caller omits it and gets the previous default.
export async function lensProbe(url, env, accept?) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(url, env, ctrl.signal, accept); } finally { clearTimeout(to); }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch (_e) {}
      const headers = {};
      for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;
      return { ok: false, status: res.status, url, headers };
    }
    const cap = await lensReadCapped(res, 256 * 1024);
    // `headers` is additive and exists for dict.js, whose whole subject is the
    // response headers rather than the body. Flattened to a plain object so the
    // audit can be a pure function of it and therefore testable without a fetch.
    const headers = {};
    for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;
    return { ok: true, status: res.status, url, contentType: res.headers.get("content-type") || "", headers, body: cap.text, truncated: cap.truncated };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), url }; }
}

// AGENTS.md / agents.md — the 2025 convention for telling an agent how to work
// with a codebase or service (the CLI wave's answer to "where's the contract").
// Case varies by host, so try the lowercase web form first, then the uppercase
// repo form. `present` requires a non-trivial body, not just a 200, so an SPA
// catch-all serving HTML for everything doesn't read as a real AGENTS.md.
export async function lensProbeAgentsMd(origin, env) {
  for (const name of ["/agents.md", "/AGENTS.md"]) {
    const p = await lensProbe(origin + name, env);
    const body = (p && p.body || "").trim();
    const looksMd = body.length > 40 && !/^\s*<(?:!doctype|html)/i.test(body);
    if (p && p.ok && looksMd) return { ok: true, present: true, variant: name, status: p.status, body, truncated: p.truncated };
    if (p && p.ok && !looksMd) return { ok: true, present: false, variant: name, status: p.status, note: "answered, but the body looks like a catch-all HTML page, not Markdown instructions" };
  }
  return { ok: false, present: false, note: "no /agents.md or /AGENTS.md found" };
}

// HTMLRewriter pass for the attribute-driven extraction it's robust at:
// meta/OG/Twitter, JSON-LD script bodies, rel-links, img alt coverage,
// microdata, RDFa, and microformats class tokens.
export async function lensExtractAttrs(html) {
  const acc = {
    meta: {}, og: {}, twitter: {}, relLinks: [], jsonld: [],
    microItemtypes: new Set(), microProps: new Set(), mf: new Set(),
    rdfaTypeof: new Set(), rdfaProps: new Set(), imgTotal: 0, imgNoAlt: 0,
  };
  let jbuf: string[] | null = null;
  const MF = /^(h|p|u|dt|e)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const MF_CLASSIC = /^(vcard|hcard|hcalendar|hentry|hfeed|hreview|hrecipe|hatom|hresume|hproduct|adr|geo)$/;
  const rw = new HTMLRewriter()
    .on("meta", { element(el) {
      const name = (el.getAttribute("name") || "").toLowerCase();
      const prop = (el.getAttribute("property") || "").toLowerCase();
      const content = el.getAttribute("content") || "";
      if (prop.startsWith("og:")) acc.og[prop.slice(3)] = content;
      else if (/^(article|product|book|profile|video|music):/.test(prop)) acc.og[prop] = content;
      else if (name.startsWith("twitter:")) acc.twitter[name.slice(8)] = content;
      else if (name) acc.meta[name] = content;
      else if (prop) acc.meta[prop] = content;
    } })
    .on("script", {
      element(el) { jbuf = (el.getAttribute("type") || "").toLowerCase() === "application/ld+json" ? [] : null; },
      text(t) { if (jbuf) { jbuf.push(t.text); if (t.lastInTextNode) { acc.jsonld.push(jbuf.join("")); jbuf = null; } } },
    })
    .on("link", { element(el) {
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      if (!rel || acc.relLinks.length >= 80) return;
      acc.relLinks.push({ rel, href: el.getAttribute("href") || "", type: el.getAttribute("type") || "", title: el.getAttribute("title") || "", hreflang: el.getAttribute("hreflang") || "" });
    } })
    .on("img", { element(el) { acc.imgTotal++; const alt = el.getAttribute("alt"); if (alt === null || alt.trim() === "") acc.imgNoAlt++; } })
    .on("[itemtype]", { element(el) { const v = el.getAttribute("itemtype"); if (v && acc.microItemtypes.size < 100) acc.microItemtypes.add(v); } })
    .on("[itemprop]", { element(el) { const v = el.getAttribute("itemprop"); if (v && acc.microProps.size < 200) v.split(/\s+/).forEach((x) => x && acc.microProps.add(x)); } })
    .on("[typeof]", { element(el) { const v = el.getAttribute("typeof"); if (v && acc.rdfaTypeof.size < 100) v.split(/\s+/).forEach((x) => x && acc.rdfaTypeof.add(x)); } })
    .on("[property]", { element(el) { const v = (el.getAttribute("property") || ""); if (acc.rdfaProps.size >= 200) return; v.split(/\s+/).forEach((x) => { if (x && !/^(og|twitter|article|product|book|profile|video|music):/.test(x)) acc.rdfaProps.add(x); }); } })
    .on("[class]", { element(el) { if (acc.mf.size >= 60) return; (el.getAttribute("class") || "").split(/\s+/).forEach((tok) => { if (MF.test(tok) || MF_CLASSIC.test(tok)) acc.mf.add(tok); }); } });
  await rw.transform(new Response(html)).arrayBuffer();
  return acc;
}

export function lensParseJsonld(raw) {
  const trimmed = String(raw || "").trim();
  try {
    const obj = JSON.parse(trimmed);
    const types = new Set();
    (function walk(o) {
      if (!asRecord(o) && !Array.isArray(o)) return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o["@type"]) [].concat(o["@type"]).forEach((t) => types.add(String(t)));
      for (const k in o) walk(o[k]);
    })(obj);
    return { valid: true, types: [...types], json: JSON.stringify(obj, null, 2).slice(0, 12000) };
  } catch (e) { return { valid: false, error: (e && e.message) || "parse error", raw: trimmed.slice(0, 3000) }; }
}

export function lensHeadings(html) {
  const out: { level: number, text: string }[] = []; const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  while ((m = re.exec(html)) && out.length < 250) { const txt = lensStripInline(m[2]).trim(); if (txt) out.push({ level: +m[1], text: txt.slice(0, 300) }); }
  return out;
}

export function lensText(html) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return lensDecode(s).replace(/\s+/g, " ").trim();
}

// An end tag may carry attributes, so `</script bar>` closes a script element as
// surely as `</script>` does. The closers below are `<\/tag\b[^>]*>` for that reason;
// spelling one `<\/script\s*>` hands the whole body through into the markdown.
//
// CodeQL asks for a second thing here and does not get it, so the reasoning is
// recorded rather than argued again every time the file moves. It flags each strip
// below as js/incomplete-multi-character-sanitization, wanting a fixpoint loop,
// because removing a span can RE-FORM what was removed out of what is left either
// side. That really happens: one pass of the comment strip over `<p>a<!-<!--x-->-</p>`
// leaves `<p>a<!--</p>`, since the match starts at the INNER opener.
//
// It is unreachable anyway, twice over. The re-formed opener is eaten by the generic
// `<[^>]+>` strip further down (`<!--</p>` matches whole), and that strip is itself
// already a fixpoint: its match runs from a `<` to the next `>`, so any `<` surviving
// a pass has no `>` after it and a second pass cannot match. Looping all three cost a
// MEASURED 6.29ms against 5.72ms on a 256KB page, node, same V8 — 10% of the
// CPU-bound half of a scan, on the path LENS_PARSE_CAP exists to keep under the 10ms
// Workers ceiling. That is a real bill for a bug nothing can reach.
//
// What would change the answer: narrowing any pattern here (a literal `/<script>/g`
// re-forms and is NOT self-limiting), or the output ever reaching a parser instead of
// pre() -> esc(). Add the loop then, and delete this paragraph.

// best-effort, dependency-free HTML→Markdown, roughly what a basic LLM scraper
// ingests. The high-fidelity read is a deliberate SEPARATE surface rather than a
// v2 of this one: /lens/read runs Readability in the lens-reader Worker, because
// a real extractor needs a DOM and linkedom alone is 94.6 KB gzip. This stays
// crude on purpose, since the AI view is showing what a crude scraper sees.
export function lensMarkdown(html, baseUrl) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<!--[\s\S]*?(?:-->|--!>)/g, "");
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer|aside)\b[\s\S]*?<\/\1\b[^>]*>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, i) => "\n\n```\n" + lensDecode(i.replace(/<[^>]+>/g, "")).replace(/\n+$/g, "") + "\n```\n\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, i) => "`" + lensStripInline(i).trim() + "`");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, i) => "\n\n" + "#".repeat(+l) + " " + lensStripInline(i).trim() + "\n\n");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, i) => "\n\n> " + lensStripInline(i).trim().replace(/\n+/g, "\n> ") + "\n\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, i) => "- " + lensStripInline(i).trim() + "\n");
  s = s.replace(/<img\b[^>]*>/gi, (m) => { const alt = lensTagAttr(m, "alt"); const src = lensAbs(lensTagAttr(m, "src"), baseUrl); return src ? `![${alt}](${src})` : ""; });
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (m, i) => { const href = lensAbs(lensTagAttr(m, "href"), baseUrl); const txt = lensStripInline(i).trim(); if (!txt) return ""; return href ? `[${txt}](${href})` : txt; });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "**" + lensStripInline(i).trim() + "**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "*" + lensStripInline(i).trim() + "*");
  s = s.replace(/<\/(p|div|section|article|header|main|ul|ol|table|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = lensDecode(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

export function lensStripInline(h) { return lensDecode(String(h).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "); }

export function lensTagAttr(tag, name) { const m = String(tag).match(new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; }

export function lensAbs(href, base) { if (!href) return href; try { return new URL(href, base).toString(); } catch { return href; } }

export function lensDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
    .replace(/&amp;/g, "&");
}

// ── the Terms lens ----------------------------------------------------------
// What this site permits, resists, or charges — per bot, per path. Everything
// below is read from PUBLISHED policy (robots.txt, Content-Signal, TDMRep,
// noai directives) plus what happened to our own identified fetch. Lens never
// wears another bot's user-agent to test enforcement; same honesty rule as
// AadharshBot itself.

// The crawlers worth a scoreboard row: the household names of the agentic web,
// grouped by what they take (a search index / a training corpus / live
// answers). Verdicts are evaluated per-bot against the exact fetched path.
const LENS_BOTS = [
  { ua: "Googlebot",          owner: "Google",       kind: "search",  note: "the classic search index" },
  { ua: "Bingbot",            owner: "Microsoft",    kind: "search",  note: "Bing (and Copilot grounding)" },
  { ua: "GPTBot",             owner: "OpenAI",       kind: "train",   note: "training corpus" },
  { ua: "ClaudeBot",          owner: "Anthropic",    kind: "train",   note: "training corpus" },
  { ua: "Google-Extended",    owner: "Google",       kind: "train",   note: "the Gemini-training consent token" },
  { ua: "Applebot-Extended",  owner: "Apple",        kind: "train",   note: "Apple Intelligence consent token" },
  { ua: "Meta-ExternalAgent", owner: "Meta",         kind: "train",   note: "Llama training + Meta AI" },
  { ua: "CCBot",              owner: "Common Crawl", kind: "train",   note: "the open crawl most models started on" },
  { ua: "Bytespider",         owner: "ByteDance",    kind: "train",   note: "famously robots-indifferent" },
  { ua: "Amazonbot",          owner: "Amazon",       kind: "train",   note: "Alexa answers + training" },
  { ua: "OAI-SearchBot",      owner: "OpenAI",       kind: "answers", note: "the ChatGPT Search index" },
  { ua: "ChatGPT-User",       owner: "OpenAI",       kind: "answers", note: "live fetch for a user's chat" },
  { ua: "Claude-User",        owner: "Anthropic",    kind: "answers", note: "live fetch for a user's chat" },
  { ua: "PerplexityBot",      owner: "Perplexity",   kind: "answers", note: "answer-engine index" },
  { ua: "AadharshBot",        owner: "aadhar.sh",    kind: "answers", note: "the bot that fetched this page" },
];

// robots.txt → { groups: [{agents, rules, signal}], sitemaps }. Groups follow
// RFC 9309: consecutive User-agent lines share one group; Content-Signal
// (contentsignals.org) rides along as a group-level directive.
// robots.txt parsing + RFC 9309 evaluation moved to lib/robots.js (a second caller,
// /around, now OBEYS these on the crawl). Imported above for local use here and
// re-exported so every lens caller and the public export surface stay identical.
export { lensParseRobots, lensPathMatch, lensRobotsVerdict };

// "search=yes,ai-input=yes,ai-train=no" → { search: "yes", ... }
export function lensParseContentSignal(raw) {
  const out = {};
  for (const part of String(raw || "").split(",")) {
    const kv = part.split("=");
    if (kv.length === 2 && kv[0].trim()) out[kv[0].trim().toLowerCase()] = kv[1].trim().toLowerCase();
  }
  return out;
}

// assemble the whole terms envelope: scoreboard + signals + price + enforcement
// + the open → signaled → enforced → paid spectrum.
export function lensTerms({ finalUrl, status, headers, body, robots, tdmrep, metaRobots }) {
  let path = "/";
  try { const u = new URL(finalUrl); path = u.pathname + u.search; } catch (_e) {}
  // The terms envelope is assembled tier by tier below (scoreboard, signals,
  // paid, enforcement, directives, tdmrep, spectrum), and each tier is skipped
  // when the site does not carry it. Same reason the inspect accumulator is
  // open: the alternative is a second copy of seven shapes that already exist
  // where they are produced.
  const t: Record<string, any> = { path, robotsPresent: !!(robots && robots.ok) };

  // "absent" (a clean 404) and "unreachable" (timeout / 403 / 5xx) are very
  // different claims — never report unknown terms as no terms.
  const robotsAbsent = !!(robots && !robots.ok && (robots.status === 404 || robots.status === 410));
  t.robotsUnknown = !t.robotsPresent && !robotsAbsent;
  t.robotsError = t.robotsUnknown ? ((robots && (robots.error || (robots.status ? "HTTP " + robots.status : null))) || "unreachable") : null;

  const parsed = t.robotsPresent ? lensParseRobots(robots.body || "") : { groups: [], sitemaps: [] };
  t.scoreboard = LENS_BOTS.map((b) => {
    if (t.robotsUnknown) return { ua: b.ua, owner: b.owner, kind: b.kind, note: b.note, verdict: "unknown", matchedUa: null, rule: null };
    const v = lensRobotsVerdict(parsed, b.ua, path);
    return { ua: b.ua, owner: b.owner, kind: b.kind, note: b.note, verdict: v.verdict, matchedUa: v.matchedUa, rule: v.rule };
  });
  t.signals = parsed.groups.filter((g) => g.signal).map((g) => ({ agents: g.agents, raw: g.signal, parsed: lensParseContentSignal(g.signal) }));

  // price signals on the fetched response: HTTP 402, Cloudflare pay-per-crawl
  // headers, an x402 payment envelope in the body.
  const crawlerHeaders = {};
  for (const k in headers) if (/^crawler-/i.test(k)) crawlerHeaders[k] = headers[k];
  t.paid = { http402: status === 402, crawlerHeaders, x402: null };
  if (status === 402 && body) {
    try { const j = JSON.parse(body); if (j && (j.x402Version != null || j.accepts)) t.paid.x402 = JSON.stringify(j, null, 2).slice(0, 6000); } catch (_e) {}
  }

  // enforcement: what actually happened to our identified, signed fetch.
  const challenged = headers["cf-mitigated"] === "challenge" || /_cf_chl_opt|challenge-platform|<title>Just a moment/i.test(String(body || "").slice(0, 6000));
  t.enforcement = { status, challenged, blocked: challenged || status === 401 || status === 403 || status === 451 };

  const xRobotsTag = headers["x-robots-tag"] || null;
  t.directives = { metaRobots: metaRobots || null, xRobotsTag, noai: /noai|noimageai/i.test((metaRobots || "") + " " + (xRobotsTag || "")) };
  t.tdmrep = tdmrep && tdmrep.ok ? { present: true, body: String(tdmrep.body || "").slice(0, 4000) } : { present: false };

  // the spectrum: strongest tier present wins; reasons list everything found.
  // Nuance: an all-yes Content-Signal (or naming bots only to allow them) is an
  // explicit GRANT — that keeps the site at "open", just deliberately so.
  const reasons: string[] = [];
  const named = t.scoreboard.filter((b) => b.matchedUa && b.matchedUa !== "*");
  const blocked = t.scoreboard.filter((b) => b.verdict === "block");
  const restrictiveSignals = t.signals.some((s) => Object.values(s.parsed).some((v) => v !== "yes"));
  if (t.paid.http402) reasons.push({ tier: "paid", why: "answered 402 Payment Required" + (t.paid.x402 ? " with an x402 payment envelope" : "") });
  if (Object.keys(crawlerHeaders).length) reasons.push({ tier: "paid", why: "advertises pay-per-crawl price headers (" + Object.keys(crawlerHeaders).join(", ") + ")" });
  if (t.enforcement.challenged) reasons.push({ tier: "enforced", why: "served a bot challenge to our identified fetch" });
  else if (t.enforcement.blocked) reasons.push({ tier: "enforced", why: "refused our identified fetch with HTTP " + status });
  if (blocked.length) reasons.push({ tier: "signaled", why: "robots.txt blocks " + blocked.length + " of " + t.scoreboard.length + " scoreboard crawlers for this path" });
  if (named.length && !blocked.length) reasons.push({ tier: "open", why: "robots.txt names " + named.length + " scoreboard crawler" + (named.length > 1 ? "s" : "") + " explicitly, all allowed" });
  if (t.signals.length) reasons.push(restrictiveSignals
    ? { tier: "signaled", why: "declares restrictive Content-Signal preferences in robots.txt" }
    : { tier: "open", why: "declares Content-Signal preferences, all yes — explicitly open, in writing" });
  if (t.directives.noai) reasons.push({ tier: "signaled", why: "sets a noai directive (meta robots / X-Robots-Tag)" });
  if (t.tdmrep.present) reasons.push({ tier: "signaled", why: "publishes a TDM Reservation Protocol manifest" });
  if (t.robotsUnknown) reasons.push({ tier: "open", why: "robots.txt could not be read (" + t.robotsError + ") — robots terms unknown, not absent" });
  const order = ["open", "signaled", "enforced", "paid"];
  t.spectrum = {
    tier: reasons.reduce((top, r) => (order.indexOf(r.tier) > order.indexOf(top) ? r.tier : top), "open"),
    reasons: reasons.length ? reasons.map((r) => r.why) : ["no machine terms found — any bot may read anything here, free"],
  };
  return t;
}

// ── context economics --------------------------------------------------------
// What reading this page costs a machine, per representation it could ingest.
// The semantic web asked publishers to structure content up front; LLMs won by
// brute-force reading the human HTML instead — this is that choice, priced.
//
// chars-per-token calibrated 2026-07 against o200k_base on real pages
// (stripe.com 584KB, wikipedia Semantic_Web, daringfireball, aadhar.sh;
// size-weighted): raw HTML ≈ 2.9 (minified script-heavy markup tokenizes
// brutally — stripe hit 2.5), stripped text ≈ 4.5, markdown ≈ 3.9.
// Estimates, and the UI labels them ≈.
const LENS_CPT = { html: 3.0, text: 4.5, markdown: 3.9 };
// reference input prices, USD per million tokens, last checked 2026-08-14 against
// each vendor's own pricing page. Ordered most to least expensive, because the
// first entry is the headline the cost table and the agent trace both quote.
// Sonnet 5 is listed at its STANDARD $3.00, not the $2.00 introductory rate that
// runs to 2026-08-31: a page pricing somebody else's HTML should not quote a
// number that expires in a fortnight.
const LENS_RATES = [
  { model: "Claude Sonnet 5", usdPerMtok: 3.0 },
  { model: "Claude Haiku 4.5", usdPerMtok: 1.0 },
  { model: "GPT-5.6 Luna", usdPerMtok: 0.2 },
];

/**
 * Every tier is optional: an HTML page prices html/text/markdown/outline, a
 * non-HTML text body prices raw alone, and add() skips whatever is absent.
 */
export function lensCost({ html, text, markdown, headings, raw }: {
  html?: number; text?: number; markdown?: number; headings?: Array<{ level: number; text: string }>; raw?: number;
}) {
  const tiers: { key: any, label: any, note: any, chars: number, tokens: number }[] = [];
  const add = (key, label, note, chars, cpt) => {
    if (chars > 0) tiers.push({ key, label, note, chars, tokens: Math.round(chars / cpt) });
  };
  add("html", "raw HTML", "what a naive scraper puts in context", html, LENS_CPT.html);
  add("text", "stripped text", "tags dropped, structure lost", text, LENS_CPT.text);
  add("markdown", "markdown", "the AI-view rendering below", markdown, LENS_CPT.markdown);
  if (headings && headings.length) {
    const outline = headings.map((h) => "#".repeat(h.level) + " " + h.text).join("\n");
    add("outline", "outline", "headings only — what an efficient agent asks for first", outline.length, LENS_CPT.markdown);
  }
  add("raw", "raw body", "served as-is — already machine-shaped", raw, LENS_CPT.text);
  return tiers.length ? { tokenizer: "o200k_base, calibrated estimate", checked: "2026-08", rates: LENS_RATES, tiers } : null;
}

// ── agent doors ---------------------------------------------------------------
// Does this site publish surfaces for agents, or must they brute-force the
// human page? The research question behind the whole machine-internet thread
// (publish-for-agents vs drive-the-human-web), probed live per site.

// /mcp — Streamable HTTP MCP servers answer a GET with SSE, a JSON-RPC error,
// 401 + WWW-Authenticate (OAuth-protected), or a POST-only 4xx in JSON. A SPA
// answering 200 text/html is a router fallback, not a server.
export async function lensProbeMcp(origin, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(origin + "/mcp", env, ctrl.signal, "application/json, text/event-stream"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const www = res.headers.get("www-authenticate") || "";
    const head = (await lensReadCapped(res, 2048)).text;
    if (/^text\/event-stream$/i.test(ct)) return { verdict: "yes", detail: "SSE stream at /mcp" };
    if (/jsonrpc/i.test(head)) return { verdict: "yes", detail: "JSON-RPC answer at /mcp (HTTP " + res.status + ")" };
    if (res.status === 401 && www) return { verdict: "likely", detail: "401 + WWW-Authenticate at /mcp (OAuth-protected server)" };
    if ([400, 405, 406].includes(res.status) && /json/i.test(ct)) return { verdict: "maybe", detail: "HTTP " + res.status + " " + ct + " at /mcp (POST-only server?)" };
    return { verdict: "no", detail: res.status === 404 ? "no /mcp" : "HTTP " + res.status + (ct ? " " + ct : "") };
  } catch (_e) { return { verdict: "unknown", detail: "probe failed" }; }
}

// /ask — NLWeb's REST convention. A real instance answers JSON (usually an
// error asking for a query); we never send one, so nothing runs on their side.
export async function lensProbeNlweb(origin, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(origin + "/ask", env, ctrl.signal, "application/json"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const head = (await lensReadCapped(res, 1024)).text.trim();
    if (res.status === 404 || /html/i.test(ct)) return { verdict: "no", detail: res.status === 404 ? "no /ask" : "HTML at /ask (a page, not an endpoint)" };
    const json = /json/i.test(ct) || head.startsWith("{");
    // A door has to ANSWER before it counts as one. This accepted ANY non-404
    // JSON, and error pages are overwhelmingly JSON on a JSON endpoint, so a
    // `410 Gone`, a `412`, a `429` and a bare `401` all read as "NLWeb-shaped"
    // — and because an NLWeb door is an ACTION surface, each one promoted its
    // whole site to Agent-Native. Measured over a 46-site survey (2026-08-15):
    // 4 of the 6 sites this rubric called Agent-Native earned the top rung from
    // a /ask that answered 410, 412, 429 or 401. One decade-dead API and three
    // bot walls, scored as a working agent interface.
    // SSE is the protocol's DEFAULT framing (streaming defaults to true), so an
    // origin that streams here is answering as an NLWeb server rather than
    // failing. This probe demanded JSON and therefore graded a correctly
    // behaving instance ABSENT — and a bot wall does not stream, so accepting
    // this reopens none of the false positives the tightening below closed.
    const streamed = /^text\/event-stream$/i.test(ct) || /^\s*(event|data):/m.test(head);
    if (streamed && res.ok) return { verdict: "likely", detail: "event stream at /ask (NLWeb streams by default)" };
    if (json && res.ok) return { verdict: "maybe", detail: "JSON at /ask (HTTP " + res.status + ") — NLWeb-shaped" };
    // A refusal that NAMES the required parameter is the strongest evidence this
    // probe can get without sending a query, and it was being read as absence.
    // `query` is required by the spec, so a conforming server has to refuse a
    // bare knock; ours answers 400 with `"parameter": "query"` and its own lens
    // called that no endpoint at all. The discriminator against the 410/412/429
    // bot walls in the note above is that they refuse the REQUEST and never
    // mention a parameter they have no concept of.
    if (json && (res.status === 400 || res.status === 422) && /\bquery\b/.test(head)) {
      return { verdict: "likely", detail: "HTTP " + res.status + " at /ask asking for `query` by name" };
    }
    // 401 is the one refusal that still evidences a door, and only when the
    // origin says how to open it. Same rule lensProbeMcp already applies to a
    // 401 at /mcp, so the two door probes agree about what a locked door is.
    const www = res.headers.get("www-authenticate") || "";
    if (json && res.status === 401 && www) return { verdict: "likely", detail: "401 + WWW-Authenticate at /ask (auth-gated endpoint)" };
    // A 5xx is our probe failing to get an answer, not the site lacking a door;
    // `unknown` is what the doors tier already renders as "never answered".
    if (res.status >= 500) return { verdict: "unknown", detail: "HTTP " + res.status + " at /ask — origin did not answer" };
    return { verdict: "no", detail: "HTTP " + res.status + (ct ? " " + ct : "") };
  } catch (_e) { return { verdict: "unknown", detail: "probe failed" }; }
}

// Accept: text/markdown — Cloudflare-style content negotiation: the same URL,
// re-served for machines. Supported iff the content-type actually flips.
export async function lensProbeMdNego(pageUrl, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(pageUrl, env, ctrl.signal, "text/markdown"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    try { await res.body?.cancel(); } catch (_e) {}
    return { supported: /^text\/markdown$/i.test(ct), contentType: ct, status: res.status };
  } catch (_e) { return { supported: false, note: "probe failed" }; }
}

// WebMCP is a page-level JS API, so the marker lives in the HTML we already
// fetched — no extra request. Two shapes reach that HTML, and until 2026-08-06
// this only knew the first:
//
//   inline — the site calls document.modelContext.registerTool() itself, so the
//     call sites are right there in the document.
//   bridge — the site turns WebMCP on at its CDN and a LOADER tag is injected;
//     every registerTool call lives in the external module, where a scan of the
//     document cannot see it. Cloudflare's is `<script type="module"
//     src="/.webmcp/bridge.js" data-packs="…">`, injected by HTMLRewriter at the
//     edge, and it proxies the origin's own MCP server (`data-mcp-url`, default
//     `/mcp`) into the page.
//
// Missing the bridge shape mattered more every week: it is one dashboard toggle,
// so the population of sites carrying it grows without any of them writing a line
// of code, and a scan calling all of them "no WebMCP" would have been quietly
// wrong at increasing scale. `kind` is reported because the two are genuinely
// different claims — inline means somebody wrote tools for this page, bridge means
// an MCP server got hoisted into it — and a reader deserves to tell them apart.
const WEBMCP_MARKERS = [
  { kind: "inline", re: /navigator\.modelContext|document\.modelContext|modelContext\.(?:registerTool|provideContext)|window\.webmcp/i },
  { kind: "bridge", re: /\/\.webmcp\/bridge\.js|\bdata-(?:packs|mcp-url)=/i },
];
export function lensDetectWebmcp(html) {
  const body = String(html || "");
  for (const { kind, re } of WEBMCP_MARKERS) {
    const m = body.match(re);
    if (m) return { found: true, kind, marker: m[0] };
  }
  return { found: false };
}

// a well-known JSON probe only counts if the body parses AND has the right
// shape — SPAs answer 200 text/html for every path, and that must read as
// absent, not present. And a probe that never answered reads as UNKNOWN,
// not absent — same honesty rule as the robots.txt tier.
// One predicate for "this probe never actually answered the question", shared by
// both JSON interpreters below so they cannot disagree. lensProbe only sets .error
// when the fetch THROWS; a reachable-but-broken origin returns { ok:false, status:503 }
// with no error, which is still not an answer. (429 stays a definitive negative here,
// matching the door tier; revisit if rate-limited probes need their own "unknown".)
function lensProbeUnanswered(probe) {
  return !probe || !!probe.error || !!(probe.status && probe.status >= 500);
}

function lensJsonDoor(probe, validate, label) {
  if (!probe || !probe.ok) {
    return { present: false, status: probe ? probe.status : null, unknown: lensProbeUnanswered(probe) };
  }
  let j: any = null;
  try { j = JSON.parse(probe.body); } catch (_e) { return { present: false, note: "answered, but not JSON (SPA fallback?)" }; }
  if (!asRecord(j) || !validate(j)) return { present: false, note: "JSON, but not " + label + "-shaped" };
  return { present: true, json: j };
}

export function lensAgentDoors({ llmsTxt, mdNego, mcp, nlweb, webmcp, agentCard, openapi, aiPlugin, apiCatalog }) {
  const doors: Record<string, any> = {
    mcp: mcp || { verdict: "unknown" },
    nlweb: nlweb || { verdict: "unknown" },
    webmcp: webmcp || { found: false },
    agentCard: lensJsonDoor(agentCard, (j) => j.name && (j.url || j.skills || j.capabilities || j.protocolVersion), "agent-card"),
    openapi: lensJsonDoor(openapi, (j) => j.openapi || j.swagger, "OpenAPI"),
    aiPlugin: lensJsonDoor(aiPlugin, (j) => j.schema_version || j.name_for_model, "ai-plugin"),
    apiCatalog: lensJsonDoor(apiCatalog, (j) => j.linkset, "linkset"),
    mdNegotiation: mdNego || { supported: false, note: "not probed (non-HTML target)" },
    llmsTxt: {
      present: !!(llmsTxt && llmsTxt.ok),
      unknown: !!(llmsTxt && !llmsTxt.ok && llmsTxt.error),
    },
  };
  if (doors.agentCard.present) doors.agentCard.detail = String(doors.agentCard.json.name || "").slice(0, 80);
  if (doors.openapi.present) doors.openapi.detail = "OpenAPI " + String(doors.openapi.json.openapi || doors.openapi.json.swagger).slice(0, 20);
  if (doors.aiPlugin.present) doors.aiPlugin.detail = String(doors.aiPlugin.json.name_for_model || "manifest").slice(0, 80);
  if (doors.apiCatalog.present) doors.apiCatalog.detail = (doors.apiCatalog.json.linkset || []).length + " linkset entr" + ((doors.apiCatalog.json.linkset || []).length === 1 ? "y" : "ies");
  for (const k of ["agentCard", "openapi", "aiPlugin", "apiCatalog"]) delete doors[k].json;

  // the verdict: action surfaces beat readable ones beat nothing.
  const action: string[] = [];
  if (doors.mcp.verdict === "yes" || doors.mcp.verdict === "likely") action.push("an MCP endpoint");
  if (doors.nlweb.verdict === "maybe" || doors.nlweb.verdict === "likely") action.push("an NLWeb-shaped /ask");
  if (doors.webmcp.found) action.push("in-page WebMCP tools");
  if (doors.agentCard.present) action.push("an A2A agent card");
  const readable: string[] = [];
  if (doors.llmsTxt.present) readable.push("llms.txt");
  if (doors.mdNegotiation.supported) readable.push("markdown negotiation");
  if (doors.apiCatalog.present) readable.push("an RFC 9264 API catalog");
  if (doors.openapi.present) readable.push("OpenAPI");
  if (doors.aiPlugin.present) readable.push("a legacy ai-plugin manifest");
  // probes that never answered can't vote — say so rather than undercount.
  const unknowns: string[] = [];
  if (doors.llmsTxt.unknown) unknowns.push("llms.txt");
  if (doors.mcp.verdict === "unknown") unknowns.push("/mcp");
  if (doors.nlweb.verdict === "unknown") unknowns.push("/ask");
  if (doors.mdNegotiation.note === "probe failed") unknowns.push("markdown negotiation");
  for (const [k, label] of [["agentCard", "agent card"], ["openapi", "OpenAPI"], ["aiPlugin", "ai-plugin"], ["apiCatalog", "api-catalog"]]) {
    if (doors[k].unknown) unknowns.push(label);
  }

  // a timed-out probe can hide an action/readable door too, not just flip a
  // human-only verdict — so hedge on every verdict where unknowns remain.
  const hedge = unknowns.length
    ? " (" + unknowns.length + " probe" + (unknowns.length > 1 ? "s" : "") + " never answered, so this may undercount: " + unknowns.join(", ") + ")"
    : "";
  let verdict, note;
  if (action.length) {
    verdict = "agent-native";
    note = "This site publishes action surfaces: " + action.join(", ") + (readable.length ? " — plus " + readable.join(", ") + "." : ".") + hedge;
  } else if (readable.length) {
    verdict = "agent-readable";
    note = "This site publishes for machine readers (" + readable.join(", ") + ") but exposes no action surface." + hedge;
  } else if (unknowns.length) {
    verdict = "human-only";
    note = "No agent door answered, but " + unknowns.length + " probe" + (unknowns.length > 1 ? "s" : "") + " (" + unknowns.join(", ") + ") never got a response — this verdict may undercount.";
  } else {
    verdict = "human-only";
    note = "No agent door found. An agent here must brute-force the human page — the AI view prices exactly that.";
  }
  doors.strategy = { verdict, note, action, readable, unknowns };
  return doors;
}

// ── sitemaps ---------------------------------------------------------------
// Is this response actually a sitemap? `probe.ok` alone is not the question,
// and treating it as the question is how this rubric MANUFACTURED passes: a
// site that serves its SPA shell or a soft-404 page at /sitemap.xml answers
// 200 text/html, and every one of those was scored a valid sitemap. A missed
// sitemap is an undercount; an invented one is a lie, so this errs toward
// refusing rather than guessing.
export function lensSitemapVerdict(probe) {
  if (!probe || !probe.ok) {
    return { valid: false, reason: probe && probe.status ? "HTTP " + probe.status : "no response" };
  }
  const body = String(probe.body || "");
  const ct = String(probe.contentType || "").toLowerCase();
  // A .gz sitemap is legal and common, and this probe reads TEXT, so the body
  // in hand is compressed bytes decoded as text. Saying "not sitemap-shaped"
  // about that would be a fabrication about a file we did not read.
  if (/application\/(x-)?gzip|application\/octet-stream/.test(ct) || /\.gz(\?|#|$)/i.test(String(probe.url || ""))) {
    return { valid: false, compressed: true, reason: "compressed sitemap — this probe reads text, so its contents were not verified" };
  }
  if (/<(urlset|sitemapindex)\b/i.test(body)) {
    // `entries` may be precomputed by the caller: the declared-sitemap probe
    // counts before trimming its body, because a 256KB sitemap kept whole would
    // push the discovery blob past DISCOVERY_MAX_BYTES and silently disable the
    // cache for exactly the sites that need it most.
    return { valid: true, kind: "xml", entries: Number.isFinite(probe.entries) ? probe.entries : (body.match(/<url>|<sitemap>/gi) || []).length };
  }
  // sitemaps.org also blesses a plain-text file of one URL per line.
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /text\/plain/.test(ct) && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) {
    return { valid: true, kind: "text", entries: lines.length };
  }
  if (/<html|<!doctype html/i.test(body)) return { valid: false, reason: "HTML at the sitemap URL — a page, not a sitemap" };
  return { valid: false, reason: "answered, but is not sitemap-shaped" };
}

// robots.txt is the AUTHORITY on where a sitemap lives (RFC 9309 §2.2.3);
// /sitemap.xml is a convention and nothing more. Probing only the convention
// called Stripe's real sitemap (/sitemap/sitemap.xml, declared in its
// robots.txt) missing, and it did the same to 13 other sites in the same
// survey — the single largest source of disagreement with Cloudflare's
// scanner, which follows the directive. The declared URL is third-party
// controlled, so it goes through the same SSRF guard every visitor-supplied
// target does.
export function lensSitemapDeclared(robots, origin) {
  if (!robots || !robots.ok) return null;
  const conventional = origin + "/sitemap.xml";
  for (const raw of lensParseRobots(robots.body || "").sitemaps) {
    const v = validateLensTarget(raw);
    if (!v.ok) continue;
    if (v.url === conventional || v.url === conventional + "/") continue;
    return v.url;
  }
  return null;
}

// ── agent readiness rubric -------------------------------------------------
// A local, evidence-backed implementation of the public IsItAgentReady rubric.
// The score is intentionally transparent: pass / (pass + fail + unknown),
// with neutral emerging-commerce checks excluded. A site can inspect exactly
// why a point moved instead of receiving an opaque vendor verdict.
const LENS_READINESS_META = {
  robotsTxt: { category: "discoverability", label: "robots.txt" }, sitemap: { category: "discoverability", label: "Sitemap" },
  linkHeaders: { category: "discoverability", label: "Link headers" }, dnsAid: { category: "discoverability", label: "DNS-AID" },
  markdownNegotiation: { category: "contentAccessibility", label: "Markdown negotiation" },
  robotsTxtAiRules: { category: "botAccessControl", label: "AI bot rules" }, contentSignals: { category: "botAccessControl", label: "Content Signals" },
  webBotAuth: { category: "botAccessControl", label: "Web Bot Auth" }, apiCatalog: { category: "discovery", label: "API Catalog" },
  oauthDiscovery: { category: "discovery", label: "OAuth discovery" }, oauthProtectedResource: { category: "discovery", label: "OAuth Protected Resource" },
  authMd: { category: "discovery", label: "Auth.md" }, mcpServerCard: { category: "discovery", label: "MCP Server Card" },
  a2aAgentCard: { category: "discovery", label: "A2A Agent Card", optional: true, countInScore: false },
  agentSkills: { category: "discovery", label: "Agent Skills" }, webMcp: { category: "discovery", label: "WebMCP" },
  x402: { category: "commerce", label: "x402", optional: true, countInScore: false }, mpp: { category: "commerce", label: "MPP", optional: true, countInScore: false },
  ucp: { category: "commerce", label: "UCP", optional: true, countInScore: false }, acp: { category: "commerce", label: "ACP", optional: true, countInScore: false },
  ap2: { category: "commerce", label: "AP2", optional: true, countInScore: false },
  // The EXECUTION half, imported so the CLI check and this rubric cannot drift
  // into two different definitions of the same two questions.
  ...EXECUTION_META,
};

const LENS_READINESS_CATEGORIES = [
  { key: "discoverability", label: "Discoverability", countInScore: true },
  { key: "contentAccessibility", label: "Content Accessibility", countInScore: true },
  { key: "botAccessControl", label: "Bot Access Control", countInScore: true },
  { key: "discovery", label: "API, Auth, MCP & Skill Discovery", countInScore: true },
  { key: "commerce", label: "Commerce", countInScore: false },
  // Last, because it is the only category that needs a real browser and so the
  // only one that is usually neutral. Everything above it is a declaration
  // audit: this asks what an engine DID with the page. Measured 2026-08-12,
  // aadhar.sh passed all twenty declared checks on a day its homepage rendered
  // twelve blank squares and every page threw.
  { key: "execution", label: "Execution in an agent browser", countInScore: true },
];

function lensJsonVerdict(probe, validate) {
  // same "did it answer?" rule as lensJsonDoor: a 5xx origin did NOT answer, so it is
  // unknown, not a definitive fail (this used to call a reachable-but-broken 503 a fail,
  // undercounting webBotAuth / the oauth checks that route through here).
  if (lensProbeUnanswered(probe)) return { status: "unknown", detail: probe && probe.status ? "HTTP " + probe.status + " — probe did not answer" : "probe did not answer" };
  if (!probe.ok) return { status: "fail", detail: "HTTP " + (probe.status || "error") };
  try {
    const json = JSON.parse(probe.body || "");
    return validate(json) ? { status: "pass", detail: "valid JSON shape" } : { status: "fail", detail: "JSON answered, but the expected fields were absent" };
  } catch (_e) { return { status: "fail", detail: "answered, but was not valid JSON" }; }
}

function lensReadinessItem(key, status, detail) {
  const meta = LENS_READINESS_META[key];
  return {
    key, category: meta.category, label: meta.label, status, detail,
    optional: !!meta.optional,
    countInScore: meta.countInScore !== false && !meta.optional,
  };
}

// What LENS itself observed on the wire. This is intentionally orthogonal to
// the standards checklist below: it asks whether an identified machine got a
// usable answer, whether six named crawler identities got one too, and whether
// the site offered a machine door. Cloudflare supplies the standards opinion in
// the composite; counting this local mirror again would double-weight it.
// Every field optional, for the same reason lensReadiness's are: each is read
// behind a guard and a scan legitimately produces none of them when the body
// could not be decoded. Required destructuring made a caller that supplies four
// of five fail on the shape rather than the behaviour.
export function lensFieldEvidence({ status, bodyUnreadable, anatomy, agent, botViews }: {
  status?: any; bodyUnreadable?: any; anatomy?: any; agent?: any; botViews?: any;
}) {
  const components: { key: any, label: any, score: any, detail: any }[] = [];
  const add = (key, label, score, detail) => components.push({ key, label, score, detail });

  const identifiedOk = Number.isFinite(status) && status >= 200 && status < 400 && !bodyUnreadable;
  add(
    "identifiedFetch", "identified fetch", Number.isFinite(status) ? (identifiedOk ? 100 : 0) : null,
    Number.isFinite(status)
      ? (identifiedOk ? `HTTP ${status}; the AadharshBot response was readable` : `HTTP ${status}; no readable success response`)
      : "the identified fetch did not answer",
  );

  const allViews = Array.isArray(botViews) ? botViews : [];
  // Controls (Chrome, curl) exist to prove the instrument got in at all. They are
  // not bot identities, so scoring them here would let a site that serves browsers
  // and refuses every crawler score as though two crawlers had succeeded.
  const views = allViews.filter((bot) => bot && bot.role !== "control");
  const controls = allViews.filter((bot) => bot && bot.role === "control");
  const answered = views.filter((bot) => Number.isFinite(bot && bot.status));
  const successful = answered.filter((bot) => bot.status >= 200 && bot.status < 400 && !bot.blocked && !bot.challenge);
  const scoredTotal = LENS_BOT_VIEWS.filter((p) => p.role !== "control").length;
  const fullSample = views.length === scoredTotal;
  // If no control got a readable response, a crawler 403 is not evidence about
  // crawler policy: nothing this instrument sent got through. Report unknown.
  const controlsPassed = controls.length === 0 || controls.some(
    (bot) => Number.isFinite(bot.status) && bot.status >= 200 && bot.status < 400 && !bot.blocked && !bot.challenge);
  add(
    "sampledBots", "sampled bot retrieval",
    fullSample && controlsPassed ? Math.round((successful.length / views.length) * 100) : null,
    !fullSample
      ? `${views.length} of ${scoredTotal} bot samples ran; this component stays unknown`
      : !controlsPassed
        ? "no control identity got a readable response, so the crawler samples cannot be read as user-agent policy"
        : `${successful.length} of ${views.length} named bot identities received an unblocked response${answered.length < views.length ? `; ${views.length - answered.length} did not answer` : ""}`,
  );

  const wordCount = anatomy && Number.isFinite(anatomy.wordCount) ? anatomy.wordCount : null;
  const bodyScore = wordCount == null ? null : wordCount >= 40 ? 100 : wordCount > 0 ? 50 : 0;
  add(
    "usableBody", "usable response body", bodyScore,
    wordCount == null ? "the response body was not parsed" : `${wordCount} words survived the bounded HTTP parse`,
  );

  const strategy = agent && agent.strategy;
  const hasAction = !!(strategy && Array.isArray(strategy.action) && strategy.action.length);
  const hasReadable = !!(strategy && Array.isArray(strategy.readable) && strategy.readable.length);
  const unknownDoors = !!(strategy && Array.isArray(strategy.unknowns) && strategy.unknowns.length);
  const doorScore = !strategy ? null : hasAction ? 100 : hasReadable ? 60 : unknownDoors ? null : 0;
  add(
    "agentDoor", "machine door", doorScore,
    hasAction ? strategy.action.join(", ") : hasReadable ? strategy.readable.join(", ") : unknownDoors ? "one or more door probes never answered" : "no readable or actionable machine door was found",
  );

  const known = components.filter((component) => Number.isFinite(component.score));
  return {
    overall: known.length === components.length
      ? Math.round(known.reduce((sum, component) => sum + component.score, 0) / components.length)
      : null,
    components,
    scoringNote: "Four equally weighted observations. Missing evidence leaves the field score unfinished; it is never reweighted.",
  };
}

// EVERY FIELD IS OPTIONAL, which is what the body already assumed: each one is
// read behind a truthiness guard, and `execution` is legitimately null whenever
// the browser budget was spent. Left to inference the destructure makes all ten
// REQUIRED, so a caller that supplies nine (the rubric tests, which pass a base
// object without sitemapDeclared) fails on the shape rather than the behaviour.
export function lensReadiness({ headers, robots, sitemap, sitemapDeclared, terms, discovery, agent, openapi, botViews, execution }: {
  headers?: any; robots?: any; sitemap?: any; sitemapDeclared?: any; terms?: any;
  discovery?: any; agent?: any; openapi?: any; botViews?: any; execution?: any;
}) {
  // Keyed by check name, valued by whatever lensReadinessItem produces. Derived
  // from the producer rather than hand-written, so adding a field there cannot
  // leave a second copy here describing the old shape. Without it Object.values
  // below yields unknown[] and every `item.status` read fails.
  const items: Record<string, ReturnType<typeof lensReadinessItem>> = {};
  const robotsParsed = robots && robots.ok ? lensParseRobots(robots.body || "") : null;
  const robotsRules = robotsParsed && robotsParsed.groups.length > 0;
  // Gate the "AI bot rules" STATUS on actually-named agents. Keying it on
  // robotsRules (= "any User-agent group exists") passed a robots.txt carrying
  // nothing but `User-agent: *` on a check whose own fix copy says to declare
  // explicit GPTBot/ClaudeBot/CCBot rules — this site scored that unearned pass on
  // its own scan. The predicate already existed; it just lived in the detail string.
  const namedAiRules = !!(robotsRules && robotsParsed.groups.some((g) =>
    g.agents.some((a) => a !== "*" && /bot|crawler|extended|spider|anthropic|openai|claude/i.test(a))));
  const link = String((headers && headers.link) || "");
  const usefulLinks = (link.match(/rel\s*=\s*["']?(?:sitemap|alternate|service-doc|service-desc|api-catalog)/gi) || []).length;
  const botAuth = lensJsonVerdict(discovery && discovery.webBotAuth, (j) => Array.isArray(j.keys) && j.keys.length > 0);
  const oauthOpen = lensJsonVerdict(discovery && discovery.oauthDiscovery && discovery.oauthDiscovery.openidConfiguration, (j) => !!(j.issuer || j.authorization_endpoint || j.token_endpoint));
  const oauthServer = lensJsonVerdict(discovery && discovery.oauthDiscovery && discovery.oauthDiscovery.oauthAuthorizationServer, (j) => !!(j.issuer || j.token_endpoint || j.authorization_endpoint));
  const oauthResource = lensJsonVerdict(discovery && discovery.oauthProtectedResource, (j) => !!(j.resource || j.authorization_servers || j.scopes_supported));
  const mcpCard = lensJsonVerdict(discovery && discovery.mcpServerCard, (j) => !!(j.serverInfo || j.server || j.name || j.capabilities));
  const skills = lensJsonVerdict(discovery && discovery.agentSkills, (j) => Array.isArray(j.skills));
  const ucp = lensJsonVerdict(discovery && discovery.commerce && discovery.commerce.ucp, (j) => !!(j.protocol || j.version || j.services || j.capabilities));
  const acp = lensJsonVerdict(discovery && discovery.commerce && discovery.commerce.acp, (j) => !!(j.protocol || j.api_base_url || j.capabilities || j.services));
  const ap2 = lensJsonVerdict(discovery && discovery.commerce && discovery.commerce.ap2, (j) => !!(j.protocol || j.version || j.capabilities));

  items.robotsTxt = lensReadinessItem("robotsTxt", robots && robots.ok ? "pass" : robots && (robots.status === 404 || robots.status === 410) ? "fail" : "unknown", robots && robots.ok ? "valid response with " + robotsParsed.groups.length + " User-agent group(s)" : "robots.txt did not return a readable 200");
  // Two probes, best-of: the conventional /sitemap.xml and whatever robots.txt
  // DECLARED, which is the authoritative location and often a different path.
  // Each is validated rather than trusted for answering 200 — see
  // lensSitemapVerdict for why a bare `ok` was manufacturing passes.
  const sitemapCandidates = [
    { probe: sitemap, verdict: lensSitemapVerdict(sitemap), declared: false },
    { probe: sitemapDeclared, verdict: lensSitemapVerdict(sitemapDeclared), declared: true },
  ].filter((c) => c.probe);
  const sitemapHit = sitemapCandidates.find((c) => c.verdict.valid);
  const sitemapCompressed = sitemapCandidates.find((c) => c.verdict.compressed);
  const sitemapAnswered = sitemapCandidates.some((c) => c.probe.ok || c.probe.status === 404 || c.probe.status === 410);
  items.sitemap = lensReadinessItem(
    "sitemap",
    sitemapHit ? "pass" : sitemapCompressed || !sitemapAnswered ? "unknown" : "fail",
    sitemapHit
      ? "sitemap answered with " + sitemapHit.verdict.entries + " URL entr" + (sitemapHit.verdict.entries === 1 ? "y" : "ies") + (sitemapHit.declared ? " (at the location robots.txt declares)" : "")
      : sitemapCompressed
        ? sitemapCompressed.verdict.reason
        : sitemapCandidates.length
          ? sitemapCandidates[sitemapCandidates.length - 1].verdict.reason
          : "sitemap.xml was not found or did not answer",
  );
  items.linkHeaders = lensReadinessItem("linkHeaders", usefulLinks ? "pass" : "fail", usefulLinks ? usefulLinks + " agent-useful Link relation(s)" : "no agent-useful Link relations on the fetched response");
  items.dnsAid = lensReadinessItem("dnsAid", discovery && discovery.dnsAid && discovery.dnsAid.ok ? (discovery.dnsAid.found ? "pass" : "fail") : "unknown", discovery && discovery.dnsAid && discovery.dnsAid.found ? "DNS-AID record found" : "no DNS-AID record found at the checked discovery names");
  // A probe that never ran cannot be a "fail". lensProbeMdNego sets `note` ONLY when
  // it produced no real answer ("probe failed", or "not probed (non-HTML target)");
  // a genuine negative carries contentType/status and no note. Keying on the exact
  // string "probe failed" let the not-probed case fall through to fail and then
  // assert "Accept: text/markdown stayed non-markdown" about a request never sent —
  // the same fabrication the agent-doors tier already refuses to make.
  const mdNego = (agent && agent.mdNegotiation) || null;
  items.markdownNegotiation = lensReadinessItem("markdownNegotiation", mdNego && mdNego.supported ? "pass" : mdNego && mdNego.note ? "unknown" : "fail", mdNego && mdNego.supported ? "same URL returned text/markdown" : mdNego && mdNego.note ? mdNego.note : "Accept: text/markdown stayed non-markdown");
  items.robotsTxtAiRules = lensReadinessItem("robotsTxtAiRules", robots && robots.ok ? (namedAiRules ? "pass" : "fail") : "unknown", namedAiRules ? "named AI bot rules found" : robotsRules ? "wildcard rules apply to crawlers, no AI crawler is named" : "robots policy could not be evaluated");
  items.contentSignals = lensReadinessItem("contentSignals", terms && terms.robotsUnknown ? "unknown" : terms && terms.signals && terms.signals.length ? "pass" : "fail", terms && terms.signals && terms.signals.length ? terms.signals.length + " Content-Signal directive(s)" : "no Content-Signal directive found");
  items.webBotAuth = lensReadinessItem("webBotAuth", botAuth.status, botAuth.detail);
  items.apiCatalog = lensReadinessItem("apiCatalog", agent && agent.apiCatalog && agent.apiCatalog.present ? "pass" : agent && agent.apiCatalog && agent.apiCatalog.unknown ? "unknown" : "fail", agent && agent.apiCatalog && agent.apiCatalog.present ? agent.apiCatalog.detail : "no valid API Catalog linkset");
  items.oauthDiscovery = lensReadinessItem("oauthDiscovery", oauthOpen.status === "pass" || oauthServer.status === "pass" ? "pass" : oauthOpen.status === "unknown" || oauthServer.status === "unknown" ? "unknown" : "fail", oauthOpen.status === "pass" || oauthServer.status === "pass" ? "OAuth or OIDC discovery metadata found" : "no valid OAuth/OIDC discovery document");
  items.oauthProtectedResource = lensReadinessItem("oauthProtectedResource", oauthResource.status, oauthResource.detail);
  items.authMd = lensReadinessItem("authMd", discovery && discovery.authMd && discovery.authMd.ok && String(discovery.authMd.body || "").trim() ? "pass" : discovery && discovery.authMd && discovery.authMd.error ? "unknown" : "fail", discovery && discovery.authMd && discovery.authMd.ok ? "auth.md answered" : "no auth.md registration guide");
  items.mcpServerCard = lensReadinessItem("mcpServerCard", mcpCard.status, mcpCard.detail);
  items.a2aAgentCard = lensReadinessItem("a2aAgentCard", agent && agent.agentCard && agent.agentCard.present ? "pass" : "fail", agent && agent.agentCard && agent.agentCard.present ? agent.agentCard.detail : "no valid A2A Agent Card");
  items.agentSkills = lensReadinessItem("agentSkills", skills.status, skills.detail);
  items.webMcp = lensReadinessItem("webMcp", agent && agent.webmcp && agent.webmcp.found ? "pass" : "fail",
    agent && agent.webmcp && agent.webmcp.found
      ? (agent.webmcp.kind === "bridge" ? "a CDN-injected bridge loads this origin's MCP tools into the page" : "modelContext call sites in the page")
      : "no WebMCP marker found in the fetched HTML");
  items.x402 = lensReadinessItem("x402", terms && terms.paid && terms.paid.http402 ? "pass" : "neutral", terms && terms.paid && terms.paid.http402 ? "HTTP 402 payment requirement observed" : "not observed (optional; not scored)");
  const openapiText = openapi && openapi.ok ? String(openapi.body || "") : "";
  items.mpp = lensReadinessItem("mpp", /x-payment-info|mpp/i.test(openapiText) ? "pass" : "neutral", /x-payment-info|mpp/i.test(openapiText) ? "payment metadata found in OpenAPI" : "not observed (optional; not scored)");
  items.ucp = lensReadinessItem("ucp", ucp.status === "pass" ? "pass" : "neutral", ucp.status === "pass" ? "UCP-shaped discovery metadata found" : "not observed (optional; not scored)");
  items.acp = lensReadinessItem("acp", acp.status === "pass" ? "pass" : "neutral", acp.status === "pass" ? "ACP-shaped discovery metadata found" : "not observed (optional; not scored)");
  items.ap2 = lensReadinessItem("ap2", ap2.status === "pass" ? "pass" : "neutral", ap2.status === "pass" ? "AP2-shaped discovery metadata found" : "not observed (optional; not scored)");

  // Execution rides whatever agent-browser evidence this scan happens to hold.
  // With none, both come back `neutral`: shown in the grid, excluded from the
  // score. That is deliberate and is the opposite of how `unknown` is treated
  // above. An unknown DECLARED check means we asked and the site did not
  // answer, which is the site's fact. An unmeasured execution check means our
  // browser budget was spent, which is OURS, and docking a stranger's score for
  // our rate limit would make the number dishonest.
  const exec = executionChecks(execution);
  items.agentScripts = lensReadinessItem("agentScripts", exec.agentScripts.status, exec.agentScripts.detail);
  items.agentMedia = lensReadinessItem("agentMedia", exec.agentMedia.status, exec.agentMedia.detail);

  const categories = LENS_READINESS_CATEGORIES.map((category) => {
    const values = Object.values(items).filter((item) => item.category === category.key && item.countInScore && item.status !== "neutral");
    const passed = values.filter((item) => item.status === "pass").length;
    return { key: category.key, label: category.label, score: values.length ? Math.round((passed / values.length) * 100) : 0, passed, total: values.length, checkCount: Object.values(items).filter((item) => item.category === category.key).length, countInScore: category.countInScore };
  });
  const counted = Object.values(items).filter((item) => item.countInScore && item.status !== "neutral");
  const passed = counted.filter((item) => item.status === "pass").length;
  const overall = counted.length ? Math.round((passed / counted.length) * 100) : 0;
  const actionSurface = !!(agent && agent.strategy && agent.strategy.action && agent.strategy.action.length);
  const strongPublishing = items.markdownNegotiation.status === "pass" && items.contentSignals.status === "pass" && items.linkHeaders.status === "pass";
  const baseline = items.robotsTxt.status === "pass" || items.sitemap.status === "pass";
  const ladder = actionSurface ? 5 : strongPublishing ? 3 : baseline ? 1 : 0;
  // The ladder reads ONE signal per rung, and the score reads twenty. Left
  // alone the two contradict each other in public: github.com scored 13/100 and
  // was labelled Agent-Native, walmart.com 27/100 and the same, because a
  // single door probe outranks every failed check beneath it. So a rung may
  // claim at most ONE step beyond what the breadth of the score supports.
  //
  // One step rather than zero on purpose. The top rung is a claim about
  // CAPABILITY, and a site can genuinely ship a working agent interface while
  // publishing none of the metadata the other checks look for — that site
  // deserves to outrank its score. What it may not do is outrun the whole
  // rubric by four rungs on the strength of one probe.
  const RUNGS = [0, 1, 3, 5];
  const supported = Math.floor(overall / 20) + 1;
  const ceiling = RUNGS.filter((rung) => rung <= supported).pop() ?? 0;
  const number = Math.min(ladder, ceiling);
  const LEVEL_NAMES = { 0: "Not Ready", 1: "Basic Web Presence", 3: "Agent-Readable", 5: "Agent-Native" };
  const level = { number, name: LEVEL_NAMES[number] };
  // Say so when the cap bit, rather than quietly publishing a smaller number
  // than the evidence produced — the reader is owed the disagreement.
  const levelNote = number < ladder
    ? `one signal supports ${LEVEL_NAMES[ladder]}, but ${overall}/100 of the rubric passed, so the level is held at ${LEVEL_NAMES[number]}`
    : null;
  // ship the label with each action: LENS_READINESS_META already owns it, so the
  // client should render it off the envelope rather than keep a second copy that
  // silently wins and drifts when a label is renamed here.
  const nextActions = Object.values(items).filter((item) => item.status === "fail" && item.countInScore).slice(0, 5).map((item) => ({ key: item.key, label: item.label }));
  return {
    overall, level: level.number, levelName: level.name, levelNote,
    categories, checks: items, counted: counted.length, passed,
    scoringNote: "Passes divided by pass + fail + unknown; neutral checks are shown but excluded. Execution checks stay neutral until an agent browser has actually rendered the page, so a spent render budget never costs a site points.",
    nextActions, botViews: botViews || [],
  };
}
