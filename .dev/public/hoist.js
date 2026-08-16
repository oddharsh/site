// hoist.js — the top-layer hover surface every rich hover on this site shares.
//
// Three callers had grown three copies of this: tooltip.js (photos, tracks,
// artists, car links), serendipity's event covers, and now nav.js's Run
// preview. The copies had already drifted — serendipity never got the popover
// hoist, the keyboard path, or the will-change lifecycle, and its own comment
// asked the next editor to keep its TIP_DISMISS_MS "in sync" with the homepage
// by hand. A third copy is how you end up with three behaviors, so the engine
// lives here once and the callers keep only what is genuinely theirs: which
// elements are targets (findTarget) and what the surface says (contentFor).
//
// What this owns: the top-layer hoist, the two placement modes, the gap-hop
// dismissal timer, the scroll model, and the compositor-layer lifecycle.
// What it does NOT own: any styling. Each caller ships its own CSS for its own
// node, because a camera back, album art, an event cover, and a Run thumbnail
// look nothing alike. The contract is only that the node is `popover="manual"`
// and positions itself from --x/--y (cursor mode) or `position-anchor` under a
// `.anchored` class (anchored mode).

// Hover-only. Long-press on touch fires synthetic mouseover/mouseout, which
// used to pop tooltips mid-scroll on mobile (gotcha #10). `(hover: none)` is
// the touch-only signal; `(pointer: coarse)` also catches hybrids whose primary
// pointer is touch. Exported so callers can skip building their content
// machinery entirely rather than build it for a surface that will never show.
export const hoverCapable = () =>
  !(window.matchMedia &&
    (window.matchMedia("(hover: none)").matches ||
     window.matchMedia("(pointer: coarse)").matches));

// CSS anchor positioning, for the anchored mode. Unsupported engines simply
// never get the class, so their users are no worse off than before it existed.
export const ANCHOR_OK = !!(window.CSS && CSS.supports &&
  (CSS.supports("position-area: bottom") || CSS.supports("inset-area: bottom")));

/**
 * @param {object} o
 * @param {HTMLElement} o.node          the surface to hoist; caller owns its CSS
 * @param {(t: Element) => string}      o.contentFor  html for a target, or falsy to suppress
 * @param {(el: EventTarget) => Element|null} [o.findTarget]
 *        when given, pointer + focus handling is wired automatically. Omit it to
 *        drive the surface yourself (the Run preview follows selection, not the
 *        cursor, so it calls showAnchored directly and wires nothing).
 * @param {boolean} [o.followPointer=true]  false → anchored-only, no cursor tracking
 * @param {string}  [o.anchorName="--xp-tip"]  must be unique per surface on a page
 * @param {number}  [o.dismissMs=50]
 * @param {number}  [o.settleMs=60]
 * @param {number}  [o.openMs=0]     cold-open dwell (see below). 0 = show at once.
 * @param {number}  [o.autopopMs=0]  hide again after this long. 0 = stay until dismissed.
 */
