#!/usr/bin/env node
// check-interactions.ts: `bun run act:check`. Every control on every page,
// operated once.
//
//   bun run act:check                       # build, boot the Worker in-process, operate everything
//   bun run act:check -- --only /lwe/dac    # some pages
//   bun run act:check -- --list             # count the controls and operate nothing
//
// browser:check reads a page while it loads and stops (gotcha 108). The site's substance is
// what happens after: the demos, sliders, filters, pickers. This opens each
// manifest surface at 390px, finds the controls inside the page's own content,
// reads what a keyboard and a screen reader get from each one, operates it
// the way a thumb would, and reads what that caused. Eight readings:
//
//   name    Chrome's accessibility tree has no name for it, so a screen reader
//           announces "button" and nothing else (gotcha 110).
//   focus   the Tab key can't land on it.
//   ring    nothing on screen changes when the keyboard does land on it.
//   key     it is not a native control, and answers a click but neither Enter
//           nor Space.
//   error   the control threw.
//   dead    nothing observable happened: no DOM change, no canvas draw, no
//           request, no sound, no navigation. A control that does nothing is
//           a broken demo or a leftover.
//   slow    one task blocked the main thread past SLOW_MS, under 4x CPU
//           throttle. That is a slider that stutters on a phone.
//   scroll  the page is wider than its box afterwards (gotcha 97): a toggle
//           that swaps in a wide table.
//
// It runs against the local Worker ONLY, and has no --base on purpose: it
// presses every button it finds, and a deployment has real writes behind some
// of them. Submit buttons and links that leave the page are never pressed.
//
// config/interaction-budget.json holds the exceptions, each with its reason,
// keyed by page and control. An entry its control no longer needs is reported.
//
// THE CONTROLS RUN EVERY TIME, on /search, before the sweep: eight planted
// controls, one per reading. One throws, one has no handler, one spins for
// 400 ms, one pushes a 600px block into the page, one has no text, one is a
// span that takes no focus, one has its focus ring removed and one answers
// only a click. Three of them must fail their own reading and no other, which
// proves the keyboard readings pass a control that is fine. A reading that
// misses its plant exits 2 ("blind").
import { chromium } from "playwright-core";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { overflows } from "./lib/browser-readings.ts";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { only: { type: "string" }, list: { type: "boolean" } } });

/** One blocking task longer than this, under 4x throttle, is a stutter. */
const SLOW_MS = 300;
/** After an action: long enough for a handler's rAF, fetch and redraw to land. */
const SETTLE_MS = 250;
/** How much longer a press that has caused nothing yet is given before it reads dead. */
const LATE_MS = 750;
/** Controls operated per page. A page with more names how many it skipped. */
const PER_PAGE = 60;
const PARALLEL = 3;
// /rn answers 302 to Spotify, so there is no page of ours to operate.
const OFFSITE = new Set(["/rn"]);

type Verdict = "dead" | "slow" | "error" | "scroll" | "name" | "focus" | "ring" | "key";
type Budget = Record<string, Record<string, { allow: Verdict[]; why: string }>>;
const budget: Budget = JSON.parse(readFileSync(`${root}config/interaction-budget.json`, "utf8")).pages;
const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
const only = values.only?.split(",");
const paths = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p) && (!only || only.includes(p)));

declare global {
  var __act: { effects: string[]; longest: number; mark(): void };
}

