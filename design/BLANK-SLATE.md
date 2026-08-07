# Blank-slate rebuild

Status: active implementation plan for `codex/blank-slate-rewrite`.

This branch replaces the site's presentation and request pipeline from first
principles. The old HTML, CSS, and JavaScript are evidence about public
behavior, not implementation material. The replacement may retain words,
photographs, machine-readable records, URLs, and persisted data because those
are the site itself. It must not copy or depend on the old DOM, style rules,
page scripts, component vocabulary, or routing implementation.

## Outcome

Make aadhar.sh feel like one unusually well-restored Windows XP Explorer
application, built with the current web platform. Every route is a useful
semantic document before JavaScript runs. JavaScript is reserved for a feature
whose meaning cannot be expressed in HTML and CSS, or for an interaction whose
result genuinely changes with user input or server data.

The rebuild is successful when it is:

- faster or equal on measured user outcomes: LCP, INP, CLS, TTFB, and direct
  manipulation frame time;
- smaller and simpler in source and over the wire;
- complete across the frozen public route and representation contract;
- accessible by keyboard, screen reader, forced-colors mode, coarse pointer,
  reduced motion, print, a browser with JavaScript disabled, and a machine
  client that never asks for HTML;
- deployable through the existing protected release path without migrating or
  losing persisted data.

## Inputs and non-inputs

Allowed sources of truth:

- prose, captions, photographs, downloadable artifacts, and authored datasets;
- the 59-surface registry and the 123-route production acceptance inventory;
- response schemas, content negotiation, authentication rules, cache policy,
  and storage schemas that public or persisted consumers rely on;
- the visual brief: Luna Blue, native fonts, squared controls, one-pixel
  bevels, vivid plastic color, and honest affordances.

Not allowed in the finished system:

- an old page loaded, embedded, imported, or transformed at request time;
- copied legacy markup, stylesheets, page scripts, shell components, or route
  handlers;
- a compatibility flag or parallel site that leaves two implementations alive;
- a framework runtime, hydration layer, client router, webfont, or service
  worker used to manufacture performance the document can provide directly.

A one-time content migration may extract authored prose or structured records.
Its reviewed output becomes the canonical source; the extractor is not part of
the runtime.

## Design system

### Subject, audience, and job

The subject is a personal computer that happens to be a public website: a place
to inspect Aadharsh's work, photographs, notes, listening, experiments, and
small internet tools. It serves curious people first and machine clients as an
equally intentional second audience. The primary job is browsing; utilities
must remain operable without making every page feel like an application.

### Visual thesis

Use a single Explorer window, not a desktop full of draggable imitations. The
window chrome establishes the period; the document remains the document. An
Explorer task pane is the signature device: it exposes nearby actions, other
places, and honest details for the current object. A real breadcrumb/address
bar makes the information architecture visible and doubles as navigation.

Ordinary pages do not drag, resize, maximize, minimize, or pretend to be
software they are not. Direct manipulation remains only in demonstrations
where the manipulation teaches the subject.

### Compact token set

| role | value | purpose |
|---|---|---|
| caption start | `oklch(52% 0.25 258)` | active Explorer title |
| caption end | `oklch(70% 0.17 248)` | Luna title highlight |
| selection | `oklch(53% 0.16 255)` | selected and current items |
| face | `#ece9d8` | control and window chrome |
| paper | `#fff` | documents and fields |
| ink | `#000` | text |
| success | `oklch(57% 0.17 138)` | live/available state only |

Chrome uses the native Tahoma stack with Verdana as the practical fallback.
Captions use Trebuchet MS. Data and code use Courier New. No other family is
introduced. Type sizes use one compact UI scale rather than a marketing-page
display scale.

Depth comes from one-pixel light and dark edges. Only the upper window corners
may round, by at most three pixels. There are no translucent cards, large blur
shadows, pills, soft easing, generic hero gradients, or decorative dashboards.

### Page anatomy

Wide viewport:

```text
+---------------------------------------------------------------+
| icon  Aadharsh Explorer                              _  []  x |
+---------------------------------------------------------------+
| File  View  Go  Help                                           |
+---------------------------------------------------------------+
| Address | aadhar.sh / section / object                    Go   |
+----------------------+----------------------------------------+
| Object tasks         |                                        |
| - nearby action      |  document heading                      |
| - alternate format  |  summary                               |
|                      |                                        |
| Other places         |  semantic page content                 |
| - Writing            |                                        |
| - Photos             |                                        |
|                      |                                        |
| Details              |                                        |
| format, date, state  |                                        |
+----------------------+----------------------------------------+
| status text                                      privacy state |
+---------------------------------------------------------------+
```

