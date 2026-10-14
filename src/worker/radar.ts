// radar.ts — the instrument half of a signal radar.

import { COLS, SPARK, blank, fit, kv, rightTo, rows, rule, s, wrap } from "./lib/tui.ts";

const INNER = COLS - 4;

export const RADAR_LIMITS = {
  samples: 40,
  name: 48,
  history: 32,
};

export const BANDS = [
  { max: -45, label: "arm's reach", style: "ok" },
  { max: -60, label: "same table", style: "ok" },
  { max: -72, label: "same room", style: "warn" },
  { max: -85, label: "next room", style: "warn" },
  { max: -200, label: "far / noise", style: "bad" },
];

export const bandOf = (rssi) => BANDS.find((band) => rssi >= band.max) || BANDS[BANDS.length - 1];

export const radius = (rssi) => Math.max(0, Math.min(1, (Math.abs(rssi) - 30) / 60));

function angleOf(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return (hash % 3600) / 3600 * Math.PI * 2;
}

const MARKERS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function readSamples(payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.samples) ? payload.samples : [];
  const out = [];
  for (const item of raw) {
    const rssi = Number(item?.rssi);
    if (!Number.isFinite(rssi) || rssi > 0 || rssi < -200) continue;
    out.push({
      name: String(item?.name ?? "unknown").slice(0, RADAR_LIMITS.name),
      rssi: Math.round(rssi),
      kind: String(item?.kind ?? "").slice(0, 12).toLowerCase(),
      history: (Array.isArray(item?.history) ? item.history : [])
        .map(Number).filter((n) => Number.isFinite(n) && n <= 0 && n >= -200)
        .slice(-RADAR_LIMITS.history),
    });
    if (out.length >= RADAR_LIMITS.samples) break;
  }
  return out.sort((a, b) => b.rssi - a.rssi);
}

function sparkline(history) {
  if (history.length < 2) return "";
  const lo = Math.min(...history), hi = Math.max(...history);
  const span = hi - lo || 1;
  return history.slice(-16).map((v) => SPARK[Math.round(((v - lo) / span) * (SPARK.length - 1))]).join("");
}

export function ringPlot(samples, { height = 17 } = {}) {
  const cy = Math.floor(height / 2);
  const ry = cy - 1;
  // Terminal cells are about twice as tall as they are wide, so the x radius has
  // to be doubled or every ring reads as an ellipse.
  const rx = ry * 2;
  const width = rx * 2 + 1;
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));

  for (const band of BANDS.slice(0, 4)) {
    const r = radius(band.max);
    for (let deg = 0; deg < 360; deg += 3) {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(rx + Math.cos(rad) * rx * r);
      const y = Math.round(cy + Math.sin(rad) * ry * r);
      if (y >= 0 && y < height && x >= 0 && x < width && grid[y][x] === " ") grid[y][x] = "·";
    }
  }
  grid[cy][rx] = "+";

  const placed = [];
  samples.forEach((sample, i) => {
    if (i >= MARKERS.length) return;
    const r = radius(sample.rssi);
    const angle = angleOf(sample.name);
    let x = Math.round(rx + Math.cos(angle) * rx * r);
    let y = Math.round(cy + Math.sin(angle) * ry * r);
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));
    let guard = 0;
    while (grid[y][x] !== " " && grid[y][x] !== "·" && guard < width) { x = (x + 1) % width; guard += 1; }
    grid[y][x] = MARKERS[i];
    placed.push({ ...sample, marker: MARKERS[i] });
  });

  const pad = Math.max(0, Math.floor((INNER - width) / 2));
  const lines = grid.map((row) => [s(" ".repeat(pad) + row.join("").replace(/\s+$/, ""), "border")]);
  return { lines, placed };
}

export function radarFrame(samples, { source = "" } = {}) {
  if (!samples.length) {
    return {
      title: "radar — no signal",
      body: rows(
        ...wrap("No usable readings in that payload. Each sample needs a name and an rssi in dBm (negative). Nothing is stored here, so send the whole set each time.", INNER).map((row) => [s(row)]),
        blank(),
        [s('  {"samples":[{"name":"Kitchen AP","rssi":-58,"kind":"wifi"}]}', "accent")],
      ),
      status: [],
    };
  }

  const { lines, placed } = ringPlot(samples);
  const strongest = placed[0];

  const meter = (item) => {
    const band = bandOf(item.rssi);
    const filled = Math.round((1 - radius(item.rssi)) * 18);
    const trend = sparkline(item.history);
    return [
      s(` ${item.marker} `, "key"),
      ...fit([s(item.name, "strong"), s(item.kind ? `  ${item.kind}` : "", "dim")], 26),
      s("▇".repeat(filled), band.style),
      s("▁".repeat(Math.max(0, 18 - filled)), "dim"),
      ...rightTo([s(` ${item.rssi} dBm`, band.style)], 10),
      s("  "),
      ...fit([s(band.label, "label")], 12),
      s(trend, "dim"),
    ];
  };

  return {
    title: `radar — ${placed.length} source${placed.length === 1 ? "" : "s"}`,
    body: rows(
      lines,
      blank(),
      [s("  rings are signal strength. ANGLES ARE DECORATIVE — RSSI has no bearing.", "dim")],
      blank(),
      rule(INNER, "sources, strongest first"),
      ...placed.map(meter),
      blank(),
      kv("closest", `${strongest.name} at ${strongest.rssi} dBm (${bandOf(strongest.rssi).label})`, INNER, { gutter: 12 }),
      source ? kv("sampled by", source, INNER, { gutter: 12 }) : blank(),
    ),
    status: [
      [s("bands ", "label"), s("-45 arm's reach · -60 same table · -72 same room", "dim")],
      [s("nothing is stored — post the full set each time", "dim")],
    ],
  };
}