/** Installed before any page script: notes everything a control could cause. */
function instrument() {
  const act: typeof globalThis.__act = {
    effects: [],
    longest: 0,
    mark() {
      act.effects.length = 0;
      act.longest = 0;
    },
  };
  globalThis.__act = act;
  const saw = (what: string) => {
    if (!act.effects.includes(what)) act.effects.push(what);
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) act.longest = Math.max(act.longest, entry.duration);
  }).observe({ type: "longtask" });
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver((records) => {
      for (const r of records) {
        // The shell is not the page answering. nav.js fills the taskbar, ticks
        // its clock and adds lazy stylesheets to <head> on its own schedule, and
        // with those counted the inert plant read alive in 1 run of 7. Every
        // shell element carries an axp- id or class (luna.css).
        const shell = (node: Node | null) => {
          const el = node instanceof Element ? node : (node?.parentElement ?? null);
          return !!el?.closest('head, [id^="axp-"], [class^="axp-"]');
        };
        const moved = [...r.addedNodes, ...r.removedNodes];
        if (shell(r.target) || (r.target === document.body && moved.length > 0 && moved.every((n) => shell(n) || n.nodeType !== Node.ELEMENT_NODE))) continue;
        // The pressed element's own state (aria-pressed, class) counts: a
        // toggle that only restyles itself did respond.
        saw(r.type === "childList" ? "dom" : r.type === "attributes" ? `attr:${r.attributeName}` : "text");
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const wrap = (proto: object | undefined, methods: string[], what: string) => {
    if (!proto) return;
    for (const method of methods) {
      if (!(method in proto)) continue;
      const real: (...args: unknown[]) => unknown = Reflect.get(proto, method);
      Reflect.set(proto, method, function (this: unknown, ...args: unknown[]) {
        saw(what);
        return Reflect.apply(real, this, args);
      });
    }
  };
  const draws = ["fillRect", "clearRect", "strokeRect", "fill", "stroke", "fillText", "strokeText", "drawImage", "putImageData"];
  wrap(globalThis.CanvasRenderingContext2D?.prototype, draws, "canvas");
  wrap(globalThis.OffscreenCanvasRenderingContext2D?.prototype, draws, "canvas");
  wrap(globalThis.WebGLRenderingContext?.prototype, ["drawArrays", "drawElements", "clear"], "canvas");
  wrap(globalThis.WebGL2RenderingContext?.prototype, ["drawArrays", "drawElements", "clear"], "canvas");
  wrap(globalThis.AudioContext?.prototype, ["resume", "createOscillator", "createBufferSource", "createGain"], "audio");
  wrap(globalThis.Clipboard?.prototype, ["writeText", "write", "readText", "read"], "clipboard");
  wrap(globalThis.Document?.prototype, ["execCommand"], "clipboard");
  wrap(globalThis.Storage?.prototype, ["setItem", "removeItem"], "storage");
  wrap(globalThis.History?.prototype, ["pushState", "replaceState"], "history");
  wrap(globalThis.Element?.prototype, ["scrollIntoView", "showPopover", "hidePopover", "requestFullscreen", "animate"], "view");
  wrap(globalThis.HTMLDialogElement?.prototype, ["showModal", "show", "close"], "view");
  wrap(globalThis.HTMLMediaElement?.prototype, ["play", "pause"], "audio");
  // a button that opens a file chooser does it by clicking a hidden input
  wrap(globalThis.HTMLElement?.prototype, ["click", "focus"], "view");
  wrap(globalThis.HTMLInputElement?.prototype, ["showPicker"], "view");
  wrap(globalThis.Worker?.prototype, ["postMessage"], "worker");
  wrap(globalThis, ["fetch", "open", "scrollTo", "scrollBy"], "request");
  addEventListener("hashchange", () => saw("history"));
  addEventListener("toggle", () => saw("view"), true);
}

type Control = { key: string; kind: "press" | "range" | "pick" | "type" | "check" };

/**
 * The controls in the page's own content, in document order, each with a key
 * that survives a redraw: its tag, id or a short path, and its label.
 */
const controlsIn = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden], [inert], [aria-hidden='true']");
    };
    const found: { key: string; kind: "press" | "range" | "pick" | "type" | "check" }[] = [];
    const counts = new Map<string, number>();
    const all = document.querySelectorAll(
      `${scope} :is(button, input, select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="switch"])`,
    );
    for (const el of all) {
      if (!visible(el) || el.matches(":disabled, [aria-disabled='true'], [data-plant]")) continue;
      const type = el.getAttribute("type") ?? "";
      // Never pressed: anything that submits a form or leaves the page, and
      // inputs a thumb can't fill from here.
      if (el.matches("[type='submit'], [type='reset'], [type='file'], [type='hidden'], [type='image']")) continue;
      if (el instanceof HTMLButtonElement && el.form && type !== "button") continue;
      const kind =
        el instanceof HTMLSelectElement
          ? "pick"
          : el instanceof HTMLTextAreaElement
            ? "type"
            : el instanceof HTMLInputElement
              ? type === "range"
                ? "range"
                : type === "checkbox" || type === "radio"
                  ? "check"
                  : type === "button"
                    ? "press"
                    : "type"
              : "press";
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.getAttribute("value") || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 24);
      const base = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : ""}${label ? ` "${label}"` : ""}`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      const key = n === 1 ? base : `${base} (${n})`;
      el.setAttribute("data-act", key);
      found.push({ key, kind });
    }
    return found;
  }, scope);

/** What a keyboard and a screen reader get from a control, read before it is pressed. */
type Reach = { name: string | null; focusable: boolean; ring: boolean; native: boolean };

/**
 * Three readings, taken through the DevTools protocol so they are the
 * browser's own answers. The NAME is the one Chrome's accessibility tree
 * computes, which is what a screen reader is handed. Whether Tab can LAND on
 * it is read by focusing it. The RING is read by forcing :focus-visible on it
 * and comparing what is drawn: a scripted focus after a press draws no ring in
 * Chrome, since :focus-visible follows the last input, and the first sweep read
 * 406 of 519 controls as ringless that way.
 */
async function reach(page: Page, cdp: CDPSession, control: Control): Promise<Reach | null> {
  const selector = `[data-act=${JSON.stringify(control.key)}]`;
  const el = page.locator(selector).first();
  if (!(await el.count()) || !(await el.isVisible())) return null;
  // Whatever the last press opened is closed first: a modal dialog makes the
  // rest of the page inert, and an inert control has no name and takes no focus.
  await page.evaluate(() => {
    for (const open of document.querySelectorAll(":popover-open")) if (open instanceof HTMLElement) open.hidePopover();
    for (const open of document.querySelectorAll("dialog[open]")) if (open instanceof HTMLDialogElement) open.close();
  });
  // On screen first. A content-visibility section that has not been scrolled to
  // is not rendered, and what is not rendered has no accessibility node and
  // takes no focus: read from the top of /garage/horizon, 27 buttons with
  // plain text labels had "no name".
  await el.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
  const name = nodes[0]?.ignored ? null : String(nodes[0]?.name?.value ?? "").trim() || null;
  // What focus is allowed to change: the control, the label that draws it (a
  // radio shown as its label, as /coffee's slots are), or its parent.
  const look = () =>
    el.evaluate((node) =>
      [node, node.closest("label"), node.parentElement]
        .filter((e) => e instanceof HTMLElement)
        .map((e) => {
          const s = getComputedStyle(e);
          return [
            s.outlineStyle,
            s.outlineWidth,
            s.outlineColor,
            s.outlineOffset,
            s.boxShadow,
            s.borderColor,
            s.borderWidth,
            s.backgroundColor,
            s.backgroundImage,
            s.color,
            s.textDecorationLine,
          ].join("|");
        })
        .join("\n"),
    );
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const before = await look();
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
  const ring = (await look()) !== before;
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  const seen = await el.evaluate((node) => {
    if (!(node instanceof HTMLElement)) return { focusable: false, native: false };
    node.focus({ preventScroll: true });
    const landed = document.activeElement === node;
    // In the tab order, or inside a group whose members the arrow keys reach.
    const roving = !!node.closest('[role="radiogroup"], [role="toolbar"], [role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [focusgroup]');
    node.blur();
    return { focusable: landed && (node.tabIndex >= 0 || roving), native: node.matches("button, input, select, textarea, summary, a[href]") };
  });
  return { name, ring, ...seen };
}

/** What a reach reading fails on. */
function reachVerdicts(r: Reach): Verdict[] {
  const failed: Verdict[] = [];
  if (!r.name) failed.push("name");
  if (!r.focusable) failed.push("focus");
  else if (!r.ring) failed.push("ring");
  return failed;
}

/** A control that is not a native one has to answer Enter or Space itself. */
async function answersKeys(page: Page, control: Control): Promise<boolean> {
  const el = page.locator(`[data-act=${JSON.stringify(control.key)}]`).first();
  if (!(await el.count()) || !(await el.isVisible())) return true;
  for (const key of ["Enter", " "]) {
    await page.evaluate(() => globalThis.__act.mark());
    await el.focus({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press(key);
    await page.waitForTimeout(SETTLE_MS);
    if (await page.evaluate(() => globalThis.__act.effects.length > 0)) return true;
  }
  return false;
}

type Outcome = { effects: string[]; longest: number; errors: string[]; scroll: string[]; gone?: true; left?: true; pressed?: boolean };

/** Operate one control the way a thumb would, then read what it caused. */
async function operate(page: Page, control: Control, errors: string[]): Promise<Outcome> {
  const el = page.locator(`[data-act=${JSON.stringify(control.key)}]`).first();
  if (!(await el.count()) || !(await el.isVisible())) return { effects: [], longest: 0, errors: [], scroll: [], gone: true };
  const before = page.url().split("#")[0];
  // A reader scrolls to a control before using it, and a demo that starts when
  // it nears the screen has to be given the time to: /lwe/smoothing's and
  // /lwe/encoding's selects read dead when changed from the top of the page.
  // Whatever the last control opened is closed first, or it sits on top of this one.
  await page.evaluate(() => {
    for (const open of document.querySelectorAll(":popover-open")) if (open instanceof HTMLElement) open.hidePopover();
    for (const open of document.querySelectorAll("dialog[open]")) if (open instanceof HTMLDialogElement) open.close();
  });
  // To the middle of the screen, then a pause: on a page of content-visibility
  // sections (/garage/horizon) the ones that scroll into view take their real
  // height and move the control, and a press aimed before that lands elsewhere.
  await el.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await el.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(100);
  errors.length = 0;
  await page.evaluate(() => globalThis.__act.mark());
  try {
    if (control.kind === "press" || control.kind === "check") {
      // What a thumb lands on at the control's centre. The control, something
      // inside it, or the label that wraps it (a radio drawn as its label, as
      // /coffee's slots are) is the control. Anything else is in the way.
      const over = await el.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top || node.contains(top) || top.contains(node) || (node instanceof HTMLInputElement && [...(node.labels ?? [])].some((l) => l.contains(top))))
          return null;
        return top.tagName.toLowerCase() + (top.id ? `#${top.id}` : "") + (top.classList.length ? `.${top.classList[0]}` : "");
      });
      if (over) return { effects: [], longest: 0, errors: [`a thumb can't reach it: ${over} is on top`], scroll: [] };
      await el.click({ timeout: 3000, noWaitAfter: true, force: true });
    } else if (control.kind === "type") await el.fill("fhe", { timeout: 3000 });
    else
      await el.evaluate((node, kind) => {
        if (kind === "range" && node instanceof HTMLInputElement) {
          // The far end from where it sits, which is the move that redraws most.
          const [min, max] = [Number(node.min || 0), Number(node.max || 100)];
          node.value = String(Number(node.value) - min > (max - min) / 2 ? min : max);
        } else if (node instanceof HTMLSelectElement) {
          node.selectedIndex = (node.selectedIndex + 1) % Math.max(1, node.options.length);
        }
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }, control.kind);
  } catch (e) {
    return { effects: [], longest: 0, errors: [`could not be operated: ${String(e).split("\n")[0].slice(0, 120)}`], scroll: [] };
  }
  await page.waitForTimeout(SETTLE_MS);
  // A button that answers late is not dead: /garage/horizon's "Read layout
  // shifts" writes its result 300 ms after the press. One more look, later.
  if (control.kind === "press" && !errors.length && !(await page.evaluate(() => globalThis.__act.effects.length))) await page.waitForTimeout(LATE_MS);
  if (page.url().split("#")[0] !== before) return { effects: ["navigation"], longest: 0, errors: [...errors], scroll: [], left: true };
  const read = await page.evaluate(() => ({ effects: [...globalThis.__act.effects], longest: globalThis.__act.longest }));
  // Only a pressed button is judged dead. A field, a slider, a select or a
  // radio holds what it was given, and that is an effect whether or not a
  // script answers it: a quiz's second radio enables nothing new, and
  // /garage/safari27's select is a CSS demo with no script at all. They are
  // still read for errors, stutter and width.
  return { ...read, errors: [...errors], scroll: await overflows(page), pressed: control.kind === "press" };
}

