// What does THIS site need an agent to find, and what is it building past need?
//
// The readiness mirror beside this (lensReadiness in lens.ts) is Cloudflare's
// rubric: a flat list of declarations, each worth the same. That weighting docks a
// personal blog for publishing no OAuth discovery, no MCP server card and no
// auth.md, none of which it has any use for, and it hands the same point for a
// DNS-AID record as for a page that serves its words without JavaScript.
//
// Is Agentic (is-agentic.com, Vercel + Ora) fixed that with one idea worth
// borrowing: APPLICABILITY. Its Essential checks share 80 points and apply to
// every public site. Its Recommended checks share 20 and switch on only when
// the scan finds the surface they grade (an API, an MCP server, an auth flow,
// commerce). Emerging formats earn a bonus capped at 5, so a site cannot buy
// its way up with drafts. aadhar.sh scored 100 there on 2026-10-13: 80 from six
// essential checks, and +5 for 61 bonus signals. That is the honest price of
// most of what this site publishes for agents, and the point of this module.
//
// What Lens takes and what it leaves is ISAG_LEDGER below, one row per check in
// their catalog, each declined row with its reason. Lens declines on three
// grounds: the check grades fame or a business decision rather than the page;
// it needs more requests than a scan has (a cold scan spends 46 of Workers
// Free's 50 subrequests); or Lens disagrees with it.
//
// Pure and node-safe (gotcha 16): every input is evidence the scan already
// holds, so this adds zero subrequests.

import { asRecord, asText } from "./lib/parse.ts";

// Checked against https://is-agentic.com/scan/aadhar.sh on this date; the
// catalog is the 132 check ids embedded in that report.
export const ISAG_CHECKED = "2026-10-13";

export const NEED_POOLS = { essential: 80, recommended: 20, bonusCap: 5 };

// Markdown negotiation earns a Recommended slot only when the HTML tax is real:
// raw HTML at least this many times its markdown AND past this many tokens.
// Below that the page is already lean enough to read, and a twin is bonus.
// 8K tokens is near is-agentic's own page-token-budget line (their largest
// passing page on this site was ~5K).
const HTML_TAX_RATIO = 5;
const HTML_TAX_TOKENS = 8000;

type Credit = number | null;
type NeedCheck = { key: string; label: string; status: string; credit: Credit; detail: string };

// pass 1, fail 0, partial in between. `unknown` means we asked and the site did
// not answer, which is the site's fact, so it counts at zero. `neutral` means
// WE did not measure (a self-scan skips bot views, a spent budget), and docking
// a stranger for our instrument would make the number dishonest; it is shown
// and excluded. Same split lensReadiness makes for its execution checks.
const check = (key: string, label: string, credit: Credit, detail: string, neutral = false): NeedCheck => ({
  key,
  label,
  detail,
  status: neutral ? "neutral" : credit == null ? "unknown" : credit >= 1 ? "pass" : credit <= 0 ? "fail" : "partial",
  credit: neutral ? null : credit == null ? 0 : Math.max(0, Math.min(1, credit)),
});

function pool(checks: NeedCheck[], points: number) {
  const counted = checks.filter((c) => c.status !== "neutral");
  const sum = counted.reduce((a, c) => a + (c.credit ?? 0), 0);
  return {
    earned: counted.length ? Math.round((sum / counted.length) * points * 10) / 10 : 0,
    available: counted.length ? points : 0,
    passing: counted.filter((c) => c.status === "pass").length,
    total: counted.length,
    checks,
  };
}

// The share of OpenAPI operations an agent can call as a function: each needs
// an operationId to become a tool name. Resend publishes 83 operations and 0
// operationIds (is-agentic, 2026-10-12), which is exactly the gap this reads.
export function openapiOperationIds(body: string) {
  let spec: any;
  try {
    spec = JSON.parse(body);
  } catch {
    return null;
  }
  const paths = asRecord(asRecord(spec)?.paths);
  if (!paths) return null;
  let ops = 0,
    named = 0;
  for (const raw of Object.values(paths)) {
    const item = asRecord(raw);
    if (!item) continue;
    for (const m of ["get", "put", "post", "delete", "patch", "options", "head", "trace"]) {
      const op = asRecord(item[m]);
      if (!op) continue;
      ops++;
      if (asText(op.operationId)) named++;
    }
  }
  return { ops, named };
}

