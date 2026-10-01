// The documents the dictionary roll and dcz:check read to find which /a/ assets
// production serves. Both walks then close over the /a/ graph, so a root is
// needed only for an asset NO other root reaches: a page-scoped asset loaded by
// one document (/dotfiles, /garage/pretext) is invisible from the other four.
//
// ONE list, because the two walks had to be edited in step and had drifted once
// before: dcz:check shipped reading two pages while the roll read four, and
// graded a different set from the one the roll adopts (2026-08-19).
export const SHELL_DISCOVERY_ROOTS = ["/", "/lens", "/lwe/utf8", "/writing", "/dotfiles", "/garage/pretext"] as const;

// Both discovery walks adopt the same dictionary-carrying asset types. The
// extension must be complete: .json is not a .js URL, nor is .js.map a script.
// Query strings and SVG fragments sit outside the filename.
export function shellAssetRefs(body: string): string[] {
  return [...body.matchAll(/\/a\/([\w-]+\.[0-9a-f]{8}\.(?:js|css|svg))(?![\w./%-])/g)].map(([, name]) => name);
}
