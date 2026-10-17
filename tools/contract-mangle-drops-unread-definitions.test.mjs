// ── step 5c drops custom-property definitions nothing reads ─────────────────
// design/tokens is the whole palette, and luna.css shipped all of it: 42 of its
// 174 custom properties were read by no page, script or Worker CSS on
// 2026-10-09 (205 B brotli). pruneUnread drops those from the staged
// stylesheets before the rename. A drop is only safe if the name is read
// nowhere, so these pin what counts as a read, the fixed point, and that only
// stylesheets are edited; the last case checks the real build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneUnread, definitionsIn, RESERVED } from "./lib/mangle-custom-properties.ts";
import { assert, ROOT, test } from "./contract-shared.ts";

const css = (rel) => rel.endsWith(".css");
const prune = (entries) => pruneUnread(new Map(entries), css);

test("a definition nothing reads is dropped, and one something reads is kept", () => {
  const { files, dropped } = prune([["a.css", ":root{--used:red;--unread:blue}.p{color:var(--used)}"]]);
  assert.deepEqual(dropped, ["--unread"]);
  assert.equal(files.get("a.css"), ":root{--used:red}.p{color:var(--used)}");
});

test("a read anywhere counts: another file, a script's getPropertyValue, a style() query, a comment", () => {
  const { dropped } = prune([
    ["a.css", ":root{--page:1;--script:2;--query:3;--noted:4}"],
    ["p.html", "<style>.q{width:var(--page)}</style>"],
    ["s.js", 'getComputedStyle(el).getPropertyValue("--script") // --noted'],
    ["b.css", "@container style(--query: 3){.x{color:red}}"],
  ]);
  assert.deepEqual(dropped, []);
});

test("it runs to a fixed point: a token only an unread token reads goes too", () => {
  const { files, dropped } = prune([["a.css", ":root{--a:var(--b);--b:var(--c);--c:1px;--kept:2}.x{margin:var(--kept)}"]]);
  assert.deepEqual(dropped, ["--a", "--b", "--c"]);
  assert.equal(files.get("a.css"), ":root{--kept:2}.x{margin:var(--kept)}");
});

test("reserved names stay, and only stylesheets are edited", () => {
  const tail = [...RESERVED][0];
  const { files, dropped } = prune([
    ["a.css", `:root{${tail}:1}`],
    ["p.html", '<b style="--attr:3"></b>'],
    ["s.js", 'el.style.cssText = "--js:1"'],
  ]);
  assert.deepEqual(dropped, [], "a reserved name is kept, and definitions outside stylesheets are not counted");
  assert.equal(files.get("p.html"), '<b style="--attr:3"></b>');
  assert.equal(files.get("s.js"), 'el.style.cssText = "--js:1"');
});

test("a name defined in a stylesheet and in markup loses only the stylesheet copy", () => {
  const { files, dropped } = prune([["a.css", ":root{--both:1}"], ["p.html", '<b style="--both:3"></b>']]);
  assert.deepEqual(dropped, ["--both"]);
  assert.equal(files.get("a.css"), ":root{}");
  assert.equal(files.get("p.html"), '<b style="--both:3"></b>', "markup is never edited");
});

test("a BEM selector is left alone, and the pass ends", () => {
  // `.tab--active:hover` looks like a definition of --active to DEFINITION, and
  // the first version looped forever trying to remove it
  const { files, dropped } = prune([["a.css", ".tab--active:hover{color:red}:root{--unread:1}"]]);
  assert.deepEqual(dropped, ["--unread"]);
  assert.equal(files.get("a.css"), ".tab--active:hover{color:red}:root{}");
});

test("a name is matched whole, never as a prefix of a longer one", () => {
  const { files, dropped } = prune([["a.css", ":root{--blue-9:1;--blue-95:2}.x{color:var(--blue-95)}"]]);
  assert.deepEqual(dropped, ["--blue-9"]);
  assert.equal(files.get("a.css"), ":root{--blue-95:2}.x{color:var(--blue-95)}");
});

// The staged tree after the build: every definition in a shipped stylesheet is
// read by some served file, which is the property the pass is for.
const BUILT = fileURLToPath(new URL(".build/public/", ROOT));
test("every definition in a built stylesheet is read somewhere", { skip: !existsSync(BUILT) && "needs a built tree: bun run build" }, () => {
  const texts = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/^(i|images|og|cars|pd)$/.test(e.name)) walk(p); }
      else if (/\.(css|html|js)$/.test(e.name) && !/\.src\.(css|html|js)$/.test(e.name)) texts.push([p, readFileSync(p, "utf8")]);
    }
  };
  walk(BUILT);
  const sheets = texts.filter(([p]) => p.endsWith(".css"));
  assert.ok(sheets.length >= 5, `only ${sheets.length} stylesheets: the walk is reading the wrong tree`);
  const unread = [];
  for (const [p, text] of sheets) for (const name of definitionsIn(text)) {
    if (RESERVED.has(name)) continue;
    // every metacharacter escaped, backslash included, though names are [a-z0-9-]
    const re = new RegExp(`${name.replace(/[\\^$.*+?()[\]{}|-]/g, (c) => `\\${c}`)}(?![a-z0-9-])(?!\\s*:)`);
    if (!texts.some(([, t]) => re.test(t))) unread.push(`${p.slice(BUILT.length)} ${name}`);
  }
  assert.deepEqual(unread, []);
});
