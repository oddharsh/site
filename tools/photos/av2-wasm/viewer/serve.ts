// serve.ts: the local AV2 viewer. Serves the page, the decoder /garage/av2
// ships (its worker module and .wasm, at their site paths), a sample corpus,
// and the site's own Luna stylesheets.
//   bun tools/photos/av2-wasm/viewer/serve.ts [corpus-dir]
// The corpus dir needs a sets.json listing [{title, files: [{name, label}]}];
// any .avif can also be dropped onto the page.
const here = import.meta.dir;
const site = `${here}/../../../..`;
const corpus = process.argv[2] ?? `${here}/../build/corpus`;
const roots: [string, string][] = [
  ["/garage/av2-decode.js", `${site}/src/client/garage/av2-decode.ts`],
  ["/garage/av2/", `${site}/public/garage/av2/`],
  ["/corpus/", `${corpus}/`],
  ["/luna.css", `${site}/src/styles/luna.css`],
  ["/prose.css", `${site}/src/styles/prose.css`],
];
const port = +(process.env.PORT || 8812);
Bun.serve({
  port,
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p.includes("..")) return new Response("bad path", { status: 400 });
    let file = p === "/" ? `${here}/index.html` : null;
    for (const [pre, dir] of roots) if (!file && p.startsWith(pre)) file = pre.endsWith("/") ? dir + p.slice(pre.length) : dir;
    const f = file ? Bun.file(file) : null;
    if (!f || !(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "cache-control": "no-store" } });
  },
});
console.log(`AV2 viewer on http://localhost:${port} (corpus ${corpus})`);
