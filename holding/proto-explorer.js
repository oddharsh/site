// proto-explorer.js — PROTOTYPE, not shipped behaviour.
//
// Two Explorer chrome devices from the #262 rewrite, rebuilt on this site's own
// Luna tokens so they can be judged on real pages with real content:
//
//   1. the ADDRESS BAR — a sunken well under the caption holding the section
//      icon and a breadcrumb of real links, the way Explorer shows the path;
//   2. the TASK PANE — the left column Explorer fills with "what can I do with
//      this object", "where else can I go", and "what is this thing".
//
// Nothing here runs unless the URL asks for it:
//
//   ?chrome=bar    address bar only
//   ?chrome=pane   task pane only
//   ?chrome=1      both        (?chrome=off or no parameter = today's page)
//
// so any route can be compared against itself by adding one query parameter.
//
// THE HONESTY RULE IS THE HARD PART, and it is why the pane is built from the
// DOM rather than from a table of what pages ought to contain. Every entry has
// a source that is true at the moment it renders:
//
//   Object tasks  the document's own <link rel="alternate"> elements, plus the
//                 section's data endpoint where this tree really serves one,
//                 plus the parent folder.
//   Other places  the taskbar nav.js already built, so the two can never drift.
//   Details       counted from the rendered document, never asserted.
//
// A group with nothing true to say does not render. That is the behaviour to
// judge: a task pane that pads itself with plausible links is worse than none.
(function () {
  "use strict";

  var D = document;
  var mode = new URLSearchParams(location.search).get("chrome") || "";
  if (!mode || mode === "off") return;
  var wantBar = mode === "bar" || mode === "1" || mode === "both";
  var wantPane = mode === "pane" || mode === "1" || mode === "both";

  var win = D.querySelector("body > .window, body > .np-window");
  if (!win) return;
  // The window families name their workspace differently: .content on the
  // static/worker pages, .np-folder-body on the writing folder, .np-body on a
  // note. The chrome attaches to whichever one this page has.
  var content = win.querySelector(":scope > .content, :scope > .np-folder-body, :scope > .np-body, :scope > .body");
  if (!content) return;

  // ── what this tree actually serves ────────────────────────────────────────
  // Verified against the running server rather than assumed. A section absent
  // from this table simply contributes no data task.
  var SECTION_DATA = {
    "/photos": [
      { href: "/photos/query.json", label: "Query the photo records" },
      { href: "/images/manifest.json", label: "Open the photo manifest" }
    ],
    "/writing": [{ href: "/writing/posts.json", label: "Open the post registry" }]
  };

  var TITLES = {
    "/": "aadhar.sh", "/garage": "Garage", "/lwe": "Learning with Errors",
    "/writing": "My Writing", "/photos": "Photographs", "/reading": "Reading",
    "/serendipity": "Serendipity", "/around": "Around", "/lens": "Lens",
    "/terminal": "Terminal", "/pixel-peeper": "Pixel Peeper", "/rn": "Music",
    "/coffee": "Coffee", "/whoareyou": "Who are you", "/security": "Security Center",
    "/updates": "Windows Update", "/restore": "System Restore"
  };

  var segments = location.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  var sectionPath = segments.length ? "/" + segments[0] : "/";
  var parentPath = segments.length > 1 ? "/" + segments.slice(0, -1).join("/") : segments.length ? "/" : null;
  // A folder is a section index: one path segment, and a section this site
  // recognises. Only a folder gets counted, because "Contains" and "Modified"
  // are folder facts — asked of the homepage they produced "1 notes" and a date
  // belonging to a photograph, which is exactly the fabrication to avoid.
  var isFolder = segments.length === 1 && Boolean(TITLES[sectionPath]);

  function titleFor(path, fallback) { return TITLES[path] || fallback || path.replace(/^\//, ""); }

  // An h1 here can carry a status pill ("Thumbnail encoding study SHIPPED") and a
  // title bar carries its window controls. Both are chrome about the object, not
  // the object's name, so strip them before quoting the heading anywhere.
  function plainText(node, strip) {
    if (!node) return "";
    var copy = node.cloneNode(true);
    copy.querySelectorAll(strip).forEach(function (extra) { extra.remove(); });
    return copy.textContent.replace(/\s+/g, " ").trim();
  }
  function headingText(node) { return plainText(node, ".status, .badge, .pill, .tag"); }
  function link(href, label) {
    var a = D.createElement("a");
    a.href = href;
    a.textContent = label;                    // textContent: page titles and captions are content
    return a;
  }

  // ── styles ────────────────────────────────────────────────────────────────
  // Every colour is a luna.css token or a relative colour derived from one, so
  // the devices tone-shift with the rest of the site rather than pinning hexes.
  if (!D.getElementById("proto-explorer-css")) {
    var style = D.createElement("style");
    style.id = "proto-explorer-css";
    style.textContent = [
      /* ---- address bar ---- */
      ".px-address{display:flex;align-items:center;gap:6px;flex:0 0 auto;",
      "padding:3px 6px;background:var(--face);",
      "border-bottom:1px solid var(--shadow);",
      "font:var(--text-ui,11px)/1.6 var(--font-ui);color:var(--ink-soft)}",
      ".px-address>.px-label{padding-left:2px;color:var(--ink-soft);flex:0 0 auto}",
      // the well is sunken like a real combo box, and scrolls rather than wraps
      // so a deep path never grows the chrome to two rows.
      ".px-well{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;",
      "padding:2px 6px;background:var(--paper);box-shadow:var(--bevel-sunken);",
      "border:1px solid var(--shadow);overflow-x:auto;white-space:nowrap;scrollbar-width:none}",
      ".px-well::-webkit-scrollbar{display:none}",
      ".px-well img{width:16px;height:16px;flex:0 0 auto;image-rendering:auto}",
      ".px-well a{color:var(--link);text-decoration:none}",
      ".px-well a:hover{color:var(--link-hover);text-decoration:underline}",
      ".px-well .px-here{color:var(--ink);font-weight:var(--weight-bold,700)}",
      ".px-sep{color:var(--ink-faint,var(--ink-soft));padding:0 1px}",

      /* ---- task pane ---- */
      // The document keeps its own scroll; the pane is a sibling column inside
      // the same scroller, which is how Explorer behaves.
      ".px-split{display:grid;grid-template-columns:180px minmax(0,1fr);gap:14px;align-items:start}",
      ".px-pane{display:flex;flex-direction:column;gap:10px;padding:2px 0 8px;",
      "font:var(--text-sm,11px)/1.45 var(--font-ui)}",
      ".px-group{border:1px solid color-mix(in oklab,var(--blue-95) 45%,white);",
      "border-radius:var(--radius-title) var(--radius-title) 0 0;overflow:hidden;",
      "background:linear-gradient(180deg,color-mix(in oklab,var(--blue-95) 10%,white) 0%,",
      "color-mix(in oklab,var(--blue-95) 22%,white) 100%)}",
      // Luna's task-pane header: pale blue gel, navy caption, rounded top only.
      ".px-group>h2{margin:0;padding:4px 8px;",
      "font:var(--weight-bold,700) var(--text-sm,11px)/1.5 var(--font-caption);",
      "color:var(--blue-45);letter-spacing:var(--tracking-heading,-0.01em);",
      "background:linear-gradient(180deg,white 0%,color-mix(in oklab,var(--blue-95) 26%,white) 100%);",
      "border-bottom:1px solid color-mix(in oklab,var(--blue-95) 40%,white)}",
      ".px-group>ul{margin:0;padding:6px 8px;list-style:none;display:flex;flex-direction:column;gap:5px}",
      ".px-group a{color:var(--link);text-decoration:none}",
      ".px-group a:hover{color:var(--link-hover);text-decoration:underline}",
      ".px-group dl{margin:0;padding:6px 8px;display:grid;grid-template-columns:1fr;gap:3px}",
      ".px-group dt{color:var(--ink-soft);font-size:var(--text-xs,10px)}",
      // A long object name or path has to wrap inside 180px rather than run out
      // under the document column.
      ".px-group dd{margin:0 0 4px;color:var(--ink);font-family:var(--font-mono);",
      "font-size:var(--text-xs,10px);overflow-wrap:anywhere}",
      ".px-pane .px-icon{display:inline-block;width:12px;text-align:center;color:var(--blue-55)}",

      // Wide: the disclosure is transparent chrome, held open, summary hidden.
      ".px-tasks>summary{display:none}",

      // Below the pane's useful width the document wins: one collapsed line
      // above the document, still in source order and still keyboard-reachable.
      "@media (max-width:760px){",
      ".px-split{display:block}",
      ".px-tasks{margin-bottom:12px;border:1px solid var(--shadow);background:var(--face)}",
      ".px-tasks>summary{display:list-item;padding:5px 9px;cursor:pointer;",
      "font:var(--weight-bold,700) var(--text-sm,11px)/1.5 var(--font-caption);color:var(--blue-45)}",
      ".px-tasks[open]>summary{border-bottom:1px solid var(--shadow)}",
      ".px-pane{padding:8px}",
      ".px-address .px-label{display:none}}"
    ].join("");
    D.head.appendChild(style);
  }

  // ── device 1: the address bar ─────────────────────────────────────────────
  function buildAddressBar() {
    var bar = D.createElement("div");
    bar.className = "px-address";

    var label = D.createElement("span");
    label.className = "px-label";
    label.textContent = "Address";
    bar.appendChild(label);

    var well = D.createElement("div");
    well.className = "px-well";

    // The favicon nav.js already set for this route IS the section icon, so the
    // address bar and the browser tab cannot show different marks.
    var icon = D.querySelector('link[rel="icon"]');
    if (icon && icon.href) {
      var img = D.createElement("img");
      img.src = icon.href;
      img.alt = "";
      well.appendChild(img);
    }

    well.appendChild(link("/", "aadhar.sh"));
    var walked = "";
    segments.forEach(function (segment, index) {
      walked += "/" + segment;
      var sep = D.createElement("span");
      sep.className = "px-sep";
      sep.textContent = "›";
      well.appendChild(sep);
      var last = index === segments.length - 1;
      if (last) {
        var here = D.createElement("span");
        here.className = "px-here";
        // The leaf names the object, so prefer the document's own h1 over a slug.
        var heading = D.querySelector(".content h1, .np-body h1, h1");
        here.textContent = titleFor(walked, heading ? headingText(heading) : segment);
        well.appendChild(here);
      } else {
        well.appendChild(link(walked, titleFor(walked, segment)));
      }
    });

    bar.appendChild(well);
    // No Go button: this bar navigates by its links, and a Go control that
    // submitted nothing would be exactly the fabricated affordance the brand
    // rules forbid. Making it a real editable address is the follow-up.
    content.parentNode.insertBefore(bar, content);
  }

  // ── device 2: the task pane ───────────────────────────────────────────────
  function group(title, node) {
    var box = D.createElement("section");
    box.className = "px-group";
    var heading = D.createElement("h2");
    heading.textContent = title;
    box.appendChild(heading);
    box.appendChild(node);
    return box;
  }

  function list(items) {
    var ul = D.createElement("ul");
    items.forEach(function (item) {
      var li = D.createElement("li");
      var glyph = D.createElement("span");
      glyph.className = "px-icon";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = item.glyph || "›";
      li.appendChild(glyph);
      li.appendChild(link(item.href, item.label));
      ul.appendChild(li);
    });
    return ul;
  }

  function objectTasks() {
    var items = [];
    // What the document itself says it also exists as.
    D.querySelectorAll('link[rel="alternate"][href]').forEach(function (node) {
      var kind = (node.type || "").indexOf("markdown") > -1 ? "Markdown" : node.title || node.type || "alternate";
      items.push({ href: node.getAttribute("href"), label: "Read this as " + kind, glyph: "≡" });
    });
    (SECTION_DATA[sectionPath] || []).forEach(function (entry) {
      items.push({ href: entry.href, label: entry.label, glyph: "{" });
    });
    if (parentPath) items.push({ href: parentPath, label: "Up to " + titleFor(parentPath), glyph: "↑" });
    return items.length ? group("Object tasks", list(items)) : null;
  }

  function otherPlaces() {
    // nav.js's taskbar is the site's own first-level list. Reading it back means
    // this group cannot list a section the shell does not, or miss a new one.
    var pins = D.querySelectorAll("#axp-taskbar a.axp-pin[href]");
    var items = [];
    pins.forEach(function (pin) {
      var href = pin.getAttribute("href");
      if (href === sectionPath || items.length >= 6) return;
      items.push({ href: href, label: titleFor(href, (pin.textContent || "").trim()), glyph: "■" });
    });
    return items.length ? group("Other places", list(items)) : null;
  }

  function details() {
    var rows = [];
    var location_ = "aadhar.sh" + (location.pathname === "/" ? "" : location.pathname.replace(/\/+$/, ""));
    var heading = D.querySelector(".px-doc h1, .content h1, .np-body h1, h1");
    var name = heading
      ? headingText(heading)
      // Reading the title bar raw appended the close "x" to the object's name.
      : plainText(win.querySelector(":scope > .title-bar, :scope > .np-titlebar"),
                  ".controls, .np-controls, button, .axp-histnav");
    // Only worth a row when it says something the Location row does not.
    if (name && name !== location_) rows.push(["Name", name]);
    rows.push(["Location", location_]);

    // Where the window already carries a status bar, that bar is the page's own
    // count and this group defers to it rather than restating it in different
    // words. Two disagreeing counts on one screen is worse than one.
    var status = isFolder ? win.querySelector(":scope > .np-status, :scope > .status-bar") : null;
    if (status && status.children.length) {
      [].forEach.call(status.children, function (cell, index) {
        var value = (cell.textContent || "").trim();
        if (value) rows.push([index ? "" : "Contains", value]);
      });
    } else if (isFolder) {
      // Otherwise count the listing this folder actually renders.
      var counts = [
        [".px-doc .shelf > li", "experiments"], [".px-doc .np-list > li", "notes"],
        [".px-doc a picture", "photographs"], [".px-doc .file-list > li", "items"]
      ];
      for (var i = 0; i < counts.length; i++) {
        var found = D.querySelectorAll(counts[i][0]);
        if (found.length) { rows.push(["Contains", found.length + " " + counts[i][1]]); break; }
      }
    }

    // The garage marks each experiment shipped/parked/live in a pill beside its
    // h1. Stripped out of the name above, it belongs here as the object's state.
    var pill = D.querySelector(".px-doc h1 .status");
    if (pill) rows.push(["Status", pill.textContent.trim()]);

    // Only a dated article states its own date. A stray <time> further down a
    // page belongs to whatever it sits in, not to the object.
    var time = D.querySelector(".px-doc h1 ~ .meta time[datetime], .px-doc header time[datetime]");
    if (time) rows.push(["Modified", time.getAttribute("datetime")]);

    var dl = D.createElement("dl");
    rows.forEach(function (row) {
      // A continuation row (second status cell) keeps its value under the term
      // above it rather than inventing a label for it.
      if (row[0]) { var dt = D.createElement("dt"); dt.textContent = row[0]; dl.appendChild(dt); }
      var dd = D.createElement("dd"); dd.textContent = row[1];
      dl.appendChild(dd);
    });
    return group("Details", dl);
  }

  function buildTaskPane() {
    var split = D.createElement("div");
    split.className = "px-split";
    // Wrapped in a real <details>. On a wide viewport the summary is hidden and
    // the element is held open, so it reads as Explorer's pane; narrow, it
    // collapses to one line, because stacking three chrome panels above the
    // document means scrolling past the furniture to reach the page.
    var shell = D.createElement("details");
    shell.className = "px-tasks";
    var summary = D.createElement("summary");
    summary.textContent = "Folder tasks";
    shell.appendChild(summary);

    var pane = D.createElement("aside");
    pane.className = "px-pane";
    pane.setAttribute("aria-label", "Explorer tasks");
    shell.appendChild(pane);

    var wide = matchMedia("(min-width: 761px)");
    var sync = function () { shell.open = wide.matches; };
    sync();
    wide.addEventListener("change", sync);

    // Move the document into its column and ATTACH it before reading it. The
    // groups below query inside .px-doc so they can never count the pane's own
    // links, and a detached wrapper matches nothing — which silently cost the
    // Status and Contains rows twice while this was being built.
    var doc = D.createElement("div");
    doc.className = "px-doc";
    while (content.firstChild) doc.appendChild(content.firstChild);
    // Pane first in the DOM matches Explorer's reading order and means a
    // no-CSS render still leads with "where am I, what can I do".
    split.appendChild(shell);
    split.appendChild(doc);
    content.appendChild(split);

    [objectTasks(), otherPlaces(), details()].forEach(function (box) { if (box) pane.appendChild(box); });

    // The task pane costs horizontal room. Folder windows have to grow, or the
    // document column loses its measure — the single most consequential thing
    // this prototype has to say.
    var current = parseInt(getComputedStyle(win).maxWidth, 10);
    if (current && current < 900) win.style.maxWidth = (current + 200) + "px";
  }

  if (wantBar) buildAddressBar();
  if (wantPane) buildTaskPane();
  D.documentElement.setAttribute("data-proto-chrome", mode);
})();
