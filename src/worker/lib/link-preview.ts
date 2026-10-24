// A card for link-preview bots on a URL whose people get a redirect.
//
// The unlisted work-calendar slug on cal.aadhar.sh 302s to a Google appointment
// schedule. An unfurler follows that 302 too, and Google answers a signed-out
// fetcher with the Google Calendar marketing page, so every paste of the link
// previewed as "Google Calendar - Easier Time Management". Measured 2026-10-17
// with facebookexternalhit, Slackbot and Twitterbot UAs: all three landed there.
//
// So the bots on this list get a 200 carrying our own Open Graph tags, and
// everything else keeps the 302 untouched. Adding a hop for people (a meta
// refresh or a script redirect) would have bought the same card for the cost
// of a slower, script-dependent click, which is the trade this avoids.
//
// The list names PREVIEW fetchers only, by the token each one documents. Search
// and AI crawlers are left off on purpose: they get the redirect and the host's
// noindex, which is the right answer for an unlisted booking link. Each token
// is matched whole, so an in-app browser that carries the vendor's name (the
// "LinkedInApp", "Twitter for iPhone" and "FBAN" browsers) is still a person
// and still gets the redirect.
import { html, type Html } from "./html.ts";

const PREVIEW_BOT = new RegExp(
  "\\b(?:" +
    [
      "facebookexternalhit", // Facebook, Messenger, Instagram DMs; iMessage sends it too
      "Facebot",
      "Twitterbot", // X; iMessage's LinkPresentation UA also names it
      "Slackbot-LinkExpanding",
      "Discordbot",
      "TelegramBot",
      "WhatsApp", // WhatsApp, and Signal's preview fetcher borrows it
      "LinkedInBot",
      "SkypeUriPreview", // Teams and Skype
      "redditbot",
      "Cardyb", // Bluesky's card service
      "Mastodon", // every Mastodon server fetches its own previews
      "Embedly",
    ].join("|") +
    ")\\b",
);

export function isLinkPreviewBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && PREVIEW_BOT.test(userAgent);
}

export type PreviewCard = {
  title: string;
  description: string;
  /** The URL that was shared, so a bot that re-fetches og:url lands here again. */
  url: string;
  /** Site-relative, a JPEG or PNG in public/og/ (contract-og-images-resolve). */
  image: string;
  imageAlt: string;
  /** Where a person misread as a bot can go from here. A plain link, never a
   *  refresh: the point of this page is that nobody is redirected by it. */
  href: string;
};

export function previewCardHtml(card: PreviewCard): Html {
  const img = `https://aadhar.sh${card.image}`;
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${card.title}</title>
<meta name="description" content="${card.description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="aadhar.sh">
<meta property="og:title" content="${card.title}">
<meta property="og:description" content="${card.description}">
<meta property="og:url" content="${card.url}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${card.imageAlt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${img}">
</head>
<body>
<h1>${card.title}</h1>
<p>${card.description} <a href="${card.href}">Open the booking page</a>.</p>
</body>
</html>`;
}

// The card for the work-calendar slug. It borrows /coffee's card, the booking
// window on the Bliss desktop, because the slug has no page of its own to
// capture and the picture says "pick a time with Aadharsh" either way.
export const WORK_CALENDAR_CARD = {
  title: "Book time with Aadharsh",
  description: "Pick an open slot on Aadharsh Pannirselvam's calendar.",
  image: "/og/coffee.jpg",
  imageAlt: "A Windows XP window titled Let's grab coffee or a bagel, listing open time slots as buttons, on the Bliss desktop.",
} as const;
