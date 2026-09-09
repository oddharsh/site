import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "../src/worker/lib/xp/window.ts";
import { PropertySheet } from "../src/worker/lib/xp/property-sheet.ts";
import { ExplorerList } from "../src/worker/lib/xp/explorer-list.ts";
import { Taskbar } from "../src/worker/lib/xp/taskbar.ts";
import { html, Html } from "../src/worker/lib/html.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = fileURLToPath(new URL("./xp/Cargo.toml", import.meta.url));
execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", manifest], { cwd: root, timeout: 120_000 });
function native(mode, input = "") {
  return execFileSync("cargo", ["run", "--quiet", "--release", "--locked", "--manifest-path", manifest, "--", mode], {
    cwd: root, input, encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
  });
}

test("Window generated types and rendering are current with the native definition", () => {
  assert.equal(readFileSync(new URL("../src/worker/lib/xp/window.ts", import.meta.url), "utf8"), native("typescript"));
  const values = [];
  const expected = [];
  for (let bits = 0; bits < 128; bits++) {
    const plain = { caption: 'Snow 雪 <&> "title"',
      windowClass: bits & 1 ? 'terminal "&' : "", titleClass: bits & 2 ? "custom" : "",
      contentClass: bits & 4 ? "console" : "", closeTitle: bits & 8 ? "Custom <close>" : undefined,
      closeLabel: bits & 16 ? "Go back" : undefined,
      windowAttrs: bits & 32 ? "" : undefined, body: bits & 64 ? "<p>Body</p>" : undefined,
    };
    values.push(plain);
    expected.push(String(Window({ ...plain,
      windowAttrs: plain.windowAttrs === undefined ? undefined : new Html(plain.windowAttrs),
      body: plain.body === undefined ? undefined : new Html(plain.body),
    })));
  }
  assert.deepEqual(JSON.parse(native("render-batch", JSON.stringify(values))), expected);
});

test("native Window batch refuses invalid input without partial output", () => {
  for (const value of [[{ caption: "valid" }, { caption: false }], [{ caption: "valid", unexpected: true }]]) {
    assert.throws(() => native("render-batch", JSON.stringify(value)), (error) => {
      assert.ok(error instanceof Error && "stdout" in error && "status" in error);
      assert.equal(error.stdout, "");
      assert.ok(error.status !== 0);
      return true;
    });
  }
});

