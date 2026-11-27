import { minifySync } from "oxc-minify";
import type { MinifyOptions } from "oxc-minify";

// The oxc-minify options every served client script is minified with, in ONE
// place so that the build and the parity watch (lib/upstream-watches.ts) cannot
// measure two different minifiers and call the difference oxc.
//
// The two settings that carry intent are `target` and `mangle.toplevel`; the
// four compress booleans restate oxc's defaults and are kept so the intent is
// legible at the call site rather than inherited.
//
// THE TREESHAKE BLOCK IS A CLAIM ABOUT THE CODE, not a tuning knob. Measured
// 2026-09-15 with `propertyWriteSideEffects: false` (the setting a bundled app
// would want): six of the seven /lens islands minified to ZERO BYTES, because
// each is an IIFE whose only externally visible effect is `window.LensX = {…}`,
// and once a property write counts as side-effect free the whole IIFE has no
// effects and is tree-shaken away. The marker tripwire in build.ts step 3 turns
// that into a failed build (`lens-browser.js: minified output lost the
// "LensBrowser" marker`), which is the reason every script row in
// tools/lib/client-assets.ts carries one. The islands communicate through
// globals on purpose, so `true` here is the same decision as
// `mangle.toplevel: false` seen from the tree-shaker's side.
//
// `propertyReadSideEffects: false` and `unknownGlobalSideEffects: false` were
// measured the same day at -17 B and 0 B across the 19 client assets (brotli
// q11) and left at their conservative values, since 17 B buys no argument.
export const OXC_MINIFY_OPTIONS = {
  module: false,
  compress: {
    // The site deliberately targets modern browsers. This preserves modern
    // syntax while enabling Oxc's full ESNext compression set.
    target: "esnext",
    dropDebugger: true,
    unused: true,
    joinVars: true,
    sequences: true,
    treeshake: {
      annotations: true,
      propertyReadSideEffects: "always",
      propertyWriteSideEffects: true,
      unknownGlobalSideEffects: true,
      invalidImportSideEffects: true,
    },
  },
  // Keep top-level names stable: several shell files expose globals that
  // other site code discovers by name.
  mangle: { toplevel: false },
  codegen: { removeWhitespace: true, legalComments: "none" },
} as const;

// The one Oxc call behind every client script and inline <script> the build
// ships (tools/build.ts steps 3 and 7b). A parse error fails the build by label.
//
// Oxc takes the source type from the filename unless `module` is true, and a
// name without a .js extension parses as a strict module, so `module: false`
// alone does not ask for a script (napi/minify/src/lib.rs at crates_v0.160.0).
// The inline label `public/x.html inline <script>` has none, and as a module
// its block-level functions lose Annex B hoisting and the mangler reuses their
// names. /lwe/fuse threw on click that way until 2026-11-27. The `.js` parses
// the classic script a browser runs; the label in errors stays as given
// (gotcha 121).
export const minifyJavaScript = (filename: string, sourceText: string, options: MinifyOptions = OXC_MINIFY_OPTIONS) => {
  const result = minifySync(filename.endsWith(".js") ? filename : `${filename}.js`, sourceText, options);
  if (result.errors.length) {
    throw new Error(`${filename}: Oxc parse/minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.code;
};
