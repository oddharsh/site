// lens-islands.d.ts — the /lens machine tabs, as the shell sees them.
//
// Each tab ships as its own island (lens-browser.js, lens-reader.js,
// lens-wire.js, lens-tools.js, lens-nlweb.js, lens-markdown.js) and registers itself on `window`
// when its script loads, because the shell loads them LAZILY: a visitor who
// never opens the Wire tab never fetches lens-wire.js. That is why every member
// here is optional, and why lens.js guards each one before calling it.
//
// Declared rather than cast at each use: when the browser program's include
// became a glob, these island names surfaced as findings at every use, and a
// cast per site would have said nothing about what an island actually is.

interface LensIsland {
  /** Draw the tab's chrome into its pane. */
  mount?: (...args: any[]) => any;
  /** Fetch and render for one target URL. */
  run?: (...args: any[]) => any;
  /** lens-tools only: draw a parsed tool catalogue. */
  render?: (...args: any[]) => any;
  /** lens-tools only: wire the rendered form's controls. */
  bind?: (...args: any[]) => any;
  // TEST HANDLES. Each island exports its internals under a leading underscore
  // for the contract tests (_question, _plan, _validate, _frame). Naming them one
  // by one would mean editing this file every time an island grows a test seam,
  // which is the allowlist problem this file replaced, so the CONVENTION is
  // declared rather than its current members.
  [testHandle: `_${string}`]: any;
}

interface LensWebMcpBridge {
  installHandlers(handlers: Record<string, (args: any) => unknown>): void;
  readonly views: readonly string[];
  readonly optIn: readonly string[];
  readonly switches: readonly string[];
}

interface Window {
  LensBrowser?: LensIsland;
  LensReader?: LensIsland;
  LensWire?: LensIsland;
  LensTools?: LensIsland;
  LensNlweb?: LensIsland;
  LensMarkdown?: LensIsland;
  LensWebMcp?: LensWebMcpBridge;
}
