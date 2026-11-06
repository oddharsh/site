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
