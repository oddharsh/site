export class Html {
  readonly html: string;
  constructor(value: string) {
    this.html = value;
  }
  toString(): string {
    return this.html;
  }
}

export type Interpolable =
  | Html
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Interpolable[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(value: string): string {
  if (!/[&<>"']/.test(value)) return value;
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value: Interpolable): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Html) return value.html;
  if (Array.isArray(value)) {
    let out = "";
    let i = 0;
    while (i < value.length) out += render(value[i++]);
    return out;
  }
  return escape(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolable[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/** Mark markup as already-safe, WITHOUT escaping it.
 *
 *  Every use is a claim that the string is either a literal this repository
 *  wrote or was built by `html`. It is the migration marker for the templates
 *  that predate the tagged template, whose interpolations are escaped BY HAND
 *  with escHtml/escAttr, and each one still owes a real migration to `html`.
 *
 *  IT IS A CALL, NOT A TAG, and that is measured rather than stylistic. A
 *  `tag` + "`" form would have been a one-token edit per call site, which is
 *  tempting for a 20-caller migration. It also more than DOUBLES the literal in
 *  the bundle: a tagged template must preserve `strings.raw`, so as soon as the
 *  content carries a backslash escape the bundler emits the cooked AND raw
 *  arrays. Measured through esbuild, which is what wrangler bundles with, on one
 *  120-line literal containing `\t` and `\n`:
 *
 *      plain literal            3907 B
 *      tagged                   8383 B   (+115%)
 *      wrapped in a call        3910 B   (+3 B)
 *
 *  It cost 1.42 KiB on `whoareyou.ts` alone before it was caught, on a PR whose
 *  whole claim was that it changed no bytes. Wrapping is free and says the same
 *  thing.
 *
 *  The count is the ledger: config/unsafe-html-baseline.json, checked by
 *  contract-html-escapes-by-construction, may only go down. */
export function unsafeHtml(value: string): Html {
  return new Html(value);
}

export const EMPTY: Html = new Html("");

export function joinHtml(parts: readonly Html[], separator = ""): Html {
  return new Html(parts.map((part) => part.html).join(separator));
}
