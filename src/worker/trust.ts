import { lunaPage } from "./lib/chrome.ts";
import { html, type Html } from "./lib/html.ts";
import { missJson } from "./lib/not-found.ts";
import { LEAVES_OUT, OPENAPI_PATH, OPERATIONS, READ_POLICY, exampleUrl, operation } from "./lib/public-api.ts";
import { RATE_WINDOW_S, rateLimitPolicy } from "./lib/ratelimit.ts";
import { ASK_BUDGET } from "./ask-rank.ts";
import { LENS_BUDGETS } from "./lens-pipeline.ts";
import { RDAP_CACHE_TTL_S } from "./whoareyou.ts";
import { TTL_BOOKING_DAYS } from "../../cal/src/booking.ts";
import { UID_COOKIE, UID_COOKIE_MAX_AGE_S } from "../../serendipity/serendipity.ts";

export const CONTACT_EMAIL = "coffee@aadhar.sh";

function years(seconds: number): string {
  const n = seconds / (365 * 86400);
  const words = ["", "one year", "two years", "three years", "four years", "five years"];
  if (!Number.isInteger(n) || !words[n]) throw new Error(`trust: a cookie lifetime of ${seconds}s is not a whole number of years`);
  return words[n];
}

const CSS = `/*min*/
  h2 { font-family: var(--font-caption); font-size: var(--text-h2); color: var(--blue-40); margin: 16px 0 6px; font-weight: bold; line-height: 1.3; }
  h2::after { content: ""; display: block; height: 1px; background: var(--rule); margin-top: 8px; }
  a:link { color: var(--link); text-decoration: underline; } a:visited { color: var(--link-visited); } a:hover { color: var(--link-hover); }
  code { font-family: var(--font-mono); background: oklch(96.72% 0 0); border: 1px solid var(--grey-88); padding: 0 3px; }
  pre { font-family: var(--font-mono); font-size: var(--text-sm); background: oklch(96.72% 0 0); border: 1px solid var(--grey-88); padding: 6px 8px; overflow-x: auto; }
  pre code { border: 0; padding: 0; background: none; }
  .lede { color: var(--ink-soft); font-size: var(--text-body); margin: 0 0 12px; }
  dl.fields { display: grid; grid-template-columns: 11em 1fr; gap: 1px; margin: 4px 0 14px; background: oklch(85.04% 0.0283 248.16); border: 1px solid var(--frame); border-top-color: var(--blue-45); border-left-color: var(--blue-45); font-size: var(--text-ui); }
  dl.fields dt { background: var(--surface-desktop); color: var(--blue-40); font-weight: bold; padding: 4px 8px; }
  dl.fields dd { background: var(--window); margin: 0; padding: 4px 8px; word-break: break-word; }
  footer { text-align: center; font-size: var(--text-xs); color: var(--ink-quiet); margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--rule); }
`;

const MAIL = html`<!--email_off--><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><!--/email_off-->`;

const FOOTER = html`
    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot;
      <a href="/about">about</a> &middot;
      <a href="/contact">contact</a> &middot;
      <a href="/privacy">privacy</a> &middot;
      <a href="/developers">developers</a> &middot;
      &copy; 2026 Aadharsh Pannirselvam
    </footer>
`;

function page({ route, title, description, body }: { route: string; title: string; description: string; body: Html }) {
  return lunaPage({
    title: `${title} · aadhar.sh`,
    path: `aadhar.sh${route}`,
    route,
    explorerName: `aadhar.sh${route}`,
    width: 660,
    description,
    css: CSS,
    body: html`${body}${FOOTER}`,
    cache: "public, max-age=300, s-maxage=300",
  });
}