async function open(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.dismiss());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(instrument);
  await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(800);
  // One Tab, so the page knows a keyboard is in use: :focus-visible follows the
  // last input, and without a key press a focused button draws no ring at all.
  await page.keyboard.press("Tab");
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  return { page, errors, cdp };
}

/** What an outcome fails on. A selection that changed is not an effect: something has to answer it. */
function verdicts(o: Outcome): Verdict[] {
  const failed: Verdict[] = [];
  if (o.errors.length) failed.push("error");
  if (!o.left && !o.effects.length && !o.errors.length && o.pressed) failed.push("dead");
  if (o.longest > SLOW_MS) failed.push("slow");
  if (o.scroll.length) failed.push("scroll");
  return failed;
}

const context = (browser: Awaited<ReturnType<typeof chromium.launch>>) =>
  browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write"],
  });

/** Every reading for one control: what a keyboard and a screen reader get, then what a press causes. */
async function read(page: Page, cdp: CDPSession, control: Control, errors: string[]): Promise<{ outcome: Outcome; failed: Verdict[] } | null> {
  const reached = await reach(page, cdp, control);
  const outcome = await operate(page, control, errors);
  if (outcome.gone || !reached) return null;
  const failed = [...reachVerdicts(reached), ...verdicts(outcome)];
  if (control.kind === "press" && !reached.native && reached.focusable && !outcome.left && !(await answersKeys(page, control))) failed.push("key");
  return { outcome, failed };
}

