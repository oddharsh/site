// build.mjs: the site's one build step, and it runs only at deploy.
//
// Authoring stays buildless: everything in holding/ is committed readable and is
// the source of truth. This script stages a copy under .build/ and minifies
// exactly three shell scripts (the assets pages load); index.html, the
// garage/ and lwe/ HTML, images, _headers, and the worker modules ship
// byte-identical to git. Each minified shell opens with a pointer to its
// readable twin (/<name>.src.js, deployed alongside), because View Source is
// part of the product and minification must not cost it.
//
//   node build.mjs                                   # stage .build/
//   npm run deploy                                   # build + wrangler deploy -c .build/wrangler.jsonc
//
// wrangler resolves `main` and `assets.directory` relative to the config file, so the
// root wrangler.jsonc is copied verbatim into .build/ and just works against the copy.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { transform } from "esbuild";

const OUT = ".build";

// the shells to minify: [file, banner pointer, tripwire the minified output MUST contain]
// sw.js left this list in v136: it's a ~15-line unregister stub now, shipped
// readable and verbatim (no version string, no twin, nothing to tripwire).
const SHELLS = [
  ["nav.js",     "/nav.src.js",     "axp-histnav"],
  ["notepad.js", "/notepad.src.js", "np-window"],
  ["lens.js",    "/lens.src.js",    "replaceState"],   // verify-routes.mjs marker
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1) stage: holding/ + wrangler config, verbatim (.assetsignore rides along)
await cp("holding", `${OUT}/holding`, { recursive: true });
await cp("wrangler.jsonc", `${OUT}/wrangler.jsonc`);

// 2) shells: deploy the readable original as <name>.src.js, minify the served file
for (const [file, srcPath, marker] of SHELLS) {
  const src = await readFile(`holding/${file}`, "utf8");
  await writeFile(`${OUT}/holding/${srcPath.slice(1)}`, src);

  const { code } = await transform(src, { minify: true, target: "es2020" });
  const banner = `/*! minified at deploy - readable source: ${srcPath} */\n`;
  const min = banner + code;

  // tripwires: a transform that breaks these invariants must fail the deploy
  if (marker && !min.includes(marker)) {
    throw new Error(`${file}: minified output lost the "${marker}" marker`);
  }

  await writeFile(`${OUT}/holding/${file}`, min);
  console.log(`${file}: ${src.length} -> ${min.length} bytes (+ ${srcPath})`);
}

console.log(`staged ${OUT}/ - deploy with: wrangler deploy -c ${OUT}/wrangler.jsonc`);
