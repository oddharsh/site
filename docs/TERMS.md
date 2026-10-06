# Terms and exact figures

A technical word in a /garage or /lwe essay can carry a one-sentence definition
and a link to the best reference for it. Hovering shows the definition in the
shell's yellow infotip; clicking goes to the source. Mark terms up before an
essay publishes.

## The markup

```html
<a class="term" data-t="lwe" href="https://en.wikipedia.org/wiki/Learning_with_errors" title="A math problem: recover a secret from equations that each carry a small random error. Believed hard even for quantum computers.">LWE</a>
```

- `data-t` is the term's key in [`src/content/terms.json`](../src/content/terms.json).
- `href` and `title` are copies of the registry's `src` and `plain`, byte for
  byte. `contract-essay-terms-match-their-registry` fails the build if they
  drift, so edit the registry and the pages together.
- The link text is whatever the sentence says ("lattices", "an LWE sample"),
  as long as it names the term.
- No JS, or a touch screen: the browser's own tooltip shows the `title` and the
  link still works. With JS on a pointer device, `infotip.js` draws the Luna
  card: the term, its definition, and the source's name.

## What to mark

Mark a word when a curious reader who doesn't do this for a living would stop
on it, and a good outside reference exists. Examples: LWE, AVIF, zstd,
ssimulacra2, Durable Object, ML-DSA, chroma subsampling.

Skip:

- everyday words and words the sentence already defines in passing;
- anything inside a heading, `<code>`, `<pre>`, an existing link, a button,
  a demo's controls, or the quiz data;
- this site's own names (/lens, AadharshBot, timbrado), which the essay
  explains itself.

Mark the **first** occurrence on the page and no other. Past about 15 terms a page starts glossing its own
vocabulary; keep the ones a reader would actually trip on.

## Writing the definition

- One sentence, two at most, under 30 words. Plain words a smart 15-year-old
  could follow.
- Say what the thing **is** or **does**. No opinion, no "important", no
  history unless the history is the point.
- House voice: no em dashes, straight quotes, no "X, not Y".
- Never guess. If you aren't sure the definition is right, read the source
  first.

## Picking the source

Wikipedia by default. Use the primary source when it's better for a reader:

| kind of term | source |
|---|---|
| an internet protocol or header | the RFC at `www.rfc-editor.org/rfc/rfcNNNN.html` |
| a web platform API or CSS feature | MDN |
| a cryptographic standard | the NIST FIPS page |
| a specific paper's construction | the paper (arXiv or the venue) |
| a tool or library with no article | the project's own docs |

Use the URL the source settles on after redirects, and open it once before you
commit it. The infotip names the source from its host (Wikipedia, MDN, RFC
Editor, NIST, arXiv, IACR ePrint, GitHub, Cloudflare Docs); any other host shows as its domain.

## Adding a term

1. Add an entry to `src/content/terms.json`, keyed in lowercase-kebab:
   `{"label": "LWE", "plain": "...", "src": "https://..."}`.
2. Mark the first occurrence on each page that uses it.
3. Spec-backed pages (`pipelines/garage/specs`, `pipelines/lwe/specs`) take
   the markup in the spec, in `bodyHtml` (garage) or `messages[].html` (lwe)
   and never in `understanding` or `editorial`, which ship as JSON. Regenerate
   with `node pipelines/<garage|lwe>/generate.mjs page <id>`.
4. Run `bun run test`.

## Exact figures: hold Alt

A rounded figure can carry its exact value. Holding Alt (Option on a Mac)
swaps every such figure on the page to its exact form, in Courier New, until
the key comes back up. `nav.js` does the swap; the markup is the opt-in:

```html
<data value="9,522 bytes">9.5 KB</data>
```

- `value` is the text Alt shows, written for a reader, units included.
- Wrap a figure only when its exact value is known: stated elsewhere on the
  page (a table, a footnote) or in the data the page was built from. Never
  work one backwards from a rounded number.
- Skip figures that are already exact. "36,980 bytes" has nothing to reveal.
- When the rounded figure stands for a summary (a median, a range), the value
  says so: `median 1,268 bytes (1,178 to 1,672)` beats a bare number.
- Same measurement, or no wrap: a figure and a table cell can share a number
  and still describe different runs, settings or files. If the page doesn't
  make the link plain, leave the figure alone.

`contract-exact-figures-are-honest-wraps` checks the shape (a non-empty value
that differs from the text, never in a heading or JSON data). Whether the
value is the right number is on the author.
