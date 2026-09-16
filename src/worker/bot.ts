// bot.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { serveMarkdownTwin } from "./lib/assets.ts";
import { BOT_NAME, BOT_UA, SIG_AGENT } from "./lib/botauth.ts";
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { esc, wantsMarkdown } from "./lib/http.ts";

// ── /bot info page ──────────────────────────────────────────────────
// static shell: ride the caches.default layer like the other rendered pages;
// edge TTL = the s-maxage in the render, version-keyed so a deploy busts it.
export async function handleBotPage(request, env, ctx) {
  // This is the page a stranger reads after finding AadharshBot in their logs,
  // and that stranger is increasingly an agent. Answer in Markdown when asked;
  // /bot.md is the stable, cacheable URL for the same bytes. The twin is
  // hand-authored (src/content/md/bot.md) because this page renders from a template
  // literal, and build.ts fails the deploy if it drifts from the constants here.
  if (wantsMarkdown(request)) {
    const md = await serveMarkdownTwin(request, env, "/bot.md");
    if (md) return md;
  }
  return cachedRender(request, ctx, () => Promise.resolve(renderBotPage()), "/bot", env);
}

export function renderBotPage() {
  const css = `/*min*/
  h1 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 14pt; color: var(--blue-40); margin: 0 0 4px; font-weight: bold; }
  h2 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 12pt; color: var(--blue-40); margin: 16px 0 6px; font-weight: bold; line-height: 1.3; }
  h2::after { content: ""; display: block; height: 1px; background: oklch(86.67% 0.0294 259.59); margin-top: 8px; }
  a:link { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; } a:visited { color: oklch(42.09% 0.1935 328.36); } a:hover { color: oklch(62.80% 0.2577 29.23); }
  code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; }
  .lede { color: var(--ink-soft); font-size: 10.5pt; margin: 0 0 12px; }
  dl.fields { display: grid; grid-template-columns: 11em 1fr; gap: 1px; margin: 4px 0 14px; background: oklch(85.04% 0.0283 248.16); border: 1px solid var(--frame); border-top-color: var(--blue-45); border-left-color: var(--blue-45); font-size: 10pt; }
  dl.fields dt { background: var(--surface-desktop); color: var(--blue-40); font-weight: bold; padding: 4px 8px; }
  dl.fields dd { background: oklch(100.00% 0 0); margin: 0; padding: 4px 8px; font-family: "Courier New", Courier, monospace; font-size: 9.5pt; word-break: break-all; }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 16px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
`;
  const body = `
    <h1>${BOT_NAME}</h1>
    <p class="lede">
      A small, transparent crawler operated by <a href="/">aadhar.sh</a>. If you see it
      in your access logs, this page tells you who it is, what it does, and how to
      stop it from visiting if you don't want it to.
    </p>

    <h2>Identity</h2>
    <dl class="fields">
      <dt>User-Agent</dt><dd>${esc(BOT_UA)}</dd>
      <dt>Signature-Agent</dt><dd>${esc(SIG_AGENT)}</dd>
      <dt>JWKS</dt><dd><a href="/.well-known/http-message-signatures-directory">/.well-known/http-message-signatures-directory</a></dd>
      <dt>Algorithm</dt><dd>sig1: Ed25519 (EdDSA), per RFC 9421 + Web Bot Auth draft</dd>
      <dt>Operator</dt><dd><!--email_off--><a href="mailto:coffee@aadhar.sh">coffee@aadhar.sh</a><!--/email_off--></dd>
    </dl>

    <h2>What it does</h2>
    <p>
      This is Aadharsh Pannirselvam's bot for <a href="/">aadhar.sh</a>, running on
      Cloudflare Workers. The <a href="/around">/around</a> dashboard checks a small
      list of public homepages daily. The music and reading sections fetch public
      playlist metadata and bookmarks. <a href="/lens">/lens</a> fetches public pages
      and discovery documents when a visitor asks to inspect a URL, and can read
      published MCP tool catalogues and NLWeb answers.
    </p>
    <p>
      Content is used for linked references, metadata, and on-demand inspection.
      It is not used to train or fine-tune AI models or build a search index.
      Requests use bounded fan-outs and cached results. The bot does not log in
      to third-party sites or read content behind a login.
    </p>
    <p>
      Lens also compares responses to sample browser and crawler User-Agent
      strings. Those diagnostic requests do not claim a Web Bot Auth identity
      for the sampled bot, and still obey AadharshBot's robots.txt policy.
    </p>

    <h2>How to verify it's really ${BOT_NAME}</h2>
    <p>
      Requests made as AadharshBot include <code>Signature-Agent</code>, <code>Signature-Input</code>,
      and <code>Signature</code> headers per
      <a href="https://www.rfc-editor.org/rfc/rfc9421" target="_blank" rel="noopener">RFC 9421</a>
      with the Web Bot Auth profile (<code>tag="web-bot-auth"</code>). Fetch the JWKS
      at the URL above, find the key with the matching <code>kid</code> (its RFC 7638 thumbprint), and verify the
      Ed25519 signature over the canonical components listed in <code>Signature-Input</code>.
      If the verification fails, the request is not from this site.
    </p>

    <h2>The second signature, retired</h2>
    <p>
      Between 2026-07-27 and 2026-08-15 every request carried a second label,
      <code>sig2</code>, a post-quantum
      <a href="https://csrc.nist.gov/pubs/fips/204/final" target="_blank" rel="noopener">ML-DSA-44</a>
      signature over the same covered components. It is gone, and its public key has been
      removed from the JWKS, so a request from this bot now carries <code>sig1</code> alone.
    </p>
    <p>
      It was removed for its CPU cost. Cloudflare's runtime has no ML-DSA in WebCrypto, so
      signing ran in pure JavaScript at roughly 8.5ms per request, against a 10ms
      per-invocation budget. One signature spent most of a request, and anything that fans
      out spent several requests' worth: the playlist scrape signs once per track, and the
      <a href="/lens">/lens</a> discovery pass signs 28 probes. Both were failing because of it.
      Nothing on the internet verified <code>sig2</code>, so dropping it costs no verifier
      anything. <a href="/garage/pqc">/garage/pqc</a> has the measurements and the full argument.
    </p>

    <h2>How to opt out</h2>
    <p>Add to your <code>robots.txt</code>:</p>
    <pre><code>User-agent: ${BOT_NAME}
Disallow: /</code></pre>
    <p>
      Before fetching third-party content, ${BOT_NAME} reads that origin's
      <code>robots.txt</code> (cached for up to 12 hours). It skips paths disallowed
      for <code>${BOT_NAME}</code> or <code>*</code>, including redirect destinations.
      If the policy is unreachable, rate-limited, or too large to read safely,
      the fetch is skipped. A positive <code>Crawl-delay</code> also makes this bot
      skip the origin. These rules apply to scheduled crawls and visitor-requested
      Lens HTTP reads. If you have a question or a complaint, email
      <!--email_off--><a href="mailto:coffee@aadhar.sh">coffee@aadhar.sh</a><!--/email_off--> and I'll reply by hand.
    </p>

    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot;
      see it in action: <a href="/around">/around</a> &middot;
      &copy; 2026 Aadharsh Pannirselvam
    </footer>
`;

  return lunaPage({
    title: "aadhar.sh/bot",
    path: BOT_NAME,
    route: "/bot",
    width: 660,
    description: "Identity and behavior of AadharshBot, the crawler operated by aadhar.sh.",
    css,
    body: unsafeHtml(body),
    cache: "public, max-age=300, s-maxage=300",
  });
}