export function createHoist(o) {
  const node = o.node;
  const contentFor = o.contentFor;
  const findTarget = o.findTarget || null;
  const followPointer = o.followPointer !== false;
  const anchorName = o.anchorName || "--xp-tip";
  const DISMISS_MS = o.dismissMs == null ? 50 : o.dismissMs;
  const SETTLE_MS = o.settleMs == null ? 60 : o.settleMs;
  // Windows' two tooltip delays, and both default OFF so the content surfaces
  // (photos, tracks, the Run preview) keep the instant show they were tuned for.
  // A surface over CHROME wants them: the cursor crosses a taskbar or a row of
  // desktop icons on its way somewhere else far more often than it comes to rest
  // on one, and a tip that fires on every pass is noise. OPEN_MS is XP's initial
  // delay (SPI_GETMOUSEHOVERTIME, 400ms), skipped while a tip is already up so
  // sweeping along a row of buttons swaps instantly — that is XP's "reshow"
  // behaviour, and it is what makes the delay feel like care rather than lag.
  const OPEN_MS = o.openMs || 0;
  // XP's autopop (5s). It also covers the one dismissal the pointer cannot: a
  // cursor that leaves the viewport for another window fires no pointerout.
  const AUTOPOP_MS = o.autopopMs || 0;

  // A dead surface still answers every method, so callers never null-check.
  const dead = { show() {}, showAnchored() {}, hide() {}, isOpen: () => false, active: () => null };
  if (!node || !hoverCapable()) return dead;

  let activeTarget = null, anchoredEl = null;
  let lastX = 0, lastY = 0;
  let hideTimer = 0, scrolling = false, scrollIdle = 0;
  let openTimer = 0, pendingTarget = null, autopopTimer = 0;

  // Position is two CSS custom-property writes and nothing else. No rAF, no
  // getBoundingClientRect, no resize listener: the caller's CSS clamps against
  // the element's own size, so it stays correct even as an image sizes the box.
  // lastX/lastY are kept only for scroll re-targeting (elementFromPoint).
  const place = (e) => {
    lastX = e.clientX; lastY = e.clientY;
    node.style.setProperty("--x", lastX + "px");
    node.style.setProperty("--y", lastY + "px");
  };

  // Popover API for the hoist: top layer, so no z-index juggling and no
  // clipping by an internal scroller or a modal dialog. Guard both calls,
  // because showPopover()/hidePopover() throw if the element is already in the
  // target state. Engines without popover fall back to a display toggle.
  const supportsPopover = "popover" in HTMLElement.prototype;
  const isOpen = () => supportsPopover
    ? node.matches(":popover-open")
    : node.style.display === "block";

  // will-change is an "earn it" hint, not a permanent set (gotcha #11): leaving
  // it on while the surface is display:none pins a compositor layer for an
  // invisible element. Promote only while open, so the per-pointermove translate
  // is a pure compositor transform (off the main thread, no box repaint) — which
  // is what keeps tracking smooth on ProMotion / Low-Power VRR — then release it
  // the instant it closes.
  const openNode = () => {
    if (AUTOPOP_MS) { clearTimeout(autopopTimer); autopopTimer = setTimeout(hide, AUTOPOP_MS); }
    if (followPointer) node.style.willChange = "transform";
    if (supportsPopover) { if (!node.matches(":popover-open")) node.showPopover(); }
    else node.style.display = "block";
  };
  const closeNode = () => {
    if (supportsPopover) { if (node.matches(":popover-open")) node.hidePopover(); }
    else node.style.display = "none";
    node.style.willChange = "auto";
  };

  // Parsed hover cards are retained by their exact HTML. Re-entering the same
  // target was already cheap, but sweeping A → B → A destroyed A's subtree and
  // constructed a fresh <img> for it. Chrome used to reuse those bytes without
  // even exposing a resource-timing entry; a 2026-08-11 HAR instead recorded
  // every reconstruction as another image load (often zero-byte memory-cache
  // work, but still a new image element and decode path). Keep the actual nodes
  // and move them back into the one visible hoist. Images remain lazy-by-use:
  // content is parsed only on its first hover, never for the whole target list.
  let mounted = null;
  const rendered = new Map();
  const render = (html) => {
    if (html === mounted) return;
    let children = rendered.get(html);
    if (!children) {
      const template = document.createElement("template");
      template.innerHTML = html;
      children = Array.from(template.content.childNodes);
      rendered.set(html, children);
    }
    node.replaceChildren(...children);
    mounted = html;
  };

  const dropAnchor = () => {
    if (anchoredEl) { anchoredEl.style.removeProperty("anchor-name"); anchoredEl = null; }
    node.classList.remove("anchored");
  };
  const cancelOpen = () => { clearTimeout(openTimer); openTimer = 0; pendingTarget = null; };
  const hide = () => {
    clearTimeout(autopopTimer); autopopTimer = 0;
    cancelOpen();
    closeNode(); dropAnchor(); activeTarget = null;
  };

  // Dismissal is deferred by a hair so hopping from one target straight across
  // the small gap to the NEXT one doesn't flash the surface off-then-on. A fresh
  // pointerover cancels the pending hide; if the cursor instead comes to rest in
  // the gap, it still clears after the delay, so dead space shows nothing.
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = 0; };
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, DISMISS_MS); };

  // Cursor-following show. Pointer hover ALWAYS follows the cursor (owner
  // re-ruling 2026-07-03: the anchored-hover experiment shipped and was rolled
  // back the same day — gliding the album art is the site's identity, same as
  // the photo camera-back, and the 500ms cold-hover delay read as lag).
  // `e` is optional: a scroll-settle re-show reuses the existing --x/--y,
  // because the cursor did not move.
  const show = (target, e) => {
    if (scrolling) return;
    cancelHide();
    cancelOpen();
    dropAnchor();
    activeTarget = target;
    const html = contentFor(target);
    if (!html) { hide(); return; }
    render(html);
    if (e) place(e);            // position before showing, so there is no glide-in
    openNode();
  };

  // Anchored show: tethered to the element via CSS anchor positioning. Used for
  // keyboard focus (no pointer to track) and for selection-driven surfaces.
  const showAnchored = (target) => {
    if (scrolling) return;
    cancelHide();
    cancelOpen();
    const html = contentFor(target);
    if (!html) { hide(); return; }
    dropAnchor();
    activeTarget = target;
    render(html);
    if (ANCHOR_OK) {
      target.style.setProperty("anchor-name", anchorName);
      anchoredEl = target;
      node.classList.add("anchored");
    }
    openNode();
  };

  // Cold-open dwell. The wait is skipped entirely while a surface is already
  // open, so only the FIRST tip of a pass costs it. `place` reads clientX/clientY
  // and nothing else, so the deferred show hands it a plain pair rather than
  // holding the event object alive for 400ms.
  const showSoon = (target, e) => {
    if (!OPEN_MS || isOpen()) { show(target, e); return; }
    if (target === pendingTarget) return;    // pointerover bubbles from children
    cancelOpen();
    pendingTarget = target;
    const x = e.clientX, y = e.clientY;
    openTimer = setTimeout(() => {
      openTimer = 0; pendingTarget = null;
      show(target, { clientX: x, clientY: y });
    }, OPEN_MS);
  };

  if (findTarget) {
    document.addEventListener("pointerover", (e) => {
      const target = findTarget(e.target);
      if (!target) {
        cancelOpen();                        // left the target before the dwell was up
        if (activeTarget) scheduleHide();    // only when open — no timer churn on plain moves
        return;
      }
      cancelHide();                          // re-entered a target → keep it up
      if (target === activeTarget) { cancelOpen(); return; }
      showSoon(target, e);
    }, { passive: true });

    // passive: the browser dispatches without waiting on us, and the work is
    // two custom-property writes.
    if (followPointer) {
      document.addEventListener("pointermove", (e) => { if (isOpen()) place(e); }, { passive: true });
    }

    document.addEventListener("pointerout", (e) => {
      const from = findTarget(e.target);
      if (!from) return;
      const to = findTarget(e.relatedTarget);
      if (to === from) return;   // still inside the same target
      if (to) return;            // moving to another valid target: let pointerover swap without a flicker
      cancelOpen();              // a dwell in progress ends with the hover that started it
      scheduleHide();
    }, { passive: true });

    // Scroll model. Any scroll (an internal window scroller bubbles here in the
    // capture phase) hides the surface and suppresses new ones WHILE scrolling,
    // so you can wheel over a photo grid or a long list without hover noise as
    // rows fly past.
    //
    // On settle we actively RE-TARGET rather than wait for a pointer event. Two
    // reasons a passive wait feels broken: the surface is position:fixed, and a
    // wheel/trackpad scroll leaves the cursor dead still, so no pointerover
    // fires when a new row slides under it. Without this the surface only comes
    // back if you jiggle the mouse. SETTLE_MS rides out trackpad momentum
    // (events keep firing ~every frame until it fully stops) without flashing
    // back mid-decel, and is short enough to read as instant.
    const reshowUnderCursor = () => {
      if (!lastX && !lastY) return;          // pointer never moved → nothing to re-target
      const target = findTarget(document.elementFromPoint(lastX, lastY));
      if (target) show(target);              // no event: the existing --x/--y are still right
    };
    document.addEventListener("scroll", () => {
      scrolling = true;
      cancelOpen();
      if (isOpen()) hide();
      clearTimeout(scrollIdle);
      scrollIdle = setTimeout(() => { scrolling = false; reshowUnderCursor(); }, SETTLE_MS);
    }, { capture: true, passive: true });

    // Keyboard-focus path: same content, tethered to the focused element. Only
    // for :focus-visible, so a mouse click that happens to focus a link doesn't
    // double-trigger on top of the cursor-following one.
    if (ANCHOR_OK) {
      document.addEventListener("focusin", (e) => {
        const target = findTarget(e.target);
        if (!target) return;
        try { if (!target.matches(":focus-visible")) return; } catch (_) {}
        showAnchored(target);                // keyboard focus is deliberate: no cold delay
      });
      document.addEventListener("focusout", (e) => {
        if (anchoredEl && findTarget(e.target) === anchoredEl) hide();
      });
    }
  }

  return { show, showAnchored, hide, isOpen, active: () => activeTarget };
}
