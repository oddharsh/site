// lens-markdown.js — the Markdown lens pane, loaded on demand by lens.js.
//
// Standalone like lens-tools.js and lens-nlweb.js: it redeclares esc/section
// rather than importing them, because /lens ships no module graph and this file
// must be a single <script src> that can arrive late or never.
//
// THE REPLAY LEADS AND THE CHECKLIST FOLLOWS, and the order is the argument.
// A conformance grade answers "is this origin correct". The question somebody
// actually has is "does the client I use get Markdown here", and those come
// apart: three of the seven shipping agents send an Accept header where Markdown
// and HTML both arrive at q=1, so a server ranking strictly by q-value passes
// every check on the list and still hands them HTML. Putting the checklist first
// would bury the finding under four green ticks.
//
// Every content-type, status and byte count below came from a stranger's server,
// so the rows are built with createElement and textContent, and the Markdown
// sample goes into a <pre> as text. The agent NAMES are ours and still go
// through the same path, because a table where some cells are trusted and some
// are not is a table somebody edits wrongly later.
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function section(title, badge, caption, inner) {
    return '<div class="lx-sec"><div class="lx-sec-h">' + esc(title) +
      (badge ? ' <span class="lx-badge' + (badge.kind ? " " + badge.kind : "") + '">' + esc(badge.text) + "</span>" : "") +
      "</div>" + (caption ? '<div class="lx-cap">' + esc(caption) + "</div>" : "") + inner + "</div>";
  }

  /** @type {any} */
  var state = null;

  function intro() {
    return section("What agents get", { text: "not run" },
      "Replays the Accept header seven named agent clients actually send, and reports which representation each one got back.",
      '<div class="lx-tools-intro"><b>Agent doors knocks. This walks through.</b> ' +
      'The doors tier keeps one boolean about Markdown negotiation: did the content-type flip for a bare ' +
      '<code>text/markdown</code>. That can be true while the client you use still gets HTML, because ' +
      'three of the seven agents send a header where Markdown and HTML arrive tied.' +
      '<div class="lx-md-run"><button class="lx-browser-run" type="button" id="lx-md-run">Check it</button></div>' +
      '<div class="lx-cap">Ten plain requests for this one page, cached for an hour. It costs the origin ' +
      'bandwidth rather than compute, and it never fires on its own.</div></div>');
  }

  function unreadablePane(s) {
    // The same distinction classifyDoor keeps, for the same reason: "this origin
    // serves no Markdown" and "we never got an answer at all" are different
    // findings, and merging them would have the pane grade a live origin on a
    // request that never arrived.
    return section("What agents get", { text: "unreadable", kind: "warn" },
      esc(s.error || ""),
      '<div class="lx-md-note">The origin did not answer a plain browser request, so nothing below could be ' +
      'measured. This is not evidence that it refuses Markdown.</div>');
  }

  function verdictLine(s) {
    if (!s.negotiating) {
      // No control separation means no reach number. An origin handing every
      // Accept the same bytes is not turning seven agents away, it has one
      // representation, and reporting "0 of 7" would read as a refusal.
      return "This URL answers every Accept header with the same " + (s.controlType || "representation") +
        ". It is not negotiating at all, so there is no Markdown here for any client to get.";
    }
    var r = s.reach;
    if (!r) return "The browser control did not come back, so reach cannot be scored.";
    if (r.reached === r.of) return "All " + r.of + " agent clients get Markdown from this URL.";
    if (r.reached === 0) return "This URL negotiates, and none of the " + r.of + " agent clients get Markdown from it.";
    return r.reached + " of " + r.of + " agent clients get Markdown. The rest send an Accept header this origin " +
      "answers with " + (s.controlType || "HTML") + ".";
  }

  function paneHtml(s) {
    if (!s) return intro();
    if (s.pending) return section("What agents get", { text: "checking…" },
      "Ten requests for this page, one per distinct Accept header.",
      '<div class="lx-md-note">Waiting for the origin.</div>');
    if (!s.ok) return unreadablePane(s);
    state = s;

    var r = s.reach;
    var badge = !s.negotiating ? { text: "no negotiation", kind: "bad" }
      : !r ? { text: "unscored", kind: "warn" }
        : r.reached === r.of ? { text: "all " + r.of, kind: "ok" }
          : r.reached ? { text: r.reached + " of " + r.of, kind: "warn" }
            : { text: "none of " + r.of, kind: "bad" };

    var caption = esc(s.host || "") + " · " + s.responses.length + " requests" + (s.fromCache ? " · cached" : "");

    var deltaHtml = s.delta
      ? '<div class="lx-md-delta"><b>' + esc(String(s.delta.ratio)) + '×</b> smaller: ' +
        esc(fmtBytes(s.delta.htmlBytes)) + " of HTML against " + esc(fmtBytes(s.delta.markdownBytes)) +
        " of Markdown, " + esc(String(s.delta.saved)) + "% less to read." +
        '<div class="lx-cap">Both numbers are the decoded bodies of the two responses just fetched, counted in ' +
        'full rather than estimated. Decoded rather than on-the-wire because an agent spends its context on the ' +
        'characters, not on what the transfer encoding did with them.</div></div>'
      // Stated as an absence rather than omitted, the same discipline the NLWeb
      // pane uses: a missing row reads as a question nobody asked.
      : '<div class="lx-cap">No byte comparison: ' + (s.anyMarkdown
        ? "one of the two responses was larger than the read cap, so a total would be a floor rather than a size."
        : "nothing here came back as Markdown to compare against.") + "</div>";

    return section("What agents get", badge, caption,
      '<div class="lx-md-verdict">' + esc(verdictLine(s)) + "</div>" +
      '<table class="lx-md-agents"><thead><tr><th>client</th><th>sends</th><th>gets</th></tr></thead>' +
      '<tbody id="lx-md-agents"></tbody></table>' +
      deltaHtml +
      '<div class="lx-sec-h" style="margin-top:10px">Conformance</div>' +
      '<div class="lx-cap">The four checks <a href="https://acceptmarkdown.com/" target="_blank" rel="noopener noreferrer">acceptmarkdown.com</a> ' +
      'scores a URL against, plus two it does not: an explicit <code>q=0</code> refusal, and the ' +
      '<code>rel=alternate</code> link the clients that send no Accept header follow instead.</div>' +
      '<div class="lx-md-checks" id="lx-md-checks"></div>' +
      (s.sample ? '<div class="lx-sec-h" style="margin-top:10px">What came back</div>' +
        '<pre class="lx-md-sample" id="lx-md-sample"></pre>' : "") +
      '<div class="lx-md-run"><button class="lx-browser-run" type="button" id="lx-md-run">Check again</button></div>');
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  /** One agent row, built as nodes because the answer half is foreign. */
  function agentNode(a) {
    var row = document.createElement("tr");
    row.className = a.ok && a.markdown ? "lx-md-yes" : a.ok ? "lx-md-no" : "lx-md-err";

    var who = document.createElement("td");
    var name = document.createElement("b");
    name.textContent = a.label;
    who.appendChild(name);
    var vendor = document.createElement("div");
    vendor.className = "lx-md-vendor";
    // The verification date travels with the row rather than sitting in a
    // footnote, so an entry that has drifted since argues with itself in place.
    vendor.textContent = a.vendor + " · header seen " + a.verified;
    who.appendChild(vendor);
    row.appendChild(who);

    var sends = document.createElement("td");
    var code = document.createElement("code");
    code.textContent = a.accept;
    sends.appendChild(code);
    row.appendChild(sends);

    var gets = document.createElement("td");
    if (!a.ok) {
      gets.className = "lx-md-gets";
      gets.textContent = "no answer";
    } else {
      gets.className = "lx-md-gets";
      var badge = document.createElement("span");
      badge.className = "lx-badge " + (a.markdown ? "ok" : "warn");
      badge.textContent = a.markdown ? "Markdown" : (a.contentType || "no content-type");
      gets.appendChild(badge);
      var meta = document.createElement("div");
      meta.className = "lx-md-vendor";
      meta.textContent = "HTTP " + a.status + (a.bytes ? " · " + fmtBytes(a.bytes) : "");
      gets.appendChild(meta);
    }
    row.appendChild(gets);
    return row;
  }

  function checkNode(c) {
    var row = document.createElement("div");
    row.className = "lx-md-check lx-md-" + c.status;

    var dot = document.createElement("span");
    dot.className = "lx-badge " + (c.status === "pass" ? "ok" : c.status === "fail" ? "bad" : "warn");
    dot.textContent = c.status;
    row.appendChild(dot);

    var body = document.createElement("div");
    var id = document.createElement("code");
    id.textContent = c.id;
    body.appendChild(id);
    var detail = document.createElement("div");
    detail.className = "lx-md-detail";
    detail.textContent = c.detail;
    body.appendChild(detail);
    row.appendChild(body);
    return row;
  }

  window.LensMarkdown = {
    run: function (targetUrl, onOk, onFail) {
      fetch("/lens/markdown?url=" + encodeURIComponent(targetUrl), { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(onOk)
        .catch(function () { onFail(); });
    },
    render: paneHtml,
    // Called after the pane's HTML lands, exactly like LensNlweb.bind. Everything
    // carrying a foreign string is created here rather than in the string above.
    bind: function (root) {
      if (!state || !state.ok) return;
      var agents = root.querySelector("#lx-md-agents");
      if (agents && state.agents) agents.replaceChildren.apply(agents, state.agents.map(agentNode));
      var checks = root.querySelector("#lx-md-checks");
      if (checks && state.checks) checks.replaceChildren.apply(checks, state.checks.map(checkNode));
      var sample = root.querySelector("#lx-md-sample");
      // textContent, so Markdown carrying an HTML block is shown rather than run.
      if (sample) sample.textContent = state.sample;
    },
  };
})();
