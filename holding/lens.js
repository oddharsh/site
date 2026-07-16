// lens.js — client behavior for /lens ("The Other Web").
//
// Calls the server-side /lens/fetch engine (CORS blocks the browser from
// fetching arbitrary origins itself), then renders the result through six
// machine "lenses" — Readiness, Anatomy, Structured data, AI view, Terms, Discovery
// files — next to a plain human read. No deps, no build. Deferred + SW-cached.
(function () {
  "use strict";
  var form = document.getElementById("lx-form");
  if (!form) return; // not the /lens page

  var urlInput = document.getElementById("lx-url");
  var panes = document.getElementById("lx-panes");
  var humanBody = document.getElementById("lx-human-body");
  var machineBody = document.getElementById("lx-machine-body");
  var machineH = document.getElementById("lx-machine-h");
  var humanH = document.getElementById("lx-human-h");
  var modeNote = document.getElementById("lx-mode-note");
  var statusBar = document.getElementById("lx-status");

  var data = null;       // last successful envelope
  var view = "both";     // both | human | machine | delta
  var lens = "readiness"; // readiness | anatomy | structured | ai | terms | discovery
  var counterfactuals = { markdown: false, semantic: false, contract: false, authority: false, receipt: false };
  var busy = false;
  var lastShotUrl = null;   // the live snapshot object URL, revoked before the next mint / on decode

  var LENS_LABEL = { readiness: "Readiness", anatomy: "Anatomy", structured: "Structured", ai: "AI view", terms: "Terms", discovery: "Discovery" };

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
  function fmtTok(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }
  function fmtUsd(x) {
    if (x >= 0.1) return "$" + x.toFixed(2);
    if (x >= 0.0005) return "$" + x.toFixed(4);
    if (x > 0) return "<$0.0005";
    return "$0";
  }
  function has(o) { return o && typeof o === "object" && Object.keys(o).length > 0; }

  function readInitialData() {
    var node = document.getElementById("lx-initial-data");
    if (!node) return null;
    try { return JSON.parse(node.textContent || "null"); } catch (e) { return null; }
  }
  var initialData = readInitialData();

  var MODE_NOTE = {
    both: "Compare keeps the live page beside the selected evidence lens.",
    human: "Human shows the page as a person receives it in a browser.",
    machine: "Machine turns the scan into an evidence-first briefing, then keeps the selected lens below it.",
    delta: "Delta keeps the page visible while you add hypothetical machine infrastructure to the route.",
  };

  function modeLabel() {
    return view === "both" ? "Compare" : view.charAt(0).toUpperCase() + view.slice(1);
  }

  function readUrlState() {
    var p = new URLSearchParams(location.search);
    var views = ["both", "human", "machine", "delta"];
    var lenses = ["readiness", "anatomy", "structured", "ai", "terms", "discovery"];
    // Seed every key false, then flip the ones named in ?cf=. Both callers REPLACE
    // `counterfactuals` with this object, and the toggle handler guards on
    // hasOwnProperty — so returning only the keys ?cf= mentioned (i.e. none, on a
    // normal visit) left every Delta switch dead and the Readiness projection
    // banner permanently empty. The seed doubles as the allowlist.
    var cf = { markdown: false, semantic: false, contract: false, authority: false, receipt: false };
    (p.get("cf") || "").split(",").forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(cf, key)) cf[key] = true;
    });
    return {
      url: p.get("url") || "",
      view: views.indexOf(p.get("view")) >= 0 ? p.get("view") : "both",
      lens: lenses.indexOf(p.get("lens")) >= 0 ? p.get("lens") : "readiness",
      counterfactuals: cf,
    };
  }

  function syncUrl(push) {
    var u;
    try { u = new URL(location.href); } catch (e) { return; }
    u.pathname = "/lens";
    ["url", "view", "lens", "cf"].forEach(function (key) { u.searchParams.delete(key); });
    var raw = urlInput.value.trim();
    if (raw) u.searchParams.set("url", raw);
    if (view !== "both") u.searchParams.set("view", view);
    if (lens !== "readiness") u.searchParams.set("lens", lens);
    var cf = Object.keys(counterfactuals).filter(function (key) { return counterfactuals[key]; });
    if (cf.length) u.searchParams.set("cf", cf.join(","));
    var next = u.pathname + (u.search || "") + (u.hash || "");
    var current = location.pathname + location.search + location.hash;
    if (next === current) return;
    try {
      (push ? history.pushState : history.replaceState).call(history, null, "", next);
    } catch (e) {}
  }

  function showError(j) {
    var msg = (j && j.error) || "Something went wrong.";
    data = null;
    machineBody.innerHTML = '<div class="lx-empty">' + esc(msg) + "</div>";
    humanBody.innerHTML = '<div class="lx-empty">No page to show.</div>';
    statusBar.innerHTML = '<span class="err">Failed:</span> <span>' + esc(msg) + "</span>";
  }

  // ---- networking -------------------------------------------------------
  function run(url) {
    if (busy) return;
    url = (url || "").trim();
    if (!url) { urlInput.focus(); return; }
    busy = true;
    urlInput.value = url;
    // reflect the scanned URL in the address bar so every scan is a shareable link.
    // replaceState (not pushState): no reload, and repeated scans don't spam the
    // history stack, so Back still leaves /lens cleanly. Pairs with the ?url= autorun
    // at the bottom: open or share /lens?url=<site> and it re-runs the same scan.
    syncUrl(false);
    humanBody.innerHTML = '<div class="lx-spin">Fetching as AadharshBot&hellip;</div>';
    machineBody.innerHTML = '<div class="lx-spin">Reading the markup&hellip;</div>';
    statusBar.innerHTML = "<span>Fetching <b>" + esc(url) + "</b> server-side&hellip;</span>";

    // /lens/fetch is the engine's one browser-facing contract: JSON in, rendered here.
    // There was briefly a /lens/fragment twin that wrapped the same payload in
    // server-rendered HTML, but this client has to render every pane itself anyway
    // (switching lenses and toggling Delta counterfactuals can't round-trip, and
    // renderMachine() is what binds the toggle handlers), so the fragment's markup was
    // injected and then overwritten in this same synchronous block, never once painted.
    // The server-side pane renderers it used live on: renderLensShell still SSRs them
    // for the no-JS path at /lens?url=, and this client hydrates from #lx-initial-data.
    fetch("/lens/fetch?url=" + encodeURIComponent(url))
      .then(function (r) {
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("json") < 0) throw new Error("The lens engine returned an unexpected response.");
        return r.json();
      })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) {
          showError(j);
          return;
        }
        data = j;
        renderHuman();
        renderMachine();
        renderStatus();
      })
      .catch(function (e) {
        busy = false;
        machineBody.innerHTML = '<div class="lx-empty">Network error: ' + esc(e && e.message || e) + "</div>";
        statusBar.innerHTML = '<span class="err">Network error.</span>';
      });
  }

  // ---- human pane: a live browser window --------------------------------
  // Framable site → embed it live (loaded by your browser, your session, like
  // a real tab). Site that forbids framing → a server-side Browser Rendering
  // screenshot. Neither available → the readable-text reader as a last resort.
  function setHumanH(badge, sub) {
    var el = document.getElementById("lx-human-h");
    if (el) el.innerHTML = "Human view <span class=\"lx-mode\">" + esc(badge) + "</span> <span class=\"lx-mode-sub\">" + esc(sub) + "</span>";
  }
  function bleed(on) { humanBody.classList.toggle("is-bleed", !!on); }

  function renderHuman() {
    if (data.framable) {
      bleed(true);
      setHumanH("Live", "loaded by your browser, like a real tab");
      humanBody.innerHTML = '<iframe class="lx-frame" src="' + esc(data.finalUrl) +
        '" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"' +
        ' referrerpolicy="no-referrer-when-downgrade" loading="lazy"></iframe>';
      return;
    }
    renderShot();
  }

  function renderShot() {
    bleed(true);
    setHumanH("Snapshot", "this site blocks live embedding, so this is a server-side render");
    humanBody.innerHTML = '<div class="lx-spin">Rendering a snapshot with headless Chrome&hellip;</div>';
    var shotUrl = data.finalUrl;
    fetch("/lens/shot?url=" + encodeURIComponent(shotUrl))
      .then(function (r) {
        var ct = r.headers.get("content-type") || "";
        if (r.ok && ct.indexOf("image/") === 0) {
          return r.blob().then(function (b) {
            // revoke the previous snapshot's object URL before minting the next, and
            // again once this one has decoded. Overwriting innerHTML drops the <img> but
            // NOT the blob-URL registry entry, so scanning several framing-blocked sites
            // in a session (nytimes + stripe are both seeded chips) otherwise pins a full
            // Browser-Rendering PNG each.
            if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
            var objUrl = URL.createObjectURL(b);
            lastShotUrl = objUrl;
            var img = new Image();
            img.className = "lx-shot";
            img.alt = "Rendered snapshot of " + shotUrl;
            img.onload = function () { if (lastShotUrl === objUrl) { URL.revokeObjectURL(objUrl); lastShotUrl = null; } };
            img.src = objUrl;
            humanBody.innerHTML = "";
            humanBody.appendChild(img);
          });
        }
        return r.json().then(function (j) { renderReader((j && j.error) || ("snapshot failed (" + r.status + ")")); })
          .catch(function () { renderReader("snapshot failed (" + r.status + ")"); });
      })
      .catch(function () { renderReader("the snapshot request didn't go through"); });
  }

  // last-resort readable view: title + outline + stripped text.
  function renderReader(note) {
    bleed(false);
    setHumanH("Reader", "embedding blocked, no snapshot, so here is the readable text");
    var a = data.anatomy;
    var out = note ? '<div class="lx-fallback-note">' + esc(note.replace(/\.\s*$/, "")) + ". Showing the readable text instead.</div>" : "";
    if (!a) { humanBody.innerHTML = out + '<div class="lx-empty">No readable text either.</div>'; return; }
    var title = (data.structured && data.structured.title) || "";
    if (title) out += '<div class="lx-h-title">' + esc(title) + "</div>";
    if (a.headings && a.headings.length) {
      out += '<div class="lx-h-outline"><b>Document outline</b><br>';
      for (var i = 0; i < a.headings.length && i < 60; i++) {
        var h = a.headings[i];
        out += '<div style="padding-left:' + ((h.level - 1) * 12) + 'px"><span style="color:#9aa">h' + h.level + "</span> " + esc(h.text) + "</div>";
      }
      out += "</div>";
    }
    out += '<div class="lx-h-text">' + esc(a.text || "(no extractable text)") + "</div>";
    humanBody.innerHTML = out;
  }

  // ---- machine pane -----------------------------------------------------
  function section(title, badge, caption, inner) {
    var b = badge ? ' <span class="lx-badge ' + (badge.kind || "") + '">' + esc(badge.text) + "</span>" : "";
    var c = caption ? '<div class="lx-cap">' + esc(caption) + "</div>" : "";
    return '<div class="lx-sec"><div class="lx-sec-h">' + esc(title) + b + "</div>" + c + inner + "</div>";
  }
  function kvTable(obj, order) {
    var keys = order ? order.filter(function (k) { return obj[k] != null && obj[k] !== ""; }) : Object.keys(obj);
    if (!keys.length) return '<div class="lx-none">none</div>';
    var rows = keys.map(function (k) {
      return "<tr><td>" + esc(k) + "</td><td>" + esc(obj[k]) + "</td></tr>";
    }).join("");
    return '<table class="lx-kv">' + rows + "</table>";
  }
  function tags(arr) {
    if (!arr || !arr.length) return '<div class="lx-none">none found</div>';
    return '<div class="lx-tags">' + arr.map(function (t) { return '<span class="lx-tag">' + esc(t) + "</span>"; }).join("") + "</div>";
  }
  function pre(text, light) {
    return '<pre class="lx-pre' + (light ? " lx-pre-light" : "") + '">' + esc(text) + "</pre>";
  }

  function badge(text, kind) {
    return '<span class="lx-badge ' + (kind || "") + '">' + esc(text) + "</span>";
  }

  function briefTable(rows) {
    return '<table class="lx-bots"><tr><th>surface</th><th>what a machine can establish</th><th>state</th></tr>' +
      rows.map(function (r) {
        return '<tr><td class="ua">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + badge(r[2], r[3]) + '</td></tr>';
      }).join("") + '</table>';
  }

  function lensFocus() {
    var a = data.anatomy || {};
    var s = data.structured || {};
    var ag = data.agent || {};
    var st = ag.strategy || {};
    var d = data.discovery || {};
    var t = data.terms || {};
    var jsonld = s.jsonld ? s.jsonld.length : 0;
    var micro = s.microdata && s.microdata.itemtypes ? s.microdata.itemtypes.length : 0;
    var rdfa = s.rdfa && s.rdfa.typeof ? s.rdfa.typeof.length : 0;
    var mf = s.microformats ? s.microformats.length : 0;
    var entityTypes = [];
    (s.jsonld || []).forEach(function (b) {
      (b.types || []).forEach(function (x) { if (entityTypes.indexOf(x) < 0) entityTypes.push(x); });
    });
    var title, badgeData, caption, rows, extra = "";

    if (lens === "readiness") {
      var rr = data.readiness || {};
      var firstFix = rr.nextActions && rr.nextActions[0];
      title = "Readiness focus";
      badgeData = { text: (rr.overall == null ? "unknown" : rr.overall + "/100"), kind: rr.overall >= 75 ? "ok" : "warn" };
      caption = "A score is useful only when it points to the surface an agent is missing.";
      rows = { "level": (rr.level == null ? "unknown" : "Level " + rr.level + " · " + (rr.levelName || "")), "scored checks": (rr.passed == null ? "?" : rr.passed + " / " + rr.counted), "next gap": firstFix ? readinessCopy(firstFix).label : "none observed", "bot samples": rr.botViews ? rr.botViews.length : 0 };
    } else if (lens === "anatomy") {
      var alt = a.imgTotal ? ((a.imgTotal - a.imgNoAlt) + " / " + a.imgTotal + " images have alt") : "no images found";
      title = "Anatomy focus";
      badgeData = { text: data.status + " " + httpText(data.status), kind: data.status >= 200 && data.status < 400 ? "ok" : "warn" };
      caption = "Can a machine get a usable reading surface before it knows what the page means?";
      rows = { "response": (data.contentType || "(none)") + " · " + bytes(a.rawBytes), "shape": (a.headings ? a.headings.length : 0) + " headings · " + (a.wordCount || 0) + " words", "accessibility": alt, "headers": Object.keys(data.headers || {}).length + " received" };
    } else if (lens === "structured") {
      title = "Structured focus";
      badgeData = { text: (jsonld || micro || rdfa || mf) ? "signals found" : "mostly untyped", kind: (jsonld || micro || rdfa || mf) ? "ok" : "off" };
      caption = "What entities and relationships can be lifted from the markup without guessing?";
      rows = { "title": s.title || "(untitled)", "schema": jsonld + " JSON-LD · " + micro + " microdata · " + rdfa + " RDFa", "microformats": mf + " class signal" + (mf === 1 ? "" : "s"), "preview": has(s.og) ? "Open Graph card present" : "no Open Graph card" };
      if (entityTypes.length) extra = tags(entityTypes.slice(0, 18));
    } else if (lens === "ai") {
      var md = ag.mdNegotiation && ag.mdNegotiation.supported ? "negotiated text/markdown" : "HTML only";
      var markdownTier = (data.cost && data.cost.tiers || []).filter(function (x) { return x.key === "markdown"; })[0];
      var directives = data.ai && data.ai.directives || {};
      title = "AI view focus";
      badgeData = { text: markdownTier ? "~" + fmtTok(markdownTier.tokens) + " tok" : md, kind: markdownTier ? "ok" : "warn" };
      caption = "What a model can ingest, how much context it costs, and whether the site offers a cleaner representation.";
      rows = { "representation": md + " · " + bytes((data.ai && data.ai.markdown || "").length), "directives": (directives.metaRobots || directives.xRobotsTag || directives.namesAiCrawlers) ? "crawler signals published" : "no AI-specific signal", "curation": data.ai && data.ai.llmsTxtPresent ? "llms.txt present" : "no llms.txt", "cheapest shortcut": markdownTier ? "markdown is the selected compact read" : "none observed" };
    } else if (lens === "terms") {
      var tier = t.spectrum && t.spectrum.tier || "unknown";
      var blocked = (t.scoreboard || []).filter(function (b) { return b.verdict === "block"; }).length;
      var enforcement = t.enforcement && (t.enforcement.challenged ? "bot challenge" : t.enforcement.blocked ? "fetch refused" : "fetch passed");
      title = "Terms focus";
      badgeData = { text: tier, kind: tier === "open" ? "ok" : "warn" };
      caption = "Is reading open, merely requested, actively enforced, or priced? Published policy and observed behavior stay separate.";
      rows = { "spectrum": tier, "robots": t.robotsUnknown ? "unknown / unreachable" : t.robotsPresent ? blocked + " of " + (t.scoreboard || []).length + " bots blocked" : "no robots.txt", "enforcement": enforcement || "not observed", "price": t.paid && t.paid.http402 ? "402 Payment Required" : "no payment signal" };
    } else {
      var doors = [ag.mcp, ag.nlweb, ag.webmcp, ag.agentCard, ag.openapi, ag.apiCatalog].filter(function (x) { return x && (x.verdict === "yes" || x.verdict === "likely" || x.verdict === "maybe" || x.present || x.found); }).length;
      var maps = (d.llmsTxt && d.llmsTxt.ok ? 1 : 0) + (d.sitemapXml && d.sitemapXml.ok ? 1 : 0);
      title = "Discovery focus";
      badgeData = { text: st.verdict || "unknown", kind: st.verdict === "agent-native" ? "ok" : st.verdict === "agent-readable" ? "" : "warn" };
      caption = "What can an agent discover before it has to drive the human page?";
      rows = { "strategy": st.note || st.verdict || "unknown", "site maps": maps + " of 2 found · llms.txt / sitemap.xml", "agent doors": doors + " declared or probable", "feeds": (d.feeds || []).length + " advertised" };
    }
    return '<div class="lx-focus">' + section(title, badgeData, caption, kvTable(rows) + extra) + "</div>";
  }

  function machineBrief() {
    var a = data.anatomy || {};
    var s = data.structured || {};
    var d = data.discovery || {};
    var ag = data.agent || {};
    var st = ag.strategy || {};
    var t = data.terms || {};
    var jsonldCount = s.jsonld ? s.jsonld.length : 0;
    var microCount = s.microdata && s.microdata.itemtypes ? s.microdata.itemtypes.length : 0;
    var rdfaCount = s.rdfa && s.rdfa.typeof ? s.rdfa.typeof.length : 0;
    var relCount = s.relLinks ? s.relLinks.length : 0;
    var title = s.title || "(untitled)";
    var robots = d.robotsTxt && d.robotsTxt.ok ? "robots.txt answered" : d.robotsTxt && d.robotsTxt.error ? "robots.txt unknown" : "no robots.txt";
    var spectrum = t.spectrum && t.spectrum.tier ? t.spectrum.tier : "unknown";
    var facts = {
      "url": data.finalUrl,
      "title": title,
      "response": data.status + " " + httpText(data.status),
      "content-type": data.contentType || "(none)",
      "payload": bytes(a.rawBytes) + (data.truncated ? " (capped)" : ""),
      "headings": a.headings ? a.headings.length : 0,
      "links in head": relCount,
      "fetched as": data.fetchedBy || "identified bot",
    };
    var out = '<div class="lx-brief-lede"><b>Machine briefing.</b> This is a reconstruction from the response and the probes Lens actually ran. It describes available evidence; it does not claim that a site has agreed to a new interface.</div>' + lensFocus();
    out += section("Observed document", { text: "observed", kind: "ok" },
      "The minimum contract a machine can recover from this response.", kvTable(facts));
    out += section("Machine affordances", { text: st.verdict || "unknown", kind: st.verdict === "agent-native" ? "ok" : st.verdict === "agent-readable" ? "" : "warn" },
      "A readable page, a declared action surface, and permission are separate signals.",
      briefTable([
        ["read", (data.contentType || "response") + ", " + bytes(a.rawBytes), "observed", "ok"],
        ["structure", jsonldCount + " JSON-LD, " + microCount + " microdata, " + rdfaCount + " RDFa type(s)", jsonldCount || microCount || rdfaCount ? "found" : "absent", jsonldCount || microCount || rdfaCount ? "ok" : "off"],
        ["discover", ((d.llmsTxt && d.llmsTxt.ok ? "llms.txt" : "") + (d.sitemapXml && d.sitemapXml.ok ? " + sitemap" : "")) || "site files not found", d.llmsTxt && d.llmsTxt.ok || d.sitemapXml && d.sitemapXml.ok ? "found" : "absent", d.llmsTxt && d.llmsTxt.ok || d.sitemapXml && d.sitemapXml.ok ? "ok" : "off"],
        ["action", st.action && st.action.length ? st.action.join(", ") : "no declared action surface", st.action && st.action.length ? "found" : "absent", st.action && st.action.length ? "ok" : "off"],
        ["policy", robots + "; spectrum: " + spectrum, robots === "robots.txt answered" ? "observed" : "unknown", robots === "robots.txt answered" ? "" : "warn"],
        ["markdown", ag.mdNegotiation && ag.mdNegotiation.supported ? "same URL serves text/markdown" : "HTML response stays HTML", ag.mdNegotiation && ag.mdNegotiation.supported ? "supported" : "absent", ag.mdNegotiation && ag.mdNegotiation.supported ? "ok" : "off"],
      ]));
    var briefText = "# observed\n" +
      "url       " + data.finalUrl + "\n" +
      "title     " + title + "\n" +
      "response  " + data.status + " " + httpText(data.status) + "\n" +
      "read      " + (data.contentType || "unknown") + " · " + bytes(a.rawBytes) + "\n" +
      "structure " + jsonldCount + " JSON-LD · " + microCount + " microdata · " + rdfaCount + " RDFa\n" +
      "action    " + (st.action && st.action.length ? st.action.join(", ") : "none observed") + "\n\n" +
      "# boundaries\n" +
      "identity  " + (data.fetchedBy || "identified fetch") + "\n" +
      "policy    " + robots + " · " + spectrum + "\n" +
      "sidefx    Lens inspected; it submitted no forms or tools";
    out += section("Copyable machine brief", { text: "plain text" },
      "The compact representation an agent could carry forward without the browser chrome.", pre(briefText, true));
    out += section("Boundaries", { text: "explicit", kind: "warn" },
      "These limits keep the reconstruction honest.",
      '<ul class="lx-why"><li>Lens fetched as ' + esc(data.fetchedBy || "an identified bot") + '; no other bot identity was tested.</li>' +
      '<li>Robots policy describes a request; the enforcement result appears separately in the Terms lens.</li>' +
      '<li>Reading a page does not grant permission to act on a user\'s behalf.</li></ul>');
    return out;
  }

  function cfState(observed, key) {
    if (observed) return { text: "observed", kind: "ok" };
    if (counterfactuals[key]) return { text: "counterfactual", kind: "warn" };
    return { text: "missing", kind: "off" };
  }

  // ONE source of truth for whether a counterfactual's surface is already published,
  // read off the SAME data.readiness.checks the projection scores against. deltaView
  // used to HARDCODE authority (and receipt) as never-observed while readinessProjection
  // read authority from the oauth checks, so a scan of aadhar.sh (which ships
  // /.well-known/oauth-protected-resource) showed "Delegated authority" as missing in the
  // Delta view and present in the Readiness tab at once. markdown/contract/authority now
  // derive from these checks in both places; semantic has no single readiness check (it is
  // computed from structured data) and receipt has no probe backing it yet.
  var CF_MAP = {
    markdown:  { checks: ["markdownNegotiation"] },
    contract:  { checks: ["apiCatalog"] },
    authority: { checks: ["oauthProtectedResource", "oauthDiscovery", "authMd"] },
  };
  function cfObserved(key, checks) {
    var m = CF_MAP[key];
    checks = checks || {};
    return !!(m && m.checks.some(function (n) { return checks[n] && checks[n].status === "pass"; }));
  }

  function deltaView() {
    var s = data.structured || {};
    var d = data.discovery || {};
    var ag = data.agent || {};
    var st = ag.strategy || {};
    var checks = (data.readiness && data.readiness.checks) || {};
    var jsonld = s.jsonld && s.jsonld.length > 0;
    var semantic = jsonld || (s.microdata && s.microdata.itemtypes && s.microdata.itemtypes.length) || (s.rdfa && s.rdfa.typeof && s.rdfa.typeof.length);
    var action = st.action && st.action.length > 0;   // the agent strategy's action surface, for the evidence line below
    var cf = [
      { key: "markdown", label: "Clean machine text", stage: "Read", observed: cfObserved("markdown", checks), detail: "Serve a deliberate text/markdown representation from the same URL." },
      { key: "semantic", label: "Entity schema", stage: "Understand", observed: !!semantic, detail: "Publish stable entities and properties a parser can validate." },
      { key: "contract", label: "Action contract", stage: "Act", observed: cfObserved("contract", checks), detail: "Describe callable operations, parameters, and side effects." },
      { key: "authority", label: "Delegated authority", stage: "Authorize", observed: cfObserved("authority", checks), detail: "Add a consent boundary with scopes and an explicit user approval." },
      { key: "receipt", label: "A result receipt", stage: "Confirm", observed: false, detail: "Return a durable result with origin, time, and provenance. No probe measures this surface yet, so it is always shown as a projection, never as observed." },
    ];
    var controls = '<div class="lx-cf-grid">' + cf.map(function (x) {
      var on = !!counterfactuals[x.key];
      return '<div class="lx-cf-card' + (on ? " is-on" : "") + '"><h4>' + esc(x.label) + '</h4><p>' + esc(x.detail) + '</p>' +
        '<button class="lx-cf-toggle" type="button" data-cf="' + esc(x.key) + '" aria-pressed="' + (on ? "true" : "false") + '"><span class="lx-cf-dot" aria-hidden="true"></span>' + (on ? "on" : "off") + "</button></div>";
    }).join("") + "</div>";
    var path = cf.map(function (x) {
      var state = cfState(x.observed, x.key);
      var copy = x.observed ? "published signal found" : counterfactuals[x.key] ? x.detail : "no matching surface observed";
      return '<div class="lx-stage"><div class="lx-stage-name">' + esc(x.stage) + '</div><div class="lx-stage-copy">' + badge(state.text, state.kind) + esc(copy) + '</div></div>';
    }).join("");
    var intro = '<div class="lx-delta-intro"><b>Counterfactual lab.</b> Turn on one piece of web infrastructure and watch the route change. Green means Lens observed a signal. Amber means this page is simulating the addition locally.</div>';
    var proof = '<div class="lx-proof"><b>Current evidence:</b> ' + esc((d.llmsTxt && d.llmsTxt.ok ? "llms.txt is present. " : "No llms.txt observed. ") + (action ? "An action surface answered. " : "No action surface answered. ") + (semantic ? "Structured data exists." : "Structured entity data is absent.")) + '</div>';
    var deltaText = cf.filter(function (x) { return counterfactuals[x.key]; }).map(function (x) { return "+ " + x.stage.toLowerCase() + " · " + x.label; }).join("\n");
    return intro + section("Infrastructure switches", null, "Each switch changes one stage of the path and nothing else.", controls) +
      section("The route", { text: "no score" }, "A task path is more useful here than a readiness number.", '<div class="lx-path">' + path + '</div>' + proof) +
      section("What this proves", { text: "local simulation", kind: "warn" }, "Counterfactuals clarify a missing contract; they do not create a real endpoint on the scanned site.", pre("# delta\n" + (deltaText || "(no switches on)"), true));
  }

  function bindCounterfactuals() {
    [].forEach.call(machineBody.querySelectorAll(".lx-cf-toggle"), function (b) {
      b.addEventListener("click", function () {
        var key = b.getAttribute("data-cf");
        if (!Object.prototype.hasOwnProperty.call(counterfactuals, key)) return;
        counterfactuals[key] = !counterfactuals[key];
        syncUrl(true);
        withViewTransition(function () { renderMachine(); });
      });
    });
  }

  // Fix copy only. Labels used to live here too and silently won over the ones the
  // worker ships on every readiness item (LENS_READINESS_META), so a label renamed
  // server-side changed the SSR text but not the hydrated text. Labels now come off
  // the envelope item; this map is just key -> how-to-fix, which the worker never carries.
  var READINESS_FIX = {
    robotsTxt: "Publish a valid /robots.txt with explicit User-agent rules and a Sitemap directive.", sitemap: "Publish /sitemap.xml and reference it from robots.txt.",
    linkHeaders: "Add RFC 8288 Link relations for your sitemap, docs, API catalog, or alternate machine representation.", dnsAid: "Publish a DNSSEC-signed _index._agents.<domain> SVCB/HTTPS record for machine discovery.",
    markdownNegotiation: "Return text/markdown when a client sends Accept: text/markdown, while keeping HTML for browsers.",
    robotsTxtAiRules: "Declare explicit GPTBot, ClaudeBot, CCBot, and other AI crawler rules in robots.txt.", contentSignals: "Add Content-Signal directives for ai-train, ai-input, and search to robots.txt.",
    webBotAuth: "Publish a valid JWKS at /.well-known/http-message-signatures-directory.", apiCatalog: "Publish /.well-known/api-catalog as application/linkset+json with service-desc and service-doc links.",
    oauthDiscovery: "Publish OAuth/OIDC discovery metadata with issuer and token endpoints.", oauthProtectedResource: "Publish /.well-known/oauth-protected-resource with authorization_servers and scopes_supported.",
    authMd: "Publish /auth.md with agent registration instructions and link it to your OAuth metadata.", mcpServerCard: "Publish /.well-known/mcp/server-card.json with serverInfo, transport, and capabilities.",
    a2aAgentCard: "Publish /.well-known/agent-card.json describing the agent's interfaces, capabilities, and skills.", agentSkills: "Publish /.well-known/agent-skills/index.json with skills, URLs, and digests.",
    webMcp: "Expose safe browser actions with navigator.modelContext and JSON Schemas.", x402: "Return a machine-readable HTTP 402 payment requirement for payable routes.",
    mpp: "Describe payable OpenAPI operations with x-payment-info and MPP settlement metadata.", ucp: "Publish /.well-known/ucp with protocol version, services, capabilities, and endpoints.",
    acp: "Publish /.well-known/acp.json so agents can discover commerce services and transports.", ap2: "Publish the AP2 discovery metadata when your commerce flow supports it.",
  };
  function readinessCopy(itemOrKey) {
    var key = typeof itemOrKey === "string" ? itemOrKey : itemOrKey && itemOrKey.key;
    var label = (itemOrKey && itemOrKey.label) || key || "check";   // the worker ships label on both items and nextActions entries
    return { label: label, fix: READINESS_FIX[key] || "Inspect this surface and publish the expected machine-readable contract." };
  }

  function readinessStatus(item) {
    if (item.status === "pass") return { text: "pass", kind: "ok" };
    if (item.status === "neutral") return { text: "optional", kind: "off" };
    if (item.status === "unknown") return { text: "unknown", kind: "warn" };
    return { text: "fix", kind: "warn" };
  }

  function readinessPolicy(bot) {
    var rows = data.terms && data.terms.scoreboard || [];
    return rows.filter(function (r) { return r.ua === bot.key; })[0] || null;
  }

  function readinessBotState(bot) {
    if (bot.error) return { text: "unknown", kind: "warn" };
    if (bot.challenge) return { text: "challenge", kind: "warn" };
    if (bot.blocked) return { text: (bot.status || "blocked") + " blocked", kind: "warn" };
    if (bot.status >= 200 && bot.status < 400) return { text: bot.status + " " + (bot.contentType || "readable"), kind: "ok" };
    return { text: bot.status || "unknown", kind: "warn" };
  }

  function readinessProjection(readiness) {
    // same CF_MAP + cfObserved the Delta view uses, so "improvable here" means exactly
    // "not observed by any of this key's checks" in both places. The primary check
    // (checks[0]) is the one whose score we project adding.
    var checks = readiness.checks || {};
    var direct = [
      { key: "markdown", label: "Clean machine text" },
      { key: "contract", label: "Action contract" },
      { key: "authority", label: "Delegated authority" },
    ];
    var active = direct.filter(function (x) { return counterfactuals[x.key] && !cfObserved(x.key, checks); });
    if (!active.length) return null;
    var pass = readiness.passed;
    var counted = readiness.counted;
    active.forEach(function (x) { var c = checks[CF_MAP[x.key].checks[0]]; if (c && c.countInScore) pass++; });
    return { score: counted ? Math.round(pass / counted * 100) : readiness.overall, labels: active.map(function (x) { return x.label; }) };
  }

  function copyText(text, button) {
    var done = function () {
      if (!button) return;
      var old = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function () {});
    else {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      ta.remove();
    }
  }

  function bindReadinessActions() {
    [].forEach.call(machineBody.querySelectorAll(".lx-copy-fix"), function (button) {
      button.addEventListener("click", function () { copyText(button.getAttribute("data-fix") || "", button); });
    });
    var all = machineBody.querySelector(".lx-copy-all");
    if (all) all.addEventListener("click", function () {
      var fixes = [].map.call(machineBody.querySelectorAll(".lx-readiness-check[data-status='fail']"), function (row) {
        return "- " + row.getAttribute("data-label") + ": " + row.getAttribute("data-fix");
      });
      copyText("Lens readiness fixes for " + (data.finalUrl || data.url) + "\n\n" + fixes.join("\n"), all);
    });
  }

  function lensReadiness() {
    var r = data.readiness;
    if (!r) return '<div class="lx-empty">Readiness checks were unavailable for this origin.</div>';
    var levelKind = r.level >= 5 ? "ok" : r.level >= 3 ? "" : "warn";
    var projection = readinessProjection(r);
    var score = '<div class="lx-readiness-hero"><div class="lx-readiness-number">' + esc(r.overall) + '<span>/100</span></div>' +
      '<div><div class="lx-readiness-kicker">Lens readiness score</div><div class="lx-readiness-level">' + badge("Level " + r.level, levelKind) + ' <b>' + esc(r.levelName) + '</b></div><div class="lx-cap">' + esc(r.scoringNote) + '</div></div></div>';
    if (projection) score += '<div class="lx-projection"><b>Counterfactual projection:</b> ' + esc(projection.score + "/100 if you add " + projection.labels.join(", ") + ".") + ' <span>illustrative; the origin has not changed.</span></div>';

    var cats = '<div class="lx-readiness-cats">' + (r.categories || []).map(function (c) {
      var skipped = c.total === 0 && c.checkCount > 0;
      return '<div class="lx-readiness-cat' + (skipped ? " is-skipped" : "") + '"><div><b>' + esc(c.label) + '</b><span>' + (c.countInScore ? c.passed + "/" + c.total : "optional") + '</span></div><strong>' + (skipped ? "—" : c.score) + '</strong></div>';
    }).join("") + '</div>';

    var checks = Object.keys(r.checks || {}).map(function (key) { return r.checks[key]; });
    var checkHtml = '<div class="lx-readiness-checks">' + checks.map(function (item) {
      var state = readinessStatus(item);
      var copy = readinessCopy(item);
      var fix = copy.fix;
      return '<div class="lx-readiness-check" data-status="' + esc(item.status) + '" data-label="' + esc(copy.label) + '" data-fix="' + esc(fix) + '"><div class="lx-readiness-check-top"><b>' + esc(copy.label) + '</b>' + badge(state.text, state.kind) + '</div><div class="lx-readiness-detail">' + esc(item.detail || "") + '</div>' + (item.status === "fail" ? '<div class="lx-readiness-fix"><span>' + esc(fix) + '</span><button class="lx-copy-fix" type="button" data-fix="' + esc(fix) + '">Copy fix</button></div>' : "") + '</div>';
    }).join("") + '</div>';

    var bots = r.botViews || [];
    var botHtml = bots.length ? '<table class="lx-bot-matrix"><tr><th>bot identity</th><th>robots policy</th><th>sampled GET</th><th>what this enables</th></tr>' + bots.map(function (bot) {
      var policy = readinessPolicy(bot);
      var actual = readinessBotState(bot);
      var implication = bot.blocked ? "This identity may not retrieve the route." : policy && policy.verdict === "block" ? "Robots asks it not to read; the sampled response is not enforcement." : bot.status >= 200 && bot.status < 400 ? "It can retrieve this response; parsing and action are separate." : "Access is uncertain from this sample.";
      return '<tr><td class="ua"><b>' + esc(bot.label) + '</b><br><span class="who">' + esc(bot.owner) + '</span></td><td>' + badge(policy ? policy.verdict : "not scored", policy && policy.verdict === "allow" ? "ok" : "warn") + '</td><td>' + badge(actual.text, actual.kind) + '</td><td class="rule">' + esc(implication) + '</td></tr>';
    }).join("") + '</table>' : '<div class="lx-none">Bot identity samples were unavailable.</div>';

    var gaps = [];
    var c = r.checks || {};
    if (c.markdownNegotiation && c.markdownNegotiation.status !== "pass") gaps.push("Agents pay the HTML/token tax because this URL does not negotiate a clean machine representation.");
    if (data.structured && !(data.structured.jsonld || []).length && c.apiCatalog && c.apiCatalog.status !== "pass") gaps.push("A machine can read the page, but it has no stable entity graph or declared action catalog to validate.");
    if (data.agent && data.agent.strategy && !data.agent.strategy.action.length) gaps.push("Reading is possible; acting is not declared. An agent must drive the human page and guess at side effects.");
    if (!gaps.length) gaps.push("The main access surfaces are published. Inspect the individual checks for the remaining edge cases and bot-specific policy.");
    var gapHtml = '<ul class="lx-why">' + gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join("") + '</ul>';
    var next = (r.nextActions || []).length ? '<div class="lx-next-actions">' + r.nextActions.map(function (a) { var copy = readinessCopy(a); return '<div><b>' + esc(copy.label) + '</b><span>' + esc(copy.fix) + '</span></div>'; }).join("") + '</div>' : '<div class="lx-none">No scored fixes are waiting.</div>';
    return score + section("Category scores", null, "The categories mirror the IsItAgentReady rubric; Commerce is visible but optional and not scored.", cats) +
      section("The access gap", { text: "human vs bot" }, "A browser can render a page even when an agent cannot establish what it may read or do.", gapHtml) +
      section("Bot views", { text: bots.length + " sampled" }, "Six representative, read-only GETs show observed response behavior. Robots policy and enforcement are deliberately separate.", botHtml) +
      section("Checks and fixes", null, "Every failed check has a concrete next move. Copy the complete implementation brief into your coding agent.", '<button class="lx-copy-all" type="button">Copy all fixes</button>' + next + checkHtml);
  }

  function renderMachine() {
    var title = view === "machine" ? "Machine view &middot; " + LENS_LABEL[lens] : view === "delta" ? "Delta view &middot; What changes" : "Machine view &middot; " + LENS_LABEL[lens];
    machineH.innerHTML = title;
    if (!data) { return; }
    var fn = { readiness: lensReadiness, anatomy: lensAnatomy, structured: lensStructured, ai: lensAI, terms: lensTerms, discovery: lensDiscovery }[lens] || lensReadiness;
    var body = view === "machine" ? machineBrief() + '<div class="lx-machine-block">' + section("Selected evidence lens", { text: LENS_LABEL[lens] }, "The original inspector remains available below the briefing.", fn()) + "</div>"
      : view === "delta" ? deltaView() : fn();
    machineBody.innerHTML = body;
    machineBody.scrollTop = 0;
    if (view === "delta") bindCounterfactuals();
    if (lens === "readiness") bindReadinessActions();
  }

  function lensAnatomy() {
    var a = data.anatomy, out = "";
    var summary = {
      status: data.status,
      "content-type": data.contentType || "(none)",
      size: bytes(a ? a.rawBytes : 0) + (data.truncated ? " (capped)" : ""),
      words: a ? a.wordCount : 0,
      "img alt coverage": a ? (a.imgTotal ? (a.imgTotal - a.imgNoAlt) + " / " + a.imgTotal + " have alt text" : "no images") : "?",
    };
    out += section("Response", null, "What the server actually sent back, before a browser touched it.",
      kvTable(summary));
    out += section("HTTP headers", { text: Object.keys(data.headers || {}).length + " headers" },
      "The envelope metadata: caching, content type, security, crawler hints.",
      kvTable(data.headers || {}));
    if (a && a.rawHtml) {
      out += section("Raw HTML source", { text: bytes(a.rawBytes) }, "The literal markup. View Source, basically.",
        pre(a.rawHtml + (a.rawBytes > a.rawHtml.length ? "\n\n[... truncated, " + bytes(a.rawBytes) + " total]" : "")));
    }
    return out;
  }

  function lensStructured() {
    var s = data.structured;
    if (!s) return '<div class="lx-empty">No HTML to parse for structured data.</div>';
    var out = "";

    var metaOrder = ["description", "keywords", "robots", "author", "generator", "viewport", "theme-color", "application-name"];
    out += section("Meta tags", null, "The original machine-readable layer (1995). description + keywords were the first SEO surface.",
      kvTable(s.meta || {}, metaOrder.concat(Object.keys(s.meta || {}).filter(function (k) { return metaOrder.indexOf(k) < 0; }))));

    // Open Graph card
    if (has(s.og)) {
      var card = '<div class="lx-ogcard">';
      if (s.og.image) card += '<img src="' + esc(s.og.image) + '" alt="" onerror="this.style.display=\'none\'">';
      card += "<div><div class=\"t\">" + esc(s.og.title || s.title || "") + "</div>";
      if (s.og.description) card += '<div class="d">' + esc(s.og.description) + "</div>";
      card += '<div class="u">' + esc(s.og.url || data.finalUrl) + (s.og.type ? "  &middot;  " + esc(s.og.type) : "") + "</div></div></div>";
      out += section("Open Graph", { text: "og:", kind: "ok" }, "Facebook, 2010. What every link-preview bot reads to build a card.", card);
    } else {
      out += section("Open Graph", { text: "absent", kind: "off" }, "Facebook, 2010. What link-preview bots read.", '<div class="lx-none">no og: tags</div>');
    }
    if (has(s.twitter)) {
      out += section("Twitter Card", { text: "twitter:" }, "Twitter, 2012. A parallel preview vocabulary, mostly overlapping OG.", kvTable(s.twitter));
    }

    // JSON-LD
    if (s.jsonld && s.jsonld.length) {
      var blocks = s.jsonld.map(function (b) {
        if (b.valid) {
          var types = b.types && b.types.length ? '<div class="lx-tags">' + b.types.map(function (t) { return '<span class="lx-tag">' + esc(t) + "</span>"; }).join("") + "</div>" : "";
          return types + pre(b.json, true);
        }
        return '<div class="lx-badge warn">invalid JSON</div> ' + esc(b.error) + pre(b.raw, true);
      }).join('<div style="height:8px"></div>');
      out += section("JSON-LD", { text: s.jsonld.length + " block" + (s.jsonld.length > 1 ? "s" : ""), kind: "ok" },
        "Schema.org as JSON, 2011 onward. The structured data Google reads for rich results, and the cleanest signal for any agent.", blocks);
    } else {
      out += section("JSON-LD", { text: "absent", kind: "off" }, "Schema.org as JSON, 2011 onward. Google's rich-results format.", '<div class="lx-none">no JSON-LD blocks</div>');
    }

    out += section("Microdata", s.microdata && s.microdata.itemtypes.length ? { text: s.microdata.itemtypes.length + " types" } : { text: "absent", kind: "off" },
      "HTML microdata, 2009 W3C. Schema.org expressed inline as itemscope/itemprop attributes.",
      (s.microdata && (s.microdata.itemtypes.length || s.microdata.props.length))
        ? tags(s.microdata.itemtypes) + (s.microdata.props.length ? '<div style="height:5px"></div>' + tags(s.microdata.props.slice(0, 40)) : "")
        : '<div class="lx-none">none</div>');

    out += section("RDFa", s.rdfa && s.rdfa.typeof.length ? { text: s.rdfa.typeof.length + " types" } : { text: "absent", kind: "off" },
      "RDFa, 2008 W3C. The semantic-web vision of embedding RDF triples in any tag.",
      (s.rdfa && (s.rdfa.typeof.length || s.rdfa.properties.length))
        ? tags(s.rdfa.typeof) + (s.rdfa.properties.length ? '<div style="height:5px"></div>' + tags(s.rdfa.properties.slice(0, 40)) : "")
        : '<div class="lx-none">none</div>');

    out += section("Microformats", s.microformats && s.microformats.length ? { text: s.microformats.length + " classes" } : { text: "absent", kind: "off" },
      "microformats, 2005 IndieWeb. People and posts marked up in plain class names (h-card, h-entry).",
      tags(s.microformats));

    return out;
  }

  // context economics: the same page priced per representation an agent could
  // ingest. The semantic web asked publishers to structure up front; LLMs pay
  // the difference per read instead — this table is that difference.
  function econSection() {
    var c = data.cost;
    if (!c || !c.tiers || !c.tiers.length) return "";
    var rate = (c.rates && c.rates[0]) || { model: "reference", usdPerMtok: 3 };
    var base = c.tiers[0];
    var rows = '<tr><th>representation</th><th class="num">size</th><th class="num">~tokens</th><th class="num">1 read</th><th class="num">1,000 reads</th><th></th></tr>';
    c.tiers.forEach(function (t) {
      var usd = t.tokens / 1e6 * rate.usdPerMtok;
      var mult = (t !== base && t.tokens > 0) ? Math.round(base.tokens / t.tokens) : 0;
      rows += "<tr><td>" + esc(t.label) + '<br><span class="who">' + esc(t.note) + '</span></td><td class="num">' + bytes(t.chars) +
        '</td><td class="num">' + fmtTok(t.tokens) + '</td><td class="num">' + fmtUsd(usd) + '</td><td class="num">' + fmtUsd(usd * 1000) +
        "</td><td>" + (mult > 1 ? '<span class="lx-mult">&times;' + mult + " cheaper</span>" : "") + "</td></tr>";
    });
    var summary = "";
    if (c.tiers.length > 1) {
      var cheapest = c.tiers[c.tiers.length - 1];
      var multAll = cheapest.tokens ? Math.round(base.tokens / cheapest.tokens) : 0;
      var per1k = fmtUsd(base.tokens / 1e6 * rate.usdPerMtok * 1000);
      summary = '<div class="lx-cap" style="margin-top:6px">' +
        (multAll > 1 ? "A naive read pays &times;" + multAll + " what the " + esc(cheapest.label) + " costs. The semantic web asked publishers to do this work up front; models just pay the difference on every read. " : "") +
        '1,000 naive reads of this page &asymp; <b>' + per1k + "</b> of inference; the publisher collects $0.00 (<a href=\"/ledger\">the ledger</a>).</div>";
    }
    var others = (c.rates || []).slice(1).map(function (r) { return r.model + " $" + r.usdPerMtok; }).join(", ");
    return section("Context economics", { text: "~" + fmtTok(base.tokens) + " tok" },
      "What reading this page costs a machine. Priced at " + rate.model + " input, $" + rate.usdPerMtok + "/Mtok (" + others + " — checked " + (c.checked || "") + "); tokens are " + c.tokenizer + ".",
      '<table class="lx-bots">' + rows + "</table>" + summary);
  }

  function lensAI() {
    var out = econSection();
    var d = (data.ai && data.ai.directives) || {};
    var dir = {
      "llms.txt": data.ai && data.ai.llmsTxtPresent ? "present at /llms.txt" : "not found",
      "meta robots": d.metaRobots || "(none)",
      "X-Robots-Tag": d.xRobotsTag || "(none)",
      "robots.txt names AI crawlers": d.namesAiCrawlers ? "yes (GPTBot / ClaudeBot / etc.)" : "no",
    };
    out += section("Crawler & model directives", null,
      "Today's frontier: llms.txt (2024) plus the AI-crawler controls sites are bolting onto robots rules.",
      kvTable(dir));
    var md = data.ai && data.ai.markdown ? data.ai.markdown : "(no markdown — non-HTML or empty body)";
    out += section("Markdown rendering", { text: bytes(md.length) },
      "Best-effort HTML to Markdown, roughly what a basic LLM scraper ingests. The clean signal under the markup.",
      pre(md, true));
    return out;
  }

  // the Terms lens: whose bots may read this path, on what signals, at what
  // price, behind what wall. Everything shown is published policy plus what
  // happened to lens's own identified fetch — no user-agent dress-up.
  function lensTerms() {
    var t = data.terms;
    if (!t) return '<div class="lx-empty">No terms to read (the origin never answered the probes).</div>';
    var out = "";

    // the spectrum strip
    var TIERS = [
      { k: "open",     label: "Open",     sub: "no terms set" },
      { k: "signaled", label: "Signaled", sub: "asks, via robots" },
      { k: "enforced", label: "Enforced", sub: "blocks at the edge" },
      { k: "paid",     label: "Paid",     sub: "charges for access" },
    ];
    var strip = '<div class="lx-spectrum">' + TIERS.map(function (x) {
      return '<div class="lx-spec' + (t.spectrum.tier === x.k ? " is-here" : "") + '"><b>' + x.label + "</b><span>" + x.sub + "</span></div>";
    }).join("") + "</div>";
    var why = '<ul class="lx-why">' + (t.spectrum.reasons || []).map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
    out += section("Where this site sits", { text: t.spectrum.tier, kind: t.spectrum.tier === "open" ? "ok" : t.spectrum.tier === "signaled" ? "" : "warn" },
      "Open to any bot, gated behind payment, or anywhere in between. The agentic web's actual terms of service.",
      strip + why);

    // the bot scoreboard
    var KIND = { search: "Search engines", train: "AI training crawlers", answers: "AI answer engines (live retrieval)" };
    var blocked = (t.scoreboard || []).filter(function (b) { return b.verdict === "block"; }).length;
    var rows = "<tr><th>crawler</th><th>runs it</th><th>verdict</th><th>why</th></tr>";
    var lastKind = null;
    (t.scoreboard || []).forEach(function (b) {
      if (b.kind !== lastKind) { rows += '<tr class="lx-kindrow"><td colspan="4">' + KIND[b.kind] + "</td></tr>"; lastKind = b.kind; }
      var badge, why2;
      if (t.robotsUnknown) { badge = '<span class="lx-badge warn">unknown</span>'; why2 = "robots.txt unreachable: " + (t.robotsError || "no answer"); }
      else if (!t.robotsPresent) { badge = '<span class="lx-badge off">no robots.txt</span>'; why2 = "nothing to obey"; }
      else if (b.verdict === "block") { badge = '<span class="lx-badge no">blocked</span>'; why2 = (b.rule || "") + " (as " + b.matchedUa + ")"; }
      else if (b.matchedUa && b.matchedUa !== "*") { badge = '<span class="lx-badge ok">allowed</span>'; why2 = (b.rule || "no matching rule") + " (named as " + b.matchedUa + ")"; }
      else if (b.matchedUa === "*") { badge = '<span class="lx-badge ok">allowed</span>'; why2 = (b.rule || "no matching rule") + " (under *)"; }
      else { badge = '<span class="lx-badge off">unmentioned</span>'; why2 = "no group matches, so allowed by default"; }
      rows += '<tr><td class="ua">' + esc(b.ua) + '</td><td>' + esc(b.owner) + '<br><span class="who">' + esc(b.note) + "</span></td><td>" + badge + '</td><td class="rule">' + esc(why2) + "</td></tr>";
    });
    var sbBadge = t.robotsUnknown ? { text: "unknown", kind: "warn" }
      : !t.robotsPresent ? { text: "no robots.txt", kind: "off" }
      : blocked ? { text: blocked + " blocked", kind: "warn" } : { text: "all allowed", kind: "ok" };
    out += section("The bot scoreboard", sbBadge,
      "robots.txt evaluated per crawler (RFC 9309 longest-match) for " + t.path + ". This is policy, not enforcement — obeying it is voluntary.",
      '<table class="lx-bots">' + rows + "</table>");

    // Content Signals
    var sig;
    if (t.signals && t.signals.length) {
      sig = t.signals.map(function (s) {
        var chips = ["search", "ai-input", "ai-train"].map(function (k) {
          var v = s.parsed[k];
          var kind = v === "yes" ? "ok" : v === "no" ? "no" : "off";
          return '<span class="lx-badge ' + kind + '">' + k + "=" + esc(v || "unset") + "</span>";
        }).join(" ");
        return '<div style="margin:0 0 7px"><span class="lx-tag">User-agent: ' + esc(s.agents.join(", ")) + '</span><div style="height:4px"></div>' + chips + "</div>";
      }).join("");
    } else {
      sig = '<div class="lx-none">no Content-Signal lines in robots.txt</div>';
    }
    out += section("Content Signals", { text: t.signals && t.signals.length ? "declared" : "absent", kind: t.signals && t.signals.length ? "ok" : "off" },
      "contentsignals.org, 2025 (Cloudflare). Three consent bits a site can attach to a robots group: search, ai-input (grounding answers), ai-train.",
      sig);

    // price
    var paid = t.paid || {};
    var paidInner = "";
    if (paid.http402) paidInner += '<div class="lx-fallback-note">This URL answered <b>402 Payment Required</b>' + (paid.x402 ? " with an x402 envelope — a machine-readable invoice." : ".") + "</div>";
    if (paid.x402) paidInner += pre(paid.x402, true);
    if (has(paid.crawlerHeaders)) paidInner += kvTable(paid.crawlerHeaders);
    if (!paidInner) paidInner = '<div class="lx-none">no price signals: no 402, no pay-per-crawl headers. (Almost nobody sets these yet — that is the frontier.)</div>';
    out += section("Price", { text: paid.http402 ? "402" : "free", kind: paid.http402 ? "warn" : "off" },
      "HTTP 402, Cloudflare pay-per-crawl headers, x402 envelopes: content gated behind machine payment.",
      paidInner);

    // enforcement
    var enf = t.enforcement || {};
    var enfInner;
    if (enf.challenged) enfInner = '<div class="lx-fallback-note">Our fetch hit a bot challenge (the &quot;verify you are human&quot; wall). The policy above is backed by active enforcement.</div>';
    else if (enf.blocked) enfInner = '<div class="lx-fallback-note">Our identified fetch was refused with HTTP ' + enf.status + ". Policy here is enforced, at least against bots that announce themselves.</div>";
    else enfInner = '<div class="lx-none">our identified fetch went through (HTTP ' + enf.status + ") — no wall between the policy and the content</div>";
    enfInner += '<div class="lx-cap" style="margin-top:6px">Honesty note: lens never wears another bot\'s user-agent to probe enforcement. This reports what happened to AadharshBot\'s own signed fetch; the scoreboard reports published policy.</div>';
    out += section("Enforcement", { text: enf.challenged ? "challenge" : enf.blocked ? "blocked" : "none seen", kind: enf.challenged || enf.blocked ? "warn" : "off" },
      "robots.txt is a request. Edges like Cloudflare can make it a wall.",
      enfInner);

    // TDMRep
    out += section("TDM Reservation Protocol", { text: t.tdmrep && t.tdmrep.present ? "found" : "absent", kind: t.tdmrep && t.tdmrep.present ? "ok" : "off" },
      "W3C community spec: the EU text-and-data-mining opt-out, at /.well-known/tdmrep.json.",
      t.tdmrep && t.tdmrep.present ? pre(t.tdmrep.body, true) : '<div class="lx-none">not present</div>');

    return out;
  }

  // agent doors: the action/read surfaces this origin exposes to machines,
  // and the verdict on which strategy the site picked (publish-for-agents vs
  // make-them-drive-the-human-page).
  function doorsSection() {
    var ag = data.agent;
    if (!ag) return "";
    var rows = "";
    function row(name, note, badge, kind, detail) {
      rows += '<tr><td class="ua">' + esc(name) + '</td><td>' + esc(note) + "</td><td><span class=\"lx-badge " + kind + '">' + esc(badge) + '</span></td><td class="rule">' + esc(detail || "") + "</td></tr>";
    }
    var mcp = ag.mcp || {};
    row("/mcp", "MCP endpoint (2024) — tools for models, at run time",
      mcp.verdict === "yes" ? "found" : mcp.verdict === "likely" ? "likely" : mcp.verdict === "maybe" ? "maybe" : "absent",
      mcp.verdict === "yes" || mcp.verdict === "likely" ? "ok" : mcp.verdict === "maybe" ? "warn" : "off", mcp.detail);
    var nl = ag.nlweb || {};
    row("/ask", "NLWeb (Microsoft, 2025) — the site as a natural-language endpoint",
      nl.verdict === "maybe" ? "NLWeb-shaped" : "absent", nl.verdict === "maybe" ? "warn" : "off", nl.detail);
    var wm = ag.webmcp || {};
    row("WebMCP", "in-page tools for browser agents (Chrome/W3C draft)",
      wm.found ? "markers found" : "absent", wm.found ? "ok" : "off", wm.marker);
    var card = ag.agentCard || {};
    row(".well-known/agent-card.json", "A2A agent card — who this agent is, what it offers",
      card.present ? "found" : "absent", card.present ? "ok" : "off", card.detail || card.note);
    var mn = ag.mdNegotiation || {};
    row("Accept: text/markdown", "content negotiation — the same URL, re-served for machines",
      mn.supported ? "supported" : "no", mn.supported ? "ok" : "off",
      mn.supported ? "content-type flips to " + mn.contentType : (mn.note || (mn.contentType ? "stays " + mn.contentType : "")));
    var oa = ag.openapi || {};
    row("/openapi.json", "OpenAPI — the build-time API contract",
      oa.present ? "found" : "absent", oa.present ? "ok" : "off", oa.detail || oa.note);
    var cat = ag.apiCatalog || {};
    row(".well-known/api-catalog", "RFC 9264 linkset — a catalog of the site's APIs",
      cat.present ? "found" : "absent", cat.present ? "ok" : "off", cat.detail || cat.note);
    if (ag.aiPlugin && ag.aiPlugin.present) {
      row(".well-known/ai-plugin.json", "OpenAI plugin manifest (2023, retired) — the fossil record", "found", "ok", ag.aiPlugin.detail);
    }
    var st = ag.strategy || {};
    var stBadge = st.verdict === "agent-native" ? { text: "agent-native", kind: "ok" }
      : st.verdict === "agent-readable" ? { text: "agent-readable", kind: "" }
      : { text: "human-only", kind: "warn" };
    return section("Agent doors", stBadge,
      "Does this site publish surfaces for agents, or must they drive the human page? The semantic web's open question, asked live.",
      '<div class="lx-cap" style="margin:0 0 6px">' + esc(st.note || "") + '</div><table class="lx-bots"><tr><th>door</th><th>what it is</th><th>status</th><th>evidence</th></tr>' + rows + "</table>");
  }

  function lensDiscovery() {
    var dsc = data.discovery;
    if (!dsc) return '<div class="lx-empty">No origin to probe.</div>';
    var out = '<div class="lx-cap" style="margin-bottom:10px">Probed at the site root: <b>' + esc(dsc.origin) + "</b></div>";
    out += doorsSection();

    function file(label, obj, caption, extra) {
      var badge = obj && obj.ok ? { text: "found", kind: "ok" } : { text: (obj && obj.status ? obj.status : "absent"), kind: "off" };
      var inner;
      if (obj && obj.ok) {
        inner = (extra || "") + pre((obj.body || "").slice(0, 12000) + (obj.truncated ? "\n\n[... truncated]" : ""), true);
      } else {
        inner = '<div class="lx-none">' + (obj && obj.error ? esc(obj.error) : "not present") + "</div>";
      }
      return section(label, badge, caption, inner);
    }

    var sitemapExtra = "";
    if (dsc.sitemapXml && dsc.sitemapXml.ok) {
      var locs = (dsc.sitemapXml.body.match(/<loc>/gi) || []).length;
      var isIndex = /<sitemapindex/i.test(dsc.sitemapXml.body);
      sitemapExtra = '<div class="lx-cap">' + locs + (isIndex ? " child sitemaps" : " URLs") + " listed.</div>";
    }

    out += file("robots.txt", dsc.robotsTxt, "1994. The oldest crawler contract: who may fetch what.");
    out += file("sitemap.xml", dsc.sitemapXml, "2005, Google/Yahoo/Microsoft. The XML list of every URL worth crawling.", sitemapExtra);
    out += file("llms.txt", dsc.llmsTxt, "2024. A curated map of a site written for language models.");
    if (dsc.llmsFullTxt && dsc.llmsFullTxt.ok) out += file("llms-full.txt", dsc.llmsFullTxt, "2024. The expanded llms.txt: full text inlined for models.");
    if (dsc.aiTxt && dsc.aiTxt.ok) out += file("ai.txt", dsc.aiTxt, "AI-training opt-out manifest, a Spawning.ai convention.");
    if (dsc.securityTxt && dsc.securityTxt.ok) out += file(".well-known/security.txt", dsc.securityTxt, "RFC 9116. Where to report vulnerabilities.");

    var feeds = dsc.feeds || [];
    var feedsInner = feeds.length
      ? '<div class="lx-tags">' + feeds.map(function (f) { return '<a class="lx-tag" href="' + esc(f.href) + '" target="_blank" rel="noopener">' + esc(f.type || "feed") + " &middot; " + esc(f.href) + "</a>"; }).join("") + "</div>"
      : '<div class="lx-none">none advertised in &lt;head&gt;</div>';
    out += section("Feeds (RSS / Atom)", feeds.length ? { text: feeds.length, kind: "ok" } : { text: "none", kind: "off" },
      "The 2000s syndication web. Declared via <link rel=\"alternate\">.", feedsInner);

    return out;
  }

  // ---- status bar -------------------------------------------------------
  function renderStatus() {
    var parts = [];
    parts.push("<span><b>" + data.status + "</b> " + esc(httpText(data.status)) + "</span>");
    parts.push("<span>" + esc(modeLabel()) + "</span>");
    parts.push("<span>" + esc(data.contentType || "?") + "</span>");
    if (data.anatomy) parts.push("<span>" + bytes(data.anatomy.rawBytes) + "</span>");
    if (data.cost && data.cost.tiers && data.cost.tiers.length) parts.push("<span>~" + fmtTok(data.cost.tiers[0].tokens) + " tok</span>");
    parts.push("<span>" + data.elapsedMs + " ms</span>");
    if (data.redirected) parts.push("<span>&rarr; " + esc(data.finalUrl) + "</span>");
    parts.push('<span style="margin-left:auto">fetched as ' + esc(data.fetchedBy) + "</span>");
    statusBar.innerHTML = parts.join("");
  }

  // Keep the lens tabs useful before the first fetch. A selected tab should
  // change the evidence pane immediately, even when there is no origin data
  // to inspect yet; the scan then replaces this primer with observed output.
  function renderIdleLens() {
    var primers = {
      readiness: {
        title: "Readiness",
        note: "A transparent score across discoverability, content access, bot policy, and agent protocols.",
        rows: ["the IsItAgentReady categories, with neutral commerce checks kept optional", "six representative bot identities: policy beside a sampled GET", "a concrete fix for every scored gap, plus counterfactual score projections"]
      },
      anatomy: {
        title: "Anatomy",
        note: "The response surface a machine can read without interpreting the page.",
        rows: ["status, content type, and payload size", "headings, links, images, and readable text", "headers and accessibility clues"]
      },
      structured: {
        title: "Structured",
        note: "The entities and relationships a parser can lift from the markup.",
        rows: ["JSON-LD and Schema.org entities", "Microdata, RDFa, and microformats", "Open Graph and Twitter preview fields"]
      },
      ai: {
        title: "AI view",
        note: "The compact representation and crawler signals available to a model.",
        rows: ["best-effort Markdown rendering", "robots and AI-specific directives", "token cost and a cleaner alternate surface"]
      },
      terms: {
        title: "Terms",
        note: "What a site asks of crawlers, what it enforces, and whether access is priced.",
        rows: ["per-bot robots.txt verdicts", "Content-Signal and TDM reservations", "the observed AadharshBot fetch and any wall"]
      },
      discovery: {
        title: "Discovery",
        note: "The doors an agent can find before it has to drive the human page.",
        rows: ["robots.txt, sitemap.xml, and llms.txt", "feeds and API/action descriptions", "MCP, NLWeb, WebMCP, and agent-card hints"]
      }
    };
    var p = primers[lens] || primers.anatomy;
    machineBody.innerHTML = '<div class="lx-idle-lens"><div class="lx-idle-kicker">Selected machine lens</div>' +
      '<h3>' + esc(p.title) + '</h3><p>' + esc(p.note) + '</p><ul>' +
      p.rows.map(function (row) { return '<li>' + esc(row) + '</li>'; }).join("") +
      '</ul><div class="lx-idle-cta">Choose an example above or paste a URL, then press <b>Go</b> to replace this primer with observed evidence.</div></div>';
  }

  function httpText(s) {
    if (s >= 200 && s < 300) return "OK";
    if (s >= 300 && s < 400) return "redirect";
    if (s === 402) return "Payment Required";
    if (s === 404) return "Not Found";
    if (s >= 400 && s < 500) return "client error";
    if (s >= 500) return "server error";
    return "";
  }

  // ---- controls ---------------------------------------------------------
  function updateModeUi() {
    if (modeNote) modeNote.textContent = MODE_NOTE[view] || MODE_NOTE.both;
    [].forEach.call(document.querySelectorAll(".lx-seg"), function (b) {
      var active = b.getAttribute("data-view") === view;
      b.classList.toggle("is-on", active);
      b.setAttribute("aria-checked", active ? "true" : "false");
    });
    if (humanH && !data) {
      humanH.innerHTML = view === "delta" ? "Human view &middot; baseline" : "Human view &middot; the live page";
    }
    if (machineH && !data) {
      machineH.innerHTML = view === "machine" ? "Machine view &middot; " + LENS_LABEL[lens] : view === "delta" ? "Delta view &middot; What changes" : "Machine view &middot; " + LENS_LABEL[lens];
    }
  }

  function withViewTransition(fn, animate) {
    if (
      animate !== false &&
      document.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return document.startViewTransition(fn);
    }
    return fn();
  }

  function setView(v, animate, writeHistory) {
    if (["both", "human", "machine", "delta"].indexOf(v) < 0) v = "both";
    view = v;
    try { localStorage.setItem("lx-mode", v); } catch (e) {}
    if (writeHistory !== false) syncUrl(true);
    withViewTransition(function () {
      panes.className = "lx-panes is-" + v;
      updateModeUi();
      if (data) {
        renderMachine();
        renderStatus();
      } else renderIdleLens();
    }, animate);
  }
  function setLens(l, animate, writeHistory) {
    lens = l;
    if (writeHistory !== false) syncUrl(true);
    withViewTransition(function () {
      [].forEach.call(document.querySelectorAll(".lx-tab"), function (b) {
        var active = b.getAttribute("data-lens") === l;
        b.classList.toggle("is-on", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      if (data) renderMachine(); else { updateModeUi(); renderIdleLens(); }
    }, animate);
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); run(urlInput.value); });
  [].forEach.call(document.querySelectorAll(".lx-chip"), function (c) {
    c.addEventListener("click", function () { run(c.getAttribute("data-url")); });
  });
  [].forEach.call(document.querySelectorAll(".lx-seg"), function (b) {
    b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
  });
  [].forEach.call(document.querySelectorAll(".lx-tab"), function (b) {
    b.addEventListener("click", function () { setLens(b.getAttribute("data-lens")); });
  });
  var urlState = readUrlState();
  try {
    var savedView = localStorage.getItem("lx-mode");
    if (["both", "human", "machine", "delta"].indexOf(savedView) >= 0) view = savedView;
  } catch (e) {}
  if (urlState.view !== "both") view = urlState.view;
    if (urlState.lens !== "readiness") lens = urlState.lens;
  counterfactuals = urlState.counterfactuals;
  setView(view, false, false);
  setLens(lens, false, false);

  window.addEventListener("popstate", function () {
    var state = readUrlState();
    view = state.view;
    lens = state.lens;
    counterfactuals = state.counterfactuals;
    if (state.url && state.url !== urlInput.value.trim()) {
      run(state.url);
      return;
    }
    if (!state.url && data) {
      data = null;
      humanBody.innerHTML = '<div class="lx-empty">Paste a URL above to see it through both eyes.</div>';
      machineBody.innerHTML = '<div class="lx-empty">The markup, metadata, and machine directives land here.</div>';
      statusBar.innerHTML = '<span>Idle. Nothing is fetched until you ask, and then just once, server-side, with no logging.</span>';
    }
    setView(view, true, false);
    setLens(lens, false, false);
  });

  // deep link: /lens?url=… autoruns. Speculation safety: an autorun fires a
  // third-party crawl, so a PRERENDERED copy of this page (omnibox prediction,
  // link hover) must hold fire until the visit is real (prerenderingchange).
  try {
    var qp = new URLSearchParams(location.search).get("url");
    if (initialData) {
      urlInput.value = qp || initialData.finalUrl || initialData.url || "";
      if (initialData.ok) {
        data = initialData;
        renderHuman();
        renderMachine();
        renderStatus();
      } else {
        showError(initialData);
      }
    } else if (qp) {
      if (document.prerendering) {
        document.addEventListener("prerenderingchange", function () { run(qp); }, { once: true });
      } else {
        run(qp);
      }
    }
  } catch (e) {}
})();
