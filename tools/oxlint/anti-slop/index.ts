// Vendored from https://github.com/dmmulroy/anti-slop (MIT, LICENSE alongside),
// which is written to be COPIED rather than depended on. Three of its fifteen
// rules are here; the other twelve were measured against this tree and left
// out, and docs/DEPENDENCIES.md records why each one was dropped. Ten of them
// visit TypeScript AST nodes exclusively and cannot fire on a repository with
// no TypeScript source, so vendoring them would be dead code that still has to
// be maintained.
//
// The rule FILES are upstream's, byte for byte, so a future re-sync is a plain
// copy rather than a merge. Everything this repo decides lives here or in
// .oxlintrc.json instead of being edited into them.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";

const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
		"no-runtime-typeof": noRuntimeTypeofRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
	},
});

export default antiSlopPlugin;
