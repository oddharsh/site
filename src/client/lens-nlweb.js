// lens-nlweb.js — the NLWeb lens pane, loaded on demand by lens.js.
//
// Standalone like lens-tools.js and lens-wire.js: it redeclares esc/section
// rather than importing them, because /lens ships no module graph and this file
// must be a single <script src> that can arrive late or never.
//
// The pane answers a question the doors tier structurally cannot. Discovery
// KNOCKS on /ask and reads a status code; this asks a real question and grades
// the answer against NLWeb's own result contract, field by field. The finding
// that matters is `schema_object`: an origin can return perfectly good prose and
// no structured data at all, and an agent pointed at it then has a paragraph
// where it was promised a machine-readable object.
//
// So the COVERAGE TABLE leads and the results follow. Reversing that would make
// this a search box pointed at somebody else's site, which is not a lens.
//
// Every string below came from a stranger's server. The rows are built with
// createElement and textContent for the same reason lens-tools.js builds its
// controls that way, and the raw schema.org object is rendered into a <pre> as
// text rather than as markup.
(function () {
  var FIELDS = ["url", "name", "site", "score", "description", "schema_object"];
  // What each field is FOR, in the reader's terms. A coverage table of six bare
  // names tells somebody who has not read the spec nothing at all.
  var FIELD_NOTE = {
    url: "where the answer lives",
    name: "what to call it",
    site: "which corpus answered",
    score: "how relevant the server thinks it is",
    description: "the passage itself",
    schema_object: "the machine-readable object — the field that makes this more than a link",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function section(title, badge, caption, inner) {
    return '<div class="lx-sec"><div class="lx-sec-h">' + esc(title) +
      (badge ? ' <span class="lx-badge' + (badge.kind ? " " + badge.kind : "") + '">' + esc(badge.text) + "</span>" : "") +
      "</div>" + (caption ? '<div class="lx-cap">' + esc(caption) + "</div>" : "") + inner + "</div>";
  }
  function trim(value, max) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  var state = null;

  function intro() {
    return section("What it answers", { text: "not run" },
      "Asks this origin's /ask endpoint one real question and grades the answer against NLWeb's result contract.",
      '<div class="lx-tools-intro"><b>Agent doors knocks. This walks through.</b> ' +
      'A door that answers 200 can still answer with nothing an agent can use, and the field that decides it is ' +
      '<code>schema_object</code>.' +
      '<div class="lx-nlweb-ask"><input type="text" id="lx-nlweb-q" maxlength="200" ' +
      'placeholder="what is this site about" aria-label="the question to ask this origin">' +
      '<button class="lx-browser-run" type="button" id="lx-nlweb-run">Ask it</button></div>' +
      '<div class="lx-cap">One request, cached for an hour. Asking somebody else’s retrieval endpoint a question ' +
      'costs them a lookup, so this sends <code>mode=list</code> and never fires on its own.</div></div>');
  }

  function shutPane(s) {
    // SHUT and UNREADABLE are different findings and are drawn differently, the
    // same distinction classifyDoor keeps: "there is no endpoint here" and "we
    // never got to look" must never read as the same sentence.
    var badge = s.gated ? { text: "locked", kind: "warn" }
      : s.unreadable ? { text: "unreadable", kind: "warn" }
        : { text: "no answer", kind: "bad" };
    var why = s.unreadable
      ? "The door is there and we did not get to look through it, so this is not evidence that the endpoint is missing."
      : "Nothing at this origin answered as an NLWeb endpoint.";
    return section("What it answers", badge,
      esc(s.endpoint || "") + " · " + esc(s.error || ""),
      '<div class="lx-nlweb-shut">' + esc(why) + "</div>");
  }

  function coverageTable(s) {
    var rows = FIELDS.map(function (field) {
      var got = s.coverage[field] || 0;
      var kind = got === s.total ? "ok" : got ? "warn" : "bad";
      var pct = s.total ? Math.round((got / s.total) * 100) : 0;
      return '<tr><td><code>' + esc(field) + "</code></td>" +
        '<td class="lx-nlweb-n"><span class="lx-badge ' + kind + '">' + got + " / " + s.total + "</span></td>" +
        '<td class="lx-nlweb-bar"><i style="width:' + pct + '%"></i></td>' +
        "<td>" + esc(FIELD_NOTE[field]) + "</td></tr>";
    }).join("");
    return '<table class="lx-nlweb-cov"><thead><tr><th>field</th><th>present</th><th></th><th>what it is for</th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }

  function paneHtml(s) {
    if (!s) return intro();
    if (s.pending) return section("What it answers", { text: "asking…" },
      "One request to this origin's /ask endpoint.", '<div class="lx-nlweb-shut">Waiting for the answer.</div>');
    if (!s.ok) return shutPane(s);
    state = s;

    var badge = s.conformant
      ? { text: "conformant", kind: "ok" }
      : { text: s.total ? "partial" : "empty", kind: s.total ? "warn" : "bad" };

    // The dialect is worth surfacing rather than normalising away: the reference
    // server speaks two, and which one an origin answers in is a real fact about
    // how current its implementation is.
    var how = s.framing === "sse"
      ? "streamed" + (s.dialect === "v0.55" ? " as named v0.55 events" : " as legacy message_type frames")
      : "one JSON body";
    var caption = esc(s.endpoint) + " · asked “" + esc(s.query) + "” · " +
      s.total + (s.total === 1 ? " result" : " results") +
      (s.shown < s.total ? " (" + s.shown + " shown)" : "") + " · " + how +
      (s.fromCache ? " · cached" : "");

    var types = (s.schemaTypes || []).length
      ? '<div class="lx-cap">schema.org types returned: ' +
        s.schemaTypes.map(function (t) { return "<code>" + esc(t.name) + "</code> " + t.count; }).join(", ") +
        " · " + s.schemaBytes + " bytes of structured data</div>"
      // Stated as an absence rather than omitted. A missing row reads as a
      // question nobody asked; this one was asked and the answer was none.
      : '<div class="lx-cap">No <code>schema_object</code> came back, so nothing here is structured data.</div>';

    var verdict = s.total === 0
      ? "The endpoint answered and found nothing. That is a working door onto an empty room for this query."
      : s.conformant
        ? "Every result carries all six fields the protocol names."
        : "Some results are missing fields the protocol names, so an agent has to handle both shapes.";

    return section("What it answers", badge, caption,
      '<div class="lx-nlweb-verdict">' + esc(verdict) + "</div>" +
      coverageTable(s) + types +
      '<div class="lx-nlweb-results" id="lx-nlweb-results"></div>' +
      '<div class="lx-nlweb-ask"><input type="text" id="lx-nlweb-q" maxlength="200" value="' + esc(s.query) +
      '" aria-label="the question to ask this origin">' +
      '<button class="lx-browser-run" type="button" id="lx-nlweb-run">Ask again</button></div>');
  }

  /** One result row, built as nodes because every string in it is foreign. */
  function resultNode(item, index) {
    var row = document.createElement("div");
    row.className = "lx-nlweb-row";

    var head = document.createElement("div");
    head.className = "lx-nlweb-head";
    var n = document.createElement("span");
    n.className = "lx-nlweb-idx";
    n.textContent = String(index + 1);
    head.appendChild(n);

    var name = document.createElement("span");
    name.className = "lx-nlweb-name";
    name.textContent = item.name || "(no name)";
    head.appendChild(name);

    // The route already parsed this: it sets `score` only when the foreign value
    // was a finite number, so a finite check here reads the domain value rather
    // than re-narrowing the representation.
    if (Number.isFinite(item.score)) {
      var score = document.createElement("span");
      score.className = "lx-badge";
      score.textContent = "score " + item.score;
      head.appendChild(score);
    }
    row.appendChild(head);

    if (item.url) {
      var link = document.createElement("div");
      link.className = "lx-nlweb-url";
      link.textContent = item.url;
      row.appendChild(link);
    }
    if (item.description) {
      var desc = document.createElement("div");
      desc.className = "lx-nlweb-desc";
      desc.textContent = trim(item.description, 300);
      row.appendChild(desc);
    }

    var schema = document.createElement("div");
    schema.className = "lx-nlweb-schema";
    if (item.schema_object) {
      var pre = document.createElement("pre");
      // textContent, so a schema.org object carrying markup is shown rather
      // than rendered. It is a stranger's JSON on our page.
      pre.textContent = JSON.stringify(item.schema_object, null, 1);
      schema.appendChild(pre);
    } else if (item.schemaOversize) {
      schema.textContent = "schema_object was " + item.schemaOversize +
        " bytes and was dropped whole rather than truncated — half a schema describes something that does not exist.";
      schema.className += " lx-nlweb-missing";
    } else {
      schema.textContent = "no schema_object — this result is a link with prose on it.";
      schema.className += " lx-nlweb-missing";
    }
    row.appendChild(schema);
    return row;
  }

  window.LensNlweb = {
    run: function (targetUrl, query, onOk, onFail) {
      var url = "/lens/nlweb?url=" + encodeURIComponent(targetUrl) +
        (query ? "&q=" + encodeURIComponent(query) : "");
      fetch(url, { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(onOk)
        .catch(function () { onFail(); });
    },
    render: paneHtml,
    // Called after the pane's HTML lands, exactly like LensTools.bind. The rows
    // are built here rather than in the string above because they carry foreign
    // strings and must be created as nodes.
    bind: function (root) {
      var mount = root.querySelector("#lx-nlweb-results");
      if (mount && state && state.ok && state.results) {
        mount.replaceChildren.apply(mount, state.results.map(resultNode));
      }
      var input = root.querySelector("#lx-nlweb-q");
      var button = root.querySelector("#lx-nlweb-run");
      // Enter submits, because a text box beside a button that ignores Enter is
      // the kind of small lie this site tries not to tell.
      if (input && button) {
        input.addEventListener("keydown", function (event) {
          if (event.key === "Enter") { event.preventDefault(); button.click(); }
        });
      }
    },
    _question: function (root) {
      var input = root && root.querySelector("#lx-nlweb-q");
      return input ? input.value.replace(/^\s+|\s+$/g, "").slice(0, 200) : "";
    },
  };
})();
