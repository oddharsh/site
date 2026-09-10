// Browser contract for the Menu consumed by /writing. Run against a local built
// site, e.g. node tools/check-xp-menu.ts http://127.0.0.1:8799. Uses an isolated
// Chrome profile; edits remain in the page's ephemeral textareas.
import assert from "node:assert/strict";
import { chromium, type Locator } from "playwright-core";

const target = new URL(process.argv[2] || "http://127.0.0.1:8799");
if (process.argv.length > 3 || target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
  throw new Error("usage: node tools/check-xp-menu.ts http://127.0.0.1:PORT (local preview only)");
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
const notepadScripts = new Set<string>();
cdp.on("Debugger.scriptParsed", (script) => {
  if (/\/(?:a\/)?notepad(?:\.[a-f0-9]{8})?\.js$/.test(script.url)) notepadScripts.add(script.scriptId);
});
await cdp.send("Debugger.enable");
async function documentClickListeners() {
  const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
  assert.ok(result.objectId);
  try {
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
    assert.ok(notepadScripts.size > 0, "the built Notepad script must have loaded");
    return listeners.filter((listener) => listener.type === "click" && notepadScripts.has(listener.scriptId)).length;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
async function focused(locator: Locator) {
  assert.equal(await locator.evaluate((element) => element === document.activeElement), true, "expected keyboard focus");
}
try {
  await page.goto(new URL("/writing", target).href);
  const files = page.locator(".np-files a[data-note]");
  assert.ok(await files.count() >= 2, "multi-window contract needs two real notes");
  const permalink = await files.first().getAttribute("href");
  assert.ok(permalink);
  assert.equal(await page.locator(".np-note .np-menubar button").count(), 0, "unopened notes have no menu setup work");
  await files.first().click();
  assert.equal(await page.locator(".np-note:not(:popover-open) .np-menubar button").count(), 0, "opening one note does not initialize the rest");
  const note = page.locator(".np-note:popover-open");
  const bar = note.getByRole("menubar");
  const text = note.getByRole("textbox");
  assert.equal(await page.locator(".np-drop").count(), 0, "dropdowns are rendered on demand");
  assert.equal(await documentClickListeners(), 0, "no Notepad document click listeners while idle");
  assert.equal(await bar.locator("button[tabindex='0']").count(), 1, "one Tab stop per menubar");
  await focused(text);
  await page.keyboard.press("Shift+Tab");
  await focused(bar.getByRole("menuitem", { name: "File", exact: true }));
  await page.keyboard.press("ArrowRight");
  await focused(bar.getByRole("menuitem", { name: "Edit", exact: true }));
  await page.keyboard.press("End");
  await focused(bar.getByRole("menuitem", { name: "Help", exact: true }));
  await page.keyboard.press("ArrowRight");
  await focused(bar.getByRole("menuitem", { name: "File", exact: true }));
  await page.keyboard.press("ArrowUp");
  await focused(bar.locator("[data-np-action='exit']"));
  assert.equal(await documentClickListeners(), 1, "one document click listener while a menu is open");
  await page.keyboard.press("ArrowDown");
  await focused(bar.locator("[data-np-action='new']"));
  await page.keyboard.press("ArrowUp");
  await focused(bar.locator("[data-np-action='exit']"));
  await page.keyboard.press("Home");
  await focused(bar.locator("[data-np-action='new']"));
  await page.keyboard.press("p");
  await focused(bar.locator("[data-np-action='print']"));
  assert.equal(await bar.getByRole("separator").count(), 1);
  await page.keyboard.press("ArrowRight");
  await focused(bar.locator("[data-np-action='undo']"));
  assert.equal(await bar.getByRole("menu", { name: "Edit", exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  await focused(bar.getByRole("menuitem", { name: "Edit", exact: true }));
  assert.equal(await note.count(), 1, "first Escape closes only the menu");
  assert.equal(await documentClickListeners(), 0, "Escape removes the document listener");
  assert.equal(await page.locator(".np-drop").count(), 0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await focused(text);
  assert.equal(await page.locator(".np-drop").count(), 0, "Tab closes the dropdown");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await bar.evaluate((element) => element.contains(document.activeElement)), false, "Shift+Tab leaves the composite");
  assert.equal(await page.locator(".np-drop").count(), 0);

  const originalText = await text.inputValue();
  for (const key of ["Enter", "Space"]) {
    await bar.getByRole("menuitem", { name: "File", exact: true }).focus();
    await page.keyboard.press(key);
    await focused(bar.locator("[data-np-action='new']"));
    assert.equal(await text.inputValue(), originalText, "opening a menu must not activate its first action");
    await page.keyboard.press("Escape");
  }

  await bar.getByRole("menuitem", { name: "Format", exact: true }).click();
  const wrap = bar.getByRole("menuitemcheckbox", { name: "Word Wrap", exact: true });
  assert.equal(await wrap.getAttribute("aria-checked"), "true");
  await page.keyboard.press("Space");
  assert.equal(await text.getAttribute("wrap"), "off", "native Space invokes the checkbox once");
  await bar.getByRole("menuitem", { name: "Format", exact: true }).click();
  assert.equal(await wrap.getAttribute("aria-checked"), "false");
  await page.keyboard.press("Enter");
  assert.equal(await text.getAttribute("wrap"), "soft");
  await focused(bar.getByRole("menuitem", { name: "Format", exact: true }));
  await bar.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await focused(text);
  assert.equal(await text.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length;
  }), true, "the action still selects the canonical note text");
  await bar.getByRole("menuitem", { name: "File", exact: true }).click();
  await bar.getByRole("menuitem", { name: "View", exact: true }).hover();
  assert.equal(await bar.getByRole("menuitemcheckbox", { name: "Status Bar", exact: true }).count(), 1);
  await text.click();
  assert.equal(await page.locator(".np-drop").count(), 0, "outside focus dismisses without stealing focus");
  await focused(text);

  // Keep both notes open and move between their menus. Each owns its own state,
  // while the page has at most one active dropdown.
  // The first floating window can cover this link; keyboard navigation remains available.
  await files.nth(1).focus();
  await page.keyboard.press("Enter");
  assert.equal(await note.count(), 2);
  const second = note.nth(1);
  const firstFile = note.first().getByRole("menuitem", { name: "File", exact: true });
  await firstFile.focus();
  await page.keyboard.press("ArrowDown");
  // Programmatic activation exercises the nonhuman path without a preceding
  // pointer focus change that could hide a broken shared-menu ownership rule.
  await second.getByRole("menuitem", { name: "File", exact: true }).evaluate((element) => (element as HTMLElement).click());
  assert.equal(await firstFile.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".np-drop").count(), 1);
  assert.equal(await documentClickListeners(), 1, "additional windows do not multiply document listeners");
  await second.evaluate((element) => (element as HTMLElement).hidePopover());
  assert.equal(await page.locator(".np-drop").count(), 0, "hiding the note disposes its open menu");
  assert.equal(await documentClickListeners(), 0, "hiding the note removes the listener");
  await bar.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await note.count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await note.count(), 0, "second Escape closes the note");

  await files.first().click();
  assert.equal(await note.getByRole("menubar").locator("button.np-menu").count(), 5, "reopening does not duplicate setup");
  await note.getByRole("menuitem", { name: "File", exact: true }).click();
  assert.equal(await documentClickListeners(), 1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.goto(new URL(permalink, target).href);
  const standalone = page.locator(".np-window");
  await standalone.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.keyboard.press("Tab");
  await focused(standalone.getByRole("textbox"));
  assert.equal(await page.locator(".np-drop").count(), 0);
  assert.deepEqual(errors, [], "no browser script errors");
  console.log("XP Menu: keyboard, focus, actions, checkbox semantics, lazy dropdowns, multiple notes and standalone permalink pass");
} finally {
  await browser.close();
}
