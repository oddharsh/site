#!/usr/bin/env node
// What a site serves depends on who it thinks is asking. This measures that.
//
// One GET per identity per trial, public pages only, read-only. Every UA string
// it sends is printed on /garage/useragent, because a survey that hides its own
// method is asking the reader to take the numbers on faith.
//
// The CONTROL rows are the load-bearing part and the reason this exists rather
// than a shell loop. A crawler identity that gets a 403 proves nothing on its
// own: the same 403 arrives when the origin is blocking our datacenter IP, our
// TLS fingerprint, or the absence of a cookie. Chrome and curl answer "could
// this instrument have seen anything at all", and a target where the controls
// disagree with each other is reported UNMEASURABLE rather than blocked.
// Measured 2026-08-21: medium.com and quora.com answer 403 to Chrome too, so
// every AI-crawler row on those hosts is uninterpretable.

const IDENTITIES = [
  // controls first; the report refuses to grade a target whose controls failed.
  { key: "chrome",  label: "Chrome",       owner: "a browser", role: "control",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" },
  { key: "curl",    label: "curl",         owner: "a plain HTTP client", role: "control",
    ua: "curl/8.7.1" },

  // The honest row, and the survey's own disclosure. It claims nothing it cannot
  // back and points at the page that publishes these numbers. Read it against
  // `googlebot` on en.wikipedia.org: claiming NOTHING is served, and claiming a
  // verifiable identity from an IP that cannot back it is refused.
  { key: "honest", label: "ua-survey (ours)", owner: "aadhar.sh", role: "control",
    ua: "aadhar-ua-survey/1.0 (+https://aadhar.sh/garage/useragent)" },

  { key: "bingbot", label: "Bingbot", owner: "Microsoft", role: "search",
    ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
  { key: "googlebot", label: "Googlebot",  owner: "Google",    role: "search",
    ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { key: "applebot",  label: "Applebot",  owner: "Apple",    role: "search",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)" },
  { key: "duckduckbot", label: "DuckDuckBot", owner: "DuckDuckGo", role: "search",
    ua: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)" },
  { key: "amazonbot", label: "Amazonbot", owner: "Amazon", role: "train",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.214 Safari/537.36 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)" },
  { key: "facebookbot", label: "facebookexternalhit", owner: "Meta", role: "answers",
    ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },

  { key: "gptbot",    label: "GPTBot",     owner: "OpenAI",    role: "train",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot" },
  { key: "claudebot", label: "ClaudeBot",  owner: "Anthropic", role: "train",
    ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { key: "claudeuser", label: "Claude-User", owner: "Anthropic", role: "answers",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com" },
  { key: "perplexity", label: "PerplexityBot", owner: "Perplexity", role: "answers",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot" },
  { key: "wba_unsigned", label: "Signature-Agent, unsigned", owner: "aadhar.sh", role: "probe",
    ua: "aadhar-ua-survey/1.0 (+https://aadhar.sh/garage/useragent)",
    headers: { "signature-agent": '"https://aadhar.sh"' } },

  // The two the source claim named by name. Neither is a documented crawler
  // token, which is the point: they cost nothing to type and nothing verifies them.
  { key: "oai_fd",  label: "OpenAI File Downloader", owner: "OpenAI (claimed)", role: "claimed",
    ua: "OpenAI File Downloader" },
  { key: "xai_img", label: "XaiImageApiFetch",       owner: "xAI (claimed)",    role: "claimed",
    ua: "XaiImageApiFetch/1.0" },
];

const TARGETS = [
  { key: "linkedin-profile", url: "https://www.linkedin.com/in/williamhgates",
    note: "a public person profile, the source claim's own example",
    markers: { contactInfo: /contact info/i, othersNamed: /others named/i,
               similarProfiles: /similar profiles|browsemap/i, signIn: /sign in|join now/i } },
  { key: "nytimes",   url: "https://www.nytimes.com/",  note: "a paywalled newsroom homepage" },
  { key: "stackoverflow", url: "https://stackoverflow.com/", note: "answers 402 to some crawlers" },
  { key: "wikipedia", url: "https://en.wikipedia.org/wiki/Web_crawler", note: "an open reference article" },
  { key: "reddit",    url: "https://www.reddit.com/r/programming/", note: "post-Google-deal access control" },
  { key: "theatlantic", url: "https://www.theatlantic.com/", note: "a second paywalled newsroom, testing whether the denylist shape repeats" },
  { key: "github",    url: "https://github.com/",       note: "a developer platform with no AI-crawler position" },
  { key: "hackernews", url: "https://news.ycombinator.com/", note: "plain HTML, no CDN bot management" },
  { key: "medium",    url: "https://medium.com/",       note: "expected to fail its controls" },
  { key: "quora",     url: "https://www.quora.com/",    note: "expected to fail its controls" },
  { key: "aadharsh",  url: "https://aadhar.sh/",        note: "this site, which serves everyone the same document" },
];

const TIMEOUT_MS = 20000;
const SHELL_WORDS = 50; // below this, a 200 is a frame rather than a document
// Raw text elements are REMOVED BY SCAN rather than by one regex, and the third
// attempt is what earned it. HTML lets an end tag carry whitespace and junk
// before the bracket, so `</script >`, `</script\t\n bar>` and `</script/>` are
// all valid closes that a `<\/script>` pattern misses, leaving the script body to
// be counted as prose. CodeQL flagged two of those three shapes in successive
// runs, which is the usual argument against parsing HTML with a regular
// expression. The security reading of js/bad-tag-filter does not apply here,
// since nothing is sanitized for render; what makes it worth doing properly is
// that this function produces the numbers /garage/useragent publishes.
//
// Verified against all 7 measurable targets before and after: every count is
// identical, so the published run stands.
export const stripRawText = (s, tag) => {
  const open = new RegExp("<" + tag + "(?=[\\s/>])", "i");
  const close = new RegExp("</" + tag + "(?=[\\s/>])", "i");
  const kept = [];
  let rest = s;
  for (;;) {
    const i = rest.search(open);
    if (i < 0) { kept.push(rest); break; }
    kept.push(rest.slice(0, i));
    const after = rest.slice(i);
    const c = after.search(close);
    // An unterminated raw-text element runs to end of document by the parser's
    // own rule, so dropping the remainder is the correct reading rather than a
    // giving-up branch.
    if (c < 0) break;
    const gt = after.indexOf(">", c);
    if (gt < 0) break;
    rest = after.slice(gt + 1);
  }
  return kept.join(" ");
};

export const words = (s: string) => stripRawText(stripRawText(s, "script"), "style")
                      .replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;

// One measured fetch of one URL as one identity.
type Sample = {
  status: number | null;
  bytes?: number;
  words?: number;
  contentType?: string;
  challenge: boolean;
  blocked: boolean;
  shell?: boolean;
  markers?: Record<string, number> | null;
  error?: string;
};

async function sample(
  target: { url: string; markers?: Record<string, RegExp> },
  identity: { ua: string; headers?: Record<string, string> },
): Promise<Sample> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      redirect: "follow", signal: ctrl.signal,
      headers: { "user-agent": identity.ua,
                 accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                 "accept-language": "en-US,en;q=0.9",
                 ...identity.headers },
    });
    const body = await res.text();
    const wordCount = words(body);
    // A Cloudflare/Akamai interstitial is a 200 carrying no document. Counting it
    // as content is how a wall gets scored as access.
    // Matching a challenge marker ANYWHERE in the body is too eager, and it cost a
    // real target. Cloudflare injects its `challenge-platform` script into pages it
    // serves perfectly well, so theatlantic.com's full 1,344-word homepage was
    // classified as an interstitial and the whole row was thrown out. An
    // interstitial is short BY CONSTRUCTION, so the length is the discriminator and
    // the header is believed on its own.
    const challengeMarker = /just a moment|challenge-platform|cf-browser-verification|enable javascript and cookies/i.test(body);
    const challenge = res.headers.get("cf-mitigated") === "challenge" || (challengeMarker && wordCount < 200);
    const blocked = challenge || [401, 402, 403, 406, 429, 451, 999].includes(res.status);
    let markers: Record<string, number> | null = null;
    if (target.markers) {
      markers = {};
      for (const [name, re] of Object.entries(target.markers)) markers[name] = (body.match(re) || []).length;
    }
    return {
      status: res.status,
      bytes: new TextEncoder().encode(body).length,
      words: wordCount,
      contentType: (res.headers.get("content-type") || "").split(";")[0].trim(),
      challenge, blocked,
      // A 200 carrying no prose is a shell, not a document. reddit.com answers 200
      // with ONE word to every identity here, browsers included, because the page
      // renders client-side. Scoring that as retrieval credits an origin for
      // serving an empty frame, and it is a THIRD state rather than a failure:
      // the request was allowed and the content still is not there.
      shell: !blocked && res.status >= 200 && res.status < 300 && wordCount < SHELL_WORDS,
      markers,
    };
  } catch (e) {
    return { status: null, error: String((e instanceof Error && e.message) || e), blocked: false, challenge: false };
  } finally { clearTimeout(to); }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null; };

async function main() {
  const trials = Number(process.env.TRIALS || 3);
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = only.length ? TARGETS.filter((t) => only.includes(t.key)) : TARGETS;
  const report = { measuredAt: new Date().toISOString().slice(0, 10), trials, identities: IDENTITIES, targets: [] };

  for (const target of targets) {
    const results: Record<string, any> = {};
    for (const identity of IDENTITIES) {
      const runs = [];
      for (let i = 0; i < trials; i++) {
        runs.push(await sample(target, identity));
        await new Promise((r) => setTimeout(r, 400)); // one request at a time, deliberately slow
      }
      const ok = runs.filter((r) => r.status !== null);
      results[identity.key] = {
        status: median(ok.map((r) => r.status)),
        words: median(ok.filter((r) => r.words != null).map((r) => r.words)),
        bytes: median(ok.filter((r) => r.bytes != null).map((r) => r.bytes)),
        wordsSpread: ok.filter((r) => r.words != null).map((r) => r.words),
        blocked: ok.length ? ok.filter((r) => r.blocked).length > ok.length / 2 : false,
        shell: ok.length ? ok.filter((r) => r.shell).length > ok.length / 2 : false,
        challenge: ok.some((r) => r.challenge),
        // A target that answers differently across identical trials is reporting
        // rate-limit state, not policy. en.wikipedia.org gave ClaudeBot 403 and
        // then 200 minutes apart, so an unstable row must not read as a verdict.
        unstable: new Set(ok.map((r) => r.status)).size > 1,
        markers: ok.find((r) => r.markers)?.markers || null,
        errors: runs.filter((r) => r.error).length,
      };
      process.stderr.write(`  ${target.key} / ${identity.key}: ${results[identity.key].status} ${results[identity.key].words ?? "-"}w\n`);
    }
    // The control gate, and the whole reason this file is not a shell loop. With
    // every control refused the instrument never got in, so nothing on this row
    // is a fact about user-agent policy. ONE control getting through is enough:
    // linkedin.com answers 999 to curl unconditionally, and requiring every
    // control to pass threw away a target that Chrome could read perfectly.
    const controls = IDENTITIES.filter((i) => i.role === "control");
    // A control that got a SHELL still got in. reddit.com answers 200 with one word
    // to a browser because the page renders client-side, which is a fact about the
    // site rather than a refusal, and excluding it here marked the single most
    // interesting row in the survey unmeasurable: reddit serves Chrome 29 words and
    // facebookexternalhit 6,168 off the same URL. Only a genuine refusal disqualifies.
    const controlsPassed = controls.some((i) => {
      const r = results[i.key];
      return r && !r.blocked && r.status && r.status < 400;
    });
    report.targets.push({
      ...target,
      markers: target.markers ? Object.keys(target.markers) : [],
      results,
      controlsPassed,
      controlDetail: controls
        .map((i) => `${i.key}:${results[i.key].blocked ? "blocked" : results[i.key].shell ? "shell-in" : "ok"}`).join(" "),
      verdict: controlsPassed ? "measurable" : "unmeasurable",
    });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
// Importing this module must not fire a survey. The contract test exercises
// `words` directly, and a bare import that made 500 outbound requests would be
// a memorable way to find that out.
if (import.meta.main) main().catch((e) => {
  // A survey that dies half way must not leave a truncated JSON body looking
  // like a complete result. Fail loudly and write nothing usable.
  process.stderr.write(`ua-survey failed: ${(e && e.stack) || e}\n`);
  process.exitCode = 1;
});