async function controls(ctx: BrowserContext, base: string) {
  const { page, errors, cdp } = await open(ctx, `${base}/search`);
  await page.evaluate(() => {
    const main = document.querySelector("main");
    main?.insertAdjacentHTML(
      "beforeend",
      '<p id="plants"><button type="button" id="p-throw">throws</button><button type="button" id="p-dead">dead</button><button type="button" id="p-slow">slow</button>' +
        '<button type="button" id="p-noname" style="width:30px;height:20px"></button><span role="button" id="p-nofocus">no focus</span>' +
        '<button type="button" id="p-noring" style="all:unset">no ring</button><span role="button" tabindex="0" id="p-nokey">no key</span>' +
        '<button type="button" id="p-wide">wide</button></p>',
    );
    document.getElementById("p-throw")?.addEventListener("click", () => {
      throw new Error("planted");
    });
    document.getElementById("p-slow")?.addEventListener("click", () => {
      for (const until = performance.now() + 400; performance.now() < until;);
      document.getElementById("p-slow")?.setAttribute("data-pressed", "");
    });
    for (const id of ["p-noname", "p-nofocus", "p-noring", "p-nokey"]) {
      document.getElementById(id)?.addEventListener("click", () => document.getElementById(id)?.setAttribute("data-pressed", ""));
    }
    document.getElementById("p-wide")?.addEventListener("click", () => {
      main?.insertAdjacentHTML("beforeend", '<div id="planted" style="width:600px;height:1px"></div>');
    });
  });
  const found = await controlsIn(page, "#plants");
  const blind: string[] = [];
  const expect = async (id: string, verdict: Verdict, only = false) => {
    const control = found.find((c) => c.key.includes(`#${id}`));
    const got = (control && (await read(page, cdp, control, errors))?.failed) ?? [];
    if (!got.includes(verdict)) blind.push(`${verdict}: the planted #${id} read ${JSON.stringify(got)}`);
    // The plain plants also prove the keyboard readings pass a control that is fine.
    if (only && got.length !== 1) blind.push(`the planted #${id} should fail ${verdict} alone and read ${JSON.stringify(got)}`);
  };
  await expect("p-throw", "error", true);
  await expect("p-dead", "dead", true);
  await expect("p-slow", "slow", true);
  await expect("p-noname", "name");
  await expect("p-nofocus", "focus");
  await expect("p-noring", "ring");
  await expect("p-nokey", "key");
  // Last, since it leaves the page wide for whatever is read after it.
  await expect("p-wide", "scroll");
  await page.close();
  return blind;
}

