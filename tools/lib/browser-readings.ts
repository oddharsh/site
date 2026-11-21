// browser-readings.ts: readings both browser checks take from a live page.
import type { Page } from "playwright-core";

/** Every scroller wider than its box, with the leaf elements that stick out. */
export const overflows = (page: Page) =>
  page.evaluate(() => {
    const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.classList.length ? `.${el.classList[0]}` : "");
    const found: string[] = [];
    for (const box of [document.documentElement, ...document.querySelectorAll("main, .content")]) {
      if (box.scrollWidth <= box.clientWidth + 1) continue;
      const edge = box.getBoundingClientRect().left + box.clientWidth + 1;
      const past = (el: Element) => el.getBoundingClientRect().right > edge;
      const clips = (el: Element) => getComputedStyle(el).overflowX !== "visible";
      const culprits: string[] = [];
      for (const el of box.querySelectorAll("*")) {
        if (!past(el) || [...el.children].some(past)) continue;
        let up = el.parentElement;
        while (up && up !== box && !clips(up)) up = up.parentElement;
        if (up === box) culprits.push(`${name(el)} +${Math.round(el.getBoundingClientRect().right - edge)}px`);
      }
      found.push(`${name(box)} is ${box.scrollWidth}px in a ${box.clientWidth}px box: ${culprits.slice(0, 4).join(", ") || "no leaf found"}`);
    }
    return found;
  });
