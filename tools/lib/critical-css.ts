// The rules of luna.css a page can use at first paint, derived from the page
// itself, so a page can load luna.css without blocking first paint and nobody
// hand-keeps a second copy of it (the homepage's inline block is that copy).
//
// The subset is luna.css with rules dropped and nothing else changed: same
// order, same bytes per rule. It goes where the page's luna <link> was, and
// luna.css still loads right after it. So once luna applies, every declaration
// that wins is the one that won without the subset: a kept rule ties its own
// copy in luna, and luna comes later. That is the parity argument, and it
// holds only while luna has no @layer (a subset could reorder layers), which
// criticalCss refuses.
//
// A rule is kept unless no selector in it can match the page. Matching is
// Bun's HTMLRewriter on the selector with every pseudo-class and pseudo-element
// stripped, which can only widen a match. A selector HTMLRewriter cannot parse
// (`+`, `~`, a dangling combinator once a pseudo is stripped) is kept. Extra
// rules cost bytes; a missing one costs a shift when luna lands, never parity.

type Block = { prelude: string; body: string; nested: boolean };

// Split minified CSS into top-level blocks. Strings are skipped so a brace in
// a data URI or a content: value cannot end a block early.
function blocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < css.length) {
    const start = i;
    let depth = 0;
    let open = -1;
    for (; i < css.length; i++) {
      const c = css[i];
      if (c === '"' || c === "'") {
        const end = css.indexOf(c, i + 1);
        if (end < 0) throw new Error(`critical-css: unterminated string at ${i}`);
        i = end;
      } else if (c === "{") {
        if (depth++ === 0) open = i;
      } else if (c === "}") {
        if (--depth === 0) break;
      } else if (c === ";" && depth === 0) {
        break;
      }
    }
    if (open < 0) {
      // a statement at-rule (@charset, @import): keep it as written
      const text = css.slice(start, i + 1).trim();
      if (text) out.push({ prelude: text, body: "", nested: false });
    } else {
      const prelude = css.slice(start, open).trim();
      out.push({ prelude, body: css.slice(open + 1, i), nested: /^@(media|supports|starting-style|container|layer)\b/.test(prelude) });
    }
    i++;
  }
  return out;
}

// drop every :pseudo and ::pseudo, with its argument list
function stripPseudos(selector: string): string {
  let out = "";
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "[") {
      const end = selector.indexOf("]", i);
      out += selector.slice(i, end + 1);
      i = end;
    } else if (c === ":") {
      let j = i + 1;
      if (selector[j] === ":") j++;
      while (j < selector.length && /[\w-]/.test(selector[j])) j++;
      if (selector[j] === "(") {
        let depth = 0;
        for (; j < selector.length; j++) {
          if (selector[j] === "(") depth++;
          else if (selector[j] === ")" && --depth === 0) break;
        }
        j++;
      }
      i = j - 1;
    } else out += c;
  }
  return out.trim();
}

// split a selector list on top-level commas
function selectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(from, i));
      from = i + 1;
    }
  }
  out.push(prelude.slice(from));
  return out.map((s) => s.trim());
}

/** The selectors (pseudo-stripped) that match an element in `html`, plus the
 *  ones HTMLRewriter cannot evaluate, which count as matching. */
async function matching(html: string, selectors: Set<string>): Promise<Set<string>> {
  const hit = new Set<string>();
  const rewriter = new HTMLRewriter();
  for (const sel of selectors) {
    if (!sel) {
      hit.add(sel); // a bare pseudo (:root, ::selection): applies to the page
      continue;
    }
    try {
      rewriter.on(sel, { element: () => void hit.add(sel) });
    } catch {
      hit.add(sel);
    }
  }
  await rewriter.transform(new Response(html)).text();
  return hit;
}