At narrow widths the task pane becomes a named native `details` region before
the document; navigation remains in source order and no content is duplicated.
Page families may change the document pane—Notepad-like prose, contact sheet,
terminal frame, chat transcript, laboratory, booking form—but not the shell's
information hierarchy.

### Platform features

Use modern features when they make the fallback simpler:

- semantic landmarks plus `search`, `dialog`, `popover`, and exclusive named
  `details` groups;
- container queries for page-family layouts, `@scope` for demo isolation, and
  `content-visibility` with explicit intrinsic sizes for long archives;
- `:open`, `:has()`, logical properties, native nesting, cascade layers, and
  relative color/OKLCH where they reduce duplication;
- `field-sizing: content`, anchor positioning, and command buttons as
  progressive enhancement only; a baseline browser must retain every action;
- focus-visible, forced-colors, reduced-motion, print, and no-script behavior
  designed deliberately rather than patched afterward.

## Architecture

```text
content/                 canonical prose and structured records
src/site/                new document renderer and shared design source
src/site/pages/          route-family renderers
src/site/features/       route-scoped browser modules
src/worker/              typed dynamic routes and scheduled work
public/                  immutable hand-authored public artifacts
scripts/build-site.mjs   deterministic static build and contract projection
dist/                    generated deploy tree, never authored
```

The build emits complete static HTML wherever output is knowable before a
request. The Worker handles only live data, writes, authenticated operations,
content negotiation that needs request headers, and bounded transformations.
Static assets are served directly by Workers Static Assets. There is one route
registry and one environment type. Binding-backed operations remain behind
narrow modules with explicit input and output contracts.

The shell stylesheet is the only render-blocking shared asset and is immutable
and content-hashed. Every optional script is an external module, route-scoped,
deferred by module semantics, and independently removable. Page source order is
also its no-CSS reading order.

## Budgets

Budgets are acceptance criteria, not targets to pad up to.

| outcome | target |
|---|---|
| static document TTFB, warm edge | <= 100 ms p75 |
| LCP, representative desktop lab | <= 500 ms unthrottled and no regression under mobile profile |
| CLS | <= 0.01 |
| INP / interaction response | <= 100 ms p75 |
| drag or continuous lab response | <= one 60 Hz frame at p95 on reference hardware |
| initial route JavaScript, ordinary document | 0 B |
| initial route JavaScript, interactive utility | <= 8 KiB compressed unless measured evidence approves more |
| shared render-blocking CSS | <= 8 KiB compressed |
| ordinary generated HTML | <= 24 KiB compressed excluding authored article text |
| request count before LCP, ordinary document | <= 3 |

Photographs reserve their intrinsic space, responsive sources, decoding and
fetch priority. Below-fold page families opt into containment only after visual
and accessibility checks. Caches improve repeat visits but never repair an
unnecessarily heavy first document.

## Public contract

The production snapshot contains 123 checked routes and 59 registered surfaces.
It is the migration oracle, not the architecture. For each row the rewrite must
preserve the intentional combination of:

- status and method behavior;
- media type, negotiation, and machine-readable schema;
- canonical/noindex and security headers;
- public read versus authenticated or preview-denied write;
- cache semantics and validators;
- persisted KV, R2, D1, Durable Object, Workflow, Analytics Engine, Browser,
  Images, and secret boundaries.

Any deliberate contract deletion gets its own migration note and test. A route
does not disappear because the old implementation was awkward.

## Migration sequence

1. Freeze production routes, representative traces, screenshots, and data
   schemas. Write the new design and acceptance tests.
2. Build the static compiler, Explorer shell, homepage, writing, and section
   indexes with zero-JavaScript documents.
3. Normalize content pages into new canonical records. Rebuild laboratories as
   isolated, route-scoped enhancements with useful static explanations.
4. Rebuild photo, music, reading, calendar, serendipity, status, identity, and
   machine utility families over their existing persisted data contracts.
5. Replace the Worker entrypoint and Wrangler configuration in one switch;
   retain no legacy router or fallback.
6. Run source checks, unit and contract tests, both Wrangler dry runs, the full
   route oracle, no-JS/a11y/forced-colors/responsive passes, and browser traces.
7. Compare the same representative production and branch URLs, document
   exceptions, and publish reviewable commits in a draft PR. Do not deploy.

## Review gates

A route family is complete only when:

- its content and alternate representations are present;
- it works at 320 CSS px, 200% zoom, keyboard-only, and JavaScript disabled;
- automated accessibility inspection has no new serious issue;
- its console is quiet and every resource request is intentional;
- its lab trace meets the outcome budgets or carries measured, reviewed
  evidence for an exception;
- the family has contract coverage at the Worker harness boundary.

The final branch is complete only when the old presentation and router are
deleted, generated output is reproducible, `git grep` finds no runtime import
from the retired implementation, and the full repository gates pass.
