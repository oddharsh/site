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
// "LensBrowser" marker`), which is the reason every SHELLS row carries one. The
// islands communicate through globals on purpose, so `true` here is the same
// decision as `mangle.toplevel: false` seen from the tree-shaker's side.
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
