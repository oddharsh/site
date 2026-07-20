// quiz.js — the "understanding check" widget for garage + LWE pages.
//
// Shared, deferred, minified at deploy (readable twin at /quiz.src.js).
// The idea is Geoffrey Litt's, from "Understanding is the new bottleneck"
// (geoffreylitt.com, 2026): reading is passive, so a page that wants to be
// understood should end by asking the reader to prove it. Five-ish questions,
// distractors drawn from real misconceptions, feedback on every option. The
// quiz is the exit criteria, never a gate: nothing locks, nothing is stored
// beyond a local best score.
//
// Two skins, chosen by the page's data block:
//   "garage" — an XP GroupBox self-test appended into #luq (radios, a raised
//              Check button, wizard-style Next, a scorecard at the end).
//   "lwe"    — the quiz continues the MSN conversation: the buddy asks in
//              .log, your pick posts as a "you" message, the buddy replies
//              with the verdict and the why.
//
// A page opts in with one inline JSON block + this script:
//   <script type="application/json" id="luq-data">{ "skin": "garage",
//     "questions": [ { "q": "…", "options": [
//       { "t": "…", "ok": true,  "why": "reinforce the right model" },
//       { "t": "…",             "why": "name the misconception" } ] } ] }</script>
//
// Option order is shuffled deterministically (seeded from the question text),
// so positions are stable across visits and balanced across questions without
// an "the answer is always C" tell. No-ops without a #luq-data block.
(function () {
  var D = document;
  var dataEl = D.getElementById("luq-data");
  if (!dataEl) return;
  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  if (!data || !data.questions || !data.questions.length) return;
  var skin = data.skin === "lwe" ? "lwe" : "garage";
  var qs = data.questions;
  var storeKey = "luq:" + location.pathname.replace(/\.html$/, "");
  var best = 0;
  try { best = parseInt(localStorage.getItem(storeKey) || "0", 10) || 0; } catch (e) {}

  var CREDIT =
    'understanding check &middot; the idea is <a href="https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck" rel="external">Geoffrey Litt&rsquo;s</a>: ' +
    "reading feels like understanding until someone asks. questions are AI-drafted from this page, misses point back at it.";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // deterministic shuffle: seed an LCG from the question text so the option
  // order is stable per question but uncorrelated across questions.
  function seeded(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff; return h / 0x80000000; };
  }
  function shuffled(q) {
    var rnd = seeded(q.q), a = q.options.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function saveBest(score) {
    if (score > best) { best = score; try { localStorage.setItem(storeKey, String(score)); } catch (e) {} }
  }

  // ── garage skin: XP GroupBox self-test ────────────────────────────────────
  function garageSkin() {
    var mount = D.getElementById("luq");
    if (!mount) return;
    var CSS =
      "#luq{margin:18px 0 6px;border:1px solid #92a0b8;border-radius:4px;background:#fdfdf8;box-shadow:inset 0 1px 0 #fff;font-family:var(--font-ui)}" +
      "#luq .luq-cap{display:flex;align-items:center;gap:7px;padding:5px 10px;font-family:var(--font-caption);font-weight:bold;font-size:10pt;color:#1d3a8a;background:linear-gradient(180deg,#f4f7fc,#dde7f6);border-bottom:1px solid #b9c8de;border-radius:3px 3px 0 0}" +
      "#luq .luq-cap .n{font-weight:normal;font-size:8.5pt;color:#5a6679;margin-left:auto;font-family:var(--font-ui)}" +
      "#luq .luq-bd{padding:11px 13px 13px}" +
      "#luq .luq-q{font-size:10pt;color:#15243f;margin:0 0 9px;font-weight:bold}" +
      "#luq .luq-opts{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}" +
      "#luq label.luq-opt{display:flex;gap:8px;align-items:baseline;font-size:9.5pt;color:#2a3346;cursor:pointer;padding:4px 7px;border:1px solid transparent;border-radius:3px}" +
      "#luq label.luq-opt:hover{background:#eef3fb;border-color:#c8d6ec}" +
      "#luq .luq-done label.luq-opt{cursor:default}#luq .luq-done label.luq-opt:hover{background:none;border-color:transparent}" +
      "#luq .luq-opt input{margin:0;flex:0 0 auto;position:relative;top:1px}" +
      "#luq .luq-opt.hit{background:#eaf6ec;border-color:#7fbb8a}#luq .luq-opt.miss{background:#fbeeee;border-color:#d89a9a}" +
      "#luq .luq-why{font-size:9pt;line-height:1.5;margin:0 0 10px;padding:7px 10px;border-radius:3px;border:1px solid}" +
      "#luq .luq-why.hit{color:#215c2b;background:#eaf6ec;border-color:#9ccba5}#luq .luq-why.miss{color:#7a2c2c;background:#fbeeee;border-color:#dcaaaa}" +
      "#luq .luq-why b{display:block;margin-bottom:2px}" +
      "#luq .luq-row{display:flex;align-items:center;gap:8px}" +
      "#luq .luq-btn{font-family:var(--font-ui);font-size:9.5pt;padding:3px 14px;cursor:pointer;color:#1a2030;background:linear-gradient(to bottom,#fff 0%,#e9edf5 100%);border:1px solid #7d8aa3;border-radius:3px;box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #b9c2d4}" +
      "#luq .luq-btn:hover{border-color:#3a71f5;background:linear-gradient(to bottom,#fff,#dce8fb)}" +
      "#luq .luq-btn:active{box-shadow:inset 1px 1px 0 #b9c2d4,inset -1px -1px 0 #fff}" +
      "#luq .luq-btn:disabled{color:#aab;background:linear-gradient(to bottom,#f3f3f3,#e6e6e6);border-color:#bbb;cursor:not-allowed;box-shadow:none}" +
      "#luq .luq-score{font-size:10pt;color:#15243f;margin:0 0 7px}#luq .luq-score b{font-size:13pt;color:#1d3a8a}" +
      "#luq .luq-list{margin:0 0 10px;padding-left:18px;font-size:9pt;color:#3a4255}#luq .luq-list li{margin:3px 0}" +
      "#luq .luq-list .ok{color:#2c7a36}#luq .luq-list .no{color:#c43636}" +
      "#luq .luq-credit{font-size:8pt;color:#8a93a5;border-top:1px solid #e2e8f3;margin-top:11px;padding-top:7px;line-height:1.5}" +
      "#luq .luq-credit a{color:#1a4fc4}";
    var st = D.createElement("style"); st.textContent = CSS; D.head.appendChild(st);

    var idx = 0, score = 0, results = [];
    mount.innerHTML =
      '<div class="luq-cap"><span aria-hidden="true">&#9997;</span>' + esc(data.title || "Before you close the hood") +
      '<span class="n">' + qs.length + " questions" + (best ? " &middot; best " + best + "/" + qs.length : "") + "</span></div>" +
      '<div class="luq-bd"></div>';
    var bd = mount.querySelector(".luq-bd");
    if (data.intro !== "") {
      var lead = D.createElement("p");
      lead.className = "luq-q"; lead.style.fontWeight = "normal"; lead.style.fontSize = "9.5pt"; lead.style.color = "#3a4255";
      lead.textContent = data.intro || "If the page did its job, this is quick. If it didn't, the misses will say which section to reopen.";
      bd.appendChild(lead);
    }
    var qwrap = D.createElement("div"); bd.appendChild(qwrap);

    function renderQ() {
      var q = qs[idx], opts = shuffled(q);
      var html = '<p class="luq-q">' + (idx + 1) + " of " + qs.length + " &middot; " + esc(q.q) + '</p><div class="luq-opts" role="radiogroup">';
      for (var i = 0; i < opts.length; i++) {
        html += '<label class="luq-opt"><input type="radio" name="luq-q' + idx + '" value="' + i + '"><span>' + esc(opts[i].t) + "</span></label>";
      }
      html += '</div><div class="luq-fb" aria-live="polite"></div><div class="luq-row"><button type="button" class="luq-btn luq-check" disabled>Check</button></div>';
      qwrap.innerHTML = html;
      var check = qwrap.querySelector(".luq-check"), fb = qwrap.querySelector(".luq-fb");
      qwrap.querySelector(".luq-opts").addEventListener("change", function () { check.disabled = false; });
      check.addEventListener("click", function () {
        var picked = qwrap.querySelector("input:checked"); if (!picked) return;
        var pick = opts[+picked.value], hit = !!pick.ok;
        if (hit) score++;
        results.push({ q: q.q, hit: hit });
        qwrap.querySelector(".luq-opts").classList.add("luq-done");
        var inputs = qwrap.querySelectorAll("input");
        for (var i = 0; i < inputs.length; i++) {
          inputs[i].disabled = true;
          if (opts[i].ok) inputs[i].parentNode.classList.add("hit");
          else if (inputs[i] === picked) inputs[i].parentNode.classList.add("miss");
        }
        fb.innerHTML = '<p class="luq-why ' + (hit ? "hit" : "miss") + '"><b>' + (hit ? "Right." : "Close, and the miss is the useful part.") + "</b>" + esc(pick.why || "") + "</p>";
        check.parentNode.innerHTML = '<button type="button" class="luq-btn luq-next">' + (idx + 1 < qs.length ? "Next &gt;" : "Finish") + "</button>";
        qwrap.querySelector(".luq-next").addEventListener("click", function () {
          idx++;
          if (idx < qs.length) renderQ(); else renderEnd();
        });
      });
    }

    function renderEnd() {
      saveBest(score);
      var list = "";
      for (var i = 0; i < results.length; i++) {
        list += '<li><span class="' + (results[i].hit ? "ok" : "no") + '">' + (results[i].hit ? "&#10003;" : "&#10007;") + "</span> " + esc(results[i].q) + "</li>";
      }
      var word = score === qs.length ? "Clean pass. The page can close." :
        score >= qs.length - 1 ? "Nearly clean. One section wants a second read." :
        "The misses above are the map: reopen those sections, the demos do not mind being re-run.";
      qwrap.innerHTML =
        '<p class="luq-score"><b>' + score + "/" + qs.length + "</b> &middot; " + esc(word) + "</p>" +
        '<ul class="luq-list">' + list + "</ul>" +
        '<div class="luq-row"><button type="button" class="luq-btn luq-again">Retake</button></div>' +
        '<p class="luq-credit">' + CREDIT + "</p>";
      qwrap.querySelector(".luq-again").addEventListener("click", function () { idx = 0; score = 0; results = []; renderQ(); });
    }

    renderQ();
  }

  // ── lwe skin: the buddy pops a quiz in the conversation ───────────────────
  function lweSkin() {
    var log = D.querySelector(".log");
    if (!log) return;
    var BOT = (D.querySelector(".msgr-head .who b") || {}).textContent || "quiz";
    var CSS =
      ".luq-opts{display:flex;flex-direction:column;gap:5px;margin-top:7px}" +
      ".luq-opt{font-family:var(--font-ui);font-size:9.5pt;text-align:left;padding:4px 10px;cursor:pointer;color:#1a2030;background:linear-gradient(to bottom,#fff,#e9edf5);border:1px solid #7d8aa3;border-radius:3px;box-shadow:inset 1px 1px 0 #fff}" +
      ".luq-opt:hover{border-color:var(--accent,#3a71f5);background:linear-gradient(to bottom,#fff,#e6efe8)}" +
      ".luq-opt:disabled{cursor:default;color:#9aa3b2;background:#f4f4f0;box-shadow:none}" +
      ".luq-opt.was-pick:disabled{color:#1a2030;border-color:var(--accent,#3a71f5)}" +
      ".luq-verdict b.hit{color:#2c7a36}.luq-verdict b.miss{color:#c43636}" +
      ".luq-credit{font-size:8pt;color:#8a93a5;margin-top:6px;line-height:1.5}.luq-credit a{color:#1a4fc4}";
    var st = D.createElement("style"); st.textContent = CSS; D.head.appendChild(st);

    var idx = 0, score = 0;
    function msg(who, html) {
      var d = D.createElement("div"); d.className = "msg " + who;
      d.innerHTML = '<div class="pic" aria-hidden="true"></div><div style="min-width:0"><div class="who"><b>' +
        esc(who === "you" ? "you" : BOT) + "</b><time>now</time></div>" + '<div class="bubble">' + html + "</div></div>";
      log.appendChild(d);
      return d;
    }

    msg("bot", "<p>" + esc(data.intro || "wait, before you close this window: pop quiz. " + qs.length + " questions, no stakes. reading feels like understanding until someone asks.") +
      (best ? " <em>(your best so far: " + best + "/" + qs.length + ")</em>" : "") + "</p>");

    function ask() {
      var q = qs[idx], opts = shuffled(q);
      var html = "<p>" + (idx + 1) + "/" + qs.length + " &middot; " + esc(q.q) + '</p><div class="luq-opts">';
      for (var i = 0; i < opts.length; i++) html += '<button type="button" class="luq-opt" data-i="' + i + '">' + esc(opts[i].t) + "</button>";
      html += "</div>";
      var m = msg("bot", html);
      m.querySelector(".luq-opts").addEventListener("click", function (e) {
        var b = e.target.closest(".luq-opt"); if (!b || b.disabled) return;
        var pick = opts[+b.dataset.i], hit = !!pick.ok;
        if (hit) score++;
        var btns = m.querySelectorAll(".luq-opt");
        for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
        b.classList.add("was-pick");
        msg("you", "<p>" + esc(pick.t) + "</p>");
        msg("bot", '<p class="luq-verdict"><b class="' + (hit ? "hit" : "miss") + '">' + (hit ? "yes." : "that one is the classic trap.") + "</b> " + esc(pick.why || "") + "</p>");
        idx++;
        if (idx < qs.length) ask(); else finish();
        // pin the chat to the newest message, same convention as ask.js —
        // only ever on a click, never on the initial page-load render
        var sc = D.querySelector(".window > .content"); if (sc) sc.scrollTop = sc.scrollHeight;
      });
    }

    function finish() {
      saveBest(score);
      var word = score === qs.length ? "full marks. you can close the window with a clear conscience." :
        "the ones you missed are pointing at a scroll-up: the demo above answers them better than I just did.";
      msg("bot", "<p><b>" + score + "/" + qs.length + "</b>. " + esc(word) + '</p><p class="luq-credit">' + CREDIT + "</p>");
    }

    ask();
  }

  if (skin === "lwe") lweSkin(); else garageSkin();
})();
