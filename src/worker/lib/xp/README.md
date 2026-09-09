# Typed XP components draft

`Window` is the first extracted component. Every existing `lunaPage` caller now
uses it. It owns frame markup and frame defaults; the page assembler owns HTTP
policy, document metadata, desktop navigation, and Explorer composition.
`LunaPageOptions` derives its frame fields from `WindowOptions` so their types
cannot drift. Text is escaped by the existing `html` tag and markup slots require
the existing `Html` type. The component adds no browser runtime or stylesheet.

The first migration preserves complete HTML bytes, headers, and status across
128 combinations of Explorer chrome, classes, close controls and escaping cases
compared with the previous assembler. Contract tests cover fragment composition,
escaping, native close navigation, and hooks used by existing shell enhancement.
This extraction establishes a real consumer; it does not itself claim a speedup.

## Rust source of truth

`tools/xp/src/lib.rs` owns Window's typed field/default definitions and template
parts. The native renderer validates its input against those fields and resolves
defaults into text, trusted markup, or the empty-markup sentinel. Its TypeScript
generator emits the same tagged template used by the Worker, including the
`WindowOptions` contract. There is no runtime template interpreter or Wasm boot.

`bun tools/gen-xp.ts` regenerates `window.ts`; `--check` verifies it without
writing. Required CI checks freshness, native tests and Clippy. A differential
test compares 128 native/TypeScript renders and checks that invalid batches emit
no partial result. The generated code differs from the earlier handwritten
component only in comments.

`PropertySheet` now uses the same field/template engine, including typed row
lists. Its read-only term/value pairs render as a semantic `<dl>` and replace
the previous inline Details markup in Explorer task panes. `Detail` derives
from the generated row type. Both Rust and TypeScript reject malformed input at
their respective runtime and compile-time boundaries; field text is escaped.
The differential contract covers empty lists, Unicode, escaping, missing fields,
unknown row fields and invalid row types, with no partial native batch output.

`ExplorerList` also uses typed rows and is consumed by both Object tasks and
Other places in the Explorer pane. `Task` derives from its generated item type.
It preserves ordinary anchors, document order, decorative glyph semantics and
the original fallback glyph for missing or empty glyph text. Native/TypeScript
tests compare these cases and reject missing required labels without publishing
partial batches. It adds no client-side list controller.

`Taskbar` owns the fixed navigation frame and Start link. The existing desktop
compiler supplies explicitly trusted pin/tray markup from `shell-data.ts`, so
the registry remains the source of its applications and tray items. The initial
frame migration preserved every desktop artifact. The desktop derivation includes the
generated Taskbar input; required XP freshness checks hold it to the Rust source.
Native tests compare frame/slot output and reject incomplete batches.

`TaskbarPin` now renders every pin, with typed link/label/hint/icon fields and a
count validated as a non-negative safe integer by both native and generated
renderers. Tests cover zero, the upper bound, fractions, negative values,
non-finite numbers, escaping, and incomplete batches. The source registry still
owns application identities and the compiler computes counts from the manifest.
`TaskbarTray` and `TrayItem` now render all tray items, the sound-button placeholder,
and the clock placeholder. IDs, links, labels, kinds and icon slots are typed;
the `hidden` field defaults to false and must be boolean in native and generated
renderers. Differential tests cover omitted/false/true values and reject strings,
numbers and null without partial output. All 1,792 built public files remain
byte-identical for this tray migration. Client behavior is still owned by the
existing navigation modules.

The pin migration changes two apostrophe spellings to `&#39;` in 42 committed
generated source files. Comparing 1,792 built public files, only 53 source-view
documents differ; rendered HTML, compressed assets, and dictionary deltas remain
identical. This is typing and validation work, not a speedup claim.

The native CLI accepts `typescript`, `render`, and `render-batch` for Window,
plus `typescript-property-sheet` / `render-property-sheet-batch` and
`typescript-explorer-list` / `render-explorer-list-batch`. Taskbar uses
`typescript-taskbar` / `render-taskbar-batch`; individual pins use
`render-taskbar-pin-batch`, and trays use `render-taskbar-tray-batch`.
Render input is a JSON object
(or array of objects for a batch), capped at 4 MiB. Unknown keys, missing required
fields and incorrect field types are rejected. HTML slots are trusted
authored markup, corresponding to Worker `Html` values: this is not an HTML
sanitizer and must not be exposed as an untrusted-content rendering endpoint.

```sh
cargo test --locked --manifest-path tools/xp/Cargo.toml
cargo clippy --locked --manifest-path tools/xp/Cargo.toml --all-targets -- -D warnings
bun tools/gen-xp.ts --check
bun test tools/contract-xp-components.test.mjs
```

## Notepad behavior typing

The existing Notepad menu now declares its action/separator union, optional
boolean checkbox reader, callback signature, menu definition and nullable open
state. Its literal-authored dialog controls and attached menu-button parent have
explicit DOM types. These annotations remove all seven existing Notepad type
errors; the browser ratchet records 157 remaining errors in other files.
They compile away: the production script and hashed URL remain unchanged. The
served `notepad.src.js` source view includes the annotations. This is a checked
boundary for the later Menu component, not shared rendering or new keyboard
behavior, and does not claim a runtime speedup.

## Full component scope still to implement

- Apply the native rendering path to static page compilation, and extend the
  shared definitions/code generation to the rest of the component family.
- Implement Menu, Dialog, and Demo components.
- Typed, small client behaviors with keyboard/focus contracts, lazy loading,
  and machine actions where a component exposes an action.
- Adoption by existing static and dynamic pages without changing the XP design.
- Browser behavior checks and measured build/served-byte/runtime comparisons.

Dynamic Window rendering uses generated TypeScript; native rendering is verified
but not yet used to compile static pages. The full component family remains
unfinished; this is not completion of the typed XP component goal.
