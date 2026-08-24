// ── Explorer chrome ──────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// ── Explorer chrome ──────────────────────────────────────────────────────────
// The address bar and task pane are markup, so the things worth pinning are the
// claims they make: that the pane's "Other places" is the site's own first-level
// list, and that nothing invents a row.
test("the task pane's places are the manifest's taskbar surfaces", async () => {
  const { PLACES } = await import("../src/worker/lib/explorer.ts");
  const manifest = JSON.parse(readFileSync("config/site-manifest.json", "utf8"));
  const pinned = manifest.surfaces.filter((s) => s.flags && s.flags.taskbar).map((s) => s.path).sort();
  assert.deepEqual(PLACES.map((p) => p.path).sort(), pinned,
    "lib/explorer.js PLACES drifted from site-manifest.json — the pane would list a section the taskbar does not, or miss one");
});

test("the pane states only what it was given", async () => {
  const { taskPane, addressBar } = await import("../src/worker/lib/explorer.ts");
  // A page with no tasks and no counted details gets the two rows that are true
  // of every object, and no Contains, Modified, or Status invented for it.
  const bare = taskPane({ path: "/garage/wire", name: "On the wire" });
  assert.match(bare, /<dt>Name<\/dt><dd>On the wire<\/dd>/);
  assert.match(bare, /<dt>Location<\/dt><dd>aadhar\.sh\/garage\/wire<\/dd>/);
  assert.doesNotMatch(bare, /Contains|Modified|Status/);
  // "Up to" is derived from the path, so a leaf offers its section and a section
  // offers the root.
  assert.match(bare, /href="\/garage">Up to Garage</);
  assert.match(taskPane({ path: "/garage" }), /href="\/">Up to aadhar\.sh</);
  // The current object is not a link to itself.
  const bar = addressBar({ path: "/garage/wire", name: "On the wire" });
  assert.match(bar, /<span aria-current="page" class="axp-here">On the wire<\/span>|<span class="axp-here" aria-current="page">On the wire<\/span>/);
  assert.match(bar, /<a href="\/garage">Garage<\/a>/);
  // Untrusted text is escaped, not interpolated.
  assert.match(taskPane({ path: "/garage/x", name: '<img src=x onerror=alert(1)>' }), /&lt;img src=x/);
});

// A twin may only be advertised where the build wrote one. The committed list is
// empty on purpose (dev serves a tree with no twins), so the guard is that the
// marker build.mjs rewrites is still there to be rewritten.
test("the twin list is generated, not committed", () => {
  const source = readFileSync("src/worker/lib/twins.ts", "utf8");
  assert.match(source, /^export const TWIN_PATHS = \[\]; \/\/ build:twins$/m,
    "lib/twins.js must ship empty with its build:twins marker — a committed list would advertise twins that 404 in dev");
});
