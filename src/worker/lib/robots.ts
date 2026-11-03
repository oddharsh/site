// RFC 9309 parsing and evaluation shared by Lens policy reports and every
// outbound AadharshBot request. crawl-delay is an extension: a positive value
// makes our unscheduled readers decline the origin rather than ignore its rate.

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[]; signal: string | null; crawlDelay: number };

export function lensParseRobots(txt) {
  const groups: RobotsGroup[] = [],
    sitemaps: string[] = [];
  let cur: RobotsGroup | null = null,
    inAgents = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!inAgents || !cur) {
        cur = { agents: [], rules: [], signal: null, crawlDelay: 0 };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (key === "sitemap") {
      sitemaps.push(val);
      continue;
    }
    if (!cur) continue;
    if (key === "allow" || key === "disallow") cur.rules.push({ allow: key === "allow", pattern: val });
    else if (key === "content-signal") cur.signal = val;
    else if (key === "crawl-delay" && /^\d+(?:\.\d+)?$/.test(val)) cur.crawlDelay = Math.max(cur.crawlDelay, Number(val));
  }
  return { groups, sitemaps };
}

// RFC 9309 evaluation for one bot: the group with the longest user-agent token
// that prefixes the bot's product token wins ('*' only as fallback), then the
// longest matching path rule; Allow beats Disallow on a length tie.
export function lensRobotsVerdict(parsed: ReturnType<typeof lensParseRobots>, botUa: string, path: string) {
  const token = botUa.toLowerCase();
  let bestUa: string | null = null;
  for (const g of parsed.groups)
    for (const ua of g.agents) {
      if (ua !== "*" && token.startsWith(ua) && (bestUa === null || ua.length > bestUa.length)) bestUa = ua;
    }
  const matchedUa = bestUa ?? (parsed.groups.some((g) => g.agents.includes("*")) ? "*" : null);
  if (matchedUa === null) return { verdict: "allow", matchedUa: null, rule: null, signal: null, crawlDelay: 0 };
  const chosen = parsed.groups.filter((g) => g.agents.includes(matchedUa));
  const target = robotsOctets(path);
  let best: RobotsRule | null = null;
  for (const g of chosen)
    for (const r of g.rules) {
      if (!r.pattern || !ruleMatcher(r)(target)) continue; // empty Disallow: = no rule at all
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
    }
  const signal = chosen.map((g) => g.signal).find(Boolean) || null;
  return {
    verdict: best && !best.allow ? "block" : "allow",
    matchedUa,
    rule: best ? (best.allow ? "Allow: " : "Disallow: ") + best.pattern : null,
    signal,
    crawlDelay: Math.max(0, ...chosen.map((g) => g.crawlDelay || 0)),
  };
}

function robotsOctets(value) {
  return value.replace(/%[0-9a-f]{2}|[^\p{ASCII}]/giu, (part) => {
    if (!part.startsWith("%")) return encodeURIComponent(part);
    const ascii = String.fromCharCode(parseInt(part.slice(1), 16));
    return /[a-z0-9._~-]/i.test(ascii) ? ascii : part.toUpperCase();
  });
}

// Compiled once per rule: a Lens scoreboard asks one parsed file about every
// bot in LENS_BOTS, and each bot that falls through to `*` re-asks the same
// rules. Measured 2026-11-03 under bun: 936 us per scoreboard against a 120-rule
// `*` group when every check compiled its pattern.
type PathMatcher = (octetPath: string) => boolean;
const RULE_MATCHERS = new WeakMap<RobotsRule, PathMatcher>();
function ruleMatcher(rule: RobotsRule): PathMatcher {
  let match = RULE_MATCHERS.get(rule);
  if (!match) RULE_MATCHERS.set(rule, (match = compilePattern(rule.pattern)));
  return match;
}

export function lensPathMatch(pattern, path) {
  return compilePattern(pattern)(robotsOctets(path));
}

function compilePattern(pattern: string): PathMatcher {
  pattern = robotsOctets(pattern);
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx =
    "^" +
    body
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*") +
    (anchored ? "$" : "");
  try {
    const re = new RegExp(rx);
    return (path) => re.test(path);
  } catch {
    const prefix = body.split("*")[0];
    return (path) => path.startsWith(prefix);
  }
}
