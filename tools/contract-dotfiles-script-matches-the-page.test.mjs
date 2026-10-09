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
  const RESTARTS = new Set(["Dock", "Finder", "SystemUIServer", "ControlCenter", "settings", "login", "relaunch"]);
  assert.ok(data.options.length >= 20, `only ${data.options.length} options; the list was 29 when this was written`);
  for (const o of data.options) {
    assert.ok(/^[a-z0-9-]+$/.test(o.id), `${o.id}: id`);
    assert.ok(!ids.has(o.id), `${o.id}: duplicate id`);
    ids.add(o.id);
    assert.ok(o.group && o.label, `${o.id}: group + label`);
    assert.ok(Array.isArray(o.restart), `${o.id}: restart is a list`);
    for (const r of o.restart) assert.ok(RESTARTS.has(r), `${o.id}: unknown restart ${r}`);
    assert.equal(o.restart.includes("relaunch"), Boolean(o.app), `${o.id}: relaunch and app come together`);
    const lines = (o.writes || []).length + (o.raw || []).length;
    assert.ok(lines > 0, `${o.id}: writes nothing`);
    for (const w of o.writes || []) {
      assert.ok(TYPES.has(w.type), `${o.id}: type ${w.type}`);
      assert.ok(w.domain && w.key, `${o.id}: domain + key`);
      const line = writeLine(w);
      assert.ok(line.startsWith("defaults "), line);
      assert.ok(!/[\n;&|]/.test(line), `${o.id}: shell metacharacter in ${line}`);
    }
    // A sudo row is root-only lines and nothing else; every other raw line is a
    // defaults write. The flag is what puts `sudo -v` at the top, so a row that
    // ran sudo without it would prompt halfway down the script.
    if (o.sudo) {
      assert.ok(!o.writes, `${o.id}: a sudo row carries raw lines only`);
      for (const r of o.raw || []) assert.ok(r.startsWith("sudo "), `${o.id}: sudo row line without sudo`);
    } else {
      for (const r of o.raw || []) assert.ok(r.startsWith("defaults write "), `${o.id}: raw line is not a defaults write`);
    }
    // Full Disk Access gates exactly one domain, and the guard has to follow it.
    const touchesA11y = [...(o.writes || []).map((w) => w.domain), ...(o.raw || [])].some((x) => /com\.apple\.universalaccess/.test(x));
    assert.equal(touchesA11y, Boolean(o.fullDiskAccess), `${o.id}: universalaccess writes need fullDiskAccess, and only they do`);
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

test("sudo asks once at the top, and a Terminal without Full Disk Access does not end the script", () => {
  const script = projectScript(html);
  const firstGroup = script.indexOf("# ── ");
  assert.ok(/^sudo -v$/m.test(script) && script.indexOf("sudo -v") < firstGroup, "sudo -v before the first write");
  const plain = new Set(data.options.filter((o) => !o.sudo).map((o) => o.id));
  assert.doesNotMatch(renderScript(data, plain), /\bsudo\b/, "no sudo rows ticked, no password prompt");
  // set -e ends the script on the first failed write, so every line of an
  // fda row must carry the guard and the tail must report it.
  for (const o of data.options.filter((x) => x.fullDiskAccess)) {
    const lines = renderScript(data, new Set([o.id])).split("\n").filter((l) => l.startsWith("defaults "));
    assert.ok(lines.length > 0 && lines.every((l) => l.endsWith(" || no_fda=1")), `${o.id}: unguarded write`);
  }
  assert.match(script, /^\[ -z "\$\{no_fda:-\}" \] \|\| echo /m, "the tail names the Full Disk Access miss");
  const apps = [...new Set(data.options.filter((o) => o.app).map((o) => o.app))];
  if (apps.length) assert.match(script, new RegExp(`^echo 'relaunch ${apps.join(", ")}'$`, "m"));
});