export function renderAboutPage() {
  return page({
    route: "/about",
    title: "About Aadharsh Pannirselvam",
    description: "Who runs aadhar.sh: Aadharsh Pannirselvam, researcher and investor at Archetype, and what the site holds.",
    body: html`
    <h1>About</h1>
    <p class="lede">
      I'm Aadharsh Pannirselvam. I research and invest at
      <a href="https://www.archetype.fund/" rel="external">Archetype</a>, a crypto-native
      venture firm, and I build this site by hand in the meantime.
    </p>

    <h2>Work</h2>
    <p>
      Most of my research time goes to cryptography and privacy-enhancing technology:
      fully homomorphic encryption, multi-party computation, trusted execution
      environments and zero-knowledge proofs. I studied at the University of Chicago.
      My resume is at <a href="/resume.pdf">/resume.pdf</a>, with the same content as
      Markdown at <a href="/resume.md">/resume.md</a> and as JSON Resume at
      <a href="/resume.json">/resume.json</a>.
    </p>

    <h2>This site</h2>
    <p>
      aadhar.sh is a personal site styled after Windows XP and Outlook Express,
      written by hand and served by a Cloudflare Worker. It holds:
    </p>
    <ul>
      <li><a href="/photos">/photos</a>: my photographs, each with its camera settings and film recipe.</li>
      <li><a href="/writing">/writing</a>: longform notes.</li>
      <li><a href="/lwe">/lwe</a>: explainers of applied cryptography, written as chats with live demos.</li>
      <li><a href="/garage">/garage</a>: experiments and measurements from building the site.</li>
      <li><a href="/lens">/lens</a>: a tool that shows how a machine reads any URL.</li>
      <li><a href="/serendipity">/serendipity</a>: a shared pool of events worth going to.</li>
    </ul>
    <p>
      Agents can read the whole map at <a href="/llms.txt">/llms.txt</a> and call the site
      from code through the endpoints on <a href="/developers">/developers</a>.
    </p>

    <h2>Elsewhere</h2>
    <p>
      These profiles are mine, and the homepage's schema.org <code>Person</code> lists the
      same set under <code>sameAs</code>:
      <a href="https://x.com/oddhash" rel="external me">X</a>,
      <a href="https://www.instagram.com/aadharsh.hif" rel="external me">Instagram</a>,
      <a href="https://github.com/oddharsh" rel="external me">GitHub</a>,
      <a href="https://www.linkedin.com/in/aadharsh-pannirselvam" rel="external me">LinkedIn</a>,
      <a href="https://farcaster.xyz/aadharsh" rel="external me">Farcaster</a>,
      <a href="https://curius.app/aadharsh-pannirselvam" rel="external me">Curius</a>,
      <a href="https://beliapp.com/users/aadharsh" rel="external me">Beli</a>,
      <a href="https://open.spotify.com/user/aadharsh2010" rel="external me">Spotify</a>
      and <a href="https://app.ens.domains/aadharsh.eth" rel="external me">aadharsh.eth</a>.
      To reach me, see <a href="/contact">/contact</a>.
    </p>
`,
  });
}

export function renderContactPage() {
  return page({
    route: "/contact",
    title: "Contact Aadharsh Pannirselvam",
    description: "How to reach Aadharsh Pannirselvam: email, a coffee in NYC, security reports, and the crawler's opt-out.",
    body: html`
    <h1>Contact</h1>
    <p class="lede">
      Email is the fastest way to reach me. I read it myself and reply by hand.
    </p>

    <dl class="fields">
      <dt>Email</dt><dd>${MAIL}</dd>
      <dt>Coffee in NYC</dt><dd><a href="/coffee">aadhar.sh/coffee</a></dd>
      <dt>Security reports</dt><dd><a href="/.well-known/security.txt">/.well-known/security.txt</a></dd>
      <dt>The crawler</dt><dd><a href="/bot">/bot</a></dd>
    </dl>

    <h2>Grab a coffee</h2>
    <p>
      If you're in New York and want to talk, pick a slot at <a href="/coffee">/coffee</a>
      or write to ${MAIL}. Each booking is a manual opt-in on my side, so I confirm it
      by hand. Open slots are also published as JSON at
      <a href="/coffee/availability.json">/coffee/availability.json</a>.
    </p>

    <h2>Report a security issue</h2>
    <p>
      The disclosure contacts and scope are in
      <a href="/.well-known/security.txt">/.well-known/security.txt</a> (RFC 9116), and
      <a href="/security">/security</a> describes the headers and policies this site sends.
      Please write before you publish anything.
    </p>

    <h2>If my crawler visited you</h2>
    <p>
      AadharshBot is this site's crawler. <a href="/bot">/bot</a> explains what it fetches,
      how to verify its signatures, and the one <code>robots.txt</code> line that stops it.
      Questions or complaints about it go to the same address, ${MAIL}.
    </p>

    <h2>Elsewhere</h2>
    <p>
      I'm <a href="https://x.com/oddhash" rel="external me">@oddhash</a> on X, and on
      <a href="https://www.linkedin.com/in/aadharsh-pannirselvam" rel="external me">LinkedIn</a>,
      <a href="https://github.com/oddharsh" rel="external me">GitHub</a> and
      <a href="https://farcaster.xyz/aadharsh" rel="external me">Farcaster</a>.
      <a href="/about">/about</a> has the rest.
    </p>
`,
  });
}