test("PropertySheet native and generated renderers preserve typed rows and escaping", () => {
  assert.equal(readFileSync(new URL("../src/worker/lib/xp/property-sheet.ts", import.meta.url), "utf8"), native("typescript-property-sheet"));
  const cases = [{ rows: [] }, { rows: [{ term: 'Name <&>', value: 'Snow 雪 "tea"' }, { term: "", value: "" }] }];
  const expected = cases.map((value) => String(PropertySheet(value)));
  assert.deepEqual(JSON.parse(native("render-property-sheet-batch", JSON.stringify(cases))), expected);
  assert.equal(expected[0], "<dl></dl>");
  assert.equal(expected[1], '<dl><dt>Name &lt;&amp;&gt;</dt><dd>Snow 雪 &quot;tea&quot;</dd><dt></dt><dd></dd></dl>');
  for (const value of [{ rows: "bad" }, { rows: [null] }, { rows: [{ term: "missing value" }] }, { rows: [{ term: "x", value: "y", extra: true }] }]) {
    assert.throws(() => native("render-property-sheet-batch", JSON.stringify([{ rows: [] }, value])), (error) => {
      assert.ok(error instanceof Error && "stdout" in error);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});

test("XP Window composes trusted slots and escapes text and attributes", () => {
  const frame = Window({
    caption: '<img src=x onerror="bad">',
    body: html`<p>${"<article>"}</p>`,
    address: html`<nav>address</nav>`, pane: html`<aside>details</aside>`,
    windowClass: '" onclick="bad', closeHref: '/?x="&y=1',
    closeTitle: 'Close "window"',
  });
  assert.ok(frame instanceof Html);
  const markup = String(frame);
  assert.ok(markup.includes('&lt;img src=x onerror=&quot;bad&quot;&gt;'));
  assert.ok(markup.includes('<p>&lt;article&gt;</p>'));
  assert.ok(markup.includes('<nav>address</nav>'));
  assert.ok(markup.includes('<aside>details</aside>'));
  assert.ok(markup.includes('class="window &quot; onclick=&quot;bad"'));
  assert.ok(markup.includes('href="/?x=&quot;&amp;y=1"'));
  assert.ok(markup.includes('aria-label="Close &quot;window&quot;"'));
});

test("Taskbar shares native frame semantics with the generated desktop component", () => {
  assert.equal(readFileSync(new URL("../src/worker/lib/xp/taskbar.ts", import.meta.url), "utf8"), native("typescript-taskbar"));
  const cases = [{ pins: "", tray: "" }, { pins: '<a href="/garage">Garage</a>', tray: '<div id="axp-tray">雪</div>' }];
  const expected = cases.map(({ pins, tray }) => String(Taskbar({ pins: new Html(pins), tray: new Html(tray) })));
  assert.deepEqual(JSON.parse(native("render-taskbar-batch", JSON.stringify(cases))), expected);
  for (const output of expected) {
    assert.ok(output.startsWith('<div id="axp-taskbar" role="navigation" aria-label="taskbar">'));
    assert.ok(output.includes('href="/run" aria-haspopup="dialog" aria-expanded="false"'));
    assert.ok(output.includes('<span class="axp-kbd" aria-hidden="true">⌘K</span>'));
  }
  assert.ok(expected[1].includes('<div id="axp-pins"><a href="/garage">Garage</a></div><div id="axp-spacer"></div><div id="axp-tray">雪</div>'));
  assert.throws(() => native("render-taskbar-batch", JSON.stringify([cases[0], { pins: "" }])), (error) => {
    assert.ok(error instanceof Error && "stdout" in error);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("ExplorerList preserves native links, glyph fallback, and row ordering", () => {
  assert.equal(readFileSync(new URL("../src/worker/lib/xp/explorer-list.ts", import.meta.url), "utf8"), native("typescript-explorer-list"));
  const cases = [{ items: [] }, { items: [
    { href: '/?q="&x=1', label: '<Snow 雪>' },
    { href: "/two", label: "Second", glyph: "" },
    { href: "/three", label: "Third", glyph: "<&" },
  ] }];
  const expected = cases.map((value) => String(ExplorerList(value)));
  assert.deepEqual(JSON.parse(native("render-explorer-list-batch", JSON.stringify(cases))), expected);
  assert.equal(expected[0], "<ul></ul>");
  assert.equal(expected[1], '<ul><li><span class="axp-glyph" aria-hidden="true">›</span><a href="/?q=&quot;&amp;x=1">&lt;Snow 雪&gt;</a></li><li><span class="axp-glyph" aria-hidden="true">›</span><a href="/two">Second</a></li><li><span class="axp-glyph" aria-hidden="true">&lt;&amp;</span><a href="/three">Third</a></li></ul>');
  assert.throws(() => native("render-explorer-list-batch", JSON.stringify([{ items: [] }, { items: [{ href: "/" }] }])), (error) => {
    assert.ok(error instanceof Error && "stdout" in error);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("XP Window keeps a native close link and the shell enhancement hooks", () => {
  const markup = String(Window({ caption: "Terminal", windowClass: "terminal",
    contentClass: "console", windowAttrs: html`data-no-histnav`, closeHref: "/garage", closeLabel: "Return to Garage" }));
  assert.ok(markup.startsWith('<div class="window terminal" data-no-histnav>'));
  assert.ok(markup.includes('<div class="title-bar">'));
  assert.ok(markup.includes('<div class="content console">'));
  assert.ok(markup.includes('class="close" href="/garage"'));
  assert.ok(markup.includes('aria-label="Return to Garage"'));
});