async function sweep(ctx: BrowserContext, base: string) {
  const failures: string[] = [];
  const stale: string[] = [];
  const notes: string[] = [];
  const suspects: { path: string; control: Control; first: number }[] = [];
  let operated = 0;
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      let { page, errors, cdp } = await open(ctx, base + path);
      const found = await controlsIn(page, "main");
      if (values.list) {
        notes.push(`${String(found.length).padStart(3)}  ${path}`);
        await page.close();
        continue;
      }
      if (found.length > PER_PAGE) notes.push(`${path} has ${found.length} controls; the first ${PER_PAGE} were operated`);
      const allowed = budget[path] ?? {};
      const used = new Set<string>();
      for (const control of found.slice(0, PER_PAGE)) {
        const reading = await read(page, cdp, control, errors);
        if (!reading) continue;
        const { outcome, failed } = reading;
        operated++;
        const allow = new Set(allowed[control.key]?.allow);
        for (const verdict of failed) {
          if (allow.has(verdict)) {
            used.add(`${control.key}\n${verdict}`);
            continue;
          }
          if (verdict === "slow") {
            suspects.push({ path, control, first: outcome.longest });
            continue;
          }
          const detail =
            verdict === "error"
              ? outcome.errors[0]
              : verdict === "scroll"
                ? outcome.scroll[0]
                : verdict === "name"
                  ? "a screen reader has no name to announce for it"
                  : verdict === "focus"
                    ? "the Tab key can't land on it"
                    : verdict === "ring"
                      ? "nothing changes on screen when the keyboard lands on it"
                      : verdict === "key"
                        ? "it answers a click and neither Enter nor Space"
                        : `${control.kind === "press" ? "pressing" : "changing"} it caused nothing`;
          failures.push(`FAIL  ${verdict.padEnd(6)} ${path}  ${control.key}: ${detail}`);
        }
        // A control that left the page, or widened it, gets a fresh page for the next one.
        if (outcome.left || outcome.scroll.length) {
          await page.close();
          ({ page, errors, cdp } = await open(ctx, base + path));
          await controlsIn(page, "main");
        }
      }
      // An unused allowance is reported, except for "dead". Anything the page
      // does on its own while a button is being read (a clock, a late fetch)
      // counts as that button's effect, so an inert button reads alive now and
      // then: /garage/horizon's "Cut" did in 1 of 5 sweeps. That can hide a
      // dead button for a run; it must not call its allowance stale.
      for (const [key, { allow }] of Object.entries(allowed)) {
        for (const verdict of allow) {
          if (verdict !== "dead" && !used.has(`${key}\n${verdict}`)) stale.push(`${path}  ${key} is allowed ${verdict} and did not need it`);
        }
      }
      await page.close();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  // A slow press has to repeat on a fresh page, read alone. One reading is not
  // enough: /garage/horizon's "Pop out" read 338 ms in a sweep and 136 to 187 ms
  // in six presses on its own (2026-11-20), and a rewrite made to fix it
  // changed nothing. A press that blocks every time still fails.
  for (const { path, control, first } of suspects) {
    const { page, errors } = await open(ctx, base + path);
    await controlsIn(page, "main");
    const again = await operate(page, control, errors);
    await page.close();
    if (again.longest > SLOW_MS) {
      failures.push(
        `FAIL  ${"slow".padEnd(6)} ${path}  ${control.key}: one task blocked for ${Math.round(Math.min(first, again.longest))} ms, over ${SLOW_MS}`,
      );
    } else notes.push(`${path}  ${control.key} blocked for ${Math.round(first)} ms beside other pages and ${Math.round(again.longest)} ms alone`);
  }
  return { failures: failures.sort(), stale: stale.sort(), notes: notes.sort(), operated };
}

const server = createTestHarness({
  workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${root}counter/wrangler.jsonc` }],
});
let code = 1;
try {
  const base = String((await server.listen()).url).replace(/\/$/, "");
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    const ctx = await context(browser);
    const blind = await controls(ctx, base);
    if (blind.length) {
      for (const line of blind) console.error(`act:check is BLIND. ${line}`);
      code = 2;
    } else {
      const { failures, stale, notes, operated } = await sweep(ctx, base);
      for (const line of notes) console.log(values.list ? line : `NOTE  ${line}`);
      for (const line of failures) console.log(line);
      for (const line of stale) console.log(`STALE ${line}: drop it from config/interaction-budget.json`);
      console.log(
        `act:check: ${operated} control(s) operated on ${paths.length} pages at 390px, ${failures.length} failure(s), ${stale.length} stale exception(s); all eight planted controls were caught.`,
      );
      code = failures.length || stale.length ? 1 : 0;
    }
  } finally {
    await browser.close();
  }
} finally {
  // workerd holds the process open; close() before the exit code is reported.
  await server.close();
}

process.exit(code);
