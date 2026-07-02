// around.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_NAME, BOT_UA, SIG_AGENT, signedFetch } from "./lib/botauth.js";
import { deleteSWRKV, swrKV } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, extractMeta, extractTitle } from "./lib/http.js";

  // Signature-Agent value (RFC 8941 string)

// the neighborhood — crypto-VC homepages worth checking in on. just funds
// whose work i follow; the dashboard is mostly an excuse to point a branded
// crawler at something interesting.
export const NEIGHBORS = [
  { name: "Paradigm",                url: "https://www.paradigm.xyz/" },
  { name: "a16z crypto",             url: "https://a16zcrypto.com/" },
  { name: "Polychain Capital",       url: "https://polychain.capital/" },
  { name: "Multicoin Capital",       url: "https://multicoin.capital/" },
  { name: "Variant Fund",            url: "https://variant.fund/" },
  { name: "Dragonfly",               url: "https://www.dragonfly.xyz/" },
  { name: "Electric Capital",        url: "https://www.electriccapital.com/" },
  { name: "1confirmation",           url: "https://1confirmation.com/" },
  { name: "Standard Crypto",         url: "https://standardcrypto.vc/" },
  { name: "Union Square Ventures",   url: "https://www.usv.com/" },
  { name: "Archetype",               url: "https://www.archetype.fund/" },
  { name: "Pace Capital",            url: "https://pacecapital.com/" },
  { name: "Thrive Capital",          url: "https://thrivecap.com/" },
  { name: "Sequoia Capital",         url: "https://www.sequoiacap.com/" },
  { name: "Founders Fund",           url: "https://foundersfund.com/" },
  { name: "Hummingbird",             url: "https://www.hummingbird.vc/" },
  { name: "Benchmark",               url: "https://www.benchmark.com/" },
  { name: "Index Ventures",          url: "https://www.indexventures.com/" },
  { name: "Ribbit Capital",          url: "https://ribbitcap.com/" },
  { name: "Topology",                url: "https://www.topology.vc/" },
];

// ── /around ─────────────────────────────────────────────────────────
// what's going on in the crypto-VC neighborhood. each homepage fetched live
// by AadharshBot (or served from a 1hr KV cache). curious, not competitive.
export async function handleAround(request, env, ctx) {
  const report = await getOrBuildAroundReport(request, env, ctx);
  return renderAroundHtml(report);
}

export async function handleAroundJson(request, env, ctx) {
  const report = await getOrBuildAroundReport(request, env, ctx);
  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag":  "noindex",
    },
  });
}

const AROUND_KEY = "around:report";

export async function getOrBuildAroundReport(request, env, ctx) {
  const url = new URL(request.url);

  // optional bust for force-refresh
  if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {
    await deleteSWRKV(env, AROUND_KEY);
  }

  // two-key stale-while-revalidate via lib/cache.js. The report persists in KV,
  // a tiny sentinel carries the 1h freshness window, and lapsed reports rebuild in
  // the background so nobody waits on the 20-neighbor crawl except a true first run.
  return swrKV(env, ctx, AROUND_KEY, 3600, () => runAround(env), {
    isValid: (r) => r && Array.isArray(r.results),
    shouldStore: (r) => r && Array.isArray(r.results) && r.results.length > 0,
  });
}

export async function runAround(env) {
  const results = await Promise.all(NEIGHBORS.map(async ({ name, url }) => {
    const t0 = Date.now();
    try {
      // bound each neighbor to 4s (connect + TTFB + the 200KB body read).
      // signedFetch forwards opts.signal (botauth.js:45); on timeout it aborts
      // into the catch below as an {error} row instead of a hung neighbor
      // stalling the whole Promise.all. body cap alone (200KB) didn't bound
      // a slow/tar-pit connection.
      const res = await signedFetch(url, env, { signal: AbortSignal.timeout(4000) });
      // some sites return 100MB+ — cap the body we read.
      const reader = res.body?.getReader();
      let body = "";
      let received = 0;
      const CAP = 200 * 1024;  // 200 KB plenty for <head>
      if (reader) {
        const dec = new TextDecoder();
        while (received < CAP) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          body += dec.decode(value, { stream: true });
        }
        try { await reader.cancel(); } catch {}
      }
      const elapsed = Date.now() - t0;
      return {
        name, url,
        status:        res.status,
        title:         extractTitle(body),
        description:   extractMeta(body, "description") || extractMeta(body, "og:description") || "",
        ogImage:       extractMeta(body, "og:image") || "",
        server:        res.headers.get("server") || "",
        lastModified:  res.headers.get("last-modified") || "",
        contentType:   res.headers.get("content-type") || "",
        elapsedMs:     elapsed,
      };
    } catch (e) {
      return { name, url, error: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }
  }));
  // sort fastest → slowest; errors (no latency or huge values) fall to the
  // bottom so the table reads as a leaderboard.
  results.sort((a, b) => {
    const an = a.error ? Infinity : (a.elapsedMs ?? Infinity);
    const bn = b.error ? Infinity : (b.elapsedMs ?? Infinity);
    return an - bn;
  });
  return {
    crawledBy: BOT_UA,
    crawledAt: new Date().toISOString(),
    signedWith: SIG_AGENT,
    count:     results.length,
    results,
  };
}

