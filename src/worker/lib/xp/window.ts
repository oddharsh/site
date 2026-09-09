// Window is a fragment: document metadata, HTTP policy, and desktop navigation
// belong to the page assembler. Slots require the site's existing Html type.
import { EMPTY, Html, html } from "../html.ts";

export type WindowOptions = {
  caption: string;
  body?: Html;
  address?: Html;
  pane?: Html;
  titleClass?: string;
  windowClass?: string;
  contentClass?: string;
  windowAttrs?: Html;
  closeHref?: string;
  closeTitle?: string;
  closeLabel?: string;
};

/** Shared XP frame; native links remain usable before client enhancement. */
export function Window({
  caption,
  body = EMPTY,
  address = EMPTY,
  pane = EMPTY,
  titleClass = "",
  windowClass = "",
  contentClass = "",
  windowAttrs = EMPTY,
  closeHref = "/",
  closeTitle = "back to aadhar.sh",
  closeLabel = closeTitle,
}: WindowOptions): Html {
  return html`<div class="window${windowClass ? " " + windowClass : ""}"${windowAttrs === EMPTY ? EMPTY : html` ${windowAttrs}`}>
  <div class="title-bar">
    <span class="title-text${titleClass ? " " + titleClass : ""}"><span class="icon"></span>${caption}</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="${closeHref}" title="${closeTitle}" aria-label="${closeLabel}"></a></span>
  </div>${address}
  ${pane}<div class="content${contentClass ? " " + contentClass : ""}">
${body}
  </div>
</div>`;
}
