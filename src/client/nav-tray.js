// nav-tray.js — first-interaction island for XP notification balloons.
// The taskbar links remain ordinary links until nav.js intercepts a plain click.

export function createTray(options) {
  var D = document;
  var sound = options.sound;
  var loadSys = options.loadSys;
  var loadUpd = options.loadUpd;
  var loadWebmcp = options.loadWebmcp;
  var balloon = /** @type {HTMLElement | null} */ (null), balloonKind = /** @type {string | null} */ (null);

  /** @returns {HTMLElement} */
  function el(html) {
    var t = D.createElement("template");
    t.innerHTML = html.trim();
    var node = t.content.firstElementChild;
    if (!(node instanceof HTMLElement)) throw new Error("Tray island template must produce an element");
    return node;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function body() { return balloon && balloon.querySelector(".bd"); }
  function flatFields(j) {
    var m = {};
    (j.groups || []).forEach((g) => { (g.fields || []).forEach((f) => { m[f.k] = f.v; }); });
    return m;
  }
  function renderSys(j) {
    var b = body(); if (!b) return;
    if (!j) { b.innerHTML = '<div class="load">couldn\'t read this connection.</div>'; return; }
    var m = flatFields(j);
    b.innerHTML =
      '<div class="ln"><span class="k">Network</span> <b>' + esc(m["Cloudflare colo"] || "—") + '</b> <span class="k">' + esc(m["ISP / ASN"] || "") + '</span></div>' +
      '<div class="ln"><span class="k">Transport</span> <b>' + esc(m["HTTP version"] || "—") + '</b> · ' + esc(m["TLS version"] || "") + '</div>' +
      '<div class="ln"><span class="k">Region</span> ' + esc((m["City"] || "—") + ", " + (m["Country"] || "")) + '</div>' +
      '<div class="ln"><span class="k">Client</span> ' + esc(m["Best guess"] || "—") + '</div>';
  }
  function renderSec(j) {
    var b = body(); if (!b) return;
    var m = j ? flatFields(j) : {};
    var tr = j ? ('<div class="ln"><span class="k">Transport</span> ' + esc((m["HTTP version"] || "") + " · " + (m["TLS version"] || "")) + '</div>') : "";
    b.innerHTML =
      '<div class="ln"><b>Firewall</b> <span class="ok">ON</span> <span class="k">Cloudflare edge</span></div>' +
      '<div class="ln"><b>Automatic Updates</b> <span class="ok">ON</span> <span class="k">immutable assets</span></div>' +
      '<div class="ln"><b>Threat protection</b> <span class="ok">ON</span> <span class="k">bot auth</span></div>' + tr;
  }
  function renderUpd(j) {
    var b = body(); if (!b) return;
    if (!j) { b.innerHTML = '<div class="load">couldn\'t read the update log.</div>'; return; }
    var latest = (j.items || []).slice(0, 2).map((it) => {
      return '<div class="ln"><span class="k">' + esc(it.slug) + '</span> ' + esc(it.title) + '</div>';
    }).join("");
    b.innerHTML =
      '<div class="ln"><b class="ok">aadhar.sh is up to date.</b></div>' +
      '<div class="ln"><span class="k">build</span> <span class="mono">' + esc(j.build || "—") + '</span></div>' + latest;
  }

  // The agent-activity balloon. Unlike its three neighbours this reads no
  // endpoint: the log lives in webmcp.js's module scope for this document only,
  // which is the whole design (see the audit-log note there).
  function renderWebmcp(j) {
    var b = body(); if (!b) return;
    if (!j) { b.innerHTML = '<div class="load">this browser has no WebMCP, so nothing can drive this page.</div>'; return; }
    if (!j.calls) {
      b.innerHTML =
        '<div class="ln"><b>' + j.registered + '</b> tools an agent could use here.</div>' +
        '<div class="ln"><span class="k">Nothing has asked yet. Anything that writes will stop and ask you first.</span></div>';
      return;
    }
    var tally = '<div class="ln"><b>' + j.calls + '</b> tool call' + (j.calls === 1 ? "" : "s") + ' this visit' +
      (j.refused ? ' \u00b7 <b class="no">' + j.refused + ' you refused</b>' : "") +
      (j.failed ? ' \u00b7 <span class="k">' + j.failed + ' failed</span>' : "") + "</div>";
    // Newest first, because the question a person opens this to answer is
    // "what did it just do", never "what did it do first".
    var rows = (j.recent || []).map((c) => {
      // Named rather than left to an else, so a fourth outcome shows up as
      // "unknown" instead of being quietly filed under failed.
      var mark = c.outcome === "ok" ? '<span class="ok">ran</span>'
        : c.outcome === "refused" ? '<span class="no">refused</span>'
        : c.outcome === "failed" ? '<span class="k">failed</span>'
        : '<span class="k">' + esc(String(c.outcome || "unknown")) + '</span>';
      return '<div class="ln"><span class="mono">' + esc(c.name) + '</span> ' + mark +
        ' <span class="k">' + Math.round(c.ms) + 'ms' + (c.gated ? ' \u00b7 asked you' : "") + '</span></div>';
    }).join("");
    b.innerHTML = tally + rows;
  }

  var BALLOON = {
    sysprop: { title: "System Properties", href: "/whoareyou",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#1c4bb0' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'><rect x='1.8' y='2.4' width='12.4' height='8' rx='1'></rect><path d='M6 10.4v2M10 10.4v2M4.6 12.9h6.8'></path></svg>",
      load: loadSys, render: renderSys },
    security: { title: "Security Center", href: "/security",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#2c8f1e' stroke-width='1.3' stroke-linejoin='round' stroke-linecap='round'><path d='M8 1.7 2.7 3.7 V8 c0 3.4 2.6 5.4 5.3 6.4 2.7-1 5.3-3 5.3-6.4 V3.7 Z'></path><path d='M5.7 8 7.3 9.7 10.5 6.2'></path></svg>",
      load: loadSys, render: renderSec },
    updates: { title: "Windows Update", href: "/updates",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#1c4bb0' stroke-width='1.2'><circle cx='8' cy='8' r='6'></circle><path d='M2 8 h12 M8 2 c2.3 2.4 2.3 9.2 0 12 M8 2 c-2.3 2.4 -2.3 9.2 0 12'></path></svg>",
      load: loadUpd, render: renderUpd },
    webmcp: { title: "Agent activity", href: "/whoareyou",
      icon: "<svg viewBox='0 0 16 16' fill='none' stroke='#1c4bb0' stroke-width='1.25' stroke-linecap='round' stroke-linejoin='round'><rect x='2.4' y='1.8' width='9.4' height='12.4' rx='1.2'></rect><path d='M4.4 5.4h5.4M4.4 8h4.2M4.4 10.6h4.8'></path><circle cx='12.2' cy='11.9' r='2.5' stroke='#2c8f1e'></circle><path d='M11 11.9 11.9 12.9 13.5 10.9' stroke='#2c8f1e'></path></svg>",
      load: loadWebmcp, render: renderWebmcp }
  };

  // The balloon is a popover="auto", so the platform owns what this file used
  // to hand-roll with two always-attached document listeners: light dismiss on
  // an outside press, Esc, and the top layer (no z-index to out-bid). Opening
  // it closes any other auto popover, which is XP's behaviour too (a Notepad
  // menu collapses when the tray is clicked), and leaves the manual popovers
  // alone (the /writing notes, the hover cards).
  //
  // The icons are <a href> so a modified click still opens the full page, and
  // popovertarget only works on buttons, so the popover is driven from script.
  // showPopover({ source }) makes the icon part of the balloon's light-dismiss
  // tree where the engine supports it. Where it does not, pressing the open
  // icon light-dismisses the balloon before its click lands, and the click
  // would open it again; pressedOpen remembers the press so that click closes.
  var pressedOpen = /** @type {string | null} */ (null);
  function isOpen() { return !!balloon && balloon.matches(":popover-open"); }
  /** @returns {HTMLElement} */
  function build() {
    if (balloon) return balloon;
    var b = el(
      '<div id="axp-balloon" popover="auto" role="dialog" aria-label="notification">' +
        '<div class="tb"><span class="ic" aria-hidden="true"></span><span class="t"></span><button class="x" type="button" title="Close" aria-label="Close">✕</button></div>' +
        '<div class="bd"></div><div class="ft"></div>' +
      '</div>'
    );
    balloon = b;
    D.body.appendChild(b);
    b.querySelector(".x").addEventListener("click", close);
    // Every close path (the ✕, Esc, an outside press, another auto popover
    // opening) lands here, so the bookkeeping lives in one place.
    b.addEventListener("beforetoggle", (e) => {
      if (/** @type {ToggleEvent} */ (e).newState !== "closed") return;
      sound.play("close");
      var ic = balloonKind && D.querySelector('.axp-trayico[data-kind="' + balloonKind + '"]');
      if (ic instanceof HTMLElement) {
        ic.setAttribute("aria-expanded", "false");
        // Hand focus back only when it was inside the balloon. An outside press
        // is taking focus somewhere on purpose.
        if (b.contains(D.activeElement)) try { ic.focus(); } catch (_) {}
      }
      balloonKind = null;
    });
    [].forEach.call(D.querySelectorAll(".axp-trayico"), (ic) => {
      ic.addEventListener("pointerdown", () => {
        pressedOpen = isOpen() ? balloonKind : null;
      });
    });
    return b;
  }
  /** @param {HTMLElement} b @param {HTMLElement} ic */
  function placeTail(b, ic) {
    try {
      var ir = ic.getBoundingClientRect(), br = b.getBoundingClientRect();
      var x = Math.max(14, Math.min(br.width - 14, (ir.left + ir.width / 2) - br.left));
      b.style.setProperty("--tail", x + "px");
    } catch (_) {}
  }
  function open(kind, ic) {
    var cfg = BALLOON[kind]; if (!cfg) return;
    var b = build();
    if (isOpen()) b.hidePopover();
    b.querySelector(".ic").innerHTML = cfg.icon;
    b.querySelector(".t").textContent = cfg.title;
    b.querySelector(".ft").innerHTML = '<a href="' + cfg.href + '">full page</a>';
    body().innerHTML = '<div class="load">reading…</div>';
    // No try: an engine without the Popover API throws here, which rejects
    // nav.js's toggleTray promise and falls back to navigating to the page.
    b.showPopover(ic ? { source: ic } : undefined);
    balloonKind = kind;
    sound.play("open");
    if (ic) { ic.setAttribute("aria-expanded", "true"); placeTail(b, ic); }
    var x = b.querySelector(".x"); if (x instanceof HTMLElement) try { x.focus(); } catch (_) {}
    cfg.load((data) => { if (isOpen() && balloonKind === kind) cfg.render(data); });
  }
  function close() {
    if (balloon && isOpen()) balloon.hidePopover();
  }
  function toggle(kind, ic) {
    var pressed = pressedOpen;
    pressedOpen = null;
    if (pressed === kind || (isOpen() && balloonKind === kind)) close();
    else open(kind, ic);
  }

  return { toggle: toggle, close: close };
}
