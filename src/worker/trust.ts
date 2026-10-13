// trust.ts: /about, /contact, /privacy and /developers.
//
// The four pages an agent (or a person) checks before trusting a site: who runs
// it, how to reach them, what a visit leaves behind, and how to call it from
// code. Each is a fixed document, rendered at deploy by build.ts beside
// /bot.html and served through serveBuiltPage, with a hand-authored Markdown
// twin in src/content/md/ that gen-md-twins.ts TWIN_FACTS holds to the facts
// below.
//
// Nothing here is runtime state, so every renderer takes no arguments (the
// deploy-time renderer contract). A claim on /privacy names the module that
// makes it true, so a reader of this file can check it the same way.
import { lunaPage } from "./lib/chrome.ts";
import { html, type Html } from "./lib/html.ts";

export const CONTACT_EMAIL = "coffee@aadhar.sh";

// The /bot page's document style, shared by all four. Tokens only.
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
    // the address bar names the object, as /bot's does; <title> keeps the
    // descriptive name for search results and bookmarks
    explorerName: `aadhar.sh${route}`,
    width: 660,
    description,
    css: CSS,
    body: html`${body}${FOOTER}`,
    cache: "public, max-age=300, s-maxage=300",
  });
}

// ── /about ───────────────────────────────────────────────────────────────────
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

// ── /contact ─────────────────────────────────────────────────────────────────
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

// ── /privacy ─────────────────────────────────────────────────────────────────
// Read from the code on 2026-10-13. Each paragraph names what it describes so
// it can be re-checked: dispatch.ts serveWorkerRequest (the log line),
// cloudflare.config.ts observability, ledger.ts / lib/not-found.ts /
// speculation.ts (Analytics Engine), serendipity/serendipity.ts (the one
// cookie, contributor cookies, attendees), cal/src/booking.ts (90-day
// bookings), webmention.ts, ask-rank.ts and lwe-ask (AI Gateway),
// whoareyou.ts (RDAP), lens.ts (isitagentready, KV caches), representation.ts.
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
      The site sets one cookie, <code>serendipity-uid</code>, and only on
      <a href="/serendipity">/serendipity</a> pages when you open an event or contribute
      one. It is a random id, <code>HttpOnly</code>, scoped to <code>/serendipity</code>,
      and lasts two years. Some pages keep your preferences in your browser's own storage
      (sound on or off, tooltips, the Lens view, quiz scores, scroll position). That never
      leaves your device. Pages load scripts, styles, fonts and images from this site
      only, so your browser talks to no third party while you read.
    </p>

    <h2>When you send something</h2>
    <ul>
      <li><strong>A coffee booking</strong> (<a href="/coffee">/coffee</a>): your name,
        email, topic, optional neighborhood and the slot. It is stored for 90 days after
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
        that answer for 24 hours.</li>
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

// ── /developers ──────────────────────────────────────────────────────────────
// The rate limits quoted here are the code's: lens-pipeline.ts LENS_RL_INSPECT
// (30/min) and LENS_RL_COMPARE (4/min), ask-rank.ts ASK_BUDGET (20/min, after
// which ranking falls back to lexical rather than refusing).
export function renderDevelopersPage() {
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
      <dt>OpenAPI 3.1</dt><dd><a href="/openapi.json">/openapi.json</a></dd>
      <dt>MCP server</dt><dd><a href="/mcp">https://aadhar.sh/mcp</a> (card: <a href="/.well-known/mcp/server-card.json">server-card.json</a>)</dd>
      <dt>API catalog</dt><dd><a href="/.well-known/api-catalog">/.well-known/api-catalog</a> (RFC 9727)</dd>
      <dt>Site map for agents</dt><dd><a href="/llms.txt">/llms.txt</a></dd>
      <dt>Authentication</dt><dd>none</dd>
    </dl>

    <h2>Quickstart</h2>
    <p>Search the site, then read the page you found as Markdown:</p>
    <pre><code>curl 'https://aadhar.sh/search.json?q=fhe&amp;limit=3'
curl -H 'Accept: text/markdown' https://aadhar.sh/lwe/fhe</code></pre>
    <p>Ask a question in plain language (NLWeb), as one JSON body:</p>
    <pre><code>curl 'https://aadhar.sh/ask?query=how+does+the+site+sign+requests&amp;streaming=0'</code></pre>
    <p>See how a machine reads any public URL:</p>
    <pre><code>curl 'https://aadhar.sh/lens/fetch?url=example.com'</code></pre>
    <p>Find a Fuji film recipe in the photo archive:</p>
    <pre><code>curl 'https://aadhar.sh/photos/query.json?recipe=DR400&amp;limit=5'</code></pre>

    <h2>Endpoints</h2>
    <ul>
      <li><a href="/search.json?q=agents">/search.json</a>: lexical search over every public page.</li>
      <li><a href="/ask?query=what+is+this+site&amp;streaming=0">/ask</a>: NLWeb natural-language search, ranked by a model, with extractive answers.</li>
      <li><a href="/photos/query.json?limit=5">/photos/query.json</a> and <a href="/images/manifest.json">/images/manifest.json</a>: the photo archive, its EXIF and recipes.</li>
      <li><a href="/lens/fetch?url=example.com">/lens/fetch</a>, <a href="/lens/compare.json?left=example.com&amp;right=aadhar.sh">/lens/compare.json</a> and <a href="/lens/census.json">/lens/census.json</a>: agent readiness for any URL, and a weekly census.</li>
      <li><a href="/rn/tracks">/rn/tracks</a>: the playlist playing right now.</li>
      <li><a href="/around/json">/around/json</a> and <a href="/around/changes.json">/around/changes.json</a>: a crawled neighborhood of venture firm homepages.</li>
      <li><a href="/coffee/availability.json">/coffee/availability.json</a>: open coffee slots in New York.</li>
      <li><a href="/ledger.json">/ledger.json</a> and <a href="/resume.json">/resume.json</a>: the AI-crawler ledger and a JSON Resume.</li>
    </ul>
    <p>
      Every operation in <a href="/openapi.json">/openapi.json</a> has an
      <code>operationId</code>, typed parameters and a response schema, so a client can
      turn it into function-calling tools directly. The <a href="/mcp">MCP server</a>
      exposes the same capabilities as tools.
    </p>

    <h2>Limits</h2>
    <p>
      Lens inspections are limited to 30 a minute per caller, shared with the MCP server,
      and comparisons to 4 a minute. Over the limit, those answer <code>429</code>.
      <code>/ask</code> ranks 20 questions a minute per caller with its model, then falls
      back to lexical ranking and says so in <code>_meta.ranking</code> instead of
      refusing. Please cache what you read; most endpoints send a
      <code>Cache-Control</code> that says for how long.
    </p>

    <h2>Errors</h2>
    <p>
      Errors are JSON with at least an <code>error</code> sentence, and most add a
      <code>code</code> token. A path that does not exist answers <code>404</code> in the
      format you ask for: JSON for <code>Accept: application/json</code>, Markdown for
      <code>Accept: text/markdown</code>, with the closest real pages.
    </p>
    <pre><code>{
  "ok": false,
  "error": "/no-such-endpoint.json is not a page or endpoint on aadhar.sh.",
  "code": "not_found",
  "status": 404,
  "hint": "Every page is listed in /sitemap.xml, and every JSON endpoint in /openapi.json.",
  "docs": "https://aadhar.sh/developers"
}</code></pre>

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
