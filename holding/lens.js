// lens.js — client behavior for /lens ("The Other Web").
//
// Calls the server-side /lens/fetch engine (CORS blocks the browser from
// fetching arbitrary origins itself), then renders the result through five
// machine "lenses" — Anatomy, Structured data, AI view, Terms, Discovery
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
  var statusBar = document.getElementById("lx-status");

  var data = null;       // last successful envelope
  var view = "both";     // both | human | machine
  var lens = "anatomy";  // anatomy | structured | ai | discovery
  var busy = false;

  var LENS_LABEL = { anatomy: "Anatomy", structured: "Structured", ai: "AI view", terms: "Terms", discovery: "Discovery" };

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
  function has(o) { return o && typeof o === "object" && Object.keys(o).length > 0; }

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
    try {
      history.replaceState(null, "", "/lens?url=" + encodeURIComponent(url));
    } catch (e) {}
    humanBody.innerHTML = '<div class="lx-spin">Fetching as AadharshBot&hellip;</div>';
    machineBody.innerHTML = '<div class="lx-spin">Reading the markup&hellip;</div>';
    statusBar.innerHTML = "<span>Fetching <b>" + esc(url) + "</b> server-side&hellip;</span>";

    fetch("/lens/fetch?url=" + encodeURIComponent(url), { headers: { accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) {
          var msg = (j && j.error) || "Something went wrong.";
          machineBody.innerHTML = '<div class="lx-empty">' + esc(msg) + "</div>";
          humanBody.innerHTML = '<div class="lx-empty">No page to show.</div>';
          statusBar.innerHTML = '<span class="err">Failed:</span> <span>' + esc(msg) + "</span>";
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
            humanBody.innerHTML = '<img class="lx-shot" alt="Rendered snapshot of ' + esc(shotUrl) + '" src="' + URL.createObjectURL(b) + '">';
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

  function renderMachine() {
    machineH.innerHTML = "Machine view &middot; " + LENS_LABEL[lens];
    if (!data) { return; }
    var fn = { anatomy: lensAnatomy, structured: lensStructured, ai: lensAI, terms: lensTerms, discovery: lensDiscovery }[lens];
    machineBody.innerHTML = fn();
    machineBody.scrollTop = 0;
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

  function lensAI() {
    var out = "";
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

  function lensDiscovery() {
    var dsc = data.discovery;
    if (!dsc) return '<div class="lx-empty">No origin to probe.</div>';
    var out = '<div class="lx-cap" style="margin-bottom:10px">Probed at the site root: <b>' + esc(dsc.origin) + "</b></div>";

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
    parts.push("<span>" + esc(data.contentType || "?") + "</span>");
    if (data.anatomy) parts.push("<span>" + bytes(data.anatomy.rawBytes) + "</span>");
    parts.push("<span>" + data.elapsedMs + " ms</span>");
    if (data.redirected) parts.push("<span>&rarr; " + esc(data.finalUrl) + "</span>");
    parts.push('<span style="margin-left:auto">fetched as ' + esc(data.fetchedBy) + "</span>");
    statusBar.innerHTML = parts.join("");
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
  function setView(v) {
    view = v;
    panes.className = "lx-panes is-" + v;
    [].forEach.call(document.querySelectorAll(".lx-seg"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-view") === v);
    });
  }
  function setLens(l) {
    lens = l;
    [].forEach.call(document.querySelectorAll(".lx-tab"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-lens") === l);
    });
    if (data) renderMachine(); else machineH.innerHTML = "Machine view &middot; " + LENS_LABEL[l];
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

  // deep link: /lens?url=… autoruns. Speculation safety: an autorun fires a
  // third-party crawl, so a PRERENDERED copy of this page (omnibox prediction,
  // link hover) must hold fire until the visit is real (prerenderingchange).
  try {
    var qp = new URLSearchParams(location.search).get("url");
    if (qp) {
      if (document.prerendering) {
        document.addEventListener("prerenderingchange", function () { run(qp); }, { once: true });
      } else {
        run(qp);
      }
    }
  } catch (e) {}
})();
