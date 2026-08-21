# lwe-publish

Turn a chat about a topic into a deployed Learning With Errors page, without hand-building the chrome or hand-wiring four files. Phase 1 (this directory) is the generator and the registry. Phases 2 and 3 layer the chat-to-spec structuring and a one-command publish on top.

## What is here

- `concepts.json` — the registry. One entry per concept drives the buddy list, the nav.js Run destinations, and the sitemap. Edit this, not the four downstream files.
- `generate.mjs` — the generator.
- `specs/<id>.json` — one page-spec per concept. Holds what is unique to that page: the conversation, the demos, the disclosure, the editorial card, and the understanding check. The window chrome, messenger shell, and quiz wiring come from the generator, so every page stays identical in its bones.

## Commands

```bash
node pipelines/lwe/generate.mjs page <id>   # specs/<id>.json -> public/lwe/<id>.html
node pipelines/lwe/generate.mjs wire        # rewrite the registry-driven regions (sitemap, buddy list, nav, ask.js CONCEPTS)
node pipelines/lwe/build-corpus.mjs         # rebuild the ask corpus from lwe-ask/corpus/<concept>.json
node pipelines/lwe/publish.mjs <id>         # one command: page -> corpus -> wire -> print the deploy steps
```

`wire` rewrites three marked regions straight from the registry: the sitemap URLs (`sitemap.xml`), the buddy-list Online group (`lwe/index.html`), and the nav.js Run entries. Each region is bounded by a `generated:*:start` / `:end` marker pair, so `wire` is idempotent and re-runnable. Adding a concept is now: write its spec, add a registry entry, `generate.mjs page <id>`, `generate.mjs wire`. The per-buddy `.pic` CSS stays hand-authored (it rarely changes). Every generated page also emits the shared `/quiz.js` runtime with its own understanding payload.

## The spec format

```json
{
  "id": "encoding",
  "description": "meta description",
  "buddyStat": "image encoding",
  "hasAsk": false,
  "disclosure": "<b>...</b> who wrote what, what is verbatim, what is AI-paced",
  "messages": [
    { "who": "you", "time": "23:01", "html": "<p>learner question</p>" },
    { "who": "bot", "time": "23:01", "html": "<p>answer</p>", "cite": { "url": "...", "title": "..." } },
    { "demo": { "id": "demo-bpp", "bar": "title", "html": "<p class=\"lead\">...</p>" } },
    { "scrollnote": "end of draft" }
  ],
  "demoCss": "/* per-page demo styles */",
  "demoJs": "/* per-page demo behavior */"
}
```

## Editorial and understanding contract

Every spec carries two records alongside the conversation:

```json
{
  "editorial": {
    "reader": "who is trying to understand this",
    "problem": "what they cannot yet predict",
    "thesis": "the model the page wants them to carry away",
    "evidence": ["what supports the model"],
    "uncertainty": "what the page still cannot claim"
  },
  "understanding": {
    "intro": "a short invitation to reconstruct the model",
    "questions": [
      {
        "q": "a mechanism or prediction question",
        "options": [
          { "t": "the correct model", "ok": true, "why": "why it works" },
          { "t": "a real misconception", "why": "what the page should reopen" },
          { "t": "another plausible model", "why": "what it gets wrong" }
        ]
      }
    ]
  }
}
```

The generator requires three to seven questions, exactly one correct option per
question, and feedback on every option. The check tests reconstruction rather
than recognition: ask why the mechanism works, what it predicts, or what result
would falsify the model. It diagnoses a second read; it never blocks the page.

The shared contract applies the site's LRS and voice rules to author-facing copy.
Write for a named reader, put the point near the front, keep the actor close to
the verb, and let the new idea land at the end. Use concrete evidence and state
the remaining uncertainty. The contract rejects em dashes, canned AI language,
and the `not X, Y` negation pattern before the generator writes HTML.

## Content contract (the voice the structuring step must hit)

Apply the whole writing-style ruleset together, never one subset instead of another.

- **LRS clarity.** Every sentence needs a character doing an action. Kill nominalizations (the -tion / -ment / -ance / -ity nouns that hide a verb). Link clauses with real connectors (because, although, so that), not "and" or "also".
- **No AI shibboleths.** No em dashes. Straight apostrophes. Contractions on. None of the banned phrases (leverage, delve, robust, "it's worth noting"). Never the "not X, Y" negation pattern. Emojis only when they clearly earn their place (a functional UI glyph, or a genuinely apt beat), never as filler reactions.
- A teacher bubble that quotes a source stays verbatim and carries a `cite`.

## Demo detection (the rule for Phase 2)

Demos get authored by hand, in real time. But the source chat decides where they go: a request to clarify, a request to re-explain, or an explicit "show me" is a demo cue. The structuring step flags those moments as `{demo:{...}}` slots; a human builds the actual widget.

## The built-in ask box (per-concept, sandboxed RAG)

Every LWE page can carry a live "ask a follow-up" box, grounded only in that concept's own sources and sandboxed from the others (the worker filters retrieval by concept). To turn it on:

1. Set `"hasAsk": true` on the registry entry. The generated page then ships `ask.js`, and `wire` adds the concept to ask.js's CONCEPTS allow-list, so the include set never drifts from the allow-list.
2. Add `lwe-ask/corpus/<concept>.json`: an array of `{ text, source, title }` passages. `build-corpus.mjs` injects them into the worker's corpus tagged by concept, each carrying its own source link.
3. Ship it: merge to `main` (CI promotes to `production`; Workers Builds deploys the site Worker carrying the page + ask.js), then `cd lwe-ask && bun run deploy` + `curl -X POST https://aadhar.sh/lwe/ask/reindex -H "x-reindex-secret: $REINDEX_SECRET"` (the corpus). That route is gated, so a bare POST answers 401.

**Copyright rule (convention, enforced in code review).** A corpus file may hold the author's own writing, the site's own AI-authored explanation of a topic, or genuinely republishable sources (Wikipedia with attribution, public domain). It must NEVER hold third-party copyrighted text. Copyrighted material (the 0xPARC primer, a book) informs the AI-authored page copy and shows up as a `cite` link, but never enters the retrieval corpus. The "found when building" case (no source supplied) defaults to a few relevant Wikipedia sections, chunked with attribution.

## Phase 2: chat to spec

Feed a raw LLM transcript of learning a topic; get back a draft `specs/<id>.json`. The structuring pass:
- Segments the chat into a clean conversation, `you` (learner) and `bot` (teacher) turns, honesty-tagged. A teacher turn that quotes a source keeps a `cite`.
- **Demo detection:** a request to clarify, to re-explain, or an explicit "show me" becomes a `{demo:{...}}` slot. The pipeline flags the moment; a human builds the actual widget (demos stay artisanal).
- Splits the sources: republishable ones become `lwe-ask/corpus/<concept>.json` passages; copyrighted ones stay as `cite` links only.
- Hits the content contract (the LRS voice above).

## Phases

1. **Generator + registry** (done). New page = one spec; wiring comes from the registry.
2. **Chat to spec** (done). The structuring pass above produces a draft spec plus the corpus split.
3. **`publish.mjs`** (done). One command builds the page, rebuilds the ask corpus, and wires every registry-driven region, then prints the deploy + reindex steps (those touch the live account, so they stay explicit).
