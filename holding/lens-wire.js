// lens-wire.js — the Wire lens pane, loaded on demand by lens.js.
//
// Standalone like lens-reader.js and lens-browser.js: it redeclares esc/bytes/
// section rather than importing them, because /lens ships no module graph and
// this file must be a single <script src> that can arrive late or never.
//
// The pane's job is a COST, not a network debugger. A devtools waterfall already
// exists and is better at being a waterfall. What no other surface here shows is
// that the document every other lens argues about is a small fraction of what
// loading the page actually spends, and that most of the spending goes to people
// who wrote none of it. So the third-party share leads, the itemised rows come
// last, and every panel says what its number is worth.
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function bytes(n) {
    if (n == null) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  function num(n) { return String(n == null ? "?" : n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function section(title, badge, caption, inner) {
    return '<div class="lx-sec"><div class="lx-sec-h">' + esc(title) +
      (badge ? ' <span class="lx-badge' + (badge.kind ? " " + badge.kind : "") + '">' + esc(badge.text) + "</span>" : "") +
      "</div>" + (caption ? '<div class="lx-cap">' + esc(caption) + "</div>" : "") + inner + "</div>";
  }
  function kvTable(obj) {
    var rows = "";
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (obj[k] == null || obj[k] === "") continue;
      rows += "<tr><td>" + esc(k) + "</td><td>" + esc(obj[k]) + "</td></tr>";
    }
    return '<table class="lx-kv">' + rows + "</table>";
  }
  var CREDIT =
    '<div class="lx-cap lx-wire-credit">Recorded over the Chrome DevTools Protocol in a Cloudflare Browser Run instance, ' +
    'identified as AadharshBot. One cold load, no extensions, no blocker, no cookies — so this is the page a machine gets ' +
    'on first contact, which is usually worse than the page you get.</div>';

  function intro() {
    return section("What it costs", { text: "not run" },
      "Every request the page actually makes, and who receives them.",
      '<div class="lx-wire-intro">Every other lens reads the <b>document</b>. This one records the <b>load</b>: ' +
      'each request the page fires, its bytes on the wire, and which host got it. The number worth waiting for is ' +
      'how much of the weight belongs to somebody who wrote none of the words.' +
      '<button class="lx-browser-run" type="button" id="lx-wire-run">Record the load</button></div>' + CREDIT);
  }

  function busyPane() {
    return '<div class="lx-spin">Opening a browser and recording every request the page makes&hellip;</div>';
  }

  // The headline, and the reason this tab exists. A bare percentage would be a
  // verdict without a scale, so the band names what kind of page each range
  // usually means rather than pretending one number settles it.
  function headline(d) {
    var p = d.thirdParty.bytesPct;
    var kind = p >= 60 ? "warn" : p >= 30 ? "" : "ok";
    var reading = p >= 60
      ? "Most of this page's weight is not the publisher's. On a news or commerce page that is ad tech, tag managers and trackers; the words are the small part."
      : p >= 30
        ? "A normal modern page: the publisher's own content plus a working set of embeds, fonts and analytics."
        : "Nearly everything here is first-party. Either the page is genuinely self-contained, or its third parties load later than this observation ran.";
    return section("Who this page is actually for", { text: p + "% third-party bytes", kind: kind },
      "Share of transfer bytes going to a site other than the one in the address bar.",
      '<div class="lx-wire-split">' +
        '<div class="lx-wire-bar" role="img" aria-label="' + esc(p + " percent of bytes are third-party") + '">' +
          '<span class="lx-wire-first" style="width:' + (100 - p) + '%"></span>' +
          '<span class="lx-wire-third" style="width:' + p + '%"></span>' +
        "</div>" +
        '<div class="lx-wire-legend"><span><i class="lx-wire-first"></i>' + esc(d.pageSite || "this site") + " · " +
          bytes(d.bytes - d.thirdParty.bytes) + "</span><span><i class=\"lx-wire-third\"></i>" +
          num(d.thirdParty.hosts) + " other host" + (d.thirdParty.hosts === 1 ? "" : "s") + " · " +
          bytes(d.thirdParty.bytes) + "</span></div>" +
      "</div>" +
      kvTable({
        "requests": num(d.requests) + " total · " + num(d.thirdParty.requests) + " third-party (" + d.thirdParty.requestsPct + "%)",
        "transferred": bytes(d.bytes),
        "distinct hosts": num(d.hostTotal),
        "load event": d.loadFired ? d.navMs + " ms to settle" : "never fired within " + d.navMs + " ms",
      }) + '<div class="lx-cap">' + esc(reading) + "</div>");
  }

  var TYPE_LABEL = {
    document: "HTML documents", css: "stylesheets", js: "scripts", image: "images",
    font: "fonts", xhr: "data (XHR/fetch)", media: "audio/video", beacon: "beacons", other: "other",
  };

  // Bytes by kind, sorted heaviest first, with a bar so the shape is readable
  // before the numbers are. Scripts dominating an "article" is the finding.
  function byType(d) {
    var keys = Object.keys(d.byType).sort(function (a, b) { return d.byType[b].bytes - d.byType[a].bytes; });
    if (!keys.length) return "";
    var max = d.byType[keys[0]].bytes || 1;
    var rows = keys.map(function (k) {
      var t = d.byType[k];
      return '<li><b>' + esc(TYPE_LABEL[k] || k) + '</b>' +
        '<span class="lx-wire-track"><i style="width:' + Math.max(2, Math.round((t.bytes / max) * 100)) + '%"></i></span>' +
        '<span class="lx-wire-n">' + bytes(t.bytes) + " · " + num(t.count) + "</span></li>";
    }).join("");
    return section("Where the bytes went", { text: num(d.requests) + " requests" },
      "Transfer size by resource kind. A page whose scripts outweigh its document is a program that happens to contain an article.",
      '<ol class="lx-wire-types">' + rows + "</ol>");
  }

  // The roll call. This is the panel people screenshot: a list of companies that
  // received a request because someone opened a page.
  function hosts(d) {
    if (!d.hosts.length) return "";
    var rows = d.hosts.map(function (h) {
      return "<tr><td>" + (h.third ? '<span class="lx-wire-dot third"></span>' : '<span class="lx-wire-dot first"></span>') +
        "<code>" + esc(h.host) + "</code></td><td>" + num(h.count) + "</td><td>" + bytes(h.bytes) + "</td></tr>";
    }).join("");
    var more = d.hostTotal > d.hosts.length
      ? '<div class="lx-cap">' + num(d.hostTotal - d.hosts.length) + " further host" +
        (d.hostTotal - d.hosts.length === 1 ? "" : "s") + " received requests and are not listed.</div>"
      : "";
    return section("Everyone who got a request", { text: num(d.hostTotal) + " hosts", kind: d.thirdParty.hosts >= 20 ? "warn" : "" },
      "Heaviest first. A dot on the left marks a host that is not this site.",
      '<table class="lx-kv lx-wire-hosts"><thead><tr><th>host</th><th>requests</th><th>bytes</th></tr></thead><tbody>' +
      rows + "</tbody></table>" + more +
      '<div class="lx-cap">"Not this site" compares the last two labels of the hostname, so a page and its own CDN on a ' +
      'different domain read as separate, and two subdomains of one site read as one. The host list above is the ' +
      "observation; the grouping is a convenience laid over it.</div>");
  }

  function waterfall(d) {
    if (!d.rows.length) return "";
    var rows = d.rows.map(function (r) {
      var cls = r.failed ? " is-failed" : r.third ? " is-third" : "";
      // "canceled" and "fail" are different events and the difference is
      // load-bearing: a beacon that got its 204 and was then abandoned at
      // teardown is the page working as designed, and calling it a failure puts
      // a wrong number on the one panel that has to be trustworthy.
      var status = r.failed ? "fail"
        : r.aborted ? (r.status == null ? "canceled" : r.status + " ✕")
        : r.cached ? "cache" : (r.status == null ? "—" : r.status);
      return '<tr class="lx-wire-row' + cls + '"><td>' + esc(r.type) + "</td><td>" + esc(status) + "</td><td>" +
        bytes(r.bytes) + "</td><td>" + (r.ms == null ? "—" : r.ms + " ms") + '</td><td><code title="' + esc(r.url) + '">' +
        esc(r.host) + "</code></td></tr>";
    }).join("");
    var capped = d.truncated
      ? '<div class="lx-cap">First ' + num(d.rows.length) + " of " + num(d.requests) +
        " requests, in load order. The totals above count every one of them.</div>"
      : "";
    var states = [];
    if (d.failed) states.push(num(d.failed) + " failed");
    if (d.aborted) states.push(num(d.aborted) + " canceled after a response, which is normal for beacons");
    if (d.cached) states.push(num(d.cached) + " served from cache");
    var stateNote = states.length ? '<div class="lx-cap">' + esc(states.join(" · ")) + ".</div>" : "";
    return section("The load, in order", { text: num(d.rows.length) + " shown" },
      "Each row is one request the browser made. Failures, cancellations and cache hits are marked rather than dropped.",
      '<div class="lx-wire-scroll"><table class="lx-kv lx-wire-list"><thead><tr><th>kind</th><th>status</th><th>bytes</th><th>time</th><th>host</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" + stateNote + capped);
  }

  // Say what the observation is NOT, on the panel itself. A single cold load from
  // one Cloudflare colo, as a declared bot, is a real measurement of a specific
  // thing, and reading it as "what this page costs everyone" is the mistake the
  // number invites.
  function caveats(d) {
    return section("What this measurement is", { text: "one cold load" },
      "The honest scope of the number above.",
      kvTable({
        "who asked": d.identifiedAs || "an unidentified headless Chrome (the UA override did not apply)",
        "cache state": "cold — no cookies, no storage, nothing warmed",
        "consent": "no banner was dismissed, so anything gated behind consent did not load",
        "observation window": (d.navMs || 0) + " ms, ending " + (d.loadFired ? "2.5s after the load event" : "at the navigation timeout"),
        "recorded": d.fromCache ? "from this lens's 6h cache" : "just now",
      }) +
      '<div class="lx-cap">A page that serves fewer trackers to a declared bot than to a person will look cleaner here ' +
      "than it is. That gap is itself worth knowing, and this lens cannot measure it without pretending to be someone " +
      "it is not, which it will not do.</div>");
  }

  function mount(d, isBusy) {
    if (isBusy) return busyPane();
    if (!d) return intro();
    if (!d.ok) {
      return section("What it costs", { text: "failed", kind: "warn" },
        "The load could not be recorded.",
        '<div class="lx-fallback-note">' + esc(d.error || "Unknown failure.") + "</div>" +
        '<button class="lx-browser-run" type="button" id="lx-wire-run">Try again</button>') + CREDIT;
    }
    if (!d.requests) {
      return section("What it costs", { text: "no requests" },
        "The browser reached the page and recorded no completed requests.",
        '<div class="lx-empty">Nothing on the wire. Usually a navigation that never resolved, or a host that refused the connection.</div>') + CREDIT;
    }
    return headline(d) + byType(d) + hosts(d) + waterfall(d) + caveats(d) + CREDIT;
  }

  function run(data, done, onError) {
    fetch("/lens/wire?url=" + encodeURIComponent(data.finalUrl || data.url))
      .then(function (response) {
        // Read as text and parse by hand, same reasoning as lens-reader.js: a
        // non-JSON body means the edge or the runtime answered for us with an
        // HTML error page, and .json() would surface a V8 parser message naming
        // the parser rather than the failure.
        return response.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (_e) {}
          if (!json) {
            return {
              ok: false,
              error: "the wire lens answered with " + (response.headers.get("content-type") || "an unknown body") +
                " instead of a trace (HTTP " + response.status + "). That is the edge or the Worker failing, not the target page.",
            };
          }
          return json;
        });
      })
      .then(done)
      .catch(function (error) {
        done({ ok: false, error: String((error && error.message) || error) });
        if (onError) onError(error);
      });
  }

  window.LensWire = { mount: mount, run: run };
})();
