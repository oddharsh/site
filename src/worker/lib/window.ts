// lib/window.ts — the XP window's title bar, written ONCE (#1026).
//
// Every document on the site draws the same strip: Back/Forward, the section
// icon and caption, then the three caption buttons. It used to be written in 45
// places, lunaPage plus 44 hand copies in src/pages, and the copies drifted (on
// 2026-09-29: four markup variants for one control, and two pages hiding their
// focusable Back/Forward from assistive tech). Now there is one function:
//
//   | caller                         | how it gets the bytes                  |
//   |--------------------------------|----------------------------------------|
//   | lunaPage (lib/chrome.ts)       | calls titleBar() per request or build  |
//   | serendipity's shell            | calls titleBar()                       |
//   | the 44 static pages            | gen:shell writes titleBar() into the   |
//   |                                | source between axp:window markers      |
//   | pipelines/{garage,lwe}         | call titleBar() when scaffolding       |
//
// The static pages carry the OUTPUT rather than a marker the build expands,
// because `bun run dev` serves source bytes with no build: a marker-only page
// would paint without a title bar there. build.ts's shell freshness check fails
// any page whose bar no longer equals this function's output, so the copies
// are generated rather than trusted.
//
// Only the caption, its class, the icon class, the close target and the
// histnav opt-out vary. Everything else (the icon hidden, .min hidden, .max a
// labelled button) is fixed on purpose: those are the accessibility contract
// contract-histnav-ships-in-the-html asserts, and a field for them is how the
// drift came back.
import { EMPTY, Html, html } from "./html.ts";

// The same bytes as desktop.ts's DESKTOP_HISTNAV, written as an `html` literal
// rather than spliced through the unescaped door, whose use count
// (config/unsafe-html-baseline.json) may only go down. It has no interpolation,
// so it is Html by construction, and contract-histnav-ships-in-the-html holds
// the two copies byte-equal.
export const HISTNAV = html`<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button><button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>`;

export type TitleBarOptions = {
  // Text is escaped; an Html caption (a static page's `&middot;`) passes through.
  caption: string | Html;
  titleClass?: string;
  // A page-specific icon (dotfiles, gpt56), styled by that page's own CSS.
  iconClass?: string;
  // false for a window carrying data-no-histnav, which nav.js leaves unwired.
  histnav?: boolean;
  closeHref: string;
  closeTitle: string;
  closeLabel?: string;
  // The indent of the line the bar opens on. Continuation lines sit two deeper.
  indent?: string;
};

export function titleBar({
  caption,
  titleClass = "",
  iconClass = "",
  histnav = true,
  closeHref,
  closeTitle,
  closeLabel = closeTitle,
  indent = "  ",
}: TitleBarOptions): Html {
  const textClass = titleClass ? ` ${titleClass}` : "";
  const icon = iconClass ? ` ${iconClass}` : "";
  return html`<div class="title-bar">${histnav ? HISTNAV : EMPTY}
${indent}  <span class="title-text${textClass}"><span class="icon${icon}" aria-hidden="true"></span>${caption}</span>
${indent}  <span class="controls"><span class="min" aria-hidden="true"></span><button type="button" class="max" title="maximize" aria-label="maximize"></button><a class="close" href="${closeHref}" title="${closeTitle}" aria-label="${closeLabel}"></a></span>
${indent}</div>`;
}