export function renderAroundHtml(report) {
  const rows = report.results.map((r, i) => {
    const ok = !r.error && r.status >= 200 && r.status < 400;
    const status = r.error
      ? `<span class="bad">error</span>`
      : ok
        ? `<span class="ok">${r.status}</span>`
        : `<span class="warn">${r.status}</span>`;
    const titleCol = r.error ? esc(r.error) : (esc(r.title) || "<span class=dim>—</span>");
    const desc = r.description ? `<div class="desc">${esc(r.description)}</div>` : "";
    return `
      <tr>
        <td class="firm">${esc(r.name)}<div class="host">${esc(new URL(r.url).host)}</div></td>
        <td class="status">${status}</td>
        <td class="title">${titleCol}${desc}</td>
        <td class="latency">${r.elapsedMs}ms</td>
        <td class="link"><a href="${esc(r.url)}" target="_blank" rel="noopener">↗</a></td>
      </tr>`;
  }).join("");

  return lunaPage({
    title: "aadhar.sh/around",
    path: "aadhar.sh/around",
    width: 820,
    description: "Snapshot of crypto VC homepages I keep tabs on, crawled live by AadharshBot.",
    robots: "noindex",
    css: `
  h1 {
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; color: oklch(41.92% 0.0962 250.51);
    font-size: 18pt; margin: 0 0 4px; font-weight: bold;
  }
  .lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
  .lede code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; font-size: 10pt; }
  table.scout {
    width: 100%; border-collapse: collapse; margin: 8px 0 12px;
    border: 1px solid oklch(61.14% 0.0611 253.60); border-top-color: oklch(47.12% 0.0555 253.58); border-left-color: oklch(47.12% 0.0555 253.58);
    background: oklch(100.00% 0 0); font-size: 10pt;
  }
  table.scout thead th {
    background: oklch(94.66% 0.0114 252.09); color: oklch(41.92% 0.0962 250.51); font-weight: bold;
    padding: 5px 8px; text-align: left;
    border-bottom: 1px solid oklch(61.14% 0.0611 253.60);
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  }
  table.scout tbody td { padding: 6px 8px; border-bottom: 1px solid oklch(92.73% 0.0139 247.98); vertical-align: top; }
  table.scout tbody tr:nth-child(even) td { background: oklch(97.50% 0.0062 255.47); }
  table.scout .firm { font-weight: bold; color: oklch(41.92% 0.0962 250.51); width: 22%; }
  table.scout .host { font-family: "Courier New", Courier, monospace; color: oklch(62.68% 0 0); font-size: 9pt; font-weight: normal; }
  table.scout .status { font-family: "Courier New", Courier, monospace; width: 8%; text-align: center; }
  table.scout .ok   { color: oklch(49.32% 0.1678 142.50); font-weight: bold; }
  table.scout .warn { color: oklch(54.44% 0.1504 47.10); font-weight: bold; }
  table.scout .bad  { color: oklch(46.34% 0.1902 29.23); font-weight: bold; }
  table.scout .title { color: oklch(21.78% 0 0); }
  table.scout .desc { color: oklch(51.03% 0 0); font-size: 9.5pt; margin-top: 3px; }
  table.scout .latency { font-family: "Courier New", Courier, monospace; color: oklch(38.67% 0 0); width: 9%; text-align: right; }
  table.scout .link { width: 5%; text-align: center; }
  table.scout .link a { color: oklch(42.61% 0.2353 263.74); text-decoration: none; font-weight: bold; }
  table.scout .link a:hover { color: oklch(62.80% 0.2577 29.23); text-decoration: underline; }
  .meta {
    font-size: 9.5pt; color: oklch(51.03% 0 0);
    border: 1px solid oklch(61.14% 0.0611 253.60); background: oklch(98.81% 0.0263 99.90);
    padding: 6px 10px; margin: 12px 0;
  }
  .meta code { font-family: "Courier New", Courier, monospace; background: oklch(100.00% 0 0); border: 1px solid oklch(89.75% 0 0); padding: 0 3px; }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 14px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
  a { color: oklch(42.61% 0.2353 263.74); }
  .dim { color: oklch(62.68% 0 0); }
  hr { border: 0; border-top: 2px groove oklch(86.67% 0.0294 259.59); margin: 12px 0; height: 0; }
`,
    body: `
    <h1>Around the Neighborhood</h1>
    <p class="lede">
      A peek at what folks in crypto VC are up to. <code>${esc(BOT_UA)}</code>, the
      small branded crawler I run from this site, fetches each homepage live and
      lays it out as a tiny neighborhood window. I built this mostly to play with
      signed outbound requests per
      <a href="https://datatracker.ietf.org/wg/webbotauth/about/" target="_blank" rel="noopener">Web Bot Auth</a>;
      the shortlist is funds whose work I follow. Receiving sites can
      verify the signatures against
      <a href="/.well-known/http-message-signatures-directory">our JWKS</a>.
    </p>
    <div class="meta">
      <strong>Last crawl:</strong> ${esc(report.crawledAt)} &middot;
      <strong>UA:</strong> <code>${esc(BOT_UA)}</code> &middot;
      <strong>Signature-Agent:</strong> <code>${esc(SIG_AGENT)}</code> &middot;
      <strong>Cache:</strong> 1 hour
    </div>
    <table class="scout">
      <thead>
        <tr><th>Firm</th><th>Status</th><th>Title / description</th><th>Latency</th><th>↗</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <hr>
    <p class="dim" style="font-size:9pt">
      Also available as JSON: <a href="/around/json">/around/json</a>.
      Bot methodology and ethics: <a href="/bot">/bot</a>.
    </p>
    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot; crawled by <a href="/bot">${esc(BOT_NAME)}</a>
    </footer>
`,
    cache: "public, max-age=60, s-maxage=300",
    headers: { "x-robots-tag": "noindex" },
  });
}
