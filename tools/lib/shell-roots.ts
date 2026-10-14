// The documents the dictionary roll and dcz:check read to find which /a/ assets
// production serves. Both walks then close over the /a/ graph, so a root is
// needed only for an asset NO other root reaches: a page-scoped asset loaded by
// one document (/dotfiles, /garage/pretext) is invisible from the other four.
export const SHELL_DISCOVERY_ROOTS = ["/", "/lens", "/lwe/utf8", "/writing", "/dotfiles", "/garage/pretext"] as const;

export function shellAssetRefs(body: string): string[] {
  return [...body.matchAll(/\/a\/([\w-]+\.[0-9a-f]{8}\.(?:js|css|svg))(?![\w./%-])/g)].map(([, name]) => name);
}
