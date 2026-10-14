// ── the client asset registry, and the hasher that runs over a directory ────
// tools/lib/client-assets.ts holds ONE declaration per client asset, and
// build.ts step 6 is tools/lib/hash-client-assets.ts called with the staged
// root. Every /a/ URL on the site comes out of that pair, so this file pins it
// without a build: the hasher takes a directory, so it runs here against a
// temp dir holding three fixture files.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import {
  CLIENT_ASSETS, budgetedAssets, hashOrder, loaderRewrites, minifiedScripts, minifiedStyles, readableTwins,
  registryProblems, stagedPath, twinOracleRows, unbudgetedAssets,
} from "./lib/client-assets.ts";
import { hashClientAssets } from "./lib/hash-client-assets.ts";

/** @typedef {import("./lib/client-assets.ts").ClientAsset} ClientAsset */

const sha8 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

/** @type {ClientAsset} */
const LEAF = { file: "leaf.js", kind: "script", marker: "leaf", scope: "shell", budget: "unbudgeted",
  load: [{ via: "import" }], loadedBy: ["public/island.js", "public/index.html"] };
/** @type {ClientAsset} */
const ISLAND = { file: "sub/island.js", kind: "script", marker: "island", base: "island", scope: "page", budget: "unbudgeted",
  load: [{ via: "attr", attr: "src" }], loadedBy: ["public/index.html"] };
/** @type {ClientAsset} */
const SHEET = { file: "sheet.css", kind: "style", scope: "shell", budget: "unbudgeted",
  load: [{ via: "attr", attr: "href" }], loadedBy: ["public/index.html", "src/worker/page.ts"] };
/** @type {ClientAsset[]} */
const FIXTURE = [{ ...LEAF, loadedBy: ["public/sub/island.js", "public/index.html"] }, ISLAND, SHEET];

const FILES = {
  "public/leaf.js": "/*! leaf */export const leaf=1;",
  "public/sub/island.js": '/*! island */import("/leaf.js").then(()=>{});',
  "public/sheet.css": "/*! sheet */.a{color:red}",
  "public/index.html": '<link rel=stylesheet href=/sheet.css><script src="/sub/island.js" defer></script><script type=module>import("/leaf.js")</script><p>the file <code>/leaf.js</code> and "/sheet.css" in prose</p>',
  "public/index.src.html": '<link rel="stylesheet" href="/sheet.css"><script src="/sub/island.js"></script>',
  "src/worker/page.ts": 'export const head = "<link rel=\\"stylesheet\\" href=\\"/sheet.css\\">";',
};