export const PRIVACY_REVIEWED = "2026-10-13";

export function renderPrivacyPage() {
  return page({
    route: "/privacy",
    title: "Privacy at aadhar.sh",
    description: "What a visit to aadhar.sh leaves behind, read from the site's code: logs, counters, the one cookie, and what happens to anything you send.",
    body: html`
    <h1>Privacy</h1>
    <p class="lede">
      What a visit to this site leaves behind, read from its code on ${PRIVACY_REVIEWED}.
      There are no ads, no analytics scripts and no third-party trackers, and nothing
      here is sold or shared for marketing.
    </p>

    <h2>Every request</h2>
    <p>
      When the site's Worker answers a request, it writes one log line: the path (without
      the query string), the method, the status, how long it took, the deployed version,
      your country, the HTTP protocol, the name of a verified bot when Cloudflare
      identified one, and the client name an MCP connection declares. It does not write
      your IP address, user agent or cookies. Static files served straight from
      Cloudflare's edge do not produce this line.
    </p>
    <p>
      The site runs on Cloudflare, with Workers Logs and Traces on for every request.
      Cloudflare's own records of a request can hold more than the line above, such as
      the full URL and your user agent. Workers Logs keep 3 days of history on this plan.
      Your IP address is also used, without being stored, to apply per-minute rate limits
      and to keep you on one deployed version during a release.
    </p>

    <h2>Counters</h2>
    <p>
      Three counters in Cloudflare Analytics Engine record no IP address and no user agent
      string: visits by identified AI crawlers (the crawler's name and the page path),
      pages that answered 404 (the path, and a coarse caller class such as
      <code>browser</code> or <code>http-tool</code>), and browser prefetches of a page
      (the path). <a href="/ledger">/ledger</a> publishes the first one. The homepage visit
      counter stores a single number.
    </p>

    <h2>Cookies and browser storage</h2>
    <p>
      The site sets one cookie, <code>${UID_COOKIE}</code>, and only on
      <a href="/serendipity">/serendipity</a> pages when you open an event or contribute
      one. It is a random id, <code>HttpOnly</code>, scoped to <code>/serendipity</code>,
      and lasts ${years(UID_COOKIE_MAX_AGE_S)}. Some pages keep your preferences in your browser's own storage
      (sound on or off, tooltips, the Lens view, quiz scores, scroll position). That never
      leaves your device. Pages load scripts, styles, fonts and images from this site
      only, so your browser talks to no third party while you read.
    </p>

    <h2>When you send something</h2>
    <ul>
      <li><strong>A coffee booking</strong> (<a href="/coffee">/coffee</a>): your name,
        email, topic, optional neighborhood and the slot. It is stored for ${TTL_BOOKING_DAYS} days after
        its last change and emailed, through Resend, to me and to you.</li>
      <li><strong>A webmention</strong>: the source and target URLs, the author's name and
        URL, the title and an excerpt. Cloudflare Workers AI checks it for spam, and it is
        emailed to me. It is deleted when I decline it or the source stops linking here.</li>
      <li><strong>A question</strong> to <a href="/ask">/ask</a> or an
        <a href="/lwe">/lwe</a> explainer: it goes to Cloudflare Workers AI through
        Cloudflare AI Gateway, which logs requests. Answers to explainer questions are
        cached for 24 hours.</li>
      <li><strong>A URL scanned with <a href="/lens">/lens</a></strong>: the target's host
        is recorded in traces, results are cached for up to 6 hours, and the Cloudflare
        readiness score sends the URL to isitagentready.com. In your browser, Lens frames
        the page you scanned, so that site sees your visit like any page you open.</li>
      <li><strong>A representation capture</strong> (an MCP tool): the URL and its
        normalized response headers, never the body, with no record of who asked.</li>
      <li><strong><a href="/whoareyou">/whoareyou</a></strong>: to name your network, the
        server sends your IP address to ARIN's public RDAP service, and Cloudflare caches
        that answer for ${RDAP_CACHE_TTL_S / 3600} hours.</li>
    </ul>

    <h2>Serendipity</h2>
    <p>
      <a href="/serendipity">/serendipity</a> is a pool of events and who is going. A
      person who contributes an event lends the site their Luma session, and the stored
      cookies are used to re-read that event's guest list every six hours. Contributors
      choose a label that is shown publicly. Guests' names, short bios, avatars and
      social handles from those Luma lists are shown on event pages, and their email
      addresses are stored but never shown. Code also exists to look up a guest's public
      profile through Exa or Parallel, and neither service is configured.
    </p>

    <h2>Removal and questions</h2>
    <p>
      To have a booking, a webmention, a contributed event or a guest listing removed,
      or to ask anything about this page, write to ${MAIL}.
    </p>
`,
  });
}

