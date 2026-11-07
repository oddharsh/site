// photos-view.js — the /photos View menu: Filmstrip, Thumbnails, Details.
//
// photos.ts renders the contact sheet, the menu bar and the menu itself. This
// script wires the menu and builds the two other views over the same tiles, so
// the sheet stays the page: a visitor without JavaScript gets every photo and
// every original, and nothing here replaces a tile's link.
//
// The menu is a popover="auto" opened by its button's popovertarget, so light
// dismiss, Esc and a second press on View closing it are all the platform's.
// The keyboard model is ours, as in notepad.js: arrow keys, Home/End and
// typeahead inside the menu, and focus back on View before the menu hides
// (nav-tray.js says why the order matters).
//
// The views fetch what they show on first use and never before: manifest.json
// for each photo's 600px AVIF and its size, exif.json for the camera fields,
// and /images/meta/<stem>.json for one photo's histogram. exif.json and the
// meta files are immutable and keyed by the same ?mv= as tooltip.ts, so a
// visitor who hovered photos on the homepage already has them cached.
//
// Switching views is not remembered across visits. Explorer kept each folder's
// view, but restoring it here would swap the sheet for a table after first
// paint, a layout shift on every visit by someone who once chose Details.
(() => {
  "use strict";
  var D = document;
  var main = D.getElementById("main");
  var bar = D.querySelector(".ph-menubar") as HTMLElement | null;
  var sheet = D.querySelector(".sheet") as HTMLElement | null;
  if (!main || !bar || !sheet || !("showPopover" in HTMLElement.prototype)) return;
  var btn = D.getElementById("ph-view") as HTMLButtonElement;
  var drop = D.getElementById("ph-views") as HTMLElement;
  var items = [].slice.call(drop.querySelectorAll("[data-view]")) as HTMLButtonElement[];

  // Must match tooltip.ts's META_V, since the URL is the cache key both share.
  // contract-the-photos-view-menu fails when the two disagree.
  var META_V = "mv=7";

  type Exif = { cm?: string; ln?: string; ap?: string; sp?: string; is?: number; fl?: string; dt?: string; w?: number; h?: number };
  type Hist = { l: number[]; r?: number[]; g?: number[]; b?: number[] };
  type Photo = { stem: string; link: HTMLAnchorElement; tile: HTMLElement; alt: string; jpg: string };

  var photos: Photo[] = [].slice.call(sheet.querySelectorAll(".ph")).map((tile: HTMLElement) => {
    var link = tile.querySelector(".ph-open") as HTMLAnchorElement;
    var img = tile.querySelector("img") as HTMLImageElement;
    return {
      stem: (tile.querySelector(".ph-name") as HTMLElement).textContent || "",
      link: link,
      tile: tile,
      alt: img.alt,
      jpg: img.getAttribute("src") || img.dataset.src || "",
    };
  });

  function esc(s: string | number | null | undefined) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  }
  function getJson(url: string) {
    return fetch(url).then((r) => {
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(url + ": " + r.status);
      return r.json();
    });
  }

  // ── data, fetched once on the first switch away from Thumbnails ────────────
  var exif: Record<string, Exif> = {};
  var tiers: Record<string, { avif?: string; size?: number }> = {};
  // Each file fills its own columns, so one failing leaves the other's shown.
  // A failed file leaves its fields blank, and the next switch retries it.
  var manifest: Promise<void> | null = null;
  var camera: Promise<void> | null = null;
  function loadData() {
    manifest =
      manifest ||
      getJson("/images/manifest.json")
        .then((m) => {
          for (var p of m.photos || []) tiers[p.stem] = { avif: p.thumb_avif, size: p.size };
        })
        .catch(() => {
          manifest = null;
        });
    camera =
      camera ||
      getJson("/images/exif.json?" + META_V)
        .then((all) => {
          exif = all || {};
        })
        .catch(() => {
          camera = null;
        });
    return Promise.all([manifest, camera]);
  }

  // ── formatting: XP's Details columns, with a null field left blank ─────────
  // EXIF dates are "2026:03:08 09:33:02"; XP printed "3/8/2026 9:33 AM".
  function fmtDate(dt?: string) {
    var m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(dt || "");
    if (!m) return "";
    var h = +m[4];
    return +m[2] + "/" + +m[3] + "/" + m[1] + " " + (h % 12 || 12) + ":" + m[5] + (h < 12 ? " AM" : " PM");
  }
  // XP's Size column: whole KB, rounded up, with a thousands separator.
  function fmtSize(bytes?: number) {
    return bytes ? Math.ceil(bytes / 1024).toLocaleString("en-US") + " KB" : "";
  }
  function fmtDims(e?: Exif) {
    return e && e.w && e.h ? e.w + " x " + e.h : "";
  }
  // "1/60" sorts as 1/60 of a second, "f/2.8" as 2.8, "53 mm" as 53.
  function num(v?: string | number) {
    if (v == null) return null;
    var m = /(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?/.exec(String(v).replace(/^f\//, ""));
    return m ? (m[2] ? +m[1] / +m[2] : +m[1]) : null;
  }

  type Column = { label: string; cell: (p: Photo) => string; key: (p: Photo) => string | number | null; num?: true };
  var COLUMNS: Column[] = [
    { label: "Name", cell: (p) => '<a href="' + esc(p.link.getAttribute("href")) + '">' + esc(p.stem) + "</a>", key: (p) => p.stem },
    { label: "Size", cell: (p) => fmtSize((tiers[p.stem] || {}).size), key: (p) => (tiers[p.stem] || {}).size || null, num: true },
    { label: "Date Picture Taken", cell: (p) => fmtDate((exif[p.stem] || {}).dt), key: (p) => (exif[p.stem] || {}).dt || null },
    { label: "Dimensions", cell: (p) => fmtDims(exif[p.stem]), key: (p) => ((e) => (e && e.w && e.h ? e.w * e.h : null))(exif[p.stem]) },
    { label: "Camera Model", cell: (p) => esc((exif[p.stem] || {}).cm), key: (p) => (exif[p.stem] || {}).cm || null },
    { label: "Lens", cell: (p) => esc((exif[p.stem] || {}).ln), key: (p) => (exif[p.stem] || {}).ln || null },
    { label: "F-Number", cell: (p) => esc((exif[p.stem] || {}).ap), key: (p) => num((exif[p.stem] || {}).ap) },
    { label: "Exposure Time", cell: (p) => esc((exif[p.stem] || {}).sp), key: (p) => num((exif[p.stem] || {}).sp) },
    { label: "ISO Speed", cell: (p) => esc((exif[p.stem] || {}).is), key: (p) => num((exif[p.stem] || {}).is) },
    { label: "Focal Length", cell: (p) => esc((exif[p.stem] || {}).fl), key: (p) => num((exif[p.stem] || {}).fl) },
  ];

  // ── Details: a sortable table over the same photos ────────────────────────
  var list: HTMLElement | null = null;
  var sortBy = 0,
    sortDir = 1;
  function drawList() {
    var col = COLUMNS[sortBy];
    // Blank fields sort last in both directions, the way Explorer kept them.
    var rows = photos.slice().sort((a, b) => {
      var x = col.key(a),
        y = col.key(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    var head = COLUMNS.map((c, i) => {
      var sort = i === sortBy ? ' aria-sort="' + (sortDir > 0 ? "ascending" : "descending") + '"' : "";
      return "<th" + (c.num ? ' class="num"' : "") + sort + '><button type="button" data-col="' + i + '">' + c.label + "</button></th>";
    }).join("");
    var body = rows
      .map(
        (p) =>
          "<tr>" +
          COLUMNS.map((c, i) => {
            var cls = (c.num ? "num" : "") + (i === sortBy ? " sorted" : "");
            return "<td" + (cls ? ' class="' + cls.trim() + '"' : "") + ">" + c.cell(p) + "</td>";
          }).join("") +
          "</tr>",
      )
      .join("");
    (list as HTMLElement).innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
  }
  function showList() {
    if (!list) {
      list = D.createElement("div");
      list.className = "ph-list";
      list.addEventListener("click", (e) => {
        var head = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null;
        if (!head) return;
        var i = +(head.dataset.col as string);
        sortDir = i === sortBy ? -sortDir : 1;
        sortBy = i;
        drawList();
        (list as HTMLElement).querySelector<HTMLElement>('[data-col="' + i + '"]')!.focus();
      });
      sheet!.before(list);
    }
    list.hidden = false;
    drawList();
    var pending = loadData();
    list.setAttribute("aria-busy", "true");
    // loadData never rejects: each file catches its own failure.
    void pending.then(() => {
      list!.removeAttribute("aria-busy");
      if (view === "details") drawList();
    });
  }

  // ── Filmstrip: one large frame over the sheet laid out as a strip ─────────
  var film: HTMLElement | null = null;
  var current = 0;
  var hist: Record<string, Hist | null> = {};
  var shown = "";
  function histSvg(h: Hist | null) {
    if (!h || !Array.isArray(h.l) || !h.l.length) return "";
    var n = h.l.length;
    var pts = (a: number[]) => a.map((v, i) => i + "," + (32 - (Math.max(0, Math.min(100, v)) * 30) / 100).toFixed(1)).join(" ");
    var line = (k: "r" | "g" | "b") => (Array.isArray(h[k]) ? '<polyline class="' + k + '" points="' + pts(h[k] as number[]) + '"/>' : "");
    return (
      '<svg class="ph-hist" viewBox="0 0 ' +
      (n - 1) +
      ' 32" preserveAspectRatio="none" role="img" aria-label="Histogram">' +
      '<polygon class="luma" points="0,32 ' +
      pts(h.l) +
      " " +
      (n - 1) +
      ',32"/>' +
      line("r") +
      line("g") +
      line("b") +
      "</svg>"
    );
  }
  function drawFrame() {
    var p = photos[current];
    var e = exif[p.stem] || {};
    var t = tiers[p.stem] || {};
    var exposure = [e.ap, e.sp && e.sp + " s", e.is && "ISO " + e.is, e.fl].filter(Boolean).join(", ");
    var facts: [string, string][] = [
      ["Taken", fmtDate(e.dt)],
      ["Camera", e.cm || ""],
      ["Lens", e.ln || ""],
      ["Exposure", exposure],
      ["Dimensions", fmtDims(e)],
      ["Size", fmtSize(t.size)],
    ];
    // The picture is rebuilt only when it would change: a histogram landing
    // redraws the facts, and a new <img> then would blank the frame to repaint
    // the same photo.
    var frame = film!.querySelector(".ph-frame") as HTMLElement;
    var picture =
      '<a href="' +
      esc(p.link.getAttribute("href")) +
      '"><picture>' +
      (t.avif ? '<source type="image/avif" srcset="' + esc(t.avif) + '">' : "") +
      '<img src="' +
      esc(p.jpg) +
      '" alt="' +
      esc(p.alt) +
      '" width="600" height="600" decoding="async"></picture></a>';
    if (shown !== picture) frame.innerHTML = shown = picture;
    (film!.querySelector(".ph-info") as HTMLElement).innerHTML =
      "<h2>" +
      esc(p.stem) +
      "</h2><dl>" +
      facts
        .filter((f) => f[1])
        .map((f) => "<dt>" + f[0] + "</dt><dd>" + esc(f[1]) + "</dd>")
        .join("") +
      "</dl>" +
      histSvg(hist[p.stem] || null);
    (film!.querySelector("[data-step='-1']") as HTMLButtonElement).disabled = current === 0;
    (film!.querySelector("[data-step='1']") as HTMLButtonElement).disabled = current === photos.length - 1;
    if (!(p.stem in hist)) {
      var stem = p.stem;
      hist[stem] = null;
      getJson("/images/meta/" + encodeURIComponent(stem) + ".json?" + META_V)
        .then((m) => {
          hist[stem] = (m && m.hi) || null;
          if (view === "filmstrip" && photos[current].stem === stem) drawFrame();
        })
        .catch(() => {
          delete hist[stem];
        });
    }
  }
  function select(i: number, focus?: boolean) {
    current = Math.max(0, Math.min(photos.length - 1, i));
    photos.forEach((p, j) => {
      if (j === current) p.link.setAttribute("aria-current", "true");
      else p.link.removeAttribute("aria-current");
    });
    var link = photos[current].link;
    hydrate(link);
    if (focus) link.focus({ preventScroll: true });
    // Scroll the strip alone: scrollIntoView would also scroll the page to the
    // strip, under the frame, on every step.
    var r = photos[current].tile.getBoundingClientRect(),
      s = sheet!.getBoundingClientRect();
    if (r.left < s.left) sheet!.scrollLeft -= s.left - r.left + 8;
    else if (r.right > s.right) sheet!.scrollLeft += r.right - s.right + 8;
    drawFrame();
  }
  // The tiles past the first twelve name their URLs in data-srcset and data-src
  // until photos.ts's GALLERY_DEFER sees them near the screen. That observer
  // watches the page scroller, which a sideways strip never moves, so this one
  // watches the strip and fills tiles a strip's width ahead.
  function hydrate(scope: Element) {
    for (var s of scope.querySelectorAll<HTMLSourceElement>("source[data-srcset]")) if (!s.srcset) s.srcset = s.dataset.srcset!;
    var img = scope.querySelector<HTMLImageElement>("img[data-src]");
    if (img && !img.getAttribute("src")) img.src = img.dataset.src!;
  }
  var strip: IntersectionObserver | null = null;
  function showFilm() {
    if (!film) {
      film = D.createElement("div");
      film.className = "ph-film";
      film.innerHTML =
        '<div><figure class="ph-frame"></figure><div class="ph-steps">' +
        '<button type="button" class="xp-button" data-step="-1" aria-label="Previous picture">&#9668; Previous</button>' +
        '<button type="button" class="xp-button" data-step="1" aria-label="Next picture">Next &#9658;</button>' +
        '</div></div><div class="ph-info" aria-live="polite"></div>';
      film.addEventListener("click", (e) => {
        var step = (e.target as HTMLElement).closest("[data-step]") as HTMLElement | null;
        if (step) select(current + +(step.dataset.step as string));
      });
      sheet!.before(film);
    }
    film.hidden = false;
    strip =
      strip ||
      new IntersectionObserver(
        (es) => {
          for (var e of es) if (e.isIntersecting) hydrate(e.target);
        },
        { root: sheet, rootMargin: "0px 100%" },
      );
    for (var p of photos) strip.observe(p.tile);
    select(current);
    void loadData().then(() => {
      if (view === "filmstrip") drawFrame();
    });
  }

  // In the filmstrip a tile selects its photo rather than opening it; the
  // frame above is the link to the original. A modified click still opens.
  sheet.addEventListener("click", (e) => {
    if (view !== "filmstrip" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    var link = (e.target as HTMLElement).closest(".ph-open");
    var i = photos.findIndex((p) => p.link === link);
    if (i < 0) return;
    e.preventDefault();
    select(i, true);
  });
  main.addEventListener("keydown", (e) => {
    if (view !== "filmstrip" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!sheet!.contains(e.target as Node) && !film!.contains(e.target as Node)) return;
    var to = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: photos.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(to, sheet!.contains(e.target as Node));
  });

  // ── switching ──────────────────────────────────────────────────────────────
  var view = "thumbnails";
  function setView(next: string) {
    if (next === view) return;
    view = next;
    main!.dataset.view = next;
    items.forEach((item) => item.setAttribute("aria-checked", String(item.dataset.view === next)));
    if (film) film.hidden = next !== "filmstrip";
    if (list) list.hidden = next !== "details";
    if (next !== "filmstrip") {
      if (strip) strip.disconnect();
      photos[current].link.removeAttribute("aria-current");
    }
    if (next === "filmstrip") showFilm();
    else if (next === "details") showList();
  }

  // ── the menu ───────────────────────────────────────────────────────────────
  function focusItem(atEnd: boolean) {
    items[atEnd ? items.length - 1 : items.findIndex((item) => item.getAttribute("aria-checked") === "true")].focus();
  }
  function close() {
    btn.focus();
    if (drop.matches(":popover-open")) drop.hidePopover();
  }
  drop.addEventListener("beforetoggle", (e) => {
    var open = (e as ToggleEvent).newState === "open";
    btn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    var r = btn.getBoundingClientRect();
    drop.style.left = r.left + "px";
    drop.style.top = r.bottom + "px";
  });
  // A click, Enter or Space on View opens the menu through popovertarget, and
  // focus follows once it is shown. Toggle events coalesce when keys come
  // fast, so the arrow keys below focus directly rather than through this.
  drop.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "open" && !drop.contains(D.activeElement)) focusItem(false);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!drop.matches(":popover-open")) drop.showPopover();
    focusItem(e.key === "ArrowUp");
  });
  // Focus moving out of the menu bar (Tab from View) closes the menu; light
  // dismiss covers a click elsewhere. A null relatedTarget is skipped because
  // Safari focuses nothing when a button is pressed, and closing then would
  // drop the click on the item being pressed.
  bar.addEventListener("focusout", (e) => {
    var to = e.relatedTarget as Node | null;
    if (to && !bar!.contains(to) && drop.matches(":popover-open")) drop.hidePopover();
  });
  drop.addEventListener("keydown", (e) => {
    var at = items.indexOf(D.activeElement as HTMLButtonElement);
    var key = e.key,
      to = -1;
    if (key === "Escape" || key === "Tab") {
      // Focus goes back to View before the menu hides. Tab then carries on
      // from View, out of the menu bar, as in any menu bar.
      if (key === "Escape") e.preventDefault();
      close();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") to = (at + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    else if (key === "Home" || key === "End") to = key === "Home" ? 0 : items.length - 1;
    else if (key.length === 1 && key !== " ") {
      for (var k = 1; k <= items.length; k++) {
        var j = (at + k) % items.length;
        if ((items[j].textContent || "").toLowerCase().startsWith(key.toLowerCase())) {
          to = j;
          break;
        }
      }
    }
    if (to < 0) return;
    e.preventDefault();
    items[to].focus();
  });
  for (var item of items) {
    item.addEventListener("click", (e) => {
      var picked = (e.currentTarget as HTMLElement).dataset.view as string;
      close();
      setView(picked);
    });
  }
  bar.classList.add("on");
})();
