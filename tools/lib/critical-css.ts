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

const MAX_EXPAND = 64;

// Expand :where(...) and :is(...) into their branch selectors while stripping
// every other :pseudo and ::pseudo with its argument list (which can only widen
// a match). A selector that hits the branch cap collapses to "" so it stays kept.
function expandPseudos(selector: string): string[] {
  let partials = [""];
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "[") {
      const end = selector.indexOf("]", i);
      const chunk = end < 0 ? selector.slice(i) : selector.slice(i, end + 1);
      partials = partials.map((p) => p + chunk);
      if (end < 0) break;
      i = end;
    } else if (c === ":") {
      let j = i + 1;
      const isElement = selector[j] === ":";
      if (isElement) j++;
      const nameStart = j;
      while (j < selector.length && /[\w-]/.test(selector[j])) j++;
      const name = selector.slice(nameStart, j).toLowerCase();
      if (selector[j] === "(") {
        const argStart = j + 1;
        let depth = 0;
        for (; j < selector.length; j++) {
          const ch = selector[j];
          if (ch === '"' || ch === "'") {
            const end = selector.indexOf(ch, j + 1);
            if (end >= 0) j = end;
          } else if (ch === "(") depth++;
          else if (ch === ")" && --depth === 0) break;
        }
        const arg = selector.slice(argStart, j);
        j++;
        if (!isElement && (name === "where" || name === "is")) {
          const branches = selectorList(arg).flatMap((branch) => expandPseudos(branch));
          const next: string[] = [];
          for (const p of partials) {
            for (const b of branches) {
              // Combining a class/attr prefix with a tag branch (e.g. .x:is(div.y))
              // is not valid as ".xdiv.y"; keep the wider prefix `p` instead.
              next.push(p && !/[\s>+~]$/.test(p) && /^[a-zA-Z*]/.test(b) ? p : p + b);
              if (next.length > MAX_EXPAND) return [""];
            }
          }
          partials = next;
        }
      }
      i = j - 1;
    } else {
      partials = partials.map((p) => p + c);
    }
  }
  return partials.map((s) => s.trim());
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

// Split a CSS declaration list on top-level semicolons, skipping strings and
// parenthesised expressions (e.g. data: URIs) so a `;` inside a value stays intact.
function splitDecls(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = body.indexOf(c, i + 1);
      if (end >= 0) i = end;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      const decl = body.slice(from, i).trim();
      if (decl) out.push(decl);
      from = i + 1;
    }
  }
  const tail = body.slice(from).trim();
  if (tail) out.push(tail);
  return out;
}

function declName(decl: string): string {
  const colon = decl.indexOf(":");
  return colon < 0 ? "" : decl.slice(0, colon).trim();
}

// Drop :root custom-property declarations that nothing in the kept subset,
// page markup, sibling sheets, or page scripts references (transitively).
function pruneRootVars(css: string, refText: string, scriptWords: Set<string>): string {
  const defs = new Map<string, string[]>();
  const nonRoot: string[] = [];
  const scan = (src: string) => {
    for (const b of blocks(src)) {
      if (b.nested) scan(b.body);
      else if (b.prelude === ":root") {
        for (const decl of splitDecls(b.body)) {
          const name = declName(decl);
          if (name.startsWith("--")) {
            let list = defs.get(name);
            if (!list) defs.set(name, (list = []));
            list.push(decl.slice(decl.indexOf(":") + 1));
          } else {
            nonRoot.push(decl);
          }
        }
      } else {
        nonRoot.push(`${b.prelude}{${b.body}}`);
      }
    }
  };
  scan(css);
  if (!defs.size) return css;

  const used = new Set<string>();
  const addVars = (text: string) => {
    for (const m of text.matchAll(/--[\w-]+/g)) used.add(m[0]);
  };
  addVars(nonRoot.join("\n"));
  addVars(refText);
  // Keep any --name whose suffix appears as a word in scripts (e.g. nav.ts
  // reading `--` + "sa-t" / "taskbar-h" via getComputedStyle).
  for (const name of defs.keys()) {
    if (scriptWords.has(name.slice(2))) used.add(name);
  }
  // Transitive closure over custom properties referencing other custom properties.
  const queue = [...used];
  while (queue.length) {
    const vals = defs.get(queue.pop()!);
    if (!vals) continue;
    for (const v of vals) {
      for (const m of v.matchAll(/--[\w-]+/g)) {
        if (!used.has(m[0])) {
          used.add(m[0]);
          queue.push(m[0]);
        }
      }
    }
  }

  const rewrite = (src: string): string =>
    blocks(src)
      .map((b) => {
        if (b.prelude.endsWith(";")) return b.prelude;
        if (b.nested) {
          const inner = rewrite(b.body);
          return inner ? `${b.prelude}{${inner}}` : "";
        }
        if (b.prelude === ":root") {
          const kept = splitDecls(b.body).filter((d) => {
            const name = declName(d);
            return !name.startsWith("--") || used.has(name);
          });
          return kept.length ? `:root{${kept.join(";")}}` : "";
        }
        return `${b.prelude}{${b.body}}`;
      })
      .join("");
  return rewrite(css);
}