const QUICKSTART: readonly (readonly [operationId: string, lead: string])[] = [
  ["searchSite", "Search the site, then read the page you found as Markdown:"],
  ["askSite", "Ask a question in plain language (NLWeb), as one JSON body:"],
  ["inspectUrl", "See how a machine reads any public URL:"],
  ["queryPhotos", "Find a Fuji film recipe in the photo archive:"],
];
export const MARKDOWN_EXAMPLE = "/lwe/fhe";
const ERROR_EXAMPLE = missJson("https://aadhar.sh", "/no-such-endpoint.json", { section: null, pages: [] });

const curl = (path: string) => `curl 'https://aadhar.sh${path}'`;

export function renderDevelopersPage() {
  const quickstart = QUICKSTART.map(([id, lead], i) => {
    const lines = [curl(exampleUrl(operation(id)))];
    if (i === 0) lines.push(`curl -H 'Accept: text/markdown' https://aadhar.sh${MARKDOWN_EXAMPLE}`);
    return html`
    <p>${lead}</p>
    <pre><code>${lines.join("\n")}</code></pre>`;
  });
  const endpoints = OPERATIONS.map((op) => html`
      <li><a href="${exampleUrl(op)}">${op.method === "post" ? "POST " : ""}${op.path}</a> (<code>${op.operationId}</code>): ${op.summary}.</li>`);

  return page({
    route: "/developers",
    title: "aadhar.sh for developers: API, OpenAPI and MCP",
    description: "Call aadhar.sh from code: keyless JSON endpoints described in OpenAPI 3.1, an MCP server, Markdown twins, rate limits and the error shape.",
    body: html`
    <h1>Developers</h1>
    <p class="lede">
      Everything on aadhar.sh can be read from code. The endpoints are read-only, need no
      key or signup, and production is the sandbox: there is nothing to break.
    </p>

    <dl class="fields">
      <dt>OpenAPI 3.1</dt><dd><a href="${OPENAPI_PATH}">${OPENAPI_PATH}</a></dd>
      <dt>MCP server</dt><dd><a href="/mcp">https://aadhar.sh/mcp</a> (card: <a href="/.well-known/mcp/server-card.json">server-card.json</a>)</dd>
      <dt>API catalog</dt><dd><a href="/.well-known/api-catalog">/.well-known/api-catalog</a> (RFC 9727)</dd>
      <dt>Site map for agents</dt><dd><a href="/llms.txt">/llms.txt</a></dd>
      <dt>Authentication</dt><dd>none</dd>
    </dl>

    <h2>Quickstart</h2>${quickstart}

    <h2>Endpoints</h2>
    <ul>${endpoints}
    </ul>
    <p>
      Every operation in <a href="${OPENAPI_PATH}">${OPENAPI_PATH}</a> has an
      <code>operationId</code>, typed parameters and a response schema, so a client can
      turn it into function-calling tools directly. The <a href="/mcp">MCP server</a>
      exposes the same capabilities as tools.
    </p>

    <h2>Limits</h2>
    <p>
      The endpoints share a read budget of ${READ_POLICY[1]} requests a minute per caller,
      named on each answer as <code>RateLimit-Policy: ${rateLimitPolicy(...READ_POLICY)}</code>.
      The Lens doors have tighter budgets of their own instead: inspections are limited to ${LENS_BUDGETS.inspect.max} a minute per caller, shared
      with the MCP server, and comparisons to ${LENS_BUDGETS.compare.max} a minute. Each
      answer names its quota in a <code>RateLimit-Policy</code> header
      (<code>${rateLimitPolicy("inspect", LENS_BUDGETS.inspect.max)}</code>). Over any limit, an
      endpoint answers <code>429</code> with <code>Retry-After: ${RATE_WINDOW_S}</code> and a
      <code>RateLimit</code> header showing nothing left, the fields
      <a href="https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/">the IETF
      RateLimit draft</a> defines. <code>/ask</code> ranks ${ASK_BUDGET.max} questions
      a minute per caller with its model, then falls back to lexical ranking and says so in
      <code>_meta.ranking</code> instead of refusing. Please cache what you read; most
      endpoints send a <code>Cache-Control</code> that says for how long.
    </p>

    <h2>Errors</h2>
    <p>
      Errors are JSON with at least an <code>error</code> sentence, and most add a
      <code>code</code> token. A path that does not exist answers <code>404</code> in the
      format you ask for: JSON for <code>Accept: application/json</code>, Markdown for
      <code>Accept: text/markdown</code>, with the closest real pages. A path that looks
      like an API call (ending in <code>.json</code>, or under <code>/api/</code> or
      <code>/v1/</code>) answers JSON unless you ask for HTML. A method an endpoint does
      not serve answers <code>405</code> in the same shape, with an <code>Allow</code>
      header. This is the body the site sends for <code>/no-such-endpoint.json</code>:
    </p>
    <pre><code>${JSON.stringify(ERROR_EXAMPLE, null, 2)}</code></pre>

    <h2 id="leaves-out">What this API leaves out</h2>
    <p>
      A public API usually carries the machinery below. This one skips each piece on
      purpose, for the reason beside it, so a readiness audit that marks one missing is
      reading a decision this site already made.
    </p>
    <dl class="fields">${LEAVES_OUT.map(({ what, why }) => html`
      <dt>${what}</dt><dd>${why}</dd>`)}
    </dl>

    <h2>Pages as Markdown</h2>
    <p>
      Most pages answer <code>Accept: text/markdown</code> at their own URL, and static
      documents also have a <code>.md</code> twin (<code>/garage/encoding</code> becomes
      <code>/garage/encoding.md</code>). <a href="/llms.txt">/llms.txt</a> maps the site,
      and <a href="/llms-full.txt">/llms-full.txt</a> inlines it.
    </p>

    <h2>Questions</h2>
    <p>
      Write to ${MAIL}. How the site treats what you send is on
      <a href="/privacy">/privacy</a>.
    </p>
`,
  });
}