const stage = (files = FILES) => {
  const root = mkdtempSync(join(tmpdir(), "client-assets-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};
const snapshot = (root) => {
  const out = {};
  for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const full = join(root, rel);
    if (statSync(full).isFile()) out[rel] = readFileSync(full, "utf8");
  }
  return out;
};
const withStage = async (files, fn) => {
  const root = stage(files);
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("the hasher, over a directory: each asset gets one /a/ copy naming its final bytes, and every loader is repointed", async () => {
  await withStage(FILES, async (root) => {
    const { urls } = await hashClientAssets(root, { assets: FIXTURE });
    const after = snapshot(root);
    assert.equal(urls["leaf.js"], `/a/leaf.${sha8(FILES["public/leaf.js"])}.js`);
    const islandFinal = `/*! island */import("${urls["leaf.js"]}").then(()=>{});`;
    assert.equal(after["public/sub/island.js"], islandFinal, "the staged island carries the leaf's hashed URL");
    assert.equal(urls["sub/island.js"], `/a/island.${sha8(islandFinal)}.js`, "the island's hash covers its final bytes, under its flat base");
    assert.equal(after[`public${urls["sub/island.js"]}`], islandFinal, "and the /a/ copy is those bytes");
    assert.equal(after[`public${urls["leaf.js"]}`], FILES["public/leaf.js"]);
    assert.equal(urls["sheet.css"], `/a/sheet.${sha8(FILES["public/sheet.css"])}.css`);
    assert.equal(
      after["public/index.html"],
      `<link rel=stylesheet href=${urls["sheet.css"]}><script src="${urls["sub/island.js"]}" defer></script><script type=module>import("${urls["leaf.js"]}")</script><p>the file <code>/leaf.js</code> and "/sheet.css" in prose</p>`,
      "loaders are repointed and the prose mentions are not",
    );
    assert.equal(after["src/worker/page.ts"], `export const head = "<link rel=\\"stylesheet\\" href=\\"${urls["sheet.css"]}\\">";`, "a backslash-quoted attribute in a Worker module is repointed");
    assert.equal(after["public/index.src.html"], FILES["public/index.src.html"], "the readable twin keeps the plain URLs");
  });
});

test("declaration order cannot change a byte: the registry reversed hashes to the same tree", async () => {
  const forward = await withStage(FILES, async (root) => { await hashClientAssets(root, { assets: FIXTURE }); return snapshot(root); });
  const reversed = await withStage(FILES, async (root) => { await hashClientAssets(root, { assets: [...FIXTURE].reverse() }); return snapshot(root); });
  assert.deepEqual(reversed, forward);
  assert.deepEqual(hashOrder([...FIXTURE].reverse()).map((a) => a.file), ["sheet.css", "leaf.js", "sub/island.js"], "the island waits for its leaf whichever is declared first");
});

test("CONTROL: an edge the registry does not declare is refused, because the order was derived without it", async () => {
  /** @type {ClientAsset[]} */
  const undeclared = [ISLAND, { ...LEAF, loadedBy: ["public/index.html"] }, SHEET];
  await withStage(FILES, async (root) => {
    await assert.rejects(hashClientAssets(root, { assets: undeclared }), /public\/sub\/island\.js loads \/leaf\.js, but leaf\.js's loadedBy does not list it/);
    const stale = readdirSync(join(root, "public/a")).find((n) => n.startsWith("island.")) ?? "";
    assert.ok(readFileSync(join(root, "public/a", stale), "utf8").includes('import("/leaf.js")'), "the fixture really does reach the stale-copy state the check refuses");
  });
});

test("CONTROL: a declared loader that no longer names the asset the way its pattern matches fails by name", async () => {
  const moved = { ...FILES, "public/index.html": FILES["public/index.html"].replace('<script src="/sub/island.js" defer></script>', '<link rel=modulepreload href="/sub/island.js">') };
  await withStage(moved, async (root) => {
    await assert.rejects(hashClientAssets(root, { assets: FIXTURE }), /public\/index\.html was not repointed to \/a\/island\.[0-9a-f]{8}\.js/);
  });
  const noWorker = Object.fromEntries(Object.entries(FILES).filter(([rel]) => rel !== "src/worker/page.ts"));
  await withStage(noWorker, async (root) => {
    await assert.rejects(hashClientAssets(root, { assets: FIXTURE }), /src\/worker\/page\.ts, declared in sheet\.css's loadedBy, is not in the staged tree/);
  });
});

test("CONTROL: a dependency cycle and a malformed declaration are refused before anything is written", async () => {
  const a = { ...LEAF, file: "a.js", loadedBy: ["public/b.js"] };
  const b = { ...LEAF, file: "b.js", loadedBy: ["public/a.js"] };
  assert.throws(() => hashOrder([a, b]), /a dependency cycle among a\.js, b\.js/);
  assert.deepEqual(registryProblems(FIXTURE), []);
  assert.match(registryProblems([LEAF, { ...LEAF }]).join("\n"), /leaf\.js is declared twice/);
  assert.match(registryProblems([LEAF, { ...ISLAND, base: "leaf" }]).join("\n"), /would both hash to \/a\/leaf\.<hash8>\.js/);
  assert.match(registryProblems([{ ...ISLAND, base: undefined, file: "sub/is.land.js" }]).join("\n"), /must match \[\\w-\]\+/);
  assert.match(registryProblems([{ ...LEAF, loadedBy: [] }]).join("\n"), /declares no loadedBy witness/);
  assert.match(registryProblems([{ ...LEAF, load: [] }]).join("\n"), /declares no loader/);
  await withStage(FILES, async (root) => {
    await assert.rejects(hashClientAssets(root, { assets: [LEAF, { ...LEAF }] }), /declared twice/);
    assert.deepEqual(snapshot(root), Object.fromEntries(Object.entries(FILES)), "nothing was written");
  });
});

test("each loader shape rewrites its own syntax and leaves a bare mention of the path alone", () => {
  const asset = (file) => ({ ...LEAF, file });
  const run = (a, loader, text) => loaderRewrites(a, loader, "/a/X").reduce((t, [re, sub]) => t.replace(re, sub), text);
  assert.equal(run(asset("hoist.js"), { via: "import" }, 'import("/hoist.js");import(`/hoist.js`);see "/hoist.js"'), 'import("/a/X");import(`/a/X`);see "/hoist.js"');
  assert.equal(run(asset("hoist.js"), { via: "after", prefix: "\\bfrom\\s*" }, 'import {a} from "/hoist.js"; path:"/hoist.js"'), 'import {a} from "/a/X"; path:"/hoist.js"');
  assert.equal(run(asset("lens.js"), { via: "import", query: "?v=1" }, 'import("/lens.js?v=1");import("/lens.js")'), 'import("/a/X");import("/lens.js")');
  assert.equal(run(asset("lens-wire.js"), { via: "string", query: "?v=1" }, 's.src="/lens-wire.js?v=1";"/lens-wire.js"'), 's.src="/a/X";"/lens-wire.js"');
  assert.equal(run(asset("garage/pretext.lib.js"), { via: "import", also: ["./pretext.lib.js"] }, 'import("./pretext.lib.js");import("/garage/pretext.lib.js");<code>/garage/pretext.lib.js</code>'), 'import("/a/X");import("/a/X");<code>/garage/pretext.lib.js</code>');
  assert.equal(run(asset("pixel-peeper/manifest.json"), { via: "fetch" }, "fetch('/pixel-peeper/manifest.json')"), "fetch('/a/X')");
  assert.equal(run(asset("nav-run.css"), { via: "after", prefix: '"nav-run"\\s*:\\s*' }, '{"nav-run":"/nav-run.css",other:"/nav-run.css"}'), '{"nav-run":"/a/X",other:"/nav-run.css"}');
  const infotipCss = CLIENT_ASSETS.find((x) => x.file === "infotip.css");
  assert.ok(infotipCss);
  assert.equal(run(infotipCss, infotipCss.load[0], '{"infotip":"/infotip.css"}{infotip:"/infotip.css"}{noinfotip:"/infotip.css"}'), '{"infotip":"/a/X"}{infotip:"/a/X"}{noinfotip:"/infotip.css"}', "the source's quoted key and the minifier's bare one");
  assert.equal(run(asset("icons.svg"), { via: "attr", attr: "src", fragment: true }, '<img src="/icons.svg#pin-a"><img src=/icons.svg#pin-b> src="/icons.svg"'), '<img src="/a/X#pin-a"><img src=/a/X#pin-b> src="/icons.svg"');
  assert.equal(run(asset("nav.js"), { via: "attr", attr: "src" }, '<script src=/nav.js defer></script> path:"/nav.js" "!/nav.js" src=/nav.json>'), '<script src=/a/X defer></script> path:"/nav.js" "!/nav.js" src=/nav.json>');
});

const HAND_SORTED = [
  "nav-run.css", "nav-tray.css", "infotip.css", "quiz.css", "hoist.js", "webmcp.js", "nav-run.js", "nav-tray.js", "nav-pipes.js", "nav-tips.js",
  "lens-browser.js", "lens-reader.js", "lens-wire.js", "lens-tools.js", "lens-nlweb.js", "lens-markdown.js", "lens-webmcp.js", "lens.js",
  "tooltip.js", "infotip.js", "garage/pretext.lib.js", "garage/md-to-html.js", "garage/av2-decode.js", "dotfiles.js", "pixel-peeper/manifest.json",
  "nav.js", "luna.css", "lens-boot.js", "icons.svg", "serendipity.js", "quiz.js", "notepad.js", "lwe-base.css", "prose.css", "lwe/ask.js",
];

test("the derived hash order reproduces the hand-sorted one, and puts every asset after what it loads", () => {
  assert.deepEqual(registryProblems(), []);
  const order = hashOrder().map((a) => a.file);
  assert.deepEqual(order, HAND_SORTED);
  const registered = new Map(CLIENT_ASSETS.map((a) => [stagedPath(a), a.file]));
  let edges = 0;
  for (const a of CLIENT_ASSETS) {
    for (const rel of a.loadedBy) {
      const dependent = registered.get(rel);
      if (!dependent) continue;
      edges++;
      assert.ok(order.indexOf(a.file) < order.indexOf(dependent), `${a.file} must be hashed before ${dependent}, which loads it`);
    }
  }
  assert.ok(edges >= 20, `only ${edges} asset-to-asset edges resolved`);
  const rotated = hashOrder([...CLIENT_ASSETS.slice(11), ...CLIENT_ASSETS.slice(0, 11)]).map((a) => a.file);
  for (const a of CLIENT_ASSETS) for (const rel of a.loadedBy) {
    if (registered.has(rel)) assert.ok(rotated.indexOf(a.file) < rotated.indexOf(registered.get(rel) ?? ""));
  }
});

test("every declared asset-to-asset edge is a loader the dependent's SOURCE really carries", async () => {
  const sourceOf = (a) => (a.kind === "style" ? `src/styles/${a.file}` : a.kind === "static" ? `public/${a.file}` : `src/client/${a.file}`);
  const registered = new Map(CLIENT_ASSETS.map((a) => [stagedPath(a), a]));
  for (const a of CLIENT_ASSETS) {
    for (const rel of a.loadedBy) {
      const dependent = registered.get(rel);
      if (!dependent) continue;
      const src = await readFile(new URL(sourceOf(dependent), ROOT), "utf8");
      const matched = a.load.some((loader) => loaderRewrites(a, loader, "/a/X").some(([re]) => re.test(src)));
      assert.ok(matched, `${sourceOf(dependent)} does not load /${a.file} in any shape its registry row declares`);
    }
  }
});

test("perf-budget and the route oracle read projections of the same rows", () => {
  const minified = [...minifiedScripts().map((r) => r.file), ...minifiedStyles()];
  const budgeted = budgetedAssets().map((b) => b.file);
  const unbudgeted = unbudgetedAssets();
  assert.deepEqual([...budgeted, ...unbudgeted].sort(), [...minified].sort(), "every minified asset is either budgeted or declared unbudgeted");
  assert.equal(budgeted.length, 16);
  assert.deepEqual(budgetedAssets().find((b) => b.file === "nav.js")?.envelope, { role: "shared deferred shell", gzipKiB: 20, brotliKiB: 18 });
  assert.deepEqual([...unbudgeted].sort(), [
    "dotfiles.js", "garage/av2-decode.js", "garage/md-to-html.js", "garage/pretext.lib.js", "infotip.css", "infotip.js", "lens-markdown.js", "lens-nlweb.js", "lens-reader.js", "lens-wire.js",
    "lwe/ask.js", "nav-run.css", "nav-tray.css", "prose.css", "quiz.css", "serendipity.js", "webmcp.js",
  ]);
  assert.equal(readableTwins().length, minified.length, "one readable twin per minified asset");
  assert.ok(readableTwins().includes("lwe/ask.src.js") && readableTwins().includes("luna.src.css"));
  const rows = twinOracleRows();
  assert.equal(rows.length, minifiedScripts().length);
  assert.deepEqual(rows.find((r) => r.path === "/nav.src.js"), { path: "/nav.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "axp-histnav" });
});
