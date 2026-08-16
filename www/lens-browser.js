// lens-browser.js — the opt-in Browser Run pane for /lens.
// Loaded only when the owner asks for the rendered-browser comparison, so the
// ordinary HTTP/Human Lens path does not pay for this optional view.
(function () {
  "use strict";

  // The local parse layer. Client scripts here have no shared module graph, so
  // they cannot import _worker.js/lib/parse.js; redeclaring a couple of
  // coercions is the same trade these files already make for esc().
  /* oxlint-disable anti-slop/no-runtime-typeof -- a hand-rolled parser is made
     of typeof; keeping the checks here rather than at each use is the point. */
  function asRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null; }
  /* oxlint-enable anti-slop/no-runtime-typeof */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function bytes(n) {
    if (n == null) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  // Mirrors fmtTok in lens.js. A bare 87381 reads as noise in a table beside
  // "1.20 MB"; the pane's other magnitudes are all rounded, so this one is too.
  function fmtTok(n) {
    if (n == null) return "?";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }
  function section(title, badge, caption, inner) {
    var b = badge ? ' <span class="lx-badge ' + (badge.kind || "") + '">' + esc(badge.text) + "</span>" : "";
    var c = caption ? '<div class="lx-cap">' + esc(caption) + "</div>" : "";
    return '<div class="lx-sec"><div class="lx-sec-h">' + esc(title) + b + "</div>" + c + (inner || "") + "</div>";
  }
  function kvTable(obj) {
    var keys = Object.keys(obj).filter(function (key) { return obj[key] != null && obj[key] !== ""; });
    if (!keys.length) return '<div class="lx-none">none</div>';
    return '<table class="lx-kv">' + keys.map(function (key) {
      return "<tr><td>" + esc(key) + "</td><td>" + esc(obj[key]) + "</td></tr>";
    }).join("") + "</table>";
  }
  function pre(text) {
    return '<pre class="lx-pre lx-pre-light">' + esc(text) + "</pre>";
  }
  function treeNodes(tree) {
    var n = 0;
    (function walk(node) {
      if (!asRecord(node)) return;
      n++;
      (node.children || []).forEach(walk);
    })(tree);
    return n;
  }
  function webmcp(webmcp, data) {
    webmcp = webmcp || {};
    var status = webmcp.status === "available" ? { text: "runtime tools", kind: "ok" }
      : webmcp.status === "lab-required" ? { text: "lab required", kind: "warn" }
      : webmcp.status === "error" ? { text: "probe error", kind: "warn" }
      : { text: "not observed", kind: "off" };
    var source = data.agent && data.agent.webmcp && data.agent.webmcp.found ? "a source marker" : "no source marker";
    var inner = '<div class="lx-cap">The HTTP scan found ' + source + '. Browser Run runtime discovery is a separate observation.</div>';
    if (webmcp.status === "available") {
      var tools = Array.isArray(webmcp.tools) ? webmcp.tools : [];
      inner += tools.length ? '<div class="lx-tags">' + tools.map(function (tool) { return '<span class="lx-tag">' + esc(tool.name || "unnamed tool") + "</span>"; }).join("") + "</div>" : '<div class="lx-none">The runtime API answered, but listed no tools.</div>';
      inner += '<div class="lx-cap" style="margin-top:6px">Discovery only. Lens does not call WebMCP tools.</div>';
    } else {
      inner += '<div class="lx-none">' + esc(webmcp.detail || "No runtime WebMCP tools were observed.") + "</div>";
      inner += '<div class="lx-cap" style="margin-top:6px">Use <span class="lx-tag">node scripts/lens-webmcp.mjs ' + esc(data.finalUrl || data.url) + "</span> on the current machine for a Chrome-beta lab probe.</div>";
    }
    return section("Runtime WebMCP", status, "What a browser session can discover after the page runs.", inner);
  }
  // The pane's whole promise is disagreement ("reveals a JS dependency"), so
  // compute it instead of leaving two numbers in two panes for the reader to
  // subtract. Words are the honest axis: bytes swing wildly with inlined
  // framework code, but a page that reads 30 words over HTTP and 2,000 after
  // JavaScript has been measured, not characterized.
  //
  // The headline is one number — how much of the rendered page a crawler that
  // does not run JavaScript already had — because that is the claim this whole
  // instrument exists to support, and it was previously left as an exercise in
  // subtraction for the reader.
  function pct(rawWords, renWords) {
    if (!renWords) return null;                       // absent, never 0%
    return Math.min(100, Math.round((rawWords / renWords) * 100));
  }
  function structural(tally, a) {
    // Only the axes the HTTP side actually measured. anatomy carries images and
    // their alt coverage but no heading or link totals, so claiming a delta on
    // those would be inventing the "before" half of a comparison.
    var rows = [];
    if (tally.jsonld != null) rows.push([tally.jsonld, "JSON-LD block"]);
    if (tally.headings != null) rows.push([tally.headings, "heading"]);
    if (tally.links != null) rows.push([tally.links, "link"]);
    return rows.map(function (r) {
      return r[0] + " " + r[1] + (r[0] === 1 ? "" : "s");
    }).join(" &middot; ");
  }
  function deltaStrip(snapshot, data) {
    var a = data && data.anatomy;
    if (!a || a.rawBytes == null) return "";
    var renBytes = (snapshot.content || "").length;
    var rawWords = a.wordCount || 0;
    var tally = snapshot.tally;

    // A snapshot can arrive without a `tally`: one cached before the server
    // started counting, or one cached under the old `shape` key before that
    // rename. Both drain on the 6h TTL. Fall back to parsing the delivered
    // body, which is what this did for its whole life, and keep the truncation
    // bail with it, because a capped DOM compared against a full HTTP body
    // produced confident nonsense (stripe: "1874 -> 139 words" off a 120KB slice).
    if (!tally) {
      if (snapshot.contentTruncated) {
        return '<div class="lx-browser-delta"><b>HTTP vs rendered:</b> ' +
          esc(bytes(a.rawBytes)) + " &rarr; &ge;" + esc(bytes(renBytes)) +
          " (the rendered body hit the capture cap). A word-level comparison needs the full body, so Lens leaves it uncounted.</div>";
      }
      tally = { words: (snapshot.content || "")
        .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length };
    }

    // The cap no longer silences the comparison. The server counts the tally
    // from the FULL rendered body before truncating the `content` field, so a
    // capped snapshot still yields honest word counts — which is exactly the
    // case the old bail existed to refuse.
    var renWords = tally.words || 0;
    var share = pct(rawWords, renWords);
    var headline;
    if (share === null) {
      headline = "The render returned no readable text, so there is nothing to compare against the HTTP fetch.";
    } else if (Math.abs(renWords - rawWords) <= Math.max(10, rawWords * 0.15)) {
      headline = "A crawler that never runs JavaScript sees essentially all of this page.";
    } else if (renWords < rawWords) {
      headline = "Rendering SHRANK this page: the HTTP fetch already carried more words than the browser ended up showing.";
    } else {
      headline = "A crawler that doesn't run JavaScript sees <b>" + share + "%</b> of this page: " +
        rawWords + " of the " + renWords + " words a browser ends up with.";
    }

    var extra = structural(tally, a);
    return '<div class="lx-browser-delta"><b>HTTP vs rendered:</b> ' + headline +
      '<div class="lx-cap">' + esc(bytes(a.rawBytes)) + " &rarr; " + esc(bytes(renBytes)) +
      (snapshot.contentTruncated ? "+" : "") + " &middot; " + rawWords + " &rarr; " + renWords + " words" +
      (extra ? " &middot; after render: " + extra : "") +
      (snapshot.engine ? " &middot; engine: " + esc(snapshot.engine) : "") + "</div></div>";
  }

  // ── after interaction ────────────────────────────────────────────────────
  // Mirrors the server registry in www/_worker.js/lens-recipes.js. Kept as
  // labels only: the SCRIPTS live server-side and are published at
  // /lens/browser?recipes=1, so nothing here can imply a capability the server
  // will not actually run. An id the server has retired simply 400s and lands in
  // the existing Try-again state.
  var RECIPES = [
    { id: "expand", label: "Open collapsed sections", claim: "Opens every <details> disclosure widget, then re-reads the page." },
    { id: "consent", label: "Remove the consent overlay", claim: "Removes large fixed overlays worded like a consent or newsletter wall. Presses nothing." },
  ];

  // Rendered only alongside a plain snapshot, because that snapshot IS the
  // before. Running a recipe first would spend a render to produce an after with
  // nothing to measure it against, so the control simply does not exist yet
  // rather than sitting there disabled.
  function chips() {
    return '<div class="lx-browser-do"><b>After interaction:</b>' +
      '<div class="lx-cap">Lens runs one fixed, published script in its own copy of the page, then re-reads it. Each click spends one of your three renders a minute.</div>' +
      '<div class="lx-chips">' + RECIPES.map(function (r) {
        return '<button class="lx-chip lx-do-chip" type="button" data-do="' + esc(r.id) + '" title="' + esc(r.claim) + '">' + esc(r.label) + "</button>";
      }).join("") + "</div></div>";
  }

  // What the recipe actually did, said plainly. Every branch here is a real
  // observation and none of them is a failure, which is why none of them is
  // styled or worded as one.
  function interactionStrip(after, before, data) {
    var it = after.interaction;
    if (!it) return "";
    var head;
    if (it.note === "no-receipt") {
      // The most common real-world outcome, and the most interesting one. The
      // HTTP scan already carried the response headers, so when a CSP explains
      // the refusal we can name it instead of shrugging.
      var csp = (data && data.headers && (data.headers["content-security-policy"] || data.headers["Content-Security-Policy"])) || "";
      head = /script-src/i.test(csp)
        ? "The injected script never ran. This page's <b>Content-Security-Policy</b> refuses inline script, so Lens could not interact with it &mdash; which is itself something a machine learns about this page."
        : "The injected script did not run, and the HTTP response carried no policy that explains it. Lens does not know why.";
    } else if (it.note === "forged-receipt") {
      head = "This page returned a <b>forged result marker</b> for a script Lens did not run. Lens discarded it. That is worth knowing on its own.";
    } else if (it.note === "threw") {
      head = "The script ran and threw inside this page, so Lens is not claiming it changed anything.";
    } else if (!it.acted) {
      head = "Nothing to do here. Lens examined <b>" + (it.scanned || 0) + "</b> candidate" + (it.scanned === 1 ? "" : "s") + " and none matched.";
    } else {
      var n = it.acted, noun = n + " element" + (n === 1 ? "" : "s");
      var aw = (after.tally && after.tally.words) || 0;
      // The client's own plain snapshot wins over the server's `it.before`, and
      // that order is deliberate rather than accidental. Both are the same
      // documentTally() of the same URL, but the server's copy came from a KV
      // read that can miss (eventual consistency, or a plain run that was never
      // cached) while the pane is still holding the real thing in memory. So
      // beforeSource can honestly say "none" while a delta is still shown.
      var bw = before && before.tally ? before.tally.words : (it.before ? it.before.words : null);
      if (bw == null) {
        head = "<b>" + noun + "</b> changed. Lens has no plain snapshot to measure this against, so it is not claiming a delta.";
      } else if (aw <= bw) {
        // Genuinely interesting and frequently the truth: the wall was paint.
        head = "<b>" + noun + "</b> changed and the page did not grow. The wall was cosmetic &mdash; the text was already there for a machine.";
      } else {
        var share = Math.min(100, Math.round(((aw - bw) / aw) * 100));
        head = "<b>" + noun + "</b> changed, and the page went from <b>" + bw + "</b> to <b>" + aw +
          "</b> words: <b>" + share + "%</b> of what a machine can now read was behind something it cannot click.";
      }
    }
    var facts = [];
    if (it.scanned) facts.push(it.scanned + " candidate" + (it.scanned === 1 ? "" : "s") + " examined");
    if (after.engine) facts.push("engine: " + esc(after.engine));
    facts.push(after.cached ? "KV cache" : "fresh Browser Run");
    return '<div class="lx-browser-delta"><b>After &ldquo;' + esc(it.label) + '&rdquo;:</b> ' + head +
      '<div class="lx-cap">' + facts.join(" &middot; ") + "</div>" +
      (it.id === "consent" && it.acted
        ? '<div class="lx-cap">Lens removed the overlay from its own copy of the page. It did not accept, refuse, or record any consent choice. If this was a paywall, you are looking at a page the publisher did not intend to show you, and Lens will not fetch anything further.</div>'
        : "") +
      '<div class="lx-cap"><a href="/lens/browser?recipes=1">What exactly ran</a> &mdash; the script is published verbatim.</div></div>';
  }

  // Two screenshots beside each other is the single most legible artifact this
  // can produce, and the before is already in memory, so it costs nothing.
  function beforeAfter(before, after) {
    if (!before || !before.screenshot || !after.screenshot) return "";
    return section("Before and after", { text: "PNG", kind: "ok" }, "The same page, rendered twice: once as delivered, once after the script ran.",
      '<div class="lx-shot-pair">' +
      '<figure><img class="lx-browser-shot" src="' + esc(before.screenshot) + '" alt="Before the interaction"><figcaption>as delivered</figcaption></figure>' +
      '<figure><img class="lx-browser-shot" src="' + esc(after.screenshot) + '" alt="After the interaction"><figcaption>after the script</figcaption></figure>' +
      "</div>");
  }

  // WHAT TO SHOW WHEN THERE IS NO RENDER. A one-line error above 250px of white
  // is the single thing on this page that reads as broken rather than as
  // degraded, and on the free plan it is the COMMON outcome: 10 browser-minutes
  // a day, account-wide, shared with every other browser lens.
  //
  // So the pane says what it cannot show, and then shows what it CAN. The HTTP
  // scan already happened and none of it needed a browser, so every number here
  // is real and already in hand. Nothing is invented, and nothing pretends a
  // render occurred: the missing comparison is named as missing.
  function unavailable(error, data) {
    var msg = (error && error.message) || String(error || "unknown");
    var budget = /rate-limit|budget/i.test(msg);
    var out = '<div class="lx-fallback-note">' + esc(
      budget
        ? "No rendered snapshot right now: the shared Browser Run budget is spent. Everything below came from the HTTP fetch and is unaffected."
        : "Browser Run could not render this URL: " + msg
    ) + "</div>" +
      '<button class="lx-browser-run" type="button" id="lx-browser-run">Try again</button>';
    if (!data) return out;
    var a = data.anatomy || {};
    var st = data.structured || {};
    var cost = data.cost && data.cost.tiers && data.cost.tiers[0];
    out += section("What a render would add", { text: "not run", kind: "warn" },
      "Rendered HTML after the page's JavaScript, a screenshot, the browser's own Markdown, and its accessibility tree. The gap between that and the HTTP response is this pane's whole point, and measuring it needs the render.",
      "");
    out += section("What the HTTP fetch already got", { text: "observed", kind: "ok" },
      "None of this needed a browser. It is the same response every machine lens on this page is reading.",
      kvTable({
        status: data.status == null ? "unknown" : data.status,
        title: st.title || "(untitled)",
        "final URL": data.finalUrl || data.url,
        "content type": data.contentType || "(none)",
        "HTTP payload": bytes(a.rawBytes) + (data.truncated ? " (capped)" : ""),
        "readable text": (a.wordCount != null ? a.wordCount + " words" : bytes((a.text || "").length)),
        headings: a.headings ? a.headings.length : 0,
        "links in head": st.relLinks ? st.relLinks.length : 0,
        "cost to read": cost ? "~" + fmtTok(cost.tokens) + " tokens of " + cost.label : "not modelled",
      }));
    return out;
  }

  function summary(snapshot, data) {
    var tree = snapshot.accessibilityTree;
    var facts = {
      status: snapshot.status == null ? "unknown" : snapshot.status,
      title: snapshot.title || "(untitled)",
      "final URL": snapshot.finalUrl || snapshot.url,
      "rendered HTML": bytes((snapshot.content || "").length) + (snapshot.contentTruncated ? " (capped)" : ""),
      "rendered Markdown": bytes((snapshot.markdown || "").length),
      "accessibility nodes": tree ? treeNodes(tree) : "not returned",
      observation: snapshot.cached ? "KV cache" : "fresh Browser Run",
      elapsed: (snapshot.elapsedMs || 0) + " ms",
    };
    var out = deltaStrip(snapshot, data);
    out += section("Browser facts", { text: snapshot.status == null ? "rendered" : String(snapshot.status), kind: "ok" },
      "A rendered observation after page JavaScript. It is not folded into the AadharshBot HTTP readiness score.", kvTable(facts));
    if (snapshot.screenshot) out += section("Rendered screenshot", { text: "PNG", kind: "ok" }, "The viewport after the Browser Run page load.", '<img class="lx-browser-shot" src="' + esc(snapshot.screenshot) + '" alt="Browser Run screenshot of ' + esc(snapshot.finalUrl || snapshot.url) + '">');
    else if (snapshot.screenshotDropped) out += section("Rendered screenshot", { text: "too large", kind: "warn" },
      "Browser Run captured the page, and the full-page PNG came back at " + bytes(snapshot.screenshotDropped) + " — past what this endpoint will return inline, so it was dropped. The rest of the snapshot is unaffected.", "");
    out += webmcp(snapshot.webmcp, data);
    out += section("Rendered HTML", { text: bytes((snapshot.content || "").length) }, "The DOM returned after Browser Run executed the page. This is source evidence, shown escaped.", pre(snapshot.content || "(no content)"));
    out += section("Rendered Markdown", { text: bytes((snapshot.markdown || "").length) }, "The browser's clean text representation, separate from Lens's dependency-free HTTP reconstruction.", pre(snapshot.markdown || "(no Markdown)"));
    if (tree) out += section("Accessibility tree", { text: treeNodes(tree) + " nodes", kind: "ok" }, "The browser's structured view of roles, names, states, and hierarchy.", pre(JSON.stringify(tree, null, 2)));
    return out;
  }
  function wireChips(body, onRun) {
    var nodes = body.querySelectorAll(".lx-do-chip");
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        node.addEventListener("click", function () { onRun(node.getAttribute("data-do")); });
      })(nodes[i]);
    }
  }
  function mount(body, data, snapshot, onRun, recipeSnapshot) {
    if (!data) {
      body.innerHTML = '<div class="lx-empty">Paste a URL above, then ask Browser Run to render it here.</div>';
      return;
    }
    if (snapshot) {
      // The plain snapshot stays the body of the pane. An interaction result is
      // an ADDITION above it, so the reader never loses the baseline they are
      // being asked to compare against.
      body.innerHTML = (recipeSnapshot ? interactionStrip(recipeSnapshot, snapshot, data) : "") +
        chips() +
        (recipeSnapshot ? beforeAfter(snapshot, recipeSnapshot) : "") +
        summary(snapshot, data);
      wireChips(body, onRun);
      return;
    }
    body.innerHTML = '<div class="lx-browser-intro"><b>Third surface: the rendered browser.</b> This is separate from the HTTP Machine view and the Human view in your own browser.' +
      '<div class="lx-cap">It runs page JavaScript and returns rendered HTML, a screenshot, Markdown, an accessibility tree, and a runtime WebMCP result when the browser exposes one. It does not execute site tools.</div>' +
      '<button class="lx-browser-run" type="button" id="lx-browser-run">Run Browser Run snapshot</button></div>';
    var button = document.getElementById("lx-browser-run");
    if (button) button.addEventListener("click", onRun);
  }
  function run(body, data, done, onError, onRun, recipeId) {
    body.innerHTML = '<div class="lx-spin">Cloudflare Browser Run is opening a rendered session' +
      (recipeId ? " and running the published script" : "") + "&hellip;</div>";
    fetch("/lens/browser?url=" + encodeURIComponent(data.finalUrl || data.url) +
      (recipeId ? "&do=" + encodeURIComponent(recipeId) : ""))
      .then(function (response) {
        // Read as text and parse by hand. /lens/browser answers JSON on every
        // path it controls, so a non-JSON body means something ANSWERED FOR IT:
        // a Cloudflare 1101/1102/524 page, which is HTML. Calling .json() on
        // that surfaces V8's "Unexpected token '<', \"<!DOCTYPE \"..." to the
        // reader, which names the parser rather than the failure.
        return response.text().then(function (text) {
          var json = null;
          try { json = JSON.parse(text); } catch (_e) {}
          if (!json) {
            throw new Error("the server answered with " + (response.headers.get("content-type") || "an unknown body") +
              " instead of a snapshot (HTTP " + response.status + "). That is the edge or the runtime failing the route, not the target page.");
          }
          if (!response.ok || !json.ok) throw new Error(json.error || ("Browser Run returned " + response.status));
          return json;
        });
      })
      .then(done)
      .catch(function (error) {
        body.innerHTML = unavailable(error, data);
        var button = document.getElementById("lx-browser-run");
        if (button) button.addEventListener("click", onRun);
        onError(error);
      });
  }
  window.LensBrowser = { mount: mount, run: run };
})();
