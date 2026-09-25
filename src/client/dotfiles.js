// dotfiles.js — the /dotfiles page: tick the macOS defaults you want, get the
// `defaults write` lines that set them, paste, restart what needs restarting.
//
// ONE renderer, two consumers. The browser calls renderScript() with whatever
// the visitor left ticked; tools/gen-dotfiles.ts imports this same module under
// bun and calls it with every option ticked to write public/dotfiles/macos.sh,
// the curl-able copy. The data lives in the page, in a
// <script type="application/json" id="dotfiles-data"> block, so the page needs
// no fetch and the generator reads the page rather than a second file. A
// contract test holds the committed .sh to the projection.
//
// Nothing here touches the DOM at import time. init() is exported and the page
// calls it from a two-line inline module, which is what lets a node-side tool
// import the renderer without a `typeof document` guard standing in for a
// contract.

/**
 * @typedef {{ domain: string, key: string, type: "int"|"float"|"bool"|"string", value: string|number|boolean, host?: "current" }} Write
 * @typedef {{ id: string, group: string, label: string, note?: string, was?: string, restart: string[], writes?: Write[], raw?: string[] }} Option
 * @typedef {{ options: Option[] }} Data
 */

// What each `restart` token costs the visitor, and the line that pays it. The
// killall processes are deduped into one line at the end of the script; the
// two that are not a process get a sentence, because a script cannot log you
// out on your behalf and should not try.
const KILLALL = new Set(["Dock", "Finder", "SystemUIServer", "ControlCenter"]);
const ACTIVATE = "/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u";

// A value as `defaults write` spells it. Strings are single-quoted; a literal
// single quote inside one is the POSIX '\'' dance, which nothing in the data
// needs today and the quoting handles anyway.
function shellValue(write) {
  const v = write.value;
  switch (write.type) {
    case "bool": return `-bool ${v ? "true" : "false"}`;
    case "int": return `-int ${Number(v)}`;
    case "float": return `-float ${Number(v)}`;
    default: return `-string '${String(v).replace(/'/g, "'\\''")}'`;
  }
}

/** One `defaults write` line. */
export function writeLine(write) {
  const host = write.host === "current" ? "-currentHost " : "";
  return `defaults ${host}write ${write.domain} ${write.key} ${shellValue(write)}`;
}

/**
 * The whole script for a set of ticked option ids. `picked` omitted means all,
 * which is the committed macos.sh.
 * @param {Data} data
 * @param {Set<string>|null} [picked]
 */
export function renderScript(data, picked = null) {
  const chosen = data.options.filter((o) => !picked || picked.has(o.id));
  const out = [
    "#!/usr/bin/env bash",
    "# macOS defaults from https://aadhar.sh/dotfiles",
    "# Generated from the checklist on that page. Each line below is one",
    "# `defaults write`; the tail restarts what has to restart to read it.",
    "set -euo pipefail",
    "",
  ];
  if (!chosen.length) {
    out.push("# nothing ticked, nothing to write", "");
    return out.join("\n");
  }
  /** @type {string|null} */
  let group = null;
  for (const o of chosen) {
    if (o.group !== group) {
      group = o.group;
      out.push(`# ── ${o.group} ${"─".repeat(Math.max(0, 60 - o.group.length))}`);
    }
    out.push(`# ${o.label}${o.was ? ` (factory: ${o.was})` : ""}`);
    if (o.note) out.push(`#   ${o.note}`);
    for (const w of o.writes || []) out.push(writeLine(w));
    for (const r of o.raw || []) out.push(r);
    out.push("");
  }
  const restarts = new Set(chosen.flatMap((o) => o.restart));
  const kills = [...KILLALL].filter((p) => restarts.has(p));
  out.push(`# ── apply ${"─".repeat(55)}`);
  if (kills.length) out.push(`killall ${kills.join(" ")} 2>/dev/null || true`);
  if (restarts.has("settings")) out.push(ACTIVATE);
  if (restarts.has("login")) {
    // Named by GROUP rather than by row: the sentence is a reminder, and a
    // 17-item list is one nobody reads.
    const who = [...new Set(chosen.filter((o) => o.restart.includes("login")).map((o) => o.group.toLowerCase()))];
    out.push(`echo 'log out and back in for the rest: ${who.join(", ")}'`);
  }
  out.push("");
  return out.join("\n");
}

/** Read the page's data block. Exported so the generator parses it the same way. */
export function parseData(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.options)) throw new Error("dotfiles-data: no options array");
  return /** @type {Data} */ (data);
}

// ── the page ────────────────────────────────────────────────────────────────

/** Build the checklist and wire the buttons. The page calls this once. */
export function init() {
  const block = document.getElementById("dotfiles-data");
  const list = document.getElementById("df-list");
  const out = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("df-out"));
  const count = document.getElementById("df-count");
  if (!block || !list || !out || !count) return;
  const data = parseData(block.textContent || "");

  // Build the tree: a bold group row, then one checkbox row per option. The
  // whole thing is createElement + textContent, though every string is ours;
  // the habit is cheaper than the exception.
  /** @type {string|null} */
  let group = null;
  for (const o of data.options) {
    if (o.group !== group) {
      group = o.group;
      const g = document.createElement("div");
      g.className = "df-group";
      g.textContent = group;
      list.append(g);
    }
    const row = document.createElement("label");
    row.className = "df-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.id = o.id;
    const text = document.createElement("span");
    text.className = "df-label";
    text.textContent = o.label;
    row.append(box, text);
    if (o.was) {
      const was = document.createElement("span");
      was.className = "df-was";
      was.textContent = `factory: ${o.was}`;
      row.append(was);
    }
    if (o.note) row.title = o.note;
    list.append(row);
  }

  const boxes = () => /** @type {HTMLInputElement[]} */ ([...list.querySelectorAll("input[type=checkbox]")]);
  const picked = () => new Set(boxes().filter((b) => b.checked).map((b) => b.dataset.id || ""));
  const render = () => {
    const set = picked();
    out.value = renderScript(data, set);
    count.textContent = `${set.size} of ${data.options.length} ticked`;
  };
  list.addEventListener("change", render);
  document.getElementById("df-all")?.addEventListener("click", () => { boxes().forEach((b) => { b.checked = true; }); render(); });
  document.getElementById("df-none")?.addEventListener("click", () => { boxes().forEach((b) => { b.checked = false; }); render(); });
  const copy = document.getElementById("df-copy");
  const copyOut = async () => {
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(out.value);
      copy.textContent = "Copied";
    } catch {
      out.select();
      copy.textContent = "Select + copy";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1600);
  };
  copy?.addEventListener("click", () => { void copyOut(); });
  render();
}