/** luna.css (minified) cut down to the rules that can apply to `html` and to
 *  what `scripts` (the JS that page runs) can add to it. */
export async function criticalCss(luna: string, html: string, scripts: string[] = [], extraRefs = ""): Promise<string> {
  const scriptSrc = scripts.join("\n");
  const scriptWords = words(scriptSrc);
  if (/@layer\b/.test(luna)) throw new Error("critical-css: luna.css uses @layer, and a subset could reorder layers; the parity argument no longer holds");

  const all = new Set<string>();
  const isPrintMedia = (prelude: string) => /^@media\s+print\b/i.test(prelude);
  const collect = (css: string) => {
    for (const b of blocks(css)) {
      if (b.nested) {
        if (!isPrintMedia(b.prelude)) collect(b.body);
      } else if (!b.prelude.startsWith("@")) {
        for (const s of selectorList(b.prelude)) for (const branch of expandPseudos(s)) all.add(branch);
      }
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
          // The full sheet already loads with media="print", so print rules
          // never belong in the screen first-paint subset.
          if (isPrintMedia(b.prelude)) return "";
          const inner = keep(b.body);
          return inner ? `${b.prelude}{${inner}}` : "";
        }
        if (b.prelude.startsWith("@")) return `${b.prelude}{${b.body}}`; // @property and the like
        return selectorList(b.prelude).some((s) => expandPseudos(s).some((branch) => hit.has(branch) || namedInScripts(branch, scriptWords)))
          ? `${b.prelude}{${b.body}}`
          : "";
      })
      .join("");
  return pruneRootVars(keep(luna), `${html}\n${scriptSrc}\n${extraRefs}`, scriptWords);
}

