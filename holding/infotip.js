// infotip.js — the XP infotip layer for the desktop SHELL.
//
// tooltip.js is about this site's CONTENT (a photo's camera back, a track's
// album art). This module is about its CHROME: the taskbar app buttons, the
// system tray, the clock, the desktop icons, the title-bar controls, and any
// form field that carries a tip. Windows had a richer vocabulary here than a
// bare `title=` gives you, and the two shapes it used are the two this ships:
//
//   • Explorer's INFOTIP — bold name, then label/value rows ("Size: 110 MB /
//     Folders: … / Files: …"). Every folder and shortcut had one, and it said
//     something the icon could not.
//   • The ToolTip control's FIELD tip — one line under an input, saying what
//     the box wants before you get it wrong.
//
// Both are the same pale-yellow box, which is why they are one surface here.
//
// Everything it says is read from live state or from data the shell already
// loads: a pin's page count comes from nav.js's own destination table, the tray
// rows from the JSON their balloons already fetch, the clock's date from the
// clock. Nothing is decorative and nothing is guessed — a row whose value is
// missing is dropped, exactly like the photo tooltip's EXIF rows.
//
// The hover ENGINE is /hoist.js, shared with tooltip.js and the Run preview.
// What this file owns is which chrome has something to say, and what.

import { createHoist, hoverCapable, ANCHOR_OK } from "/hoist.js";

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// name line + optional hint line + the label/value grid. A pair whose value is
// empty never reaches the markup, so an infotip is only ever as long as the
// data behind it — the same discipline the photo recipe rows follow.
const card = (name, hint, pairs) => {
  const rows = (pairs || []).filter((p) => p && p[1])
    .map((p) => `<dt>${esc(p[0])}</dt><dd>${esc(p[1])}</dd>`).join("");
  return `<div class="n">${esc(name)}</div>` +
    (hint ? `<div class="h">${esc(hint)}</div>` : "") +
    (rows ? `<dl>${rows}</dl>` : "");
};

// A tray icon's title is "System Properties · what one request reveals": the
// name Windows would put on the icon, then what it means here. One split keeps
// the two halves in one authored string rather than two attributes.
const splitTitle = (s) => {
  const i = String(s || "").indexOf(" · ");
  return i < 0 ? [s || "", ""] : [s.slice(0, i), s.slice(i + 3)];
};

const plural = (n, one) => n + " " + one + (n === 1 ? "" : "s");

/**
 * @param {object} o
 * @param {(el: EventTarget) => Element|null} o.find
 *        "what was hovered", passed in rather than restated: nav.js's loader has
 *        to answer the same question before this module exists, and two copies
 *        of that rule is how the two come to disagree about what has a tip.
 * @param {object} [o.initial] the hover that arrived before this module did
 * @param {string} [o.kbd]     "⌘K" / "Ctrl K", already platform-resolved
 * @param {Array}  [o.pages]   nav.js's destination table, counted here (see below)
 * @param {object} [o.load]    { sys, upd, writing }: the shell's own data readers
 */
