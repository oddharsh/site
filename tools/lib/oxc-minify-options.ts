// The oxc-minify options every served client script is minified with, in ONE
// place so that the build and the parity watch (lib/upstream-watches.ts) cannot
// measure two different minifiers and call the difference oxc.
export const OXC_MINIFY_OPTIONS = {
  module: false,
  compress: {
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
  mangle: { toplevel: false },
  codegen: { removeWhitespace: true, legalComments: "none" },
} as const;
