// ── /dotfiles: the committed script is the page with everything ticked ───────
//
// The page renders its checklist from an inline data block and generates a
// script in the browser; public/dotfiles/macos.sh is the same data through the
// same renderer with every box ticked, committed so it can be curled. Two copies
// of one projection drift unless something diffs them, so this does. It also
// pins the shape of the data, because every failure on that page is silent: a
// malformed option renders as a missing row, never as an error.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { PAGE, SCRIPT, pageData, projectScript } from "./gen-dotfiles.ts";
import { renderScript, writeLine } from "../src/client/dotfiles.js";

const html = readFileSync(PAGE, "utf8");
const data = pageData(html);

test("public/dotfiles/macos.sh is the page's data with every option ticked", () => {
  const committed = readFileSync(SCRIPT, "utf8");
  assert.equal(committed, projectScript(html), "run `bun run gen:dotfiles` and commit the result");
});

test("every option is well-formed and says what has to restart", () => {
  const ids = new Set();
  const TYPES = new Set(["int", "float", "bool", "string"]);
  const RESTARTS = new Set(["Dock", "Finder", "SystemUIServer", "ControlCenter", "settings", "login"]);
  assert.ok(data.options.length >= 20, `only ${data.options.length} options; the list was 29 when this was written`);
  for (const o of data.options) {
    assert.ok(/^[a-z0-9-]+$/.test(o.id), `${o.id}: id`);
    assert.ok(!ids.has(o.id), `${o.id}: duplicate id`);
    ids.add(o.id);
    assert.ok(o.group && o.label, `${o.id}: group + label`);
    assert.ok(Array.isArray(o.restart), `${o.id}: restart is a list`);
    for (const r of o.restart) assert.ok(RESTARTS.has(r), `${o.id}: unknown restart ${r}`);
    const lines = (o.writes || []).length + (o.raw || []).length;
    assert.ok(lines > 0, `${o.id}: writes nothing`);
    for (const w of o.writes || []) {
      assert.ok(TYPES.has(w.type), `${o.id}: type ${w.type}`);
      assert.ok(w.domain && w.key, `${o.id}: domain + key`);
      const line = writeLine(w);
      assert.ok(line.startsWith("defaults "), line);
      assert.ok(!/[\n;&|]/.test(line), `${o.id}: shell metacharacter in ${line}`);
    }
    for (const r of o.raw || []) assert.ok(r.startsWith("defaults write "), `${o.id}: raw line is not a defaults write`);
  }
});

test("the personal rows stay out: no text replacements, nothing that names an account", () => {
  const keys = data.options.flatMap((o) => (o.writes || []).map((w) => w.key));
  assert.ok(!keys.includes("NSUserDictionaryReplacementItems"), "text replacements are personal (owner call, 2026-09-21)");
  assert.ok(!keys.some((k) => /^AKLast|^NSLinguistic|persistent-apps/.test(k)), "account or launch-state keys leaked in");
});

test("the group order survives into the script and the apply tail names every restart", () => {
  const script = projectScript(html);
  const groups = [...new Set(data.options.map((o) => o.group))];
  let at = -1;
  for (const g of groups) {
    const i = script.indexOf(`# ── ${g}`);
    assert.ok(i > at, `${g} missing or out of order`);
    at = i;
  }
  const restarts = new Set(data.options.flatMap((o) => o.restart));
  for (const p of ["Dock", "Finder", "SystemUIServer", "ControlCenter"]) {
    if (restarts.has(p)) assert.match(script, new RegExp(`^killall .*\\b${p}\\b`, "m"), `killall ${p}`);
  }
  if (restarts.has("login")) assert.match(script, /^echo 'log out and back in for the rest: /m);
  if (restarts.has("settings")) assert.match(script, /activateSettings -u$/m);
  // an empty pick is a script that says so, never an empty file
  assert.match(renderScript(data, new Set()), /nothing ticked/);
});