// Elements a page's scripts build (nav.js mounts the resize grip, the clock and
// the accessory windows) are not in the HTML, so the HTMLRewriter pass cannot see
// them, and a dropped rule for one lays it out in flow until luna lands. A
// selector also counts as matching when every class and id it names occurs as a
// word in those scripts.
const words = (text: string) => new Set(text.match(/[\w-]+/g));
const namedInScripts = (selector: string, scriptWords: Set<string>) => {
  const names = selector.match(/[.#][\w-]+/g);
  return !!names && names.every((n) => scriptWords.has(n.slice(1)));
};

/** luna.css (minified) cut down to the rules that can apply to `html` and to
 *  what `scripts` (the JS that page runs) can add to it. */
export async function criticalCss(luna: string, html: string, scripts: string[] = []): Promise<string> {
  const scriptWords = words(scripts.join("\n"));
  if (/@layer\b/.test(luna)) throw new Error("critical-css: luna.css uses @layer, and a subset could reorder layers; the parity argument no longer holds");

  const all = new Set<string>();
  const collect = (css: string) => {
    for (const b of blocks(css)) {
      if (b.nested) collect(b.body);
      else if (!b.prelude.startsWith("@")) for (const s of selectorList(b.prelude)) all.add(stripPseudos(s));
    }
  };
  luna = luna.replace(/\/\*[\s\S]*?\*\//g, ""); // comments, the deploy banner included, stay in luna.css
  collect(luna);
  const hit = await matching(html, all);

  const keep = (css: string): string =>
    blocks(css)
      .map((b) => {
        if (b.prelude.endsWith(";")) return b.prelude; // a statement at-rule
        if (b.nested) {
          const inner = keep(b.body);
          return inner ? `${b.prelude}{${inner}}` : "";
        }
        if (b.prelude.startsWith("@")) return `${b.prelude}{${b.body}}`; // @property and the like
        return selectorList(b.prelude).some((s) => hit.has(stripPseudos(s)) || namedInScripts(stripPseudos(s), scriptWords)) ? `${b.prelude}{${b.body}}` : "";
      })
      .join("");
  return keep(luna);
}

// Every style rule with the at-rule preludes around it, in source order. Two
// stylesheets compare rule for rule this way even when a subset drops part of
// an @media block.
function flatRules(css: string, context = ""): string[] {
  return blocks(css.replace(/\/\*[\s\S]*?\*\//g, "")).flatMap((b) =>
    b.nested ? flatRules(b.body, `${context}${b.prelude}{`) : [`${context}${b.body ? `${b.prelude}{${b.body}}` : b.prelude}`],
  );
}

/** Whether `subset` is `sheet` with rules dropped and none added or reordered,
 *  which is what the parity argument at the top of this file needs. */
export function isOrderedSubset(subset: string, sheet: string): boolean {
  const all = flatRules(sheet);
  let at = 0;
  for (const rule of flatRules(subset)) {
    at = all.indexOf(rule, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

// The pages that load their shell stylesheets without blocking first paint,
// keyed by staged path. /garage measured 2026-11-06 with @rolldown/perf-kit
// 0.1.0 (1.6 Mbit/s, 150 ms RTT, 4x CPU, 7 runs): FCP = LCP 663 to 370 ms,
// CLS 0 in every run, rendered output identical on 12 pinned pages. The
// subset is 39.9 of luna's 45.1 KB raw, about 9.6 KB more on the wire per
// load, which a repeat visit pays where a cached luna.css would be free.
export const NON_BLOCKING_PAGES = ["garage/index.html"];

// the homepage's flip (src/pages/index.html has the reasons for each part)
const swap = (href: string, id: string) =>
  `<link rel="stylesheet" href="${href}" media="print" id="${id}">\n` +
  `<script>(function(){var l=document.getElementById("${id}");function f(){l.media="all"}l.sheet?f():l.addEventListener("load",f,{once:true})})();</script>\n` +
  `<noscript><link rel="stylesheet" href="${href}"></noscript>`;

/** A staged page with each sheet's render-blocking <link> swapped for its
 *  derived subset plus a non-blocking load of the whole sheet.
 *
 *  First paint also waits for the page's first prose fold to parse
 *  (`rel=expect`). Without a blocking stylesheet Chrome paints as soon as the
 *  title bar's text arrives, before `.axp-tasks` has parsed, so the window
 *  painted 664 px wide and grew to 864 px when the `:has(>.axp-tasks)` grid
 *  applied: CLS 0.048 on the loads where the HTML split there. The first fold
 *  is where prose-fold.ts already put the end of the first screen. Chromium
 *  only; other engines paint the partial DOM as before. */
export async function nonBlockingPage(html: string, sheets: { href: string; css: string }[], scripts: string[]): Promise<string> {
  let out = html;
  for (const { href, css } of sheets) {
    const link = `<link rel="stylesheet" href="${href}">`;
    if (out.split(link).length !== 2) throw new Error(`critical-css: expected exactly one ${link}`);
    const subset = await criticalCss(css, html, scripts);
    if (!isOrderedSubset(subset, css)) throw new Error(`critical-css: the ${href} subset is not an ordered subset of it`);
    const id = `${href.replace(/^\/|\.css$/g, "")}-css`;
    out = out.replace(link, `<style>${subset}</style>\n${swap(href, id)}`);
  }
  const fold = '<section class="fold"';
  const charset = '<meta charset="utf-8">';
  if (!out.includes(fold)) throw new Error("critical-css: no prose fold to hold first paint for");
  if (!out.includes(charset)) throw new Error(`critical-css: no ${charset} to put the render-blocking expect after`);
  return out.replace(fold, `${fold} id="first-fold"`).replace(charset, `${charset}\n<link rel="expect" href="#first-fold" blocking="render">`);
}
