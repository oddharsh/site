// ask.js — the live "ask a follow-up" widget for the LWE concept pages.
//
// Shared, deferred, edge-cached. Derives the concept from the URL, turns the
// page's decorative compose bar into an ask box gated by a homemade
// "click the cars" CAPTCHA that pops out as an XP-styled <dialog> window
// (bigger tiles, dimmed backdrop). On solve → the question + a grounded, cited
// answer drop into the conversation. The answer is badged AI-framed and shows
// the real source passage. CAPTCHA tiles reuse the homepage /images thumbnails.
//
// No-ops on any page without a /lwe/<indexed-concept> + a .compose bar.
(function () {
  // generated:concepts:start
  var CONCEPTS = { "/lwe/fhe": "fhe", "/lwe/mpc": "mpc", "/lwe/tee": "tee", "/lwe/utf8": "utf8", "/lwe/vigenere": "vigenere", "/lwe/encoding": "encoding", "/lwe/pcrypto": "pcrypto", "/lwe/dac": "dac", "/lwe/drivers": "drivers", "/lwe/knots": "knots", "/lwe/lean": "lean" };
// generated:concepts:end
  var path = location.pathname.replace(/\.html$/, "").replace(/\/$/, "");
  var concept = CONCEPTS[path];
  if (!concept) return;
  var compose = document.querySelector(".compose"), log = document.querySelector(".log");
  if (!compose || !log) return;
  var D = document;
  var BOT = (D.querySelector(".msgr-head .who b") || {}).textContent || concept.toUpperCase();

  var CSS =
    ".compose .lwe-ask{display:flex;flex-direction:column;gap:6px}" +
    ".lwe-row{display:flex;gap:6px}" +
    ".lwe-q{flex:1;min-width:0;border:1px solid #7d8aa3;background:#fff;box-shadow:inset 1px 1px 0 #c3cbdb;padding:4px 7px;font-family:var(--font-ui);font-size:9.5pt}" +
    ".lwe-q:disabled{background:#f1f1f1;color:#66707d}" +
    ".lwe-btn{font-family:var(--font-ui);font-size:9.5pt;padding:3px 11px;cursor:pointer;color:#1a2030;background:linear-gradient(to bottom,#fff 0%,#e9edf5 100%);border:1px solid #7d8aa3;box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #b9c2d4;white-space:nowrap}" +
    ".lwe-btn:hover{border-color:#3a71f5;background:linear-gradient(to bottom,#fff,#dce8fb)}" +
    ".lwe-btn:active{box-shadow:inset 1px 1px 0 #b9c2d4,inset -1px -1px 0 #fff}" +
    ".lwe-btn:disabled{color:#aab;background:linear-gradient(to bottom,#f3f3f3,#e6e6e6);border-color:#bbb;cursor:not-allowed}" +
    ".lwe-btn.go{font-weight:bold;background:linear-gradient(to bottom,#eaf6ec,#cdeccf);border-color:#4a9a52}" +
    ".lwe-status{font-size:8pt;font-family:var(--font-mono);min-height:1em}" +
    ".lwe-status.ok{color:#2c7a36}.lwe-status.no{color:#c43636}" +
    // ── the pop-out CAPTCHA window ──────────────────────────────────────────
    ".lwe-dlg{padding:0;border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-radius:8px 8px 0 0;max-width:380px;width:92vw;background:#ECE9D8;box-shadow:inset 1px 1px 0 #166aee,inset -1px -1px 0 #00138c,6px 6px 16px rgba(0,20,120,.4);color:#15243f;font-family:var(--font-ui)}" +
    ".lwe-dlg::backdrop{background:rgba(8,30,120,.32)}" +
    ".lwe-dlg-tt{display:flex;align-items:center;gap:6px;padding:4px 5px 4px 8px;color:#fff;font-family:var(--font-caption);font-weight:bold;font-size:11pt;text-shadow:1px 1px #0f1089;background:linear-gradient(180deg,#5a8fe6 0%,#1f5fd0 18%,#1655c4 86%,#3a78e0 100%)}" +
    ".lwe-dlg-tt .ico{flex:0 0 auto}.lwe-dlg-tt .t{flex:1;min-width:0}" +
    ".lwe-dlg-x{width:21px;height:21px;border:1px solid #d8401c;border-radius:3px;background:linear-gradient(180deg,#e8795f,#ae3110);color:#fff;font-weight:bold;font-size:11px;cursor:pointer;line-height:1}" +
    ".lwe-dlg-x:hover{background:linear-gradient(180deg,#ff8b7d,#d34936)}" +
    ".lwe-dlg-bd{padding:11px 12px 13px}" +
    ".lwe-dlg-lead{font-size:9pt;color:#3a4255;margin:0 0 9px}.lwe-dlg-lead b{color:#15243f}" +
    ".lwe-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}" +
    ".lwe-tile{position:relative;padding:0;border:2px solid #b9c2d4;cursor:pointer;background:#fff;line-height:0;overflow:hidden;border-radius:3px}" +
    ".lwe-tile img{width:100%;aspect-ratio:1;object-fit:cover;display:block}" +
    ".lwe-tile.on{border-color:#1f5fd0;box-shadow:0 0 0 2px rgba(31,95,208,.45)}" +
    ".lwe-tile.on::after{content:'✓';position:absolute;top:2px;right:4px;color:#fff;font-weight:bold;font-size:13px;text-shadow:0 0 3px #1f5fd0,0 1px 2px #000}" +
    ".lwe-dlg-foot{display:flex;align-items:center;gap:8px;margin-top:10px}" +
    ".lwe-dlg-foot .lwe-status{flex:1}" +
    // ── answer styling ──────────────────────────────────────────────────────
    ".lwe-badge{display:inline-block;font-size:7pt;font-weight:bold;letter-spacing:.03em;color:#6b4ec2;background:#ece5fb;border:1px solid #d0c3f0;border-radius:9px;padding:0 6px;margin-bottom:4px}" +
    ".lwe-cite{color:#6b4ec2;font-weight:bold}" +
    ".lwe-src{margin-top:6px}.lwe-src summary{cursor:pointer;font-size:8pt;color:#6b7280}" +
    ".lwe-src blockquote{margin:5px 0 3px;padding:5px 9px;border-left:3px solid #c3cbdb;background:#f7f9fc;font-size:8.5pt;color:#15243f}" +
    ".lwe-src a{font-size:8pt}";
  var st = D.createElement("style"); st.textContent = CSS; D.head.appendChild(st);

  compose.innerHTML =
    '<div class="lwe-ask">' +
      '<div class="lwe-row"><input class="lwe-q" type="text" maxlength="400" placeholder="ask ' + esc(BOT) + ' a follow-up…" disabled>' +
      '<button class="lwe-btn lwe-go" disabled>ask</button></div>' +
      '<div class="lwe-gate"><button class="lwe-btn lwe-verify">🚗 verify you&rsquo;re human to ask &mdash; click the cars</button></div>' +
      '<div class="lwe-status" role="status"></div>' +
    '</div>';
  var q = /** @type {HTMLTextAreaElement} */ (compose.querySelector(".lwe-q")),
      go = /** @type {HTMLButtonElement} */ (compose.querySelector(".lwe-go")),
      verifyBtn = /** @type {HTMLButtonElement} */ (compose.querySelector(".lwe-verify")),
      barStatus = compose.querySelector(".lwe-ask > .lwe-status");
  var askToken = null, askExp = 0;

  // the pop-out CAPTCHA dialog (built once, repopulated per challenge)
  var dlg = D.createElement("dialog");
  dlg.className = "lwe-dlg";
  dlg.innerHTML =
    '<form method="dialog" class="lwe-dlg-tt"><span class="ico" aria-hidden="true">🚗</span><span class="t">Verify you&rsquo;re human</span><button class="lwe-dlg-x" value="cancel" aria-label="close">✕</button></form>' +
    '<div class="lwe-dlg-bd">' +
      '<p class="lwe-dlg-lead">Click every photo with a <b>car</b>, then hit verify.</p>' +
      '<div class="lwe-tiles"></div>' +
      '<div class="lwe-dlg-foot"><div class="lwe-status" role="status"></div>' +
      '<button class="lwe-btn go lwe-submit" type="button">verify</button>' +
      '<button class="lwe-btn lwe-cancel" type="button">cancel</button></div>' +
    '</div>';
  D.body.appendChild(dlg);
  var tilesEl = /** @type {HTMLElement} */ (dlg.querySelector(".lwe-tiles")),
      dlgStatus = dlg.querySelector(".lwe-dlg-foot .lwe-status");
  dlg.querySelector(".lwe-cancel").addEventListener("click", function () { dlg.close(); });

  function setBar(s, cls) { barStatus.innerHTML = s || ""; barStatus.className = "lwe-status " + (cls || ""); }
  function setDlg(s, cls) { dlgStatus.innerHTML = s || ""; dlgStatus.className = "lwe-status " + (cls || ""); }
  function scrollLog() { var sc = D.querySelector(".window > .content"); if (sc) sc.scrollTop = sc.scrollHeight; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtAnswer(s) { return esc(s).replace(/\[(\d)\]/g, '<sup class="lwe-cite">[$1]</sup>').replace(/\n+/g, "<br>"); }

  function appendMsg(who, html) {
    var d = D.createElement("div"); d.className = "msg " + who;
    d.innerHTML = '<div class="pic" aria-hidden="true"></div><div style="min-width:0"><div class="who"><b>' +
      esc(who === "you" ? "you" : BOT) + '</b><time>now</time></div><div class="bubble">' + html + '</div></div>';
    log.appendChild(d); scrollLog(); return d;
  }

  // ── CAPTCHA (pop-out) ───────────────────────────────────────────────────────
  verifyBtn.addEventListener("click", loadChallenge);
  function loadChallenge() {
    setBar("loading photos…");
    fetch("/lwe/ask/challenge").then(function (r) { return r.json(); }).then(function (ch) {
      var sel = {};
      tilesEl.innerHTML = ch.stems.map(function (s, i) {
        return '<button type="button" class="lwe-tile" data-i="' + i + '"><img loading="lazy" decoding="async" src="/images/' + esc(s) + '.jpg" alt=""></button>';
      }).join("");
      setBar(""); setDlg("");
      tilesEl.onclick = function (e) {
        var t = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest(".lwe-tile")); if (!t) return;
        var i = t.dataset.i; if (sel[i]) { delete sel[i]; t.classList.remove("on"); } else { sel[i] = 1; t.classList.add("on"); }
      };
      /** @type {HTMLButtonElement} */ (dlg.querySelector(".lwe-submit")).onclick = function () {
        setDlg("checking…");
        fetch("/lwe/ask/verify", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ stems: ch.stems, exp: ch.exp, token: ch.token, selected: Object.keys(sel).map(Number) }) })
          .then(function (r) { return r.json(); }).then(function (v) {
            if (v.ok) { askToken = v.askToken; askExp = v.askExp; dlg.close(); q.disabled = false; go.disabled = false; q.focus(); setBar("verified ✓ — ask away", "ok"); }
            else if (v.expired) { setDlg("that set expired — fetching a fresh one…", "no"); loadChallenge(); }
            else { setDlg(esc(v.error || "not quite — try the fresh set"), "no"); loadChallenge(); }
          }).catch(function () { setDlg("network hiccup — try again", "no"); });
      };
  // Capability probe: <dialog> support, not a value off the wire.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    }).catch(function () { setBar("couldn&rsquo;t load the challenge", "no"); });
  }

  // ── ask ──────────────────────────────────────────────────────────────────
  go.addEventListener("click", doAsk);
  q.addEventListener("keydown", function (e) { if (e.key === "Enter") doAsk(); });
  function doAsk() {
    var question = q.value.trim(); if (question.length < 3) return;
    if (!askToken || Date.now() > askExp) { q.disabled = true; go.disabled = true; setBar("verify again to keep asking", "no"); loadChallenge(); return; }
    appendMsg("you", "<p>" + esc(question) + "</p>");
    q.value = ""; go.disabled = true;
    var pending = appendMsg("bot", '<span class="lwe-badge">live · AI-framed, grounded in the essay</span><p><em>…thinking</em></p>');
    fetch("/lwe/ask", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: question, concept: concept, askToken: askToken, askExp: askExp }) })
      .then(function (r) { return r.json(); }).then(function (a) {
        var html = '<span class="lwe-badge">live · AI-framed, grounded in the essay</span><p>' + fmtAnswer(a.answer || "") + "</p>";
        if (a.sources && a.sources.length) {
          html += '<details class="lwe-src"><summary>source passage' + (a.sources[0].score ? " (" + a.sources[0].score + ")" : "") + '</summary>' +
            '<blockquote>' + esc(a.sources[0].text) + '</blockquote>' +
            '<a href="' + esc(a.sources[0].url) + '" rel="external">' + esc(a.sources[0].title || "the essay") + '</a></details>';
        }
        pending.querySelector(".bubble").innerHTML = html;
        go.disabled = false; scrollLog();
      }).catch(function () { pending.querySelector(".bubble").innerHTML = '<p>(couldn&rsquo;t reach the bot — try again)</p>'; go.disabled = false; });
  }
})();