const has = (probe: any) => !!(probe && probe.status === "pass");
const tokensOf = (cost: any, key: string) => {
  const tier = cost && Array.isArray(cost.tiers) ? cost.tiers.find((t: any) => t.key === key) : null;
  return tier ? tier.tokens : null;
};

export function lensNeed({
  status,
  bodyUnreadable,
  url,
  finalUrl,
  isHtml,
  anatomy,
  structured,
  headers,
  cost,
  readiness,
  agent,
  terms,
  openapi,
  botViews,
}: {
  status?: any;
  bodyUnreadable?: any;
  url?: any;
  finalUrl?: any;
  isHtml?: any;
  anatomy?: any;
  structured?: any;
  headers?: any;
  cost?: any;
  readiness?: any;
  agent?: any;
  terms?: any;
  openapi?: any;
  botViews?: any;
}) {
  const mirror = (readiness && readiness.checks) || {};
  const field = (readiness && readiness.field && readiness.field.components) || [];
  const html = String((anatomy && anatomy.rawHtml) || "");
  const text = String((anatomy && anatomy.text) || "");
  const headings = (anatomy && anatomy.headings) || [];
  const rel = (structured && structured.relLinks) || [];
  const og = (structured && structured.og) || {};
  const meta = (structured && structured.meta) || {};
  const jsonld = (structured && structured.jsonld) || [];
  const doors = agent || {};

  // ── which surfaces apply ────────────────────────────────────────────────
  // The website always does. Every other surface switches on only on positive
  // evidence, and each carries the evidence that switched it.
  // A POST-only server answers lens's GET with a 405, which the door probe
  // calls "maybe". A server card beside that 405 settles it. Only "no" counts
  // as absent: "maybe" and "unknown" are not evidence that nothing is there.
  const mcpVerdict = doors.mcp && doors.mcp.verdict;
  const mcpUp = mcpVerdict === "yes" || mcpVerdict === "likely" || (mcpVerdict === "maybe" && has(mirror.mcpServerCard));
  const mcpAbsent = mcpVerdict === "no";
  const apiWhy =
    doors.openapi && doors.openapi.present
      ? "an OpenAPI description answered"
      : doors.apiCatalog && doors.apiCatalog.present
        ? "an API catalog answered"
        : doors.aiPlugin && doors.aiPlugin.present
          ? "a legacy ai-plugin manifest answered"
          : null;
  const oauthSeen = has(mirror.oauthProtectedResource) || has(mirror.oauthDiscovery);
  const mcpAuthGated = mcpUp && /401/.test(String(doors.mcp.detail || ""));
  const ldTypes = jsonld.flatMap((j: any) => (j && j.valid ? j.types : []));
  const paymentDoor = ["x402", "mpp", "ucp", "acp", "ap2"].find((k) => has(mirror[k]));
  const sells = ldTypes.find((t: string) => /^(Product|Offer|AggregateOffer)$/.test(t));
  const surfaces = [
    { key: "website", label: "Public website", applies: true, why: "every public URL" },
    { key: "api", label: "API", applies: !!apiWhy, why: apiWhy || "no OpenAPI, API catalog or plugin manifest answered" },
    {
      key: "mcp",
      label: "MCP",
      applies: !!mcpUp,
      why:
        String((doors.mcp && doors.mcp.detail) || (mcpAbsent ? "/mcp did not answer as an MCP server" : "the /mcp probe did not run")) +
        (mcpVerdict === "maybe" && mcpUp ? ", and a server card describes it" : ""),
    },
    // Authorization is a surface only when it guards something: an API or an
    // MCP server. OAuth metadata in front of neither is in beyondNeed below.
    {
      key: "auth",
      label: "Authorization",
      applies: !!((apiWhy || mcpUp) && (oauthSeen || mcpAuthGated)),
      why: mcpAuthGated
        ? "/mcp answered 401 with WWW-Authenticate"
        : oauthSeen && (apiWhy || mcpUp)
          ? "OAuth metadata in front of an API or MCP server"
          : oauthSeen
            ? "OAuth metadata, but nothing found for it to guard"
            : "no OAuth metadata and no 401 challenge",
    },
    {
      key: "commerce",
      label: "Commerce",
      applies: !!(paymentDoor || sells),
      why: paymentDoor ? `${mirror[paymentDoor].label} answered` : sells ? `JSON-LD declares a ${sells}` : "no payment protocol and no Product or Offer markup",
    },
  ];
  const applies = (k: string) => surfaces.some((s) => s.key === k && s.applies);
  const notHtml = !isHtml && !html;

  // ── essential: what every public URL owes an agent ─────────────────────
  const essential: NeedCheck[] = [];
  const chars = text.length;
  const h1 = headings.some((h: any) => h.level === 1);
  essential.push(
    notHtml
      ? check("servedContent", "Content without JavaScript", null, "not an HTML page; nothing to render", true)
      : bodyUnreadable
        ? check("servedContent", "Content without JavaScript", null, "the body could not be decoded here", true)
        : check(
            "servedContent",
            "Content without JavaScript",
            chars >= 500 ? (h1 ? 1 : 0.5) : chars > 0 ? 0.25 : 0,
            `${chars.toLocaleString("en-US")} characters in the raw HTML${h1 ? ", with an H1" : ", no H1"}${chars < 500 ? "; below the 500 a reader needs" : ""}`,
          ),
  );

  const bots = field.find((c: any) => c.key === "sampledBots");
  const sampled = Array.isArray(botViews) && botViews.length > 0;
  essential.push(
    !sampled
      ? check("crawlerReach", "Agents are let in", null, "bot views were not sampled on this scan", true)
      : !bots || bots.score == null
        ? check("crawlerReach", "Agents are let in", null, bots ? bots.detail : "no bot evidence", true)
        : check("crawlerReach", "Agents are let in", bots.score / 100, bots.detail),
  );

  // robots.txt, read for the agents a PERSON sent. Turning away GPTBot or CCBot
  // is a training-consent choice and costs nothing here; turning away
  // ChatGPT-User or Claude-User refuses someone who asked for this page.
  const board = terms && Array.isArray(terms.scoreboard) ? terms.scoreboard : [];
  const asked = board.filter((r: any) => r && r.kind === "answers" && String(r.ua).endsWith("-User"));
  const refused = asked.filter((r: any) => r.verdict === "block");
  essential.push(
    !asked.length
      ? check("userAgents", "robots.txt admits user-sent agents", null, "robots policy was not evaluated", true)
      : asked.some((r: any) => r.verdict === "unknown")
        ? check("userAgents", "robots.txt admits user-sent agents", null, "robots.txt did not answer readably")
        : check(
            "userAgents",
            "robots.txt admits user-sent agents",
            1 - refused.length / asked.length,
            refused.length
              ? `robots.txt refuses ${refused.map((r: any) => r.ua).join(", ")} on this path`
              : `${asked.map((r: any) => r.ua).join(" and ")} may fetch this path; training crawlers are a separate choice`,
          ),
  );

  // One page, so this is the narrow version of their five-page sample: did the
  // URL itself ask for credentials?
  essential.push(
    !Number.isFinite(status)
      ? check("publicRead", "Readable without signing in", null, "the identified fetch did not answer")
      : status === 401 || status === 407
        ? check("publicRead", "Readable without signing in", 0, `HTTP ${status}: the page asks for credentials`)
        : status >= 200 && status < 400
          ? check("publicRead", "Readable without signing in", 1, `HTTP ${status} with no credentials sent`)
          : check("publicRead", "Readable without signing in", null, `HTTP ${status}: neither a page nor a sign-in wall`),
  );

  const hostOf = (u: any) => {
    try {
      return new URL(String(u)).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const metaRefresh = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html);
  const jsStub = chars < 200 && /(?:window\.)?location(?:\.href)?\s*=|location\.replace\(/.test(html);
  const crossDomain = url && finalUrl && hostOf(url) && hostOf(finalUrl) && hostOf(url) !== hostOf(finalUrl);
  essential.push(
    notHtml
      ? check("redirects", "Redirects resolve cleanly", null, "not an HTML page", true)
      : check(
          "redirects",
          "Redirects resolve cleanly",
          metaRefresh || jsStub ? 0 : crossDomain ? 0.5 : 1,
          metaRefresh
            ? "a meta refresh stub: an HTTP client stops here"
            : jsStub
              ? "a JavaScript redirect stub: an HTTP client stops here"
              : crossDomain
                ? `the request left ${hostOf(url)} for ${hostOf(finalUrl)}`
                : "no meta-refresh or script stub, and no cross-domain hop",
        ),
  );

  const idParts: Array<[string, boolean]> = [
    ["canonical", rel.some((l: any) => /(^|\s)canonical(\s|$)/.test(l.rel))],
    ["lang", /<html[^>]*\slang\s*=\s*["']?[a-z]/i.test(html)],
    ["og:image", !!og.image],
    ["og:type", !!og.type],
  ];
  const idHave = idParts.filter(([, ok]) => ok).map(([k]) => k);
  const idMiss = idParts.filter(([, ok]) => !ok).map(([k]) => k);
  essential.push(
    notHtml
      ? check("identity", "Says what it is", null, "not an HTML page", true)
      : check(
          "identity",
          "Says what it is",
          idHave.length / idParts.length,
          idMiss.length ? `missing ${idMiss.join(", ")}` : "canonical URL, lang, og:image and og:type all present",
        ),
  );

  // ── recommended: switched on per surface ───────────────────────────────
  const recommended: NeedCheck[] = [];
  const robotsMeta = String(meta.robots || "") + " " + String((headers && headers["x-robots-tag"]) || "");
  if (!notHtml) {
    recommended.push(
      check(
        "searchVisible",
        "Not hidden from search",
        /noindex/i.test(robotsMeta) ? 0 : 1,
        /noindex/i.test(robotsMeta) ? "noindex on the page or in X-Robots-Tag" : "no noindex directive",
      ),
    );
    if (mirror.sitemap)
      recommended.push(
        check("sitemap", "Sitemap", mirror.sitemap.status === "pass" ? 1 : mirror.sitemap.status === "unknown" ? null : 0, mirror.sitemap.detail),
      );
    const validLd = jsonld.filter((j: any) => j && j.valid);
    recommended.push(
      check(
        "jsonld",
        "JSON-LD identity",
        validLd.length ? 1 : jsonld.length ? 0.5 : 0,
        validLd.length
          ? `${validLd.length} valid block(s): ${[...new Set(ldTypes)].slice(0, 4).join(", ") || "untyped"}`
          : jsonld.length
            ? "JSON-LD present but none parsed"
            : "no JSON-LD",
      ),
    );
  }
  // The discerning one. A twin halves an agent's bill on a heavy page and buys
  // almost nothing on a lean one, so it is Recommended only when the tax is real.
  const htmlTok = tokensOf(cost, "html");
  const mdTok = tokensOf(cost, "markdown");
  const heavy = htmlTok != null && mdTok != null && mdTok > 0 && htmlTok >= HTML_TAX_TOKENS && htmlTok / mdTok >= HTML_TAX_RATIO;
  const mdNego = mirror.markdownNegotiation;
  if (heavy && mdNego) {
    recommended.push(
      check(
        "markdown",
        "Markdown for a heavy page",
        mdNego.status === "pass" ? 1 : mdNego.status === "unknown" ? null : 0,
        `raw HTML is ~${htmlTok.toLocaleString("en-US")} tokens, ${Math.round(htmlTok / mdTok)}x its markdown; ${mdNego.status === "pass" ? "a markdown twin answers" : "no markdown twin answers"}`,
      ),
    );
  }
  if (applies("api")) {
    const spec = doors.openapi && doors.openapi.present && openapi && openapi.ok ? openapiOperationIds(String(openapi.body || "")) : null;
    recommended.push(
      check(
        "apiDescribed",
        "API is described",
        doors.openapi && doors.openapi.present ? 1 : 0.5,
        doors.openapi && doors.openapi.present
          ? String(doors.openapi.detail || "OpenAPI answered")
          : "an API is advertised, but no OpenAPI description answered",
      ),
    );
    if (spec && spec.ops) {
      recommended.push(
        check(
          "operationIds",
          "Operations an agent can call by name",
          spec.named / spec.ops,
          `${spec.named} of ${spec.ops} operations carry an operationId; a function-calling agent needs one per tool`,
        ),
      );
    }
  }
  if (applies("mcp")) {
    const card = mirror.mcpServerCard;
    const findable = has(card) || has(mirror.apiCatalog) || !!(doors.llmsTxt && doors.llmsTxt.present);
    recommended.push(
      check(
        "mcpFindable",
        "MCP server is findable",
        findable ? 1 : 0,
        has(card) ? "a server card describes it" : findable ? "linked from llms.txt or the API catalog" : "/mcp answers, but nothing on the site points to it",
      ),
    );
  }
  if (applies("auth")) {
    const prm = mirror.oauthProtectedResource;
    recommended.push(
      check(
        "protectedResource",
        "Agents can find the authorization server",
        has(prm) ? 1 : prm && prm.status === "unknown" ? null : 0,
        has(prm) ? "RFC 9728 protected-resource metadata answered" : "no /.well-known/oauth-protected-resource; an agent holding a 401 has nowhere to go",
      ),
    );
  }
  if (applies("commerce")) {
    recommended.push(
      check(
        "machinePayment",
        "A machine can pay",
        paymentDoor ? 1 : 0,
        paymentDoor ? `${mirror[paymentDoor].label} answered` : "the site sells, but publishes no machine payment protocol",
      ),
    );
  }

  // ── bonus: emerging doors, capped ──────────────────────────────────────
  const bonusKeys = ["robotsTxtAiRules", "contentSignals", "linkHeaders", "dnsAid", "webBotAuth", "authMd", "a2aAgentCard", "agentSkills", "webMcp"];
  const signals: string[] = [];
  if (doors.llmsTxt && doors.llmsTxt.present) signals.push("llms.txt");
  if (!heavy && has(mdNego)) signals.push("markdown negotiation");
  for (const k of bonusKeys) if (has(mirror[k])) signals.push(mirror[k].label);
  if (!applies("mcp") && !mcpAbsent && has(mirror.mcpServerCard)) signals.push(mirror.mcpServerCard.label);
  if (doors.nlweb && (doors.nlweb.verdict === "likely" || doors.nlweb.verdict === "maybe")) signals.push("NLWeb /ask");
  const bonus = { points: Math.min(NEED_POOLS.bonusCap, signals.length), cap: NEED_POOLS.bonusCap, signals };

  // ── the score ──────────────────────────────────────────────────────────
  // Their arithmetic: earned essential + earned recommended + bonus, capped at
  // 100. One departure, for the site with no recommended check at all (a
  // non-HTML URL with nothing else): the 80 is rescaled to 100 so an empty
  // pool cannot cap a perfect score at 85.
  const ess = pool(essential, NEED_POOLS.essential);
  const rec = pool(recommended, NEED_POOLS.recommended);
  const available = ess.available + rec.available;
  const base = available ? ((ess.earned + rec.earned) / available) * 100 : null;
  const overall = base == null || ess.available === 0 ? null : Math.min(100, Math.round(base + bonus.points));

  // ── past need ──────────────────────────────────────────────────────────
  // SKIP: mirror checks this site fails (or leaves unanswered) that it has no
  // reason to fix. The mirror's next-actions list would otherwise send a blog
  // off to build OAuth.
  const skip: Array<{ key: string; label: string; why: string }> = [];
  const skipIf = (key: string, when: boolean, why: string) => {
    const item = mirror[key];
    if (item && (item.status === "fail" || item.status === "unknown") && when) skip.push({ key, label: item.label, why });
  };
  const guardsNothing = !applies("api") && !applies("mcp");
  skipIf("oauthDiscovery", guardsNothing, "no API or MCP server here for it to authorize");
  skipIf("oauthProtectedResource", guardsNothing, "no API or MCP server here for it to protect");
  skipIf("authMd", guardsNothing, "no API or MCP server here to sign an agent up for");
  skipIf("mcpServerCard", mcpAbsent, "no MCP server answered, so a card would describe nothing");
  skipIf("apiCatalog", !applies("api"), "no API to catalog");
  skipIf("webBotAuth", true, "a key directory for bots this origin sends; skip it unless you run one");
  skipIf("robotsTxtAiRules", true, "a wildcard group already admits every crawler; name them only to treat them differently");
  skipIf("contentSignals", true, "states a usage preference; worth publishing once you hold one, and access works without it");
  skipIf("dnsAid", true, "a draft; llms.txt and Link headers already tell an agent where to look");
  skipIf("webMcp", true, "pays only when the page has actions worth handing an agent");
  skipIf("linkHeaders", true, "a shortcut to files an agent can already find at their well-known paths");

  // BEYOND NEED: doors this site built that point at nothing it serves.
  const beyondNeed: Array<{ label: string; why: string }> = [];
  if (oauthSeen && guardsNothing) beyondNeed.push({ label: "OAuth metadata", why: "published, but Lens found no API or MCP server behind it" });
  if (has(mirror.mcpServerCard) && mcpAbsent) beyondNeed.push({ label: "MCP Server Card", why: "describes a server that did not answer at /mcp" });
  if (signals.length > NEED_POOLS.bonusCap) {
    beyondNeed.push({
      label: `${signals.length} emerging doors`,
      why: `worth ${NEED_POOLS.bonusCap} points between them; build each one when a reader you can name will use it`,
    });
  }

  return {
    overall,
    pools: NEED_POOLS,
    surfaces,
    essential: ess,
    recommended: rec,
    bonus,
    fixes: [...essential, ...recommended]
      .filter((c) => c.status === "fail" || c.status === "partial" || c.status === "unknown")
      .map((c) => ({ key: c.key, label: c.label, detail: c.detail })),
    skip,
    beyondNeed,
    source: { name: "Is Agentic", url: "https://is-agentic.com/methodology", checked: ISAG_CHECKED },
    scoringNote: `Essential checks share ${NEED_POOLS.essential} points and apply everywhere; Recommended share ${NEED_POOLS.recommended} and apply only to surfaces this scan found; emerging doors add at most ${NEED_POOLS.bonusCap}. A check Lens could not measure is shown and excluded; one the site did not answer counts at zero.`,
  };
}

// ── the ledger ─────────────────────────────────────────────────────────────
// Every check in Is Agentic's catalog, filed once. `scored` maps a Lens need
// check to the is-agentic ids it stands in for; `bonus` are counted as signals;
// `declined` carries the reason Lens leaves them out. The contract test holds
// this to the catalog, so a new is-agentic check has to be filed somewhere.
export const ISAG_LEDGER = {
  scored: {
    servedContent: ["content-no-js"],
    crawlerReach: ["bot-detection", "agent-crawler-reachability"],
    userAgents: ["robots-agent-user-policy"],
    publicRead: ["docs-auth-gate"],
    redirects: ["redirect-hygiene"],
    identity: ["metadata-completeness"],
    searchVisible: ["noindex-directives"],
    sitemap: ["sitemap"],
    jsonld: ["json-ld"],
    markdown: ["markdown-negotiation-vary", "markdown-negotiation"],
    apiDescribed: ["openapi-spec", "public-api"],
    operationIds: ["function-calling-compat", "api-schema-analysis"],
    mcpFindable: ["mcp-server", "mcp-server-card", "mcp-well-known-discovery", "mcp-transport-modern"],
    protectedResource: ["oauth-protected-resource", "oauth-support"],
    machinePayment: ["x402-support", "mpp-support", "ucp-support", "acp-support", "ap2-support"],
  },
  bonus: [
    "llms-txt-exists",
    "link-headers-discovery",
    "a2a-agent-card",
    "agent-discovery-file",
    "agent-skills-index-v2",
    "webmcp",
    "nlweb-ask",
    "nlweb-streaming",
    "web-bot-auth-directory",
    "auth-md-exists",
    "robots-ai-policy-quality",
    "api-catalog-rfc9727",
  ],
  declined: [
    {
      why: "Grades fame or a directory listing. An agent already holding the URL never consults a search rank, and a stranger's site shouldn't be scored on its press.",
      ids: [
        "wikipedia-presence",
        "brand-search-accuracy",
        "agentic-search-specific",
        "agentic-search-usecase",
        "chatgpt-app-listed",
        "mcp-registry-listed",
        "skills-sh-listed",
        "skills-sh-quality",
        "registry-branding",
      ],
    },
    {
      why: "A business decision about what to sell. Whether to ship an SDK, a CLI, a free tier or a price sheet depends on what you sell; a blog owes agents none of them.",
      ids: [
        "cli-tool",
        "npm-sdk-package",
        "rest-sdk-packages",
        "sandbox-environment",
        "onboarding-friction",
        "pricing-info",
        "pricing-md",
        "acp-delegate-payment",
      ],
    },
    {
      why: "Grades how well an API is designed, past whether an agent can find it and call it by name. Sound advice for a public API with real traffic; overkill as a readiness gate.",
      ids: [
        "api-error-model",
        "api-versioning-policy",
        "async-job-pattern",
        "batch-endpoints",
        "idempotency-key-support",
        "pagination-shape",
        "rate-limit-headers",
        "response-schema-coverage",
        "json-error-responses",
        "scoped-permissions",
        "graphql-async-job-pattern",
        "graphql-batch-mutations",
        "graphql-error-type-definition",
        "graphql-pagination-pattern",
        "graphql-schema-completeness",
        "graphql-versioning-policy",
      ],
    },
    {
      why: "Needs an open MCP session (initialize, tools/list, resources/read, an OAuth dance) against a stranger's server. Lens checks that /mcp answers and stops there.",
      ids: [
        "mcp-tool-listing",
        "mcp-tool-descriptions",
        "mcp-tool-naming",
        "mcp-tool-annotations",
        "mcp-param-schemas",
        "mcp-error-handling",
        "mcp-resource-listing",
        "mcp-resource-quality",
        "mcp-server-identity",
        "mcp-auth-mechanism",
        "mcp-oauth-metadata",
        "mcp-pkce-s256",
        "mcp-multi-surface-coverage",
        "mcp-app-registry",
        "mcp-apps-ui-quality",
        "mcp-view-csp",
        "mcp-view-domain",
        "agent-auth-discovery-metadata",
        "agent-auth-endpoints-reachable",
        "agent-auth-www-authenticate",
        "auth-md-structure",
        "auth-md-walkthrough-simulation",
      ],
    },
    {
      why: "Needs more requests than a scan has, or a crawl. A cold scan spends 46 of Workers Free's 50 subrequests, and each of these is another fetch or several.",
      ids: [
        "agent-friendly-404",
        "page-token-budget",
        "llms-txt-links-resolve",
        "sitemap-lastmod",
        "markdown-url-fallback",
        "developer-portal",
        "public-api-docs",
        "trust-anchors",
        "modular-llms-txt",
      ],
    },
    {
      why: "Polish on a door that already opens. Organization schema asking a personal site for a postal address is the clearest case: it grades a business shape onto a site that isn't one.",
      ids: [
        "org-schema-completeness",
        "schema-type-breadth",
        "json-ld-entity-linking",
        "markdown-frontmatter",
        "code-fence-validity",
        "llms-txt-formatting",
        "agent-instruction",
        "markdown-link-alternate",
      ],
    },
    {
      why: "Needs a rendered accessibility tree. Lens renders only on the Browser pane's daily budget, and its execution checks already score what a render showed.",
      ids: ["ax-accessible-names", "ax-document-structure", "ax-form-labeling", "ax-native-controls", "ax-tree-injection-safe"],
    },
    {
      why: "Drafts and vendor conventions with no reader Lens can point to yet. Bonus credit at Is Agentic too; Lens leaves them unprobed rather than spend a subrequest on them.",
      ids: [
        "a2ui-support",
        "ard-catalog",
        "ard-entries-valid",
        "ard-trust-manifest",
        "ai-catalog-published",
        "agent-plugins-repo",
        "agent-rules-repo",
        "nlweb-schema-feeds",
        "pap-auth-config",
        "pap-cross-protocol",
        "pap-discovery",
        "pap-endpoint-enforcement",
        "pap-interfaces",
        "pap-issuer-binding",
      ],
    },
    {
      why: "Lens disagrees. A view keyed on User-Agent or a ?mode=agent flag is a second page to keep in sync, and UA-keyed bytes look like cloaking to a search engine. Accept negotiation on the same URL does the job, and Lens scores that.",
      ids: ["agent-ua-markdown", "agent-mode-view"],
    },
  ],
};

// The 132 ids Is Agentic's report carried on ISAG_CHECKED, for the contract
// test to hold the ledger against. Recount from any report page's embedded data.
export const ISAG_CATALOG = [
  "a2a-agent-card",
  "a2ui-support",
  "acp-delegate-payment",
  "acp-support",
  "agent-auth-discovery-metadata",
  "agent-auth-endpoints-reachable",
  "agent-auth-www-authenticate",
  "agent-crawler-reachability",
  "agent-discovery-file",
  "agent-friendly-404",
  "agent-instruction",
  "agent-mode-view",
  "agent-plugins-repo",
  "agent-rules-repo",
  "agent-skills-index-v2",
  "agent-ua-markdown",
  "agentic-search-specific",
  "agentic-search-usecase",
  "ai-catalog-published",
  "ap2-support",
  "api-catalog-rfc9727",
  "api-error-model",
  "api-schema-analysis",
  "api-versioning-policy",
  "ard-catalog",
  "ard-entries-valid",
  "ard-trust-manifest",
  "async-job-pattern",
  "auth-md-exists",
  "auth-md-structure",
  "auth-md-walkthrough-simulation",
  "ax-accessible-names",
  "ax-document-structure",
  "ax-form-labeling",
  "ax-native-controls",
  "ax-tree-injection-safe",
  "batch-endpoints",
  "bot-detection",
  "brand-search-accuracy",
  "chatgpt-app-listed",
  "cli-tool",
  "code-fence-validity",
  "content-no-js",
  "developer-portal",
  "docs-auth-gate",
  "function-calling-compat",
  "graphql-async-job-pattern",
  "graphql-batch-mutations",
  "graphql-error-type-definition",
  "graphql-pagination-pattern",
  "graphql-schema-completeness",
  "graphql-versioning-policy",
  "idempotency-key-support",
  "json-error-responses",
  "json-ld",
  "json-ld-entity-linking",
  "link-headers-discovery",
  "llms-txt-exists",
  "llms-txt-formatting",
  "llms-txt-links-resolve",
  "markdown-frontmatter",
  "markdown-link-alternate",
  "markdown-negotiation",
  "markdown-negotiation-vary",
  "markdown-url-fallback",
  "mcp-app-registry",
  "mcp-apps-ui-quality",
  "mcp-auth-mechanism",
  "mcp-error-handling",
  "mcp-multi-surface-coverage",
  "mcp-oauth-metadata",
  "mcp-param-schemas",
  "mcp-pkce-s256",
  "mcp-registry-listed",
  "mcp-resource-listing",
  "mcp-resource-quality",
  "mcp-server",
  "mcp-server-card",
  "mcp-server-identity",
  "mcp-tool-annotations",
  "mcp-tool-descriptions",
  "mcp-tool-listing",
  "mcp-tool-naming",
  "mcp-transport-modern",
  "mcp-view-csp",
  "mcp-view-domain",
  "mcp-well-known-discovery",
  "metadata-completeness",
  "modular-llms-txt",
  "mpp-support",
  "nlweb-ask",
  "nlweb-schema-feeds",
  "nlweb-streaming",
  "noindex-directives",
  "npm-sdk-package",
  "oauth-protected-resource",
  "oauth-support",
  "onboarding-friction",
  "openapi-spec",
  "org-schema-completeness",
  "page-token-budget",
  "pagination-shape",
  "pap-auth-config",
  "pap-cross-protocol",
  "pap-discovery",
  "pap-endpoint-enforcement",
  "pap-interfaces",
  "pap-issuer-binding",
  "pricing-info",
  "pricing-md",
  "public-api",
  "public-api-docs",
  "rate-limit-headers",
  "redirect-hygiene",
  "registry-branding",
  "response-schema-coverage",
  "rest-sdk-packages",
  "robots-agent-user-policy",
  "robots-ai-policy-quality",
  "sandbox-environment",
  "schema-type-breadth",
  "scoped-permissions",
  "sitemap",
  "sitemap-lastmod",
  "skills-sh-listed",
  "skills-sh-quality",
  "trust-anchors",
  "ucp-support",
  "web-bot-auth-directory",
  "webmcp",
  "wikipedia-presence",
  "x402-support",
];
