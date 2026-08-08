// bot.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { serveMarkdownTwin } from "./lib/assets.js";
import { BOT_NAME, BOT_UA, SIG_AGENT } from "./lib/botauth.js";
import { cachedRender } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, wantsMarkdown } from "./lib/http.js";

// ── /bot info page ──────────────────────────────────────────────────
// static shell: ride the caches.default layer like the other rendered pages;
// edge TTL = the s-maxage in the render, version-keyed so a deploy busts it.
export async function handleBotPage(request, env, ctx) {
  // This is the page a stranger reads after finding AadharshBot in their logs,
  // and that stranger is increasingly an agent. Answer in Markdown when asked;
  // /bot.md is the stable, cacheable URL for the same bytes. The twin is
  // hand-authored (holding/md/bot.md) because this page renders from a template
  // literal, and build.mjs fails the deploy if it drifts from the constants here.
  if (wantsMarkdown(request)) {
    const md = await serveMarkdownTwin(request, env, "/bot.md");
    if (md) return md;
  }
  return cachedRender(request, ctx, () => Promise.resolve(renderBotPage()), "/bot", env);
}

export function renderBotPage() {
  const css = `/*min*/
  h1 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 14pt; color: oklch(41.92% 0.0962 250.51); margin: 0 0 4px; font-weight: bold; }
  h2 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 12pt; color: oklch(41.92% 0.0962 250.51); margin: 16px 0 6px; font-weight: bold; line-height: 1.3; }
  h2::after { content: ""; display: block; height: 1px; background: oklch(86.67% 0.0294 259.59); margin-top: 8px; }
  a:link { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; } a:visited { color: oklch(42.09% 0.1935 328.36); } a:hover { color: oklch(62.80% 0.2577 29.23); }
  code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; }
  .lede { color: oklch(38.67% 0 0); font-size: 10.5pt; margin: 0 0 12px; }
  dl.fields { display: grid; grid-template-columns: 11em 1fr; gap: 1px; margin: 4px 0 14px; background: oklch(85.04% 0.0283 248.16); border: 1px solid oklch(61.14% 0.0611 253.60); border-top-color: oklch(47.12% 0.0555 253.58); border-left-color: oklch(47.12% 0.0555 253.58); font-size: 10pt; }
  dl.fields dt { background: oklch(94.66% 0.0114 252.09); color: oklch(41.92% 0.0962 250.51); font-weight: bold; padding: 4px 8px; }
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
      <dt></dt><dd>sig2: ML-DSA-44 (FIPS 204), provisional. See below.</dd>
      <dt>Operator</dt><dd><!--email_off--><a href="mailto:coffee@aadhar.sh">coffee@aadhar.sh</a><!--/email_off--></dd>
    </dl>

    <h2>What it does</h2>
    <p>
      It fetches small numbers of public homepages on demand, mostly because I'm
      curious. The <a href="/around">/around</a> dashboard shows what it
      currently looks at.
      It reads only what's publicly served. It respects <code>robots.txt</code>. It does not
      submit forms, log in, or scrape behind a login. It caches results in
      Cloudflare KV for at least an hour so it doesn't re-hit the same URL repeatedly.
    </p>

    <h2>How to verify it's really ${BOT_NAME}</h2>
    <p>
      Every request includes <code>Signature-Agent</code>, <code>Signature-Input</code>,
      and <code>Signature</code> headers per
      <a href="https://www.rfc-editor.org/rfc/rfc9421" target="_blank" rel="noopener">RFC 9421</a>
      with the Web Bot Auth profile (<code>tag="web-bot-auth"</code>). Fetch the JWKS
      at the URL above, find the key with the matching <code>kid</code>, and verify the
      Ed25519 signature over the canonical components listed in <code>Signature-Input</code>.
      If the verification fails, the request is not from this site.
    </p>

    <h2>The second signature</h2>
    <p>
      Both header fields are structured-fields Dictionaries, so every request carries
      two labels over the same covered components: <code>sig1</code> is the Ed25519
      signature described above, and <code>sig2</code> is a post-quantum
      <a href="https://csrc.nist.gov/pubs/fips/204/final" target="_blank" rel="noopener">ML-DSA-44</a>
      signature. The public key is the <code>AKP</code> entry in the same JWKS, formatted per
      <a href="https://www.rfc-editor.org/rfc/rfc9964.html" target="_blank" rel="noopener">RFC 9964</a>.
    </p>
    <p>
      <strong>Verify <code>sig1</code>, not <code>sig2</code>.</strong> The
      <a href="https://www.iana.org/assignments/http-message-signature/http-message-signature.xhtml" target="_blank" rel="noopener">IANA
      HTTP Signature Algorithms registry</a> holds six entries and none of them are
      post-quantum, so <code>alg="ml-dsa-44"</code> is this site's spelling rather than a
      registered codepoint. It is here because the migration is cheap now and awkward
      later, and because a running example is worth more than a writeup. Treat it as
      provisional: if a real registration lands with a different token, this one changes.
      Ignoring <code>sig2</code> entirely costs you nothing, which is the point.
      <a href="/garage/pqc">/garage/pqc</a> has the measurements and the reasoning.
    </p>

    <h2>How to opt out</h2>
    <p>Add to your <code>robots.txt</code>:</p>
    <pre><code>User-agent: ${BOT_NAME}
Disallow: /</code></pre>
    <p>
      Before the <a href="/around">/around</a> crawl fetches a site, ${BOT_NAME}
      reads that site's <code>robots.txt</code> (cached briefly per origin) and skips
      any path <code>Disallow</code>ed for <code>${BOT_NAME}</code> or <code>*</code>;
      a site whose <code>robots.txt</code> it can't read is skipped that cycle, not
      crawled. If you have a question or a complaint, email
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
    body,
    cache: "public, max-age=300, s-maxage=300",
  });
}
