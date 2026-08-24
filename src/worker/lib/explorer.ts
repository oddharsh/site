// lib/explorer.js — the Explorer address bar and task pane, as markup.
//
// Two devices, one builder, used from both sides of the site: build.mjs bakes
// them into every staged static page, and lunaPage() emits them for the
// Worker-rendered ones. Neither side owns a private copy, for the same reason
// lib/desktop.js exists — window chrome that changes in two places drifts.
//
// Node-safe on purpose (no `cloudflare:` import), because build.mjs and
// contract-tests.mjs both import it under plain node. See gotcha 16.
//
// THE HONESTY RULE IS THE DESIGN CONSTRAINT. Every row here is passed in by a
// caller that can see the thing it is describing, or derived from the URL. This
// module invents nothing: given no tasks and no details it renders the two rows
// it can always prove (where you are, and what is above you) and stops. A task
// pane that pads itself out with plausible links is worse than no task pane.
import { escAttr, escHtml } from "./http.ts";

// The first-level places, in taskbar order. Declared here rather than derived
// at runtime so the Worker carries no data file; build.mjs asserts this list
// against site-manifest.json's `taskbar` surfaces, so adding a section to the
// manifest and not to this list fails the build instead of quietly leaving the
// pane one place short.
export const PLACES = [
  { path: "/garage", label: "Garage" },
  { path: "/lwe", label: "Learning with Errors" },
  { path: "/writing", label: "Writing" },
  { path: "/reading", label: "Reading" },
  { path: "/serendipity", label: "Serendipity" },
  { path: "/around", label: "Around" },
  { path: "/lens", label: "The Other Web" },
  { path: "/terminal", label: "Terminal" },
  { path: "/pixel-peeper", label: "Pixel Peeper" },
  { path: "/rn", label: "Music" },
  { path: "/coffee", label: "Coffee" },
];

const PLACE_LABEL = new Map(PLACES.map((place) => [place.path, place.label]));

/** "/garage/encoding" -> ["/garage", "/garage/encoding"] */
function trail(path) {
  const parts = String(path || "/").split("?")[0].replace(/\/+$/, "").split("/").filter(Boolean);
  const out = [];
  let walked = "";
  for (const part of parts) { walked += `/${part}`; out.push(walked); }
  return out;
}

export function sectionOf(path) {
  const parts = trail(path);
  return parts.length ? parts[0] : "/";
}

export function parentOf(path) {
  const parts = trail(path);
  if (!parts.length) return null;
  return parts.length > 1 ? parts[parts.length - 2] : "/";
}

/** The display name for a path we know about, else the caller's fallback. */
export function labelFor(path, fallback = "") {
  if (path === "/") return "aadhar.sh";
  return PLACE_LABEL.get(path) || fallback || path.replace(/^.*\//, "");
}

/**
 * The address bar: the section icon, then the path as real links, with the
 * current object as plain text because you are already there.
 *
 * There is deliberately no Go button. Every segment here navigates, and a Go
 * that submitted nothing would be exactly the fabricated affordance the brand
 * rules forbid. Making the well a real editable address is the follow-up; /run
 * already exists to answer it.
 */
export function addressBar({ path = "/", name = "" } = {}) {
  const parts = trail(path);
  const crumbs = [`<a href="/">aadhar.sh</a>`];
  parts.forEach((step, index) => {
    const last = index === parts.length - 1;
    const text = escHtml(last ? labelFor(step, name) : labelFor(step, step.replace(/^.*\//, "")));
    crumbs.push(`<span class="axp-sep" aria-hidden="true">›</span>`);
    crumbs.push(last
      ? `<span class="axp-here" aria-current="page">${text}</span>`
      : `<a href="${escAttr(step)}">${text}</a>`);
  });
  return `<div class="axp-address"><span class="axp-addr-label">Address</span>`
    + `<div class="axp-well"><span class="axp-addr-icon" aria-hidden="true"></span>${crumbs.join("")}</div></div>`;
}

function group(title, inner) {
  return `<section class="axp-group"><h2>${escHtml(title)}</h2>${inner}</section>`;
}

function taskList(items) {
  const rows = items.map((item) => `<li><span class="axp-glyph" aria-hidden="true">${escHtml(item.glyph || "›")}</span>`
    + `<a href="${escAttr(item.href)}">${escHtml(item.label)}</a></li>`).join("");
  return `<ul>${rows}</ul>`;
}

/**
 * The task pane. `tasks` are this object's own actions (its other
 * representations, mostly) and `details` are facts the caller has counted.
 * Both are optional; what remains is true of every page.
 */
export function taskPane({ path = "/", name = "", tasks = [], details = [] } = {}) {
  const section = sectionOf(path);
  const parent = parentOf(path);
  const boxes = [];

  const objectTasks = tasks.map((task) => ({ href: task.href, label: task.label, glyph: task.glyph || "≡" }));
  if (parent) objectTasks.push({ href: parent, label: `Up to ${labelFor(parent)}`, glyph: "↑" });
  if (objectTasks.length) boxes.push(group("Object tasks", taskList(objectTasks)));

  const places = PLACES.filter((place) => place.path !== section).slice(0, 6)
    .map((place) => ({ href: place.path, label: place.label, glyph: "■" }));
  if (places.length) boxes.push(group("Other places", taskList(places)));

  const rows = [];
  const here = name && name !== "aadhar.sh" ? name : "";
  if (here) rows.push({ term: "Name", value: here });
  rows.push({ term: "Location", value: `aadhar.sh${path === "/" ? "" : String(path).replace(/\/+$/, "")}` });
  for (const detail of details) if (detail && detail.value) rows.push(detail);
  boxes.push(group("Details", `<dl>${rows.map((row) =>
    `<dt>${escHtml(row.term)}</dt><dd>${escHtml(row.value)}</dd>`).join("")}</dl>`));

  // A plain container, NOT a <details>. The disclosure was tried and removed:
  // `.axp-pane{display:flex}` is an author rule and beats the UA rule that hides
  // a closed details' content, so the pane rendered outside its 23px collapsed
  // box and painted straight over the article. luna.css already carries that
  // lesson for `.np-note[popover]`, whose comment inverts the same logic on
  // purpose. The wrapper stays explicit so luna.css can hide the whole piece of
  // secondary navigation at its narrow breakpoint instead of turning the rail
  // into a bottom strip that reads like page content.
  return `<div class="axp-tasks"><aside class="axp-pane" aria-label="Explorer tasks">${boxes.join("")}</aside></div>`;
}

