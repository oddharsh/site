// lens-tools.js — the Tools lens pane, loaded on demand by lens.js.
//
// Standalone like lens-wire.js and lens-browser.js: it redeclares esc/section
// rather than importing them, because /lens ships no module graph and this file
// must be a single <script src> that can arrive late or never.
//
// The pane turns a foreign server's `tools/list` into a form per tool, the way a
// block explorer turns an ABI into one. What it will not do is call anything.
// The product is the exact JSON-RPC frame a call would carry, plus a curl the
// visitor can run themselves; the long argument for that lives at the top of
// _worker.js/lens-tools.js.
//
// THREE RULES decide every judgement call in the planner below.
//
//  1. Never lie about the schema. A control is emitted only when it carries the
//     whole constraint. Everything else degrades to a raw JSON box that states
//     WHY. Rendering `oneOf` as its first arm is worse than a textarea, because
//     the reader believes it.
//  2. Types survive the DOM. The DOM speaks only strings, so every control
//     returns the type the schema asked for and enum options carry the JSON
//     encoding of their real value. A form that sends "5" where the server was
//     promised 5 has misdescribed the call it is previewing.
//  3. Bounded and untrusting. Every string here came from a stranger's server,
//     so the form is built with createElement and textContent, never innerHTML,
//     and depth, property count and option count are all capped.
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

  // ── the planner: JSON Schema in, a description of controls out ────────────
  // Pure, and kept separate from the DOM on purpose: the same shape is unit
  // tested in contract-tests.mjs, where there is no document to render into.
  var PLAN_LIMITS = { depth: 3, properties: 60, options: 200, desc: 400 };
  var SCALARS = { string: 1, number: 1, integer: 1, boolean: 1 };

  function trim(value, max) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  // A schema may declare `type` as an array; ["string","null"] is the common
  // nullable idiom. Take the first non-null member and REPORT the rest, because
  // a union rendered as its first arm is exactly the silent lie rule 1 bans.
  function typeOf(schema) {
    var raw = schema.type;
    if (Object.prototype.toString.call(raw) === "[object Array]") {
      var real = raw.filter(function (t) { return t !== "null"; });
      return { type: real[0], nullable: raw.indexOf("null") >= 0, union: real.length > 1, all: real };
    }
    return { type: raw, nullable: false, union: false, all: raw ? [raw] : [] };
  }

  // Constraints a control cannot enforce by shape alone. These are RENDERED,
  // never merely enforced: a hidden rule is a rule the reader cannot check.
  function constraintsOf(schema) {
    var out = [];
    var pairs = [["minimum", "min"], ["maximum", "max"], ["exclusiveMinimum", ">"], ["exclusiveMaximum", "<"],
      ["multipleOf", "multiple of"], ["minLength", "min length"], ["maxLength", "max length"],
      ["minItems", "min items"], ["maxItems", "max items"], ["pattern", "pattern"],
      ["format", "format"], ["default", "default"]];
    for (var i = 0; i < pairs.length; i++) {
      if (schema[pairs[i][0]] !== undefined) out.push(pairs[i][1] + " " + JSON.stringify(schema[pairs[i][0]]));
    }
    if (schema.uniqueItems) out.push("unique items");
    return out;
  }

  function planField(name, schema, required, depth) {
    var base = { name: name, required: !!required, description: "", constraints: [] };
    if (!schema || typeof schema !== "object" || Object.prototype.toString.call(schema) === "[object Array]") {
      return { name: name, required: !!required, description: "", constraints: [], kind: "json", why: "no schema for this property" };
    }
    base.description = trim(schema.description, PLAN_LIMITS.desc);
    base.constraints = constraintsOf(schema);

    // Composition keywords describe a shape no single control has, and $ref is
    // the same problem one step removed: resolving it needs a document this
    // planner deliberately does not hold.
    var composite = ["oneOf", "anyOf", "allOf", "not", "if", "$ref"];
    for (var i = 0; i < composite.length; i++) {
      if (schema[composite[i]] !== undefined) { base.kind = "json"; base.why = "schema uses " + composite[i]; return base; }
    }
    if (schema.const !== undefined) { base.kind = "const"; base.value = schema.const; return base; }

    if (Object.prototype.toString.call(schema.enum) === "[object Array]") {
      var all = schema.enum;
      base.kind = "select";
      base.options = all.slice(0, PLAN_LIMITS.options).map(function (value) {
        return { value: value, label: typeof value === "string" ? value : JSON.stringify(value) };
      });
      base.truncated = all.length > base.options.length ? all.length - base.options.length : 0;
      return base;
    }

    var t = typeOf(schema);
    if (t.nullable) base.constraints.push("nullable");
    if (t.union) { base.kind = "json"; base.why = "type is a union (" + t.all.join(" | ") + ")"; return base; }

    if (t.type === "string") {
      base.kind = Number(schema.maxLength) > 160 ? "textarea" : "text";
      base.format = schema.format || null;
      return base;
    }
    if (t.type === "number" || t.type === "integer") {
      base.kind = "number"; base.integer = t.type === "integer";
      base.min = schema.minimum; base.max = schema.maximum;
      base.step = t.type === "integer" ? 1 : "any";
      return base;
    }
    if (t.type === "boolean") { base.kind = "checkbox"; return base; }

    if (t.type === "array") {
      var items = schema.items;
      if (!items || typeof items !== "object" || Object.prototype.toString.call(items) === "[object Array]") {
        base.kind = "json"; base.why = items ? "tuple-style items" : "array with no item schema"; return base;
      }
      if (Object.prototype.toString.call(items.enum) === "[object Array]") {
        base.kind = "multiselect";
        base.options = items.enum.slice(0, PLAN_LIMITS.options).map(function (value) {
          return { value: value, label: typeof value === "string" ? value : JSON.stringify(value) };
        });
        base.maxItems = schema.maxItems;
        return base;
      }
      var inner = typeOf(items);
      if (SCALARS[inner.type] && !inner.union) {
        base.kind = "list"; base.item = planField("item", items, true, depth + 1); base.maxItems = schema.maxItems; return base;
      }
      if (inner.type === "object" && items.properties) {
        if (depth + 1 > PLAN_LIMITS.depth) { base.kind = "json"; base.why = "nesting deeper than " + PLAN_LIMITS.depth + " levels"; return base; }
        var sub = planObject(items, depth + 1);
        base.kind = "table"; base.columns = sub.fields; base.maxItems = schema.maxItems; return base;
      }
      base.kind = "json"; base.why = "array items are not a shape this can model"; return base;
    }

    if (t.type === "object") {
      if (!schema.properties) { base.kind = "json"; base.why = "free-form object"; return base; }
      if (depth + 1 > PLAN_LIMITS.depth) { base.kind = "json"; base.why = "nesting deeper than " + PLAN_LIMITS.depth + " levels"; return base; }
      base.kind = "group"; base.fields = planObject(schema, depth + 1).fields; return base;
    }

    base.kind = "json";
    base.why = t.type ? 'unsupported type "' + t.type + '"' : "schema declares no type";
    return base;
  }

  function planObject(schema, depth) {
    var notes = [];
    var props = schema.properties || {};
    var required = {};
    var req = Object.prototype.toString.call(schema.required) === "[object Array]" ? schema.required : [];
    for (var r = 0; r < req.length; r++) required[req[r]] = true;
    var names = Object.keys(props);
    var kept = names.slice(0, PLAN_LIMITS.properties);
    if (names.length > kept.length) notes.push((names.length - kept.length) + " more properties not rendered");
    if (schema.additionalProperties === true) notes.push("additionalProperties is true: this tool accepts keys the schema does not name");
    var fields = kept.map(function (name) { return planField(name, props[name], required[name], depth); });
    return { fields: fields, notes: notes };
  }

  function planForm(inputSchema) {
    if (!inputSchema || typeof inputSchema !== "object") {
      return { fields: [], notes: ["this tool published no inputSchema, so its arguments are unconstrained"], freeform: true };
    }
    var t = typeOf(inputSchema);
    if (t.type && t.type !== "object") return { fields: [], notes: ['inputSchema is "' + t.type + '" rather than an object'], freeform: true };
    if (!inputSchema.properties) {
      var empty = inputSchema.type === "object";
      return { fields: [], notes: [empty ? "this tool takes no arguments" : "inputSchema names no properties"], freeform: !empty };
    }
    var out = planObject(inputSchema, 0);
    return { fields: out.fields, notes: out.notes, freeform: false };
  }

  function validate(plan, values) {
    var problems = [];
    function walk(fields, scope, path) {
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var value = scope ? scope[f.name] : undefined;
        var at = path ? path + "." + f.name : f.name;
        if (value === undefined || value === "") { if (f.required) problems.push({ at: at, why: "required" }); continue; }
        if (f.kind === "number") {
          if (typeof value !== "number") problems.push({ at: at, why: "not a number" });
          else {
            if (f.integer && Math.floor(value) !== value) problems.push({ at: at, why: "must be an integer" });
            if (f.min !== undefined && value < f.min) problems.push({ at: at, why: "below minimum " + f.min });
            if (f.max !== undefined && value > f.max) problems.push({ at: at, why: "above maximum " + f.max });
          }
        }
        if (f.maxItems !== undefined && value && value.length > f.maxItems) problems.push({ at: at, why: "more than " + f.maxItems + " items" });
        if (f.kind === "group" && value && typeof value === "object") walk(f.fields, value, at);
        if (f.kind === "table" && value && value.length) {
          for (var j = 0; j < value.length; j++) walk(f.columns, value[j], at + "[" + j + "]");
        }
        if (f.kind === "json" && value && value.__parseError) problems.push({ at: at, why: "invalid JSON: " + value.__parseError });
      }
    }
    walk(plan.fields, values, "");
    return problems;
  }

  function strip(value) {
    // A field whose JSON did not parse contributes NOTHING to the frame. The
    // problem list says why the key is absent; inventing a placeholder would put
    // a byte on the wire the real call would never carry.
    if (value && typeof value === "object" && value.__parseError) return undefined;
    if (Object.prototype.toString.call(value) === "[object Array]") {
      return value.map(strip).filter(function (v) { return v !== undefined; });
    }
    if (value && typeof value === "object") {
      var out = {}, keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        var clean = strip(value[keys[i]]);
        if (clean !== undefined && clean !== "") out[keys[i]] = clean;
      }
      return out;
    }
    return value;
  }

  // The stateless 2026-07-28 shape, matching what lib/doors.js sends for
  // tools/list: no initialize handshake, both required _meta keys, and
  // clientCapabilities empty because a form offers a server nothing.
  function buildFrame(toolName, values) {
    return {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: toolName,
        arguments: strip(values || {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
  }

  function shellQuote(text) { return "'" + String(text).replace(/'/g, "'\\''") + "'"; }
  function toCurl(endpoint, frame) {
    return "curl -sS " + shellQuote(endpoint) + " \\\n" +
      "  -H 'content-type: application/json' \\\n" +
      "  -H 'accept: application/json, text/event-stream' \\\n" +
      "  -H 'mcp-method: tools/call' -H " + shellQuote("mcp-name: " + frame.params.name) + " \\\n" +
      "  -d " + shellQuote(JSON.stringify(frame));
  }

  // ── the renderer: a plan in, DOM plus a read() closure out ────────────────
  var uid = 0;
  function mk(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function readNumber(raw, integer) {
    var text = String(raw).replace(/^\s+|\s+$/g, "");
    if (text === "") return undefined;
    var value = Number(text);
    if (!isFinite(value)) return { __parseError: "not a number" };
    return integer ? Math.trunc(value) : value;
  }

  function buildField(field, onChange) {
    var wrap = mk("div", "lx-tf");
    var row = mk("div", "lx-tf-head");
    var label = mk("label", "lx-tf-label");
    label.id = "lxt" + (++uid);
    label.appendChild(mk("span", "lx-tf-name", field.name));
    if (field.required) label.appendChild(mk("span", "lx-tf-req", "required"));
    // The kind badge is a SIBLING of the label. Inside it, the accessible name
    // of every control came out as "q required text".
    row.appendChild(label);
    row.appendChild(mk("span", "lx-tf-kind", field.kind));
    wrap.appendChild(row);
    if (field.description) wrap.appendChild(mk("div", "lx-tf-desc", field.description));
    if (field.constraints && field.constraints.length) wrap.appendChild(mk("div", "lx-tf-cons", field.constraints.join(" · ")));

    // A <label> with no `for` names nothing. Single-control fields get a real
    // association; composite ones get role=group plus aria-labelledby, since
    // there is no one control for `for` to point at.
    function name(control) {
      if (control) { control.id = "lxt" + (++uid); label.htmlFor = control.id; return control; }
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-labelledby", label.id);
      return null;
    }
    function bind(node, event) { node.addEventListener(event || "input", onChange); return node; }

    if (field.kind === "text" || field.kind === "textarea") {
      var input = mk(field.kind === "textarea" ? "textarea" : "input", "lx-tf-input");
      if (field.kind === "textarea") input.rows = 3;
      else input.type = field.format === "uri" ? "url" : field.format === "email" ? "email" : "text";
      wrap.appendChild(bind(name(input)));
      return { el: wrap, read: function () { return input.value.replace(/^\s+|\s+$/g, "") === "" ? undefined : input.value; } };
    }
    if (field.kind === "number") {
      var num = mk("input", "lx-tf-input");
      num.type = "number"; num.step = String(field.step);
      if (field.min !== undefined) num.min = String(field.min);
      if (field.max !== undefined) num.max = String(field.max);
      wrap.appendChild(bind(name(num)));
      return { el: wrap, read: function () { return readNumber(num.value, field.integer); } };
    }
    if (field.kind === "checkbox") {
      var cb = mk("input"); cb.type = "checkbox"; name(cb);
      var cbRow = mk("div", "lx-tf-check");
      var cbLabel = mk("label", null, "true"); cbLabel.htmlFor = cb.id;
      cbRow.appendChild(bind(cb, "change")); cbRow.appendChild(cbLabel);
      wrap.appendChild(cbRow);
      // An UNCHECKED optional boolean is ABSENT, not false. Sending false claims
      // the caller made a choice they never made.
      return { el: wrap, read: function () { return cb.checked ? true : field.required ? false : undefined; } };
    }
    if (field.kind === "select") {
      var sel = mk("select", "lx-tf-input");
      var blank = mk("option", null, field.required ? "— choose —" : "— omit —");
      blank.value = ""; sel.appendChild(blank);
      // Option values are the JSON ENCODING of the real value, so a numeric enum
      // survives the round trip as a number. An index would work and makes the
      // DOM opaque, which is the wrong trade on a pane whose claim is showing
      // exactly what would be sent.
      field.options.forEach(function (option) {
        var node = mk("option", null, option.label);
        var encoded = JSON.stringify(option.value);
        node.value = encoded === undefined ? "null" : encoded;
        sel.appendChild(node);
      });
      wrap.appendChild(bind(name(sel), "change"));
      if (field.truncated) wrap.appendChild(mk("div", "lx-tf-warn", field.truncated + " more options not shown"));
      return { el: wrap, read: function () { return sel.value === "" ? undefined : JSON.parse(sel.value); } };
    }
    if (field.kind === "multiselect") {
      name(null);
      var box = mk("div", "lx-tf-multi");
      var boxes = field.options.map(function (option) {
        var r = mk("label", "lx-tf-multi-row");
        var i = mk("input"); i.type = "checkbox";
        r.appendChild(bind(i, "change")); r.appendChild(mk("span", null, option.label));
        box.appendChild(r);
        return { input: i, value: option.value };
      });
      wrap.appendChild(box);
      return { el: wrap, read: function () {
        var picked = boxes.filter(function (b) { return b.input.checked; }).map(function (b) { return b.value; });
        return picked.length ? picked : undefined;
      } };
    }
    if (field.kind === "list" || field.kind === "table") {
      name(null);
      var rows = [];
      var body = mk("div", "lx-tf-rows");
      function addRow() {
        var rowEl = mk("div", "lx-tf-row");
        var inner = field.kind === "list"
          ? buildField({ name: field.name, kind: field.item.kind, required: true, constraints: [], description: "", options: field.item.options, integer: field.item.integer, step: field.item.step, min: field.item.min, max: field.item.max, format: field.item.format }, onChange)
          : buildGroup(field.columns, onChange);
        var kill = mk("button", "lx-tf-kill", "×");
        kill.type = "button"; kill.title = "remove this row";
        kill.setAttribute("aria-label", "remove this " + field.name + " row");
        kill.addEventListener("click", function () {
          for (var i = 0; i < rows.length; i++) if (rows[i].row === rowEl) { rows.splice(i, 1); break; }
          rowEl.parentNode.removeChild(rowEl);
          onChange();
        });
        rowEl.appendChild(inner.el); rowEl.appendChild(kill);
        body.appendChild(rowEl);
        rows.push({ row: rowEl, read: inner.read });
        onChange();
      }
      var add = mk("button", "lx-tf-add", "Add " + field.name.replace(/s$/, ""));
      add.type = "button";
      add.addEventListener("click", addRow);
      wrap.appendChild(body); wrap.appendChild(add);
      return { el: wrap, read: function () {
        var values = rows.map(function (r) { return r.read(); }).filter(function (v) { return v !== undefined; });
        return values.length ? values : undefined;
      } };
    }
    if (field.kind === "group") {
      name(null);
      var group = buildGroup(field.fields, onChange);
      var groupBox = mk("div", "lx-tf-group");
      groupBox.appendChild(group.el);
      wrap.appendChild(groupBox);
      return { el: wrap, read: group.read };
    }
    if (field.kind === "const") {
      name(null);
      wrap.appendChild(mk("div", "lx-tf-const", JSON.stringify(field.value)));
      return { el: wrap, read: function () { return field.value; } };
    }

    // json: the escape hatch, and it always states WHY it is one. This is the
    // honest failure of a schema-driven form, so it is styled to be noticed.
    name(null);
    wrap.appendChild(mk("div", "lx-tf-warn", "no control can carry this: " + field.why));
    var raw = mk("textarea", "lx-tf-input lx-tf-json"); raw.rows = 2; raw.placeholder = "raw JSON";
    wrap.appendChild(bind(name(raw)));
    return { el: wrap, read: function () {
      var text = raw.value.replace(/^\s+|\s+$/g, "");
      if (!text) return undefined;
      try { return JSON.parse(text); } catch (e) { return { __parseError: String(e.message).slice(0, 80) }; }
    } };
  }

  function buildGroup(fields, onChange) {
    var box = mk("div", "lx-tf-fields");
    var built = fields.map(function (field) {
      var node = buildField(field, onChange);
      box.appendChild(node.el);
      return { name: field.name, read: node.read };
    });
    return { el: box, read: function () {
      var out = {};
      for (var i = 0; i < built.length; i++) {
        var value = built[i].read();
        if (value !== undefined) out[built[i].name] = value;
      }
      return Object.keys(out).length ? out : undefined;
    } };
  }

  function renderForm(plan, onChange) {
    var root = mk("form", "lx-tf-form");
    root.addEventListener("submit", function (e) { e.preventDefault(); });
    (plan.notes || []).forEach(function (note) { root.appendChild(mk("div", "lx-tf-note", note)); });
    if (!plan.fields.length) {
      if (!plan.freeform) return { el: root, read: function () { return {}; } };
      var raw = mk("textarea", "lx-tf-input lx-tf-json");
      raw.rows = 3; raw.placeholder = "raw JSON arguments";
      raw.addEventListener("input", onChange);
      root.appendChild(raw);
      return { el: root, read: function () {
        var text = raw.value.replace(/^\s+|\s+$/g, "");
        if (!text) return {};
        try { return JSON.parse(text); } catch (e) { return { __parseError: String(e.message) }; }
      } };
    }
    var group = buildGroup(plan.fields, onChange);
    root.appendChild(group.el);
    return { el: root, read: function () { return group.read() || {}; } };
  }

  // ── the pane ──────────────────────────────────────────────────────────────
  var selected = null;

  function badges(tool) {
    var a = tool.annotations;
    if (!a) return '<span class="lx-badge">no annotations</span>';
    var out = "";
    if (a.readOnlyHint === true) out += '<span class="lx-badge ok">read-only</span>';
    if (a.readOnlyHint === false) out += '<span class="lx-badge bad">writes</span>';
    if (a.destructiveHint === true) out += '<span class="lx-badge bad">destructive</span>';
    if (a.idempotentHint === true) out += '<span class="lx-badge">idempotent</span>';
    if (a.openWorldHint === true) out += '<span class="lx-badge">open world</span>';
    return out || '<span class="lx-badge">no hints set</span>';
  }

  function intro(state) {
    if (!state) {
      return section("What it accepts", { text: "not run" },
        "Reads this origin's MCP catalogue and draws a form for every tool, from the argument schema the server publishes.",
        '<div class="lx-tools-intro"><b>An MCP tool list is an ABI.</b> A block explorer turns one into a form you can fill in, ' +
        'and <code>inputSchema</code> is the same artefact under another name. What a block explorer can also do, and this cannot, ' +
        'is simulate the call: a chain is a public state machine anyone can fork, while an MCP server is a private database behind ' +
        'an RPC. There is no dry run in the protocol. So this builds the frame and stops.</div>' +
        '<button class="lx-run-btn" id="lx-tools-run" type="button">Read the catalogue</button>');
    }
    if (state.pending) return section("What it accepts", { text: "reading" }, "Asking the origin for its tool list.", '<div class="lx-cap">Reading tools/list…</div>');
    if (!state.ok) {
      var why = state.unreadable
        ? "The probe never reached a server, so this says nothing about whether one is there."
        : "The origin answered, and the answer was not a tool list.";
      return section("What it accepts", { text: state.unreadable ? "unreadable" : "no catalogue", kind: "warn" }, why,
        '<div class="lx-tools-fail">' + esc(state.error || "no detail") + "</div>" +
        '<button class="lx-run-btn" id="lx-tools-run" type="button">Try again</button>');
    }
    return null;
  }

  function paneHtml(state) {
    var head = intro(state);
    if (head) return head;

    var rows = state.tools.map(function (tool) {
      var isOpen = tool.name === selected;
      var schemaNote = tool.schemaOversize
        ? '<span class="lx-badge warn">schema too large to carry</span>'
        : !tool.inputSchema ? '<span class="lx-badge">no schema</span>' : "";
      return '<div class="lx-tool' + (isOpen ? " is-open" : "") + '">' +
        '<button class="lx-tool-head" type="button" data-tool="' + esc(tool.name) + '" aria-expanded="' + (isOpen ? "true" : "false") + '">' +
        '<span class="lx-tool-name">' + esc(tool.name) + "</span>" + badges(tool) + schemaNote + "</button>" +
        (isOpen
          ? '<div class="lx-tool-body">' +
            (tool.description ? '<p class="lx-tool-desc">' + esc(tool.description) + "</p>" : "") +
            '<p class="lx-cap">Those badges are what the server says about itself. Nothing here verifies them.</p>' +
            '<div class="lx-tool-form" data-mount="' + esc(tool.name) + '"></div>' +
            '<div class="lx-tool-problems"></div>' +
            '<div class="lx-sec-h">What would be sent</div>' +
            '<pre class="lx-tool-frame"></pre>' +
            '<div class="lx-sec-h">curl</div>' +
            '<pre class="lx-tool-curl"></pre>' +
            '<button class="lx-tf-add lx-tool-copy" type="button">Copy curl</button>' +
            '<p class="lx-cap">Nothing is sent from this page. Run the curl yourself, against your own credentials.</p>' +
            "</div>"
          : "") + "</div>";
    }).join("");

    var caption = state.count + (state.count === 1 ? " tool" : " tools") +
      (state.shown < state.count ? ", " + state.shown + " shown" : "") +
      " · " + state.withSchema + " with an argument schema · " + esc(state.endpoint);
    return section("What it accepts", { text: state.count + " tools", kind: "ok" }, caption,
      '<div class="lx-tools-list">' + rows + "</div>");
  }

  window.LensTools = {
    run: function (targetUrl, onOk, onFail) {
      fetch("/lens/tools?url=" + encodeURIComponent(targetUrl), { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (json) { selected = json && json.ok && json.tools.length ? json.tools[0].name : null; onOk(json); })
        .catch(function () { onFail(); });
    },
    render: paneHtml,
    // Called after the pane's HTML lands, exactly like bindCounterfactuals. The
    // form itself is built here rather than in the string above, because these
    // controls carry foreign strings and must be created as nodes.
    bind: function (root, state, rerender) {
      var heads = root.querySelectorAll(".lx-tool-head");
      for (var i = 0; i < heads.length; i++) {
        heads[i].addEventListener("click", function () {
          var name = this.getAttribute("data-tool");
          selected = selected === name ? null : name;
          rerender();
        });
      }
      if (!state || !state.ok || !selected) return;
      var mount = root.querySelector('.lx-tool-form[data-mount="' + (window.CSS && CSS.escape ? CSS.escape(selected) : selected) + '"]');
      if (!mount) return;
      var tool = null;
      for (var t = 0; t < state.tools.length; t++) if (state.tools[t].name === selected) tool = state.tools[t];
      if (!tool) return;

      var body = mount.parentNode;
      var problems = body.querySelector(".lx-tool-problems");
      var framePre = body.querySelector(".lx-tool-frame");
      var curlPre = body.querySelector(".lx-tool-curl");
      var plan = planForm(tool.inputSchema);

      function update() {
        var values = form.read();
        var found = validate(plan, values);
        problems.replaceChildren();
        if (found.length) {
          var note = mk("div", "lx-tools-fail");
          note.appendChild(mk("b", null, found.length + (found.length === 1 ? " problem" : " problems")));
          var ul = mk("ul");
          found.forEach(function (p) { ul.appendChild(mk("li", null, p.at + ": " + p.why)); });
          note.appendChild(ul);
          problems.appendChild(note);
        }
        var frame = buildFrame(tool.name, values);
        framePre.textContent = JSON.stringify(frame, null, 2);
        curlPre.textContent = toCurl(state.endpoint, frame);
      }
      var form = renderForm(plan, update);
      mount.replaceChildren(form.el);
      update();

      var copy = body.querySelector(".lx-tool-copy");
      if (copy) copy.addEventListener("click", function () {
        var btn = this;
        navigator.clipboard.writeText(curlPre.textContent).then(function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy curl"; }, 1200);
        }, function () { btn.textContent = "Copy failed"; });
      });
    },
    // Exported for the contract tests, which exercise the planner with no DOM.
    _plan: planForm,
    _validate: validate,
    _frame: buildFrame,
  };
})();
