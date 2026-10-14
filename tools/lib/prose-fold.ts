// prose-fold.ts — fold a long essay's later sections below the first screen.

export const FOLD_AFTER_CHARS = 3000;
export const FOLD_EVERY_CHARS = 4000;
export const SHELF_RUN_CHARS = 1500;
const SHELF = ".content.prose > ul.shelf";
const STARTS = ".content.prose > h2, .content.prose > section.demo, .content.prose > ul.shelf.cont";
export const PX_PER_CHAR = 0.6;

function splitShelf(html: string): string {
  if (html.includes("shelf cont")) return html;
  const items: number[] = [];
  let lists = 0;
  new HTMLRewriter()
    .on(SHELF, { element() { lists++; } })
    .on(`${SHELF} > li`, { element() { items.push(0); }, text(t) { items[items.length - 1] += t.text.replace(/\s+/g, " ").length; } })
    .transform(html);
  if (lists !== 1) return html;
  const cuts: number[] = [];
  for (let i = 0, run = 0, count = 0; i < items.length - 1; i++) {
    run += items[i]; count++;
    if (run >= SHELF_RUN_CHARS && count % 2 === 0) { cuts.push(i + 1); run = 0; count = 0; }
  }
  if (!cuts.length) return html;
  let attrs = "", i = -1;
  return new HTMLRewriter()
    .on(SHELF, {
      element(e) {
        attrs = [...e.attributes].filter(([n]) => n !== "class").map(([n, v]) => ` ${n}="${v.replace(/"/g, "&quot;")}"`).join("");
        e.setAttribute("class", `${e.getAttribute("class")} open`);
      },
    })
    .on(`${SHELF} > li`, {
      element(e) {
        i++;
        if (!cuts.includes(i)) return;
        const open = i === cuts[cuts.length - 1] ? "" : " open";
        e.before(`</ul><ul class="shelf${open} cont"${attrs}>`, { html: true });
      },
    })
    .transform(html);
}

type Plan = { starts: number[]; sizes: number[] };

function plan(html: string): Plan | null {
  let text = 0, hidden = 0, sawProse = false;
  const at: { h2: boolean; chars: number }[] = [];
  new HTMLRewriter()
    .on(".content.prose", { element() { sawProse = true; }, text(t) { text += t.text.length; } })
    .on(".content.prose script, .content.prose style, .content.prose template", { text(t) { hidden += t.text.length; } })
    .on(SHELF, { text(t) { hidden += t.text.length - t.text.replace(/\s+/g, " ").length; } })
    .on(STARTS, { element(e) { at.push({ h2: e.tagName === "h2", chars: text - hidden }); } })
    .transform(html);
  if (!sawProse) return null;
  const total = text - hidden;
  const starts: number[] = [];
  for (let i = 0; i < at.length; i++) {
    if (at[i].chars < FOLD_AFTER_CHARS) continue;
    const last = starts.length ? at[starts[starts.length - 1]].chars : -Infinity;
    if (!starts.length || at[i].h2 || at[i].chars - last >= FOLD_EVERY_CHARS) starts.push(i);
  }
  if (!starts.length) return null;
  const sizes = starts.map((i, k) => (k + 1 < starts.length ? at[starts[k + 1]].chars : total) - at[i].chars);
  return { starts, sizes };
}

export function foldLongProse(html: string): string {
  if (html.includes('class="fold"')) return html;
  html = splitShelf(html);
  const p = plan(html);
  if (!p) return html;
  const open = (k: number) =>
    `<section class="fold" style="contain-intrinsic-block-size:auto ${Math.max(200, Math.round(p.sizes[k] * PX_PER_CHAR))}px">`;
  let i = -1, k = 0;
  return new HTMLRewriter()
    .on(STARTS, {
      element(e) {
        i++;
        if (i !== p.starts[k]) return;
        e.before((k > 0 ? "</section>" : "") + open(k), { html: true });
        k++;
      },
    })
    .on(".content.prose", {
      element(e) {
        e.onEndTag((end) => { if (k > 0) end.before("</section>", { html: true }); });
      },
    })
    .transform(html);
}
