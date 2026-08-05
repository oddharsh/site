// terminal.js — the Windows PowerShell window at /terminal.
//
// The page server-renders one frame into the console as boot output, so the
// route is readable with JavaScript off and an agent fetching the HTML still
// gets content. This file turns that static scrollback into a shell you can
// type into: same endpoints, same frames, driven by hand instead of by curl.
//
// The premise of the whole surface is that a person should be able to FEEL what
// an agent gets. So the commands are not a toy vocabulary invented for a demo —
// `get` performs the same content negotiation an agent performs, `mcp` speaks
// real JSON-RPC to the real server, and the three programs are the same ones
// /mcp exposes as tools. Nothing here is simulated.
//
// PowerShell rather than cmd.exe on purpose: PowerShell 1.0 shipped FOR Windows
// XP in 2006, so the app is period-legal, and its dark blue console is the one
// piece of Microsoft chrome from that era that still reads as a terminal today.
(function () {
  "use strict";

  var root = document.querySelector("[data-ps-console]");
  if (!root) return;

  var out = root.querySelector(".ps-out");
  var form = root.querySelector(".ps-form");
  var input = root.querySelector(".ps-input");
  var promptEl = root.querySelector(".ps-prompt");
  if (!out || !form || !input || !promptEl) return;

  // The program currently on screen, if any. It decides what the arrow keys do
  // and what the prompt says, and it holds the query string that reproduces the
  // last frame — which is the same state the frame itself prints.
  var prog = null;
  var state = "";
  // The ask conversation this console is holding. Server-minted, carried across
  // asks so a follow-up continues rather than restarting. Cleared by `exit`.
  var askSession = "";
  var history = [];
  var histIndex = -1;

  // ── xterm-256 → rgb ──────────────────────────────────────────────────────
  // A general decoder rather than a lookup table of the dozen codes lib/tui.js
  // happens to emit today. The table would be smaller and would silently render
  // a new palette entry as unstyled text the day somebody adds one.
  function xterm(n) {
    if (n < 16) {
      var basic = ["000000", "800000", "008000", "808000", "000080", "800080", "008080", "c0c0c0",
        "808080", "ff0000", "00ff00", "ffff00", "0000ff", "ff00ff", "00ffff", "ffffff"];
      return "#" + basic[n];
    }
    if (n < 232) {
      var i = n - 16;
      var steps = [0, 95, 135, 175, 215, 255];
      var hex = function (v) { return (v < 16 ? "0" : "") + v.toString(16); };
      return "#" + hex(steps[Math.floor(i / 36) % 6]) + hex(steps[Math.floor(i / 6) % 6]) + hex(steps[i % 6]);
    }
    var g = 8 + (n - 232) * 10;
    var gh = (g < 16 ? "0" : "") + g.toString(16);
    return "#" + gh + gh + gh;
  }

  // ── ANSI → DOM ───────────────────────────────────────────────────────────
  // Built with createTextNode and style properties, never innerHTML. The frames
  // render photo captions, page titles, and — through `lens` and `get` — the
  // title of an arbitrary third-party URL. Any of those can contain markup, and
  // an HTML sink here would turn a remote page's <title> into script on this
  // origin. The escaping is structural rather than a call somebody can forget.
  function ansi(text) {
    var frag = document.createDocumentFragment();
    var style = {};
    var parts = String(text).split(/\x1b\[([0-9;]*)m/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var codes = parts[i].split(";").map(Number);
        for (var c = 0; c < codes.length; c++) {
          var code = codes[c];
          if (code === 0) style = {};
          else if (code === 1) style.bold = true;
          else if (code === 2) style.dim = true;
          else if (code === 38 && codes[c + 1] === 5) { style.fg = xterm(codes[c + 2]); c += 2; }
          else if (code === 48 && codes[c + 1] === 5) { style.bg = xterm(codes[c + 2]); c += 2; }
        }
        continue;
      }
      if (!parts[i]) continue;
      var span = document.createElement("span");
      span.appendChild(document.createTextNode(parts[i]));
      if (style.fg) span.style.color = style.fg;
      if (style.bg) span.style.background = style.bg;
      if (style.bold) span.style.fontWeight = "bold";
      if (style.dim) span.style.opacity = ".65";
      frag.appendChild(span);
    }
    return frag;
  }

  function write(text, cls) {
    var line = document.createElement("div");
    line.className = "ps-line" + (cls ? " " + cls : "");
    line.appendChild(ansi(text));
    out.appendChild(line);
    return line;
  }

  function echo(command) {
    var line = document.createElement("div");
    line.className = "ps-line ps-echo";
    var p = document.createElement("span");
    p.className = "ps-prompt";
    p.textContent = promptText();
    line.appendChild(p);
    line.appendChild(document.createTextNode(command));
    out.appendChild(line);
  }

  function promptText() { return "PS aadhar.sh\\" + (prog || "") + "> "; }

  function setPrompt() {
    promptEl.textContent = promptText();
    input.setAttribute("aria-label", promptText().trim() + " command");
  }

  function scroll() { root.scrollTop = root.scrollHeight; }

  // ── the site, as an agent sees it ────────────────────────────────────────
  async function ask(path, accept) {
    var res = await fetch(path, { headers: accept ? { accept: accept } : {} });
    return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
  }

  // Run one of the three programs and keep the state its frame prints, so the
  // next keypress continues from where the last frame left off.
  async function runProgram(name, query) {
    var path = "/terminal/" + name + (query ? (query[0] === "?" ? query : "?" + query) : "");
    var r = await ask(path);
    if (r.status !== 200) { write("the program did not answer (" + r.status + ")", "ps-err"); return; }
    write(r.body.replace(/\n+$/, ""));
    prog = name;
    // The frame prints its own state, labelled. Reading it back is what makes a
    // keypress CONTINUE the session rather than restart it, and it means the
    // client never has to model the programs' state itself.
    //
    // Match against the DE-ESCAPED body. The frame arrives coloured, so the
    // label and the URL are separated by two SGR sequences ("state " closes its
    // span, the URL opens its own) and a regex over the raw bytes never matches.
    // It fails silently in the worst way available: every keypress rebuilds the
    // program from its default state, which still renders a perfectly good frame
    // — just always the first one.
    var plain = r.body.replace(/\x1b\[[0-9;]*m/g, "");
    var printed = plain.match(/state \/terminal\/[a-z]+(\?[A-Za-z0-9_%=&.,+\-]*)/);
    state = printed ? printed[1] : "";
    // The ask frame prints the full session id in its state URL; keep it so the
    // next question continues the same transcript.
    var sess = plain.match(/session=([A-Za-z0-9-]{8,})/);
    if (sess) askSession = sess[1];
    setPrompt();
  }

  async function drive(keys) {
    if (!prog) return;
    var sep = state ? state + "&" : "?";
    await runProgram(prog, sep + "keys=" + encodeURIComponent(keys));
  }

  // ── commands ─────────────────────────────────────────────────────────────
  var HELP = [
    "",
    "  The three programs — each one is also an MCP tool at /mcp.",
    "    finger [pane]         who runs this host. panes: overview writing reading",
    "                          listening photos around coffee deploys search",
    "    photos [-film X] [-q Y]   the photo archive",
    "    lens <url>            how a public URL reads to a machine",
    "",
    "  Driving a program — arrow keys, or:",
    "    keys <sequence>       e.g. keys 2jj<cr>   (1-9 pane, j/k move, <cr> open, h back)",
    "",
    "  Just type a question. Anything that is not a command below is an ask:",
    "    ask <question>        plain language -> real tool calls -> an answer,",
    "                          with every call it made printed above the answer",
    "",
    "  Pointing it at somebody else's site — the same doors, from the outside:",
    "    doors <origin>        what is behind their agent doors: llms.txt, a",
    "                          markdown twin, an agent card, a real MCP tools/list",
    "    ask --at <origin> <q> the same read, with a model answering from it.",
    "                          Their text is untrusted, so that turn gets NO tools",
    "",
    "  Being the agent — these are the real requests, not a demo.",
    "    get <path>            fetch a page as an agent does (Accept: text/markdown)",
    "    mcp                   list the MCP tools this origin serves",
    "    mcp <tool> [json]     call one, e.g. mcp search_site {\"q\":\"lattice\"}",
    "    ls                    the public surfaces listed for agents",
    "",
    "    cls                   clear    ·    exit    close    ·    help    this",
    "",
  ];

  // A command line splits on whitespace outside quotes, so a JSON argument or a
  // quoted filter survives intact. PowerShell-ish `-flag value` pairs.
  function argv(line) {
    var m = line.match(/"[^"]*"|\S+/g) || [];
    return m.map(function (a) { return a.replace(/^"|"$/g, ""); });
  }

  var COMMANDS = {
    help: function () { HELP.forEach(function (l) { write(l); }); },
    "?": function () { COMMANDS.help(); },
    cls: function () { out.textContent = ""; },
    clear: function () { out.textContent = ""; },
    exit: function () {
      prog = null; state = ""; askSession = "";
      write("");
      write("  Session closed. The ask transcript is dropped; nothing else was stored.");
      write("");
    },

    finger: function (args) {
      var pane = args[0] ? "pane=" + encodeURIComponent(args[0]) : "";
      var q = args.indexOf("-q") >= 0 ? "&q=" + encodeURIComponent(args[args.indexOf("-q") + 1] || "") : "";
      return runProgram("finger", pane + q);
    },

    photos: function (args) {
      var query = [];
      for (var i = 0; i < args.length; i++) {
        var flag = args[i].replace(/^-+/, "");
        if (["film", "camera", "lens", "q"].indexOf(flag) >= 0 && args[i + 1]) {
          query.push(flag + "=" + encodeURIComponent(args[++i]));
        }
      }
      return runProgram("photos", query.join("&"));
    },

    lens: function (args) {
      if (!args[0]) { write("usage: lens <url>", "ps-err"); return; }
      return runProgram("lens", "url=" + encodeURIComponent(args[0]));
    },

    // Plain language in. This is also what an unrecognised line falls through
    // to, so the console reads as something you talk to rather than something
    // you have to know the verbs for.
    ask: function (args) {
      // `--at <origin>` points the whole thing at somebody else's site: the same
      // doors, read the same way, from the outside.
      var at = "";
      var rest = [];
      for (var i = 0; i < args.length; i++) {
        if ((args[i] === "--at" || args[i] === "-at") && args[i + 1]) { at = args[++i]; continue; }
        rest.push(args[i]);
      }
      var q = rest.join(" ").trim();
      if (!q && !at) { write("usage: ask <question>   ·   ask --at <origin> [question]", "ps-err"); return; }
      var parts = [];
      if (q) parts.push("q=" + encodeURIComponent(q));
      if (at) parts.push("at=" + encodeURIComponent(at));
      if (askSession) parts.push("session=" + encodeURIComponent(askSession));
      return runProgram("ask", parts.join("&"));
    },

    // Read another origin's agent doors and stop. `ask --at X <question>` is the
    // same read with a model on the end of it.
    doors: function (args) {
      if (!args[0]) { write("usage: doors <origin>   e.g. doors https://anthropic.com", "ps-err"); return; }
      return runProgram("ask", "at=" + encodeURIComponent(args[0]));
    },

    keys: function (args) {
      if (!prog) { write("no program is running — try `finger`", "ps-err"); return; }
      return drive(args.join(" "));
    },

    get: async function (args) {
      if (!args[0]) { write("usage: get <path>   e.g. get /whoareyou", "ps-err"); return; }
      // Same-origin only. `get` exists to show what THIS site hands an agent;
      // pointing it at another host would make the console an open proxy, and
      // /lens is the surface that inspects other hosts (with SSRF guards, a rate
      // limit, and an honest user-agent, none of which a fetch from here has).
      var path = args[0][0] === "/" ? args[0] : "/" + args[0];
      var r = await ask(path, "text/markdown");
      write("");
      write("  " + r.status + "  " + r.type.split(";")[0]);
      write("");
      // Bounded: a page's markdown twin can run to tens of KB and a console that
      // pastes all of it is unreadable and unscrollable.
      var body = r.body.length > 4000 ? r.body.slice(0, 4000) + "\n\n  … truncated. the whole thing is at " + path : r.body;
      body.split("\n").forEach(function (l) { write(l); });
      write("");
    },

    ls: async function () {
      var r = await fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }),
      });
      var payload = await r.json();
      var list = (payload.result && payload.result.resources) || [];
      write("");
      list.forEach(function (item) {
        write("  " + item.name + new Array(Math.max(2, 22 - item.name.length)).join(" ") + (item.title || ""));
      });
      write("");
      write("  " + list.length + " surfaces listed for agents. `get <path>` reads one.");
      write("");
    },

    mcp: async function (args) {
      var body = args.length
        ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: args[0], arguments: parseJson(args.slice(1).join(" ")) } }
        : { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      var r = await fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var payload = await r.json();
      write("");
      if (payload.error) { write("  " + payload.error.code + "  " + payload.error.message, "ps-err"); write(""); return; }
      if (!args.length) {
        (payload.result.tools || []).forEach(function (tool) {
          write("  " + tool.name);
          wrapText(tool.description, 68).forEach(function (l) { write("      " + l, "ps-dim"); });
        });
        write("");
        write("  call one:  mcp search_site {\"q\":\"lattice\"}");
        write("");
        return;
      }
      // A frame-returning tool renders as the frame; everything else as JSON.
      var structured = payload.result.structuredContent;
      if (structured && structured.frame) write(structured.frame);
      else JSON.stringify(structured || payload.result, null, 2).split("\n").forEach(function (l) { write("  " + l); });
      write("");
    },
  };

  function parseJson(text) {
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch (e) { return {}; }
  }

  function wrapText(text, width) {
    var words = String(text || "").split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = "";
    words.forEach(function (word) {
      if (!cur) { cur = word; return; }
      if (cur.length + 1 + word.length <= width) { cur += " " + word; return; }
      lines.push(cur); cur = word;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  async function run(line) {
    var args = argv(line.trim());
    if (!args.length) return;
    var name = args[0].toLowerCase();
    var command = COMMANDS[name];
    // An unrecognised line is a QUESTION, not an error. PowerShell would tell
    // you the term is not recognized, and that is the right behaviour for a
    // shell whose whole vocabulary is verbs -- but this console's point is that
    // you can throw plain language at the site, so the fallthrough is `ask`
    // rather than a scolding. The frame it prints names every tool the ask
    // touched, so a typo is legible as a typo instead of vanishing.
    if (!command) return COMMANDS.ask(args);
    try {
      await command(args.slice(1));
    } catch (e) {
      write("  the command failed: " + (e && e.message ? e.message : e), "ps-err");
    }
  }

  // ── input ────────────────────────────────────────────────────────────────
  async function submitLine() {
    var line = input.value;
    input.value = "";
    echo(line);
    if (line.trim()) { history.push(line); histIndex = history.length; }
    await run(line);
    setPrompt();
    scroll();
  }

  // The form is here for semantics and for the no-JS story, but Enter is handled
  // in keydown rather than left to implicit submission. Two reasons, and the
  // first one is not theoretical — it did not fire: implicit submission is a
  // narrow rule (a form with no submit button submits only under an exact-field
  // count condition), and it is not worth resting the console's only input path
  // on. The second is that Enter already has a second job here, sending <cr> to
  // a running program, so it needed a branch regardless.
  form.addEventListener("submit", function (event) { event.preventDefault(); submitLine(); });

  input.addEventListener("keydown", function (event) {
    // Arrow keys drive the program on screen, because reaching for them is what
    // a person does in front of a TUI. With no program up they are shell history
    // instead, which is what a person does in front of a prompt. Ctrl+P/Ctrl+N
    // are history either way, so the binding is never actually lost.
    var driving = prog && !event.ctrlKey && !event.metaKey;
    var map = { ArrowDown: "j", ArrowUp: "k", ArrowLeft: "h", ArrowRight: "l", Escape: "<esc>" };
    if (driving && map[event.key] && !(event.key === "ArrowLeft" || event.key === "ArrowRight") ) {
      event.preventDefault();
      drive(map[event.key]).then(scroll);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // An empty line in front of a running program is Enter-the-key, which the
      // program reads as "open the row under the cursor". A line with text in it
      // is Enter-the-command, always.
      if (driving && !input.value) drive("<cr>").then(scroll);
      else submitLine();
      return;
    }
    var wantsHistory = (event.ctrlKey && (event.key === "p" || event.key === "n"))
      || (!prog && (event.key === "ArrowUp" || event.key === "ArrowDown"));
    if (wantsHistory) {
      event.preventDefault();
      var back = event.key === "ArrowUp" || event.key === "p";
      histIndex = Math.max(0, Math.min(history.length, histIndex + (back ? -1 : 1)));
      input.value = history[histIndex] || "";
      return;
    }
    if (event.ctrlKey && event.key === "l") { event.preventDefault(); out.textContent = ""; }
  });

  // Clicking anywhere in the console focuses the line, the way a terminal does.
  // A click that is selecting text is left alone.
  root.addEventListener("click", function () {
    if (!String(window.getSelection() || "")) input.focus();
  });

  // Boot. The server already rendered a frame into the scrollback, so this only
  // adds the prompt and says what to type — no reflow of what is already there.
  setPrompt();
  form.hidden = false;
  write("");
  write("  Type `help` for commands. Every one of them makes the same request an");
  write("  agent would — the same frames answer `curl` and the MCP server at /mcp.");
  write("");
  scroll();
})();
