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
// That is the AUTHORED form. The build moves the JSON into its own /a/ file and
// leaves the element empty with a data-src, and this script fetches the file
// as the reader nears the end of the page (see start() at the bottom).
//
// Option order is shuffled deterministically (seeded from the question text),
// so positions are stable across visits and balanced across questions without
// an "the answer is always C" tell. No-ops without a #luq-data block.
(() => {
  var D = document;
  var dataEl = D.getElementById("luq-data");
  if (!dataEl) return;
  // Filled in by start() once the payload is in hand. Every function below runs
  // only after that, so they read these through the closure as before.
  var data, skin, qs;
  // The served reference, or the authored inline JSON (see start()).
  var src = dataEl.getAttribute("data-src");
  var inline = dataEl.textContent || "";
  var storeKey = "luq:" + location.pathname.replace(/\.html$/, "");
  var best = 0;
  try { best = parseInt(localStorage.getItem(storeKey) || "0", 10) || 0; } catch (e) {}

  var CREDIT =
    'understanding check &middot; the idea is <a href="https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck" rel="external">Geoffrey Litt&rsquo;s</a>: ' +
    "reading feels like understanding until someone asks. questions are AI-drafted from this page, misses point back at it.";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // deterministic shuffle: seed an LCG from the question text so the option
  // order is stable per question but uncorrelated across questions.
  function seeded(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff; return h / 0x80000000; };
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
    var idx = 0, score = 0, results = [];
    mount.innerHTML =
      '<div class="luq-cap"><span aria-hidden="true">&#9997;</span>' + esc(data.title || "Before you close the hood") +
      '<span class="n">' + qs.length + " questions" + (best ? " &middot; best " + best + "/" + qs.length : "") + "</span></div>" +
      '<div class="luq-bd"></div>';
    var bd = mount.querySelector(".luq-bd");
    if (data.intro !== "") {
      var lead = D.createElement("p");
      lead.className = "luq-q luq-lead";
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
      html += '</div><div class="luq-fb" aria-live="polite"></div><div class="luq-row"><button type="button" class="xp-button luq-check" disabled>Check</button></div>';
      qwrap.innerHTML = html;
      var check = /** @type {HTMLButtonElement} */ (qwrap.querySelector(".luq-check")),
          fb = qwrap.querySelector(".luq-fb");
      qwrap.querySelector(".luq-opts").addEventListener("change", () => { check.disabled = false; });
      check.addEventListener("click", () => {
        var picked = /** @type {HTMLInputElement} */ (qwrap.querySelector("input:checked")); if (!picked) return;
        var pick = opts[+picked.value], hit = !!pick.ok;
        if (hit) score++;
        results.push({ q: q.q, hit: hit });
        qwrap.querySelector(".luq-opts").classList.add("luq-done");
        var inputs = qwrap.querySelectorAll("input");
        for (var i = 0; i < inputs.length; i++) {
          inputs[i].disabled = true;
          if (opts[i].ok) /** @type {HTMLElement} */ (inputs[i].parentNode).classList.add("hit");
          else if (inputs[i] === picked) /** @type {HTMLElement} */ (inputs[i].parentNode).classList.add("miss");
        }
        fb.innerHTML = '<p class="luq-why ' + (hit ? "hit" : "miss") + '"><b>' + (hit ? "Right." : "Close, and the miss is the useful part.") + "</b>" + esc(pick.why || "") + "</p>";
        /** @type {HTMLElement} */ (check.parentNode).innerHTML = '<button type="button" class="xp-button default luq-next">' + (idx + 1 < qs.length ? "Next &gt;" : "Finish") + "</button>";
        qwrap.querySelector(".luq-next").addEventListener("click", () => {
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
        '<div class="luq-row"><button type="button" class="xp-button luq-again">Retake</button></div>' +
        '<p class="luq-credit">' + CREDIT + "</p>";
      qwrap.querySelector(".luq-again").addEventListener("click", () => { idx = 0; score = 0; results = []; renderQ(); });
    }

    renderQ();
  }

  // ── lwe skin: the buddy pops a quiz in the conversation ───────────────────
  function lweSkin() {
    var log = D.querySelector(".log");
    if (!log) return;
    var BOT = (D.querySelector(".msgr-head .who b") || {}).textContent || "quiz";
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
      m.querySelector(".luq-opts").addEventListener("click", (e) => {
        var b = /** @type {HTMLButtonElement} */ (/** @type {Element} */ (e.target).closest(".luq-opt")); if (!b || b.disabled) return;
        var pick = opts[+b.dataset.i], hit = !!pick.ok;
        if (hit) score++;
        var btns = /** @type {NodeListOf<HTMLButtonElement>} */ (m.querySelectorAll(".luq-opt"));
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

  // The payload and the sheet load together, and only once the reader is near.
  //
  // The SERVED page carries an empty #luq-data whose data-src names
  // /a/quiz-<page>.<hash8>.json (build.ts step 5d); the authored page, which is
  // what `bun run dev` and the .src.html twin serve, still carries the JSON
  // inline. Either way the quiz renders only when both it and /quiz.css are in:
  // the sheet first so a quiz never paints unstyled, and a failed sheet still
  // renders, since an unstyled quiz that works beats one that never appears. A
  // failed payload renders nothing, which is the no-JS page.
  var started = false;
  function start() {
    if (started) return;
    started = true;
    var payload = src && !inline.trim()
      ? fetch(src).then((r) => (r.ok ? r.json() : null))
      : Promise.resolve().then(() => JSON.parse(inline));
    var styled = new Promise((done) => {
      // The build rewrites this href to the hashed /a/ sheet.
      var sheet = D.createElement("link");
      sheet.rel = "stylesheet";
      sheet.onload = done;
      sheet.onerror = done;
      sheet.href = "/quiz.css";
      D.head.appendChild(sheet);
    });
    Promise.all([payload, styled]).then((got) => {
      data = got[0];
      if (!data || !data.questions || !data.questions.length) return;
      skin = data.skin === "lwe" ? "lwe" : "garage";
      qs = data.questions;
      if (skin === "lwe") lweSkin(); else garageSkin();
    }, () => {});
  }

  // WHEN: once the quiz's position is within about a screen and a half of what
  // the reader can see, so it renders while still off screen. That matters for
  // layout shift as well as bytes: a shift only counts when the content that
  // moves is in the viewport, and rendering ahead of the reader moves nothing
  // they are looking at. A page short enough that the quiz is already that
  // close starts at once, since the first observation reports it intersecting.
  //
  // The sentinel is where the quiz will appear: the garage skin's #luq mount,
  // or the last message in the LWE chat, which the quiz continues.
  var sentinel = /** @type {Element | null} */ (D.getElementById("luq"));
  if (!sentinel) {
    var log = D.querySelector(".log");
    sentinel = log && (log.lastElementChild || log);
  }
  if (!sentinel || !("IntersectionObserver" in window)) { start(); return; }
  // The page never scrolls the viewport: luna.css makes .window > .content (or
  // body, on a windowless page) the scroller, and an implicit-root observer
  // clips the target to that box before rootMargin is applied, so the margin
  // would buy nothing. Observe against the nearest scroller instead, where the
  // margin extends the box the reader actually scrolls.
  var root = /** @type {Element | null} */ (null);
  for (var el = sentinel.parentElement; el && el !== D.documentElement; el = el.parentElement) {
    var oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") { root = el; break; }
  }
  var io = new IntersectionObserver((entries) => {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) { io.disconnect(); start(); return; }
    }
  }, { root: root, rootMargin: "150% 0px" });
  io.observe(sentinel);
})();
