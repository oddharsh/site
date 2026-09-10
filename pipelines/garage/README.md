# pipelines/garage

Use this pipeline for every new Garage page. It gives the page the Luna shell,
the shared navigation hook, the active-recall check, and the same editorial card
that LWE pages use. The experiment still owns its body HTML, CSS, and JavaScript.

## Create a page

1. Copy the example below to `pipelines/garage/specs/<id>.json`.
2. Write the `editorial` card before writing the page. Name the reader, the
   problem, the thesis, the evidence, and the uncertainty.
3. Write three to seven `understanding.questions`. Each question should test
   the mechanism or a prediction. Give every option a `why`, including the
   misconception.
4. Render the spec into `src/pages/garage/<id>.html`:

```bash
node pipelines/garage/generate.mjs page <id>
```

5. Register the surface in [`site-manifest.json`](../../config/site-manifest.json) and
   project it into the Run palette:

```bash
bun run gen:manifest
```

6. Add the entry in `public/sitemap.xml` and the card in
   `src/pages/garage/index.html` by hand.
7. Run `bun run pages:check`. It discovers and validates every Garage spec,
   including new files; each spec id must match its filename.

The generator always emits the quiz data block and `/quiz.js`, so a new page
cannot silently omit the understanding check.

[`tools/gen-manifest.ts`](../../tools/gen-manifest.ts) owns the Run palette and
agent discovery projections. The shelf cards remain authored prose, and the
sitemap retains per-page freshness dates. `tools/build.ts` checks their coverage.
The retired Garage `wire` command now refuses before writing; use steps 5 and 6.

## Spec shape

```json
{
  "id": "cache-boundaries",
  "title": "Cache boundaries under load",
  "description": "A small field note about cache identity and stale bytes.",
  "status": "prototype",
  "added": "2026-07-18",
  "bodyHtml": "<h1>Cache boundaries under load</h1><p class=\"garage-intro\">Write the explanation here.</p>",
  "pageCss": "",
  "pageJs": "",
  "editorial": {
    "reader": "A curious site builder who knows the browser cache but wants the failure mode.",
    "problem": "The reader can name cache headers without predicting which stale copy a visitor will see.",
    "thesis": "A cache key must name the exact bytes that the browser is allowed to reuse.",
    "evidence": [
      "The experiment compares the response headers and the bytes they select.",
      "The final question asks what would change if the cache key stayed fixed."
    ],
    "uncertainty": "The local experiment shows the mechanism; production traffic still needs its own check."
  },
  "understanding": {
    "intro": "Before you close the hood, reconstruct the mechanism in three questions.",
    "questions": [
      {
        "q": "What does the cache key need to identify before a long-lived hit is safe?",
        "options": [
          { "t": "The exact bytes the response represents.", "ok": true, "why": "Right. A stable identity lets the browser reuse the right bytes and fetch a new name when the bytes change." },
          { "t": "Only the page title.", "why": "A title can stay the same while the bytes change. It cannot identify the response." },
          { "t": "Only the age of the response.", "why": "Age says when the cache stored a response. It says nothing about which bytes the URL names." }
        ]
      },
      {
        "q": "What would you predict if the bytes changed while the cache key stayed fixed?",
        "options": [
          { "t": "Some visitors could keep seeing the old bytes until the cache expires or is purged.", "ok": true, "why": "Right. The unchanged key gives the cache permission to reuse a response that no longer matches the source." },
          { "t": "Every browser would detect the change from the HTML title.", "why": "Browsers do not compare an arbitrary title with the origin before serving a cache hit." },
          { "t": "The response would become uncachable automatically.", "why": "The cache sees the same key and policy. It has no automatic proof that the source changed." }
        ]
      },
      {
        "q": "Which result would falsify the page's model?",
        "options": [
          { "t": "A fresh key still returns the old bytes after the origin and edge both report the new content.", "ok": true, "why": "Right. That result would show that the proposed identity boundary does not control the bytes a visitor receives." },
          { "t": "An old key returns an old response from a cache with a long lifetime.", "why": "That is the predicted failure mode, so it supports the model rather than falsifying it." },
          { "t": "A browser refetches after the cache entry expires.", "why": "Expiry is the ordinary cache lifecycle. It does not challenge the identity rule." }
        ]
      }
    ]
  }
}
```

The shared contract also checks the LRS and voice rules: active sentences,
concrete claims, no em dashes, no canned AI language, and no `not X, Y` move.
It validates the page before writing HTML, so the generated document and the
authoring record fail together when the contract breaks.

## Cite the upstream in the card

A garage card that exists because of somebody else's work opens by naming that
work, linked, before it says what we did with it. `/garage/pretext` is the model:

> [chenglou/pretext](https://github.com/chenglou/pretext) measures multiline text
> with the canvas as ground truth instead of the DOM, so asking "how tall at
> 320px?" never forces a reflow. A from-scratch re-creation of the technique
> [...] and why it's "watching" not "shipped."

The reader learns whose idea it is before they learn what the page adds, which is
the honest order. Upstream means a library, a repo, a spec, a release note, or the
demo the page is arguing with. Cloudflare and the browsers are the platform this
site runs on rather than an upstream, so a page about a Workers feature does not
owe the dashboard a citation.

**A page with no upstream cites nothing, and that is correct.** `/garage/teardown`,
`/garage/blueprint`, `/garage/gpt56` and `/garage/dyno` are about this site.
Manufacturing a citation for them would be worse than the gap.

[`contract-rss-feeds.test.mjs`](../../tools/contract-rss-feeds.test.mjs) enforces the half that rots: **every external URL in a card
also has to appear on the page it describes.** A citation that lives only on the
card credits a repo the page never mentions, and the reader who clicks through
finds nothing. Add the link to the page first, then to the card.
