import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "../src/worker/lib/xp/window.ts";
import { html, Html } from "../src/worker/lib/html.ts";

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

test("XP Window keeps a native close link and the shell enhancement hooks", () => {
  const markup = String(Window({ caption: "Terminal", windowClass: "terminal",
    contentClass: "console", windowAttrs: html`data-no-histnav`, closeHref: "/garage", closeLabel: "Return to Garage" }));
  assert.ok(markup.startsWith('<div class="window terminal" data-no-histnav>'));
  assert.ok(markup.includes('<div class="title-bar">'));
  assert.ok(markup.includes('<div class="content console">'));
  assert.ok(markup.includes('class="close" href="/garage"'));
  assert.ok(markup.includes('aria-label="Return to Garage"'));
});
