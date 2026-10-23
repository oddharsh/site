// ── link-preview bots get a card where people get a redirect ─────────────────
// The work-calendar slug on cal.aadhar.sh 302s to Google, and Google answers a
// signed-out unfurler with its marketing page, so the link previewed as "Google
// Calendar - Easier Time Management" (measured 2026-10-17). lib/link-preview.ts
// hands preview bots a 200 with our own tags instead. What this pins:
//   - the bot list matches real preview UAs and NOT the in-app browsers that
//     carry the same vendor's name, which are people and need the redirect;
//   - the card is a card: absolute image, large summary, no refresh, no script;
//   - routeCalHost asks before it redirects, inside the slug branch only;
//   - /coffee carries the same card image, and the file exists.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isLinkPreviewBot, previewCardHtml, WORK_CALENDAR_CARD } from "../src/worker/lib/link-preview.ts";
import { bookingPage } from "../cal/src/templates.ts";
import { siteConfig } from "./lib/site-config.ts";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

// Each as the fetcher sends it, not trimmed to the token.
const BOTS = {
  iMessage:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  x: "Twitterbot/1.0",
  slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  discord: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  telegram: "TelegramBot (like TwitterBot)",
  whatsapp: "WhatsApp/2.24.6.77 A",
  linkedin: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  teams: "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
  bluesky: "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
  mastodon: "http.rb/5.1.1 (Mastodon/4.3.0; +https://mastodon.social/) Bot",
};
const PEOPLE = {
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  // in-app browsers that name the vendor whose preview bot is on the list
  facebookApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/1;FBDV/iPhone16,1]",
  linkedinApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.0",
  telegramApp: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 Telegram-Android/11.0.0",
  // crawlers: they keep the redirect and the host's noindex
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
};

test("every preview fetcher is a bot, and every person is not", () => {
  for (const [name, ua] of Object.entries(BOTS)) assert.ok(isLinkPreviewBot(ua), `${name} should get the card`);
  for (const [name, ua] of Object.entries(PEOPLE)) assert.ok(!isLinkPreviewBot(ua), `${name} should get the redirect`);
  assert.ok(!isLinkPreviewBot(null) && !isLinkPreviewBot(""), "no UA is a person");
});

test("the card is a card and redirects nobody", () => {
  const html = previewCardHtml({ ...WORK_CALENDAR_CARD, url: "https://cal.aadhar.sh/x", href: "https://calendar.google.com/a?b=1&c=2" }).html;
  assert.match(html, /<meta property="og:image" content="https:\/\/aadhar\.sh\/og\/coffee\.jpg">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/cal\.aadhar\.sh\/x">/);
  assert.ok(html.includes('href="https://calendar.google.com/a?b=1&amp;c=2"'), "the fallback link is escaped");
  assert.doesNotMatch(html, /http-equiv|<script/i, "a refresh or a script would be the redirect this exists to avoid");
  assert.ok(existsSync(new URL(`public${WORK_CALENDAR_CARD.image}`, ROOT)), `${WORK_CALENDAR_CARD.image} is missing`);
});

test("routeCalHost asks before it redirects, and only for the slug", () => {
  const src = read("src/worker/index.ts");
  const fn = src.slice(src.indexOf("async function routeCalHost("), src.indexOf("function noStoreRedirect("));
  const slug = fn.slice(fn.indexOf("WORK_CALENDAR_SLUG"), fn.indexOf("routeCoffee("));
  const ask = slug.indexOf("isLinkPreviewBot(");
  assert.ok(ask > 0, "the slug branch no longer checks for a preview bot");
  assert.ok(ask < slug.indexOf("return noStoreRedirect("), "the check has to come before the redirect");
  assert.equal(fn.split("isLinkPreviewBot(").length, 2, "the bare host and /coffee paths keep their own behavior");
});

test("/coffee carries the card the slug borrows", async () => {
  const env = { ...(await siteConfig()).vars, BASE_PATH: "/coffee" };
  const page = bookingPage(env);
  const images = [...page.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="https:\/\/aadhar\.sh(\/og\/[^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(images, ["/og/coffee.jpg", "/og/coffee.jpg"]);
  assert.equal(images[0], WORK_CALENDAR_CARD.image);
});