export function start(o) {
  if (!hoverCapable()) return;

  const findTarget = o.find;
  const kbd = o.kbd || "";
  const load = o.load || {};
  // How many destinations live under a section, counted from the table nav.js
  // already carries. Counting HERE rather than there keeps the derivation on
  // the lazy side of the split: a visitor who never points at a taskbar button
  // pays for none of it. One pass, cached, because a pin is hovered repeatedly.
  const pages = o.pages || [];
  const counted = Object.create(null);
  const under = (path) => {
    if (counted[path] === undefined) {
      counted[path] = pages.filter((p) => p.path.indexOf(path + "/") === 0).length;
    }
    return counted[path];
  };

  const tip = document.createElement("div");
  tip.id = "axp-infotip";
  tip.setAttribute("popover", "manual");
  // The shell's own chrome is what this describes, so it is never announced:
  // a taskbar button already carries its label, and a field its own title.
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  // ── the native tooltip has to go, but only while ours is up ────────────────
  // Removing `title` outright would cost the accessible description a field's
  // title provides, and AT reads that at FOCUS, not at hover. So the attribute
  // is emptied on the way in and restored on the way out: the OS tooltip never
  // fires, and nothing that reads the element later sees a gap. `data-tip` is
  // where the text lives meanwhile, which is also the attribute a page can set
  // by hand to opt a control in without a native tooltip ever existing.
  const stash = (t) => {
    const title = t.getAttribute("title");
    if (title) { t.dataset.tip = title; t.setAttribute("title", ""); }
  };
  const restore = (t) => {
    if (t.dataset.tip && t.getAttribute("title") === "") t.setAttribute("title", t.dataset.tip);
  };
  const onEnter = (e) => { const t = findTarget(e.target); if (t) stash(t); };
  const onLeave = (e) => {
    const t = findTarget(e.target);
    if (t && findTarget(e.relatedTarget) !== t) restore(t);
  };
  document.addEventListener("pointerover", onEnter, { passive: true });
  document.addEventListener("pointerout", onLeave, { passive: true });
  document.addEventListener("focusin", onEnter, { passive: true });
  document.addEventListener("focusout", onLeave, { passive: true });

  // ── content, one builder per family ────────────────────────────────────────

  // A taskbar app button. "Contains" counts what nav.js's own destination table
  // knows under that section, so it can only ever be a real number of real
  // pages; a section with nothing under it simply loses the row. "Running" is
  // the pressed state the taskbar already paints, said out loud.
  const pinTip = (a) => {
    const name = (a.querySelector(".lbl") || {}).textContent || a.dataset.tip || "";
    const path = a.getAttribute("href") || "";
    // /writing is the one section whose contents nav.js does not already carry
    // (the notes are a fetch, not a table), so it counts notes rather than pages.
    const n = path === "/writing" ? notes(a) : under(path);
    const held = n ? plural(n, path === "/writing" ? "note" : "page") : "";
    return card(name, a.dataset.tip, [
      ["Type", "Application"],
      ["Contains", held],
      ["Status", a.classList.contains("cur") ? "Running" : ""],
    ]);
  };

  // "Where does this go", the way Explorer's shortcut infotip put it. A link to
  // somewhere ELSE gets a host, because that is the thing a reader is deciding
  // on; a link to somewhere here gets nothing, since the path is neither news
  // nor a risk. A `mailto:` names the address it would open a client for.
  const destination = (a) => {
    const href = a.getAttribute("href") || "";
    if (!href || href[0] === "#") return "";
    let u;
    try { u = new URL(href, location.href); } catch (_) { return ""; }
    if (u.protocol === "mailto:") return u.pathname;
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.host === location.host) return "";
    const host = u.host.replace(/^www\./, "");
    if (u.pathname === "/") return host;
    // The host is the decision; the path is context, and a 70-character slug
    // wrapped over three lines is neither. Trim the PATH only, and only with a
    // visible ellipsis — a silently shortened URL in a tooltip about where a
    // link goes would be the one kind of dishonesty this surface cannot afford.
    const room = Math.max(12, 46 - host.length);
    const path = u.pathname.length > room ? u.pathname.slice(0, room - 1) + "…" : u.pathname;
    return host + path;
  };

  // A desktop shortcut. Explorer's infotip for one named its target, and the
  // target here is honest: the host for an internet shortcut, the route for a
  // folder. Notepad's note count is the one number that needs a fetch, and it
  // arrives on the hover that asks for it (see reshow below).
  let writingCount = 0;
  const notes = (t) => {
    // loadWriting() caches its own promise in nav.js, so a repeat hover before
    // the first fetch resolves costs nothing and never issues a second request.
    if (!writingCount && load.writing) {
      load.writing().then((w) => { writingCount = (w || []).length; reshow(t); }).catch(() => {});
    }
    return writingCount;
  };
  const icoTip = (a) => {
    const name = (a.querySelector(".t") || {}).textContent || a.dataset.key || "";
    const ext = a.target === "_blank";
    const target = ext ? destination(a) : a.getAttribute("href") || "";
    const held = ext ? 0 : notes(a);
    return card(name, ext ? "" : a.dataset.tip, [
      ["Type", ext ? "Internet Shortcut" : "File folder"],
      ["Target", target],
      ["Contains", held ? plural(held, "note") : ""],
      ["Opens", ext ? "in a new window" : ""],
    ]);
  };

  // The tray. XP's tray tooltips were live readouts ("Speed: 100.0 Mbps"), not
  // restatements of the icon, so these read the same JSON the click-balloons do
  // — one fetch per page, shared with the balloon, and only ever on a hover
  // that lasted long enough to mean it. The static half renders immediately;
  // the rows fill in when the data lands.
  let sys = null, upd = null;
  const fields = (j) => {
    const m = {};
    ((j && j.groups) || []).forEach((g) => (g.fields || []).forEach((f) => { m[f.k] = f.v; }));
    return m;
  };
  const trayTip = (a) => {
    const kind = a.getAttribute("data-kind");
    const parts = splitTitle(a.dataset.tip);
    const want = (kind === "updates") ? "upd" : "sys";
    if (want === "sys" && !sys && load.sys) load.sys((j) => { sys = j; reshow(a); });
    if (want === "upd" && !upd && load.upd) load.upd((j) => { upd = j; reshow(a); });
    let rows = [];
    if (kind === "sysprop") {
      const m = fields(sys);
      rows = [
        ["Colo", m["Cloudflare colo"]],
        ["From", m["City"] && m["Country"] ? m["City"] + ", " + m["Country"] : m["Country"]],
        ["Transport", [m["HTTP version"], m["TLS version"]].filter(Boolean).join(" · ")],
      ];
    } else if (kind === "security") {
      const m = fields(sys);
      rows = [
        ["Firewall", sys ? "On · Cloudflare edge" : ""],
        ["Transport", [m["HTTP version"], m["TLS version"]].filter(Boolean).join(" · ")],
      ];
    } else if (kind === "updates") {
      const latest = (upd && upd.items && upd.items[0]) || null;
      rows = [["Build", upd && upd.build], ["Latest", latest && latest.slug]];
    }
    return card(parts[0], parts[1], rows);
  };

  // The clock's tooltip in XP was the full date, and it is the one piece of
  // chrome whose tooltip everybody has actually seen. Same wall clock the
  // taskbar is already showing, spelled out.
  const clockTip = () => {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    let date = "";
    try {
      date = new Intl.DateTimeFormat(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      }).format(new Date());
    } catch (_) {}
    return card(date || "Date and Time", "", [["Zone", zone]]);
  };

  // Deliberately no "Scheme: Windows XP" row: these are original WebAudio
  // voices, not Microsoft's, and a tooltip is not the place to blur that.
  const soundTip = (b) => {
    const muted = b.classList.contains("muted");
    return card("Sounds", muted ? "click to unmute" : "click to mute",
      [["State", muted ? "Off" : "On"]]);
  };

  const startTip = () => card("Run", "type the name of a page, photo, or profile",
    [["Shortcut", kbd]]);

  // Everything else with a tip: title-bar controls, dialog buttons, form fields,
  // and every titled thing in the page body. One line, no rows — this is the
  // ToolTip-control shape, and padding it with a "Type:" row it does not have
  // would be inventing content.
  const plainTip = (t) => {
    const text = t.dataset.tip || t.getAttribute("title") || "";
    return text ? `<div class="n">${esc(text)}</div>` : "";
  };

  // A titled link in the page body — a citation, a source, a footer pointer.
  // The title stays the whole tip when the link goes somewhere on this site,
  // because a path is neither news nor a decision. When it LEAVES, the two
  // facts a reader is actually weighing get their own rows, which is what the
  // browser's status bar does badly and an Explorer shortcut infotip did well.
  const linkTip = (a) => {
    const to = destination(a);
    const blank = a.target === "_blank";
    if (!to && !blank) return plainTip(a);
    const text = a.dataset.tip || a.getAttribute("title") || "";
    if (!text && !to) return "";
    return card(text || a.textContent.trim(), "",
      [["Target", to], ["Opens", blank ? "in a new window" : ""]]);
  };

  const contentFor = (t) => {
    // Chrome that lives ON the taskbar has to be described from ABOVE it: the
    // default below-cursor offset would put the box over the very row being
    // pointed at (and the viewport clamp would pin it there rather than let it
    // run off-screen). Placement is a fact about the target, so it is settled
    // here, where the target is in hand, and reset for every other family.
    tip.classList.toggle("up", !!t.closest("#axp-taskbar"));
    if (t.matches(".axp-pin")) return pinTip(t);
    if (t.matches(".axp-ico")) return icoTip(t);
    if (t.matches(".axp-trayico")) return trayTip(t);
    if (t.matches("#axp-clock")) return clockTip();
    if (t.matches("#axp-sound")) return soundTip(t);
    if (t.matches("#axp-start")) return startTip();
    if (t.matches("a[href]")) return linkTip(t);
    return plainTip(t);
  };

  const hoist = createHoist({
    node: tip,
    findTarget,
    contentFor,
    anchorName: "--axp-infotip",
    // Windows' two delays. The dwell is also what makes the lazy load free:
    // nav.js starts fetching this module on the same hover that starts the
    // clock, so a genuinely cold first infotip and a warm one appear at
    // roughly the same moment.
    openMs: 400,
    autopopMs: 6000,
  });

  // A tip already on screen when its data arrives should say the new thing
  // rather than wait for the next hover. Same re-render the photo tooltip does
  // when a histogram lands, and the guard is the same: only if this exact
  // target is still the open one.
  function reshow(t) { if (hoist.active() === t) hoist.show(t); }

  // Replaying the hover that arrived first. Keyboard focus is deliberate and
  // shows at once; a POINTER replay has to serve out the rest of the dwell it
  // interrupted, or the one hover a visitor is most likely to be mid-sweep on
  // would be the only one that pops instantly. `:hover` re-checks that the
  // cursor is still there, which a stored event cannot know.
  const init = o.initial;
  // The pointerover that triggered the load happened before this module had
  // listeners, so nothing stashed that element's title: without this the very
  // first infotip of a page load renders with its `title` line missing, which
  // is exactly the hover a visitor is most likely to be looking at. Stashing
  // stays on THIS side of the split on purpose — a loader that stripped titles
  // itself would leave them stripped if the module never arrived.
  if (init && init.target) stash(init.target);
  if (init && init.focus && ANCHOR_OK) hoist.showAnchored(init.target);
  else if (init && init.target) {
    const left = Math.max(0, 400 - (Date.now() - (init.at || 0)));
    setTimeout(() => {
      try { if (!init.target.matches(":hover")) return; } catch (_) { return; }
      hoist.show(init.target, init);
    }, left);
  }
}
