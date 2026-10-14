import { EMPTY, Html, html } from "./html.ts";

export const HISTNAV = html`<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button><button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>`;

export type TitleBarOptions = {
  caption: string | Html;
  titleClass?: string;
  iconClass?: string;
  histnav?: boolean;
  closeHref: string;
  closeTitle: string;
  closeLabel?: string;
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
