// lib/robots.js — RFC 9309 robots.txt parsing + evaluation. Two callers, two
// meanings: /lens RENDERS the verdict (policy, observed), /around OBEYS it
// (policy, enforced on ourselves). /bot promises the second one, so this has to
// be a real evaluator, not a display helper. Extracted verbatim from lens.js.

export function lensParseRobots(txt) {
  const groups = [], sitemaps = [];
  let cur = null, inAgents = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!inAgents) { cur = { agents: [], rules: [], signal: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (key === "sitemap") { sitemaps.push(val); continue; }
    if (!cur) continue;
    if (key === "allow" || key === "disallow") cur.rules.push({ allow: key === "allow", pattern: val });
    else if (key === "content-signal") cur.signal = val;
  }
  return { groups, sitemaps };
}

// RFC 9309 evaluation for one bot: the group with the longest user-agent token
// that prefixes the bot's product token wins ('*' only as fallback), then the
// longest matching path rule; Allow beats Disallow on a length tie.
export function lensRobotsVerdict(parsed, botUa, path) {
  const token = botUa.toLowerCase();
  let bestUa = null;
  for (const g of parsed.groups) for (const ua of g.agents) {
    if (ua !== "*" && token.startsWith(ua) && (bestUa === null || ua.length > bestUa.length)) bestUa = ua;
  }
  const matchedUa = bestUa ?? (parsed.groups.some((g) => g.agents.includes("*")) ? "*" : null);
  if (matchedUa === null) return { verdict: "allow", matchedUa: null, rule: null, signal: null };
  const chosen = parsed.groups.filter((g) => g.agents.includes(matchedUa));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!r.pattern || !lensPathMatch(r.pattern, path)) continue; // empty Disallow: = no rule at all
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  const signal = chosen.map((g) => g.signal).find(Boolean) || null;
  return {
    verdict: best && !best.allow ? "block" : "allow",
    matchedUa,
    rule: best ? (best.allow ? "Allow: " : "Disallow: ") + best.pattern : null,
    signal,
  };
}

// robots path patterns: '*' is a wildcard, a trailing '$' anchors the end.
export function lensPathMatch(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = "^" + body.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  try { return new RegExp(rx).test(path); } catch { return path.startsWith(body.split("*")[0]); }
}
