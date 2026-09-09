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

## Full component scope still to implement

- Rust rendering/code generation with one canonical component definition and
  generated TypeScript contracts; avoid parallel hand-maintained renderers.
- Taskbar, Menu, Dialog, ExplorerList, PropertySheet, and Demo components.
- Typed, small client behaviors with keyboard/focus contracts, lazy loading,
  and machine actions where a component exposes an action.
- Adoption by existing static and dynamic pages without changing the XP design.
- Browser behavior checks and measured build/served-byte/runtime comparisons.

Window rendering currently remains TypeScript. The Rust portion and the full
component family are unfinished; this is an implementation draft, not completion
of the typed XP component goal.
