// lens-browser.js — the opt-in Browser Run pane for /lens.
// Loaded only when the owner asks for the rendered-browser comparison, so the
// ordinary HTTP/Human Lens path does not pay for this optional view.
(function () {
  "use strict";

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
      if (!node || typeof node !== "object") return;
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
  function structural(shape, a) {
    // Only the axes the HTTP side actually measured. anatomy carries images and
    // their alt coverage but no heading or link totals, so claiming a delta on
    // those would be inventing the "before" half of a comparison.
    var rows = [];
    if (shape.jsonld != null) rows.push([shape.jsonld, "JSON-LD block"]);
    if (shape.headings != null) rows.push([shape.headings, "heading"]);
    if (shape.links != null) rows.push([shape.links, "link"]);
    return rows.map(function (r) {
      return r[0] + " " + r[1] + (r[0] === 1 ? "" : "s");
    }).join(" &middot; ");
  }
  function deltaStrip(snapshot, data) {
    var a = data && data.anatomy;
    if (!a || a.rawBytes == null) return "";
    var renBytes = (snapshot.content || "").length;
    var rawWords = a.wordCount || 0;
    var shape = snapshot.shape;

    // Old snapshots cached before the server started counting have no `shape`.
    // Fall back to parsing the delivered body, which is what this did for its
    // whole life — and keep the truncation bail with it, because a capped DOM
    // compared against a full HTTP body produced confident nonsense
    // (stripe: "1874 -> 139 words" off a 120KB slice).
    if (!shape) {
      if (snapshot.contentTruncated) {
        return '<div class="lx-browser-delta"><b>HTTP vs rendered:</b> ' +
          esc(bytes(a.rawBytes)) + " &rarr; &ge;" + esc(bytes(renBytes)) +
          " (the rendered body hit the capture cap). A word-level comparison needs the full body, so Lens leaves it uncounted.</div>";
      }
      shape = { words: (snapshot.content || "")
        .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length };
    }

    // The cap no longer silences the comparison. The server counts the shape
    // from the FULL rendered body before truncating the `content` field, so a
    // capped snapshot still yields honest word counts — which is exactly the
    // case the old bail existed to refuse.
    var renWords = shape.words || 0;
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

    var extra = structural(shape, a);
    return '<div class="lx-browser-delta"><b>HTTP vs rendered:</b> ' + headline +
      '<div class="lx-cap">' + esc(bytes(a.rawBytes)) + " &rarr; " + esc(bytes(renBytes)) +
      (snapshot.contentTruncated ? "+" : "") + " &middot; " + rawWords + " &rarr; " + renWords + " words" +
      (extra ? " &middot; after render: " + extra : "") +
      (snapshot.engine ? " &middot; engine: " + esc(snapshot.engine) : "") + "</div></div>";
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
  function mount(body, data, snapshot, onRun) {
    if (!data) {
      body.innerHTML = '<div class="lx-empty">Paste a URL above, then ask Browser Run to render it here.</div>';
      return;
    }
    if (snapshot) {
      body.innerHTML = summary(snapshot, data);
      return;
    }
    body.innerHTML = '<div class="lx-browser-intro"><b>Third surface: the rendered browser.</b> This is separate from the HTTP Machine view and the Human view in your own browser.' +
      '<div class="lx-cap">It runs page JavaScript and returns rendered HTML, a screenshot, Markdown, an accessibility tree, and a runtime WebMCP result when the browser exposes one. It does not execute site tools.</div>' +
      '<button class="lx-browser-run" type="button" id="lx-browser-run">Run Browser Run snapshot</button></div>';
    var button = document.getElementById("lx-browser-run");
    if (button) button.addEventListener("click", onRun);
  }
  function run(body, data, done, onError, onRun) {
    body.innerHTML = '<div class="lx-spin">Cloudflare Browser Run is opening a rendered session&hellip;</div>';
    fetch("/lens/browser?url=" + encodeURIComponent(data.finalUrl || data.url))
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
        body.innerHTML = '<div class="lx-fallback-note">Browser Run could not render this URL: ' + esc(error && error.message || error) + '</div>' +
          '<button class="lx-browser-run" type="button" id="lx-browser-run">Try again</button>';
        var button = document.getElementById("lx-browser-run");
        if (button) button.addEventListener("click", onRun);
        onError(error);
      });
  }
  window.LensBrowser = { mount: mount, run: run };
})();