// Every style rule with the at-rule preludes around it, in source order. Two
// stylesheets compare rule for rule this way even when a subset drops part of
// an @media block.
function flatRules(css: string, context = ""): string[] {
  return blocks(css.replace(/\/\*[\s\S]*?\*\//g, "")).flatMap((b) =>
    b.nested ? flatRules(b.body, `${context}${b.prelude}{`) : [`${context}${b.body ? `${b.prelude}{${b.body}}` : b.prelude}`],
  );
}

function rootRuleMatch(subRule: string, fullRule: string): boolean {
  const splitRoot = (rule: string): [string, string] | null => {
    const marker = ":root{";
    const at = rule.lastIndexOf(marker);
    if (at < 0 || !rule.endsWith("}")) return null;
    if (at > 0 && !rule.slice(0, at).endsWith("{")) return null;
    return [rule.slice(0, at + marker.length), rule.slice(at + marker.length, -1)];
  };
  const a = splitRoot(subRule);
  const b = splitRoot(fullRule);
  if (!a || !b || a[0] !== b[0]) return false;
  const fullDecls = splitDecls(b[1]);
  let pos = 0;
  for (const decl of splitDecls(a[1])) {
    pos = fullDecls.indexOf(decl, pos);
    if (pos < 0) return false;
    pos++;
  }
  return true;
}

/** Whether `subset` is `sheet` with rules (and unused :root declarations)
 *  dropped and none added or reordered, which is what the parity argument at
 *  the top of this file needs. */
export function isOrderedSubset(subset: string, sheet: string): boolean {
  const all = flatRules(sheet);
  let at = 0;
  for (const rule of flatRules(subset)) {
    let found = -1;
    for (let i = at; i < all.length; i++) {
      if (all[i] === rule || rootRuleMatch(rule, all[i])) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

// Pages that swap whatever their size, keyed by staged path. /garage measured
// 2026-11-06 with @rolldown/perf-kit 0.1.0 (1.6 Mbit/s, 150 ms RTT, 4x CPU, 7
// runs): FCP = LCP 663 to 370 ms, CLS 0 in every run, rendered output
// identical on 12 pinned pages. The subset is 39.9 of luna's 45.1 KB raw,
// about 9.6 KB more on the wire per load, which a repeat visit pays where a
// cached luna.css would be free.
export const NON_BLOCKING_PAGES = ["garage/index.html"];

/** Whether a staged page is a candidate to load its shell stylesheets without
 *  blocking first paint: every page that links luna.css, except the homepage,
 *  which inlines a hand-kept copy instead (src/pages/index.html). Build step 5f
 *  swaps a candidate only if the swapped page still fits the first round trip. */
export const nonBlocking = (rel: string, html: string): boolean =>
  rel !== "index.html" && (NON_BLOCKING_PAGES.includes(rel) || html.includes(`<link rel="stylesheet" href="/luna.css">`));

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
export async function nonBlockingPage(
  html: string,
  sheets: { href: string; css: string }[],
  scripts: string[],
  { taskPane, matchingHtml = html }: { taskPane?: string; matchingHtml?: string } = {},
): Promise<string> {
  let out = html;
  const present = sheets.filter(({ href }) => {
    const link = `<link rel="stylesheet" href="${href}">`;
    const count = out.split(link).length - 1;
    if (count === 0 && href !== "/luna.css") return false; // a page that never loads prose.css
    if (count !== 1) throw new Error(`critical-css: expected exactly one ${link}`);
    return true;
  });
  for (const { href, css } of present) {
    const link = `<link rel="stylesheet" href="${href}">`;
    // Sibling linked sheets (e.g. prose.css) may read custom properties defined
    // in luna.css's :root; include their text so :root pruning never drops them.
    const siblingCss = present
      .filter((s) => s.href !== href)
      .map((s) => s.css)
      .join("\n");
    const subset = await criticalCss(css, matchingHtml, scripts, siblingCss);
    if (!isOrderedSubset(subset, css)) throw new Error(`critical-css: the ${href} subset is not an ordered subset of it`);
    const id = `${href.replace(/^\/|\.css$/g, "")}-css`;
    out = out.replace(link, `<style>${subset}</style>\n${swap(href, id)}`);
  }
  const fold = '<section class="fold"';
  const charset = '<meta charset="utf-8">';
  // A page with no fold holds paint for its Explorer task pane instead: the
  // pane is what the `:has(>.axp-tasks)` grid waits on, and on 8 fold-less
  // pages a throttled cold load (1.6 Mbit/s, 150 ms RTT, 4x CPU) read CLS 0 to
  // 0.048 without the hold, the shift above. `taskPane` is the pane's opening
  // tag as it stands when this runs, after step 5e shortened its class.
  // A page with neither has nothing that grows the window, and paints as it arrives.
  const [target, id] = out.includes(fold) ? [fold, "first-fold"] : taskPane && out.includes(taskPane) ? [taskPane, "first-pane"] : [];
  if (!target || !id) return out;
  if (out.split(target).length !== 2 && id === "first-pane") throw new Error(`critical-css: expected one ${taskPane}`);
  if (!out.includes(charset)) throw new Error(`critical-css: no ${charset} to put the render-blocking expect after`);
  return out.replace(target, `${target} id="${id}"`).replace(charset, `${charset}\n<link rel="expect" href="#${id}" blocking="render">`);
}
