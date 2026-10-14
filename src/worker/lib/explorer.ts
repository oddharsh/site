// lib/explorer.ts — the Explorer address bar and task pane, as markup.
//
// Node-safe on purpose (no `cloudflare:` import), because build.ts and
// contract-tests.mjs both import it under plain node. See gotcha 16.
import { Html, html } from "./html.ts";

export type Task = { href: string; label: string; glyph?: string };
export type Detail = { term: string; value: string };

export const PLACES = [
  { path: "/garage", label: "Garage" },
  { path: "/lwe", label: "Learning with Errors" },
  { path: "/writing", label: "Writing" },
  { path: "/reading", label: "Reading" },
  { path: "/serendipity", label: "Serendipity" },
  { path: "/around", label: "Around" },
  { path: "/lens", label: "The Other Web" },
  { path: "/pixel-peeper", label: "Pixel Peeper" },
  { path: "/dotfiles", label: "Dotfiles" },
  { path: "/rn", label: "Music" },
  { path: "/coffee", label: "Coffee" },
];

const PLACE_LABEL = new Map(PLACES.map((place) => [place.path, place.label]));

function trail(path: string): string[] {
  const parts = String(path || "/").split("?")[0].replace(/\/+$/, "").split("/").filter(Boolean);
  const out: string[] = [];
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

export function labelFor(path, fallback = "") {
  if (path === "/") return "aadhar.sh";
  return PLACE_LABEL.get(path) || fallback || path.replace(/^.*\//, "");
}

export function addressBar({ path = "/", name = "" }: { path?: string; name?: string } = {}): Html {
  const parts = trail(path);
  const crumbs: Html[] = [html`<a href="/">aadhar.sh</a>`];
  parts.forEach((step, index) => {
    const last = index === parts.length - 1;
    const text = last ? labelFor(step, name) : labelFor(step, step.replace(/^.*\//, ""));
    crumbs.push(html`<span class="axp-sep" aria-hidden="true">›</span>`);
    crumbs.push(last
      ? html`<span class="axp-here" aria-current="page">${text}</span>`
      : html`<a href="${step}">${text}</a>`);
  });
  return html`<div class="axp-address"><span class="axp-addr-label">Address</span><div class="axp-well"><span class="axp-addr-icon" aria-hidden="true"></span>${crumbs}</div></div>`;
}

function group(title: string, inner: Html): Html {
  return html`<section class="axp-group"><h2>${title}</h2>${inner}</section>`;
}

export function taskRow(item: Task): Html {
  return html`<li><span class="axp-glyph" aria-hidden="true">${item.glyph || "›"}</span><a href="${item.href}">${item.label}</a></li>`;
}

function taskList(items: Task[]): Html {
  return html`<ul>${items.map(taskRow)}</ul>`;
}

export function taskPane(
  { path = "/", name = "", tasks = [], details = [] }:
    { path?: string; name?: string; tasks?: Task[]; details?: Detail[] } = {},
): Html {
  const section = sectionOf(path);
  const parent = parentOf(path);
  const boxes: Html[] = [];

  const objectTasks = tasks.map((task) => ({ href: task.href, label: task.label, glyph: task.glyph || "≡" }));
  if (parent) objectTasks.push({ href: parent, label: `Up to ${labelFor(parent)}`, glyph: "↑" });
  if (objectTasks.length) boxes.push(group("Object tasks", taskList(objectTasks)));

  const places = PLACES.filter((place) => place.path !== section).slice(0, 6)
    .map((place) => ({ href: place.path, label: place.label, glyph: "■" }));
  if (places.length) boxes.push(group("Other places", taskList(places)));

  const rows: Detail[] = [];
  const here = name && name !== "aadhar.sh" ? name : "";
  if (here) rows.push({ term: "Name", value: here });
  rows.push({ term: "Location", value: `aadhar.sh${path === "/" ? "" : String(path).replace(/\/+$/, "")}` });
  for (const detail of details) if (detail && detail.value) rows.push(detail);
  boxes.push(group("Details", html`<dl>${rows.map((row) =>
    html`<dt>${row.term}</dt><dd>${row.value}</dd>`)}</dl>`));

  return html`<div class="axp-tasks"><aside class="axp-pane" aria-label="Explorer tasks">${boxes}</aside></div>`;
}

