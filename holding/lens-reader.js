// lens-reader.js — the Reader lens pane, loaded on demand by lens.js.
//
// Standalone like lens-browser.js: it redeclares esc/bytes/section rather than
// importing them, because /lens ships no module graph and this file must be a
// single <script src> that can arrive late or never.
//
// The pane's job is a comparison, not a reading view. Anyone who wants to READ
// the page can open it. What they cannot see anywhere else is how much of it a
// reader-mode extractor throws away, and the fact that the extractor is
// guessing. So the gap leads, the prose comes last, and every panel says whose
// opinion it is reporting.
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
  function pre(text) { return '<pre class="lx-pre">' + esc(text) + "</pre>"; }

  var CREDIT =
    '<div class="lx-cap lx-reader-credit">Extraction by <a href="https://github.com/kepano/defuddle" rel="noopener">Defuddle</a> ' +
    "(MIT, kepano) — the engine behind Obsidian Web Clipper. It runs in its own Worker at /lens/read, " +
    "because a DOM implementation costs ~190 KB gzip and this site's Worker will not carry one.</div>";

  function intro() {
    return section("Reader's guess", { text: "not run" },
      "A third-party extractor's opinion of this page, from its own Worker.",
      '<div class="lx-reader-intro">Defuddle guesses which part of the document is the article and throws the rest away. ' +
      'The <b>Raw response</b> tab is what the server actually sent. The interesting number is the gap between them.' +
      '<button class="lx-browser-run" type="button" id="lx-reader-run">Run the extractor</button></div>' + CREDIT);
  }

  function busyPane() {
    return '<div class="lx-spin">Defuddle is re-reading the page and extracting an article&hellip;</div>';
  }

  // The headline. A percentage alone would be a verdict, and the verdict depends
  // entirely on what kind of page this is: 22% off a Wikipedia article is an
  // extractor doing its job, 55% off a landing page is an extractor deciding the
  // page has no content. So the number is stated and then INTERPRETED by band,
  // and the interpretation names the ambiguity rather than resolving it.
  function gap(d) {
    var pct = d.dropped && d.dropped.pct;
    var kind = pct == null ? "" : pct >= 50 ? "warn" : pct >= 20 ? "" : "ok";
    var reading = pct == null ? "No comparison available."
      : pct >= 50 ? "Over half the page did not survive. On an article that means heavy chrome; on a landing or index page it usually means the extractor found no article and picked a fragment."
      : pct >= 20 ? "A normal article-shaped result: navigation, footers and related-links stripped, body kept."
      : "Almost everything survived, so this page is nearly all body text — or the extractor kept the chrome too.";
    return section("What the extractor threw away", { text: pct == null ? "n/a" : pct + "% dropped", kind: kind },
      "Both counts come from the same function on the same fetch, so the difference is extraction and not two definitions of a word.",
      kvTable({
        "page as served": num(d.source && d.source.words) + " words · " + bytes(d.source && d.source.bytes),
        "extractor kept": num(d.kept && d.kept.words) + " words · " + bytes(d.kept && d.kept.bytes),
        "dropped": num(d.dropped && d.dropped.words) + " words",
      }) + '<div class="lx-cap">' + esc(reading) + "</div>");
  }

  function recoveryScore(d) {
    var r = d.recovery;
    if (!r || r.overall == null) return "";
    var rows = (r.checks || []).map(function (check) {
      return '<li><b>' + (check.pass ? '&#10003;' : '&#10005;') + ' ' + esc(check.label) + '</b><span>' + esc(check.detail || "") + '</span></li>';
    }).join("");
    return section("Defuddle content recovery", { text: r.overall + "/100", kind: r.overall >= 75 ? "ok" : r.overall >= 50 ? "" : "warn" },
      "Lens computes this from Defuddle's output. Defuddle itself does not publish a readability score.",
      '<ol class="lx-reader-recovery">' + rows + '</ol><div class="lx-cap">' + esc(r.scoringNote || "") + '</div>');
  }

  // The finding this lens exists to make visible, beyond the word gap. Defuddle
  // keeps <button> text ON PURPOSE (its markdown rules carry
  // addRule('button', replacement: content => content)), so a page with live
  // demos hands an agent control labels as though they were prose. An agent
  // cannot tell "Run all three" from a sentence.
  function controls(d) {
    var c = d.controls;
    if (!c || !c.total) return "";
    var kind = c.kept === 0 ? "ok" : c.kept >= c.total / 2 ? "warn" : "";
    var examples = (c.examples || []).length
      ? '<div class="lx-cap">Kept, verbatim: ' + (c.examples || []).map(function (x) { return "<code>" + esc(x) + "</code>"; }).join(", ") + "</div>"
      : "";
    return section("Control labels that survived", { text: c.kept + " of " + c.total, kind: kind },
      "Button and control text the extraction kept. A label without its behaviour is a claim, and an agent reading this output has no way to tell one from a sentence.",
      kvTable({
        "controls on the page": c.total,
        "labels in the extracted text": c.kept,
      }) + examples + '<div class="lx-cap">' + esc(c.note || "") + "</div>");
  }

  function claims(d) {
    return section("What the extractor claims this is", { text: d.title ? "titled" : "untitled" },
      "Metadata Defuddle lifted while extracting. Unset fields are omitted rather than guessed.",
      kvTable({
        title: d.title, author: d.author, published: d.published, site: d.site,
        "final URL": d.finalUrl, "redirected": d.redirected ? "yes" : null,
        "response": d.status + " · " + (d.contentType || "(none)"),
      }));
  }

  // A Worker's clock advances across I/O and NEVER during synchronous execution,
  // so in production `parse`, `extract` and `markdown` all read 0 while `fetch`
  // reads real time. Measured through the live route 2026-08-10: stripe.com came
  // back {fetch: 104, parse: 0, extract: 0, markdown: 0}, where the same run under
  // `wrangler dev` had reported 30 / 347 / 10.
  //
  // Printing those zeros would tell a visitor that parsing and extracting a 645 KB
  // page is free, on a panel whose entire job is saying what the second read cost.
  // So a zero is rendered as "not measurable here" with the reason, and the total
  // is labelled as the I/O it actually covers rather than as elapsed work.
  function phase(value) {
    if (value == null) return "?";
    return value > 0 ? value + " ms" : "not measurable (see below)";
  }
  function timing(d) {
    var ms = d.ms || {};
    var measured = (ms.fetch || 0);
    var blind = ["parse", "extract", "markdown"].filter(function (k) { return ms[k] === 0; }).length;
    return section("What the second read cost", { text: measured + " ms of network" },
      "This lens is opt-in because it re-fetches the target in full. The CPU half is a different story, below.",
      kvTable({
        "fetch the page again": phase(ms.fetch),
        "build a DOM (linkedom)": phase(ms.parse),
        "extract (defuddle)": phase(ms.extract),
        "to markdown (turndown)": phase(ms.markdown),
      }) + (blind
        ? '<div class="lx-cap">A Worker\'s clock advances across I/O and never during synchronous execution, so the three CPU phases cannot time themselves from inside. They are real work — the same run under a local runtime reported 30 ms, 347 ms and 10 ms — and the zeros here mean "unmeasurable", not "free". Actual CPU is readable in Workers Logs as <code>cpuTime</code>.</div>'
        : ""));
  }

  function prose(d) {
    var md = d.markdown || "";
    if (!md) return section("The extraction", { text: "empty" },
      "Defuddle returned no content for this page.", '<div class="lx-empty">Nothing extracted.</div>');
    return section("The extraction", { text: bytes(md.length) + (d.markdownTruncated ? " (capped)" : "") },
      "The markdown Defuddle would hand a clipper or an agent. First slice.",
      pre(md.slice(0, 2000) + (md.length > 2000 ? "\n\n[… " + bytes(md.length) + " total]" : "")));
  }

  function mount(d, isBusy) {
    if (isBusy) return busyPane();
    if (!d) return intro();
    if (!d.ok) {
      return section("Reader's guess", { text: "failed", kind: "warn" },
        "The extractor could not read this page.",
        '<div class="lx-fallback-note">' + esc(d.error || "Unknown failure.") + "</div>" +
        '<button class="lx-browser-run" type="button" id="lx-reader-run">Try again</button>') + CREDIT;
    }
    if (d.skipped === "not-html") {
      return section("Reader's guess", { text: "not applicable" },
        "This response is not HTML, so there is no article for an extractor to find.",
        kvTable({ "content-type": d.contentType || "(none)", "payload": bytes(d.source && d.source.bytes) }) +
        '<div class="lx-cap">Refusing is the honest answer here. Running an article heuristic over JSON would produce a number that means nothing.</div>') + CREDIT;
    }
    return recoveryScore(d) + gap(d) + controls(d) + claims(d) + prose(d) + timing(d) + CREDIT;
  }

  function run(data, done, onError) {
    fetch("/lens/read?url=" + encodeURIComponent(data.finalUrl || data.url))
      .then(function (response) {
        // Read as text and parse by hand, same reasoning as lens-browser.js: a
        // non-JSON body means the edge or the runtime answered for us with an
        // HTML error page, and .json() would surface a V8 parser message that
        // names the parser rather than the failure.
        return response.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (_e) {}
          if (!json) {
            return {
              ok: false,
              error: "the reader answered with " + (response.headers.get("content-type") || "an unknown body") +
                " instead of an extraction (HTTP " + response.status + "). That is the edge or the Worker failing, not the target page.",
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

  window.LensReader = { mount: mount, run: run };
})();
