// radar.js — the instrument half of a signal radar.
//
// ── the split, and why this is the interesting shape ──────────────────────
// A server has no antenna. Neither does an agent. Browsers expose no wifi RSSI
// at all (Network Information gives effectiveType, not signal) and Web Bluetooth
// scanning is flag-gated, which is why ben-z/findphone — the thing this is
// modelled on — is a native macOS CLI rather than a web page.
//
// So this is not a hosted radar. It is a hosted INSTRUMENT: the sensing happens
// where the antenna is (www/scripts/radar-sample.mjs, or any agent with a
// shell), and the readings are POSTed here to be drawn. The client brings the
// signal, the site brings the display. That is the only honest way to host this,
// and it happens to be the version an agent can actually use.
//
// ── THE ANGLES MEAN NOTHING, AND THE FRAME SAYS SO ────────────────────────
// RSSI is a scalar. It carries distance-ish information and NO BEARING. A
// sweeping radar with a rotating arm would imply a direction the data cannot
// support, and would be the single most misleading thing this site draws.
//
// So: concentric rings by signal strength, which is what RSSI actually supports,
// and each device's angle is a hash of its name — stable between frames so a
// device does not jump around while you walk, and explicitly labelled as
// meaningless. Distance is real. Direction is decoration, declared as such.
//
// The bands are findphone's, because they are field-calibrated rather than
// derived: -45 arm's reach, -60 same table, -72 same room.
import { COLS, blank, fit, kv, rightTo, rows, rule, s, wrap } from "./lib/tui.ts";

const INNER = COLS - 4;

export const RADAR_LIMITS = {
  samples: 40,      // devices per frame
  name: 48,         // characters of a device name
  history: 32,      // trailing readings kept for the trend sparkline
};

// dBm bands. Ordered strongest first; the first match wins.
export const BANDS = [
  { max: -45, label: "arm's reach", style: "ok" },
  { max: -60, label: "same table", style: "ok" },
  { max: -72, label: "same room", style: "warn" },
  { max: -85, label: "next room", style: "warn" },
  { max: -200, label: "far / noise", style: "bad" },
];

export const bandOf = (rssi) => BANDS.find((band) => rssi >= band.max) || BANDS[BANDS.length - 1];

// -30 dBm is about as hot as a real reading gets; -90 is the floor. Everything
// outside clamps rather than flying off the plot.
export const radius = (rssi) => Math.max(0, Math.min(1, (Math.abs(rssi) - 30) / 60));

/** Stable pseudo-angle from a name. Decorative — see the header. */
function angleOf(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return (hash % 3600) / 3600 * Math.PI * 2;
}

const MARKERS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Parse and bound whatever was POSTed. Never throws: a malformed sample is
 * dropped, not fatal, because the caller is a shell script somebody wrote in
 * five minutes and a 500 tells them nothing.
 */
export function readSamples(payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.samples) ? payload.samples : [];
  const out = [];
  for (const item of raw) {
    const rssi = Number(item?.rssi);
    if (!Number.isFinite(rssi) || rssi > 0 || rssi < -200) continue;   // dBm is negative
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
  // Strongest first: the thing you are hunting is the thing at the top.
  return out.sort((a, b) => b.rssi - a.rssi);
}

const SPARK = "▁▂▃▄▅▆▇█";
/** Trend, which is the whole point when you are walking around looking for something. */
function sparkline(history) {
  if (history.length < 2) return "";
  const lo = Math.min(...history), hi = Math.max(...history);
  const span = hi - lo || 1;
  return history.slice(-16).map((v) => SPARK[Math.round(((v - lo) / span) * (SPARK.length - 1))]).join("");
}

/**
 * The ring plot. A character grid, because a circle drawn with box characters is
 * the one thing lib/tui.js's line primitives cannot express.
 */
export function ringPlot(samples, { height = 17 } = {}) {
  const cy = Math.floor(height / 2);
  const ry = cy - 1;
  // Terminal cells are about twice as tall as they are wide, so the x radius has
  // to be doubled or every ring reads as an ellipse.
  const rx = ry * 2;
  const width = rx * 2 + 1;
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));

  // The band rings, dotted so a device marker on top of one is still legible.
  for (const band of BANDS.slice(0, 4)) {
    const r = radius(band.max);
    for (let deg = 0; deg < 360; deg += 3) {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(rx + Math.cos(rad) * rx * r);
      const y = Math.round(cy + Math.sin(rad) * ry * r);
      if (y >= 0 && y < height && x >= 0 && x < width && grid[y][x] === " ") grid[y][x] = "·";
    }
  }
  grid[cy][rx] = "+";   // you are here

  const placed = [];
  samples.forEach((sample, i) => {
    if (i >= MARKERS.length) return;
    const r = radius(sample.rssi);
    const angle = angleOf(sample.name);
    let x = Math.round(rx + Math.cos(angle) * rx * r);
    let y = Math.round(cy + Math.sin(angle) * ry * r);
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));
    // Two devices at the same strength and a colliding hash would overwrite each
    // other; nudge along the row so both are visible rather than silently one.
    let guard = 0;
    while (grid[y][x] !== " " && grid[y][x] !== "·" && guard < width) { x = (x + 1) % width; guard += 1; }
    grid[y][x] = MARKERS[i];
    placed.push({ ...sample, marker: MARKERS[i] });
  });

  const pad = Math.max(0, Math.floor((INNER - width) / 2));
  const lines = grid.map((row) => [s(" ".repeat(pad) + row.join("").replace(/\s+$/, ""), "border")]);
  return { lines, placed };
}

/** The whole instrument: rings, then a meter per device. */
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
      // Stated on the frame, not only in the source. Somebody reading this over
      // a shoulder will otherwise assume the angles point somewhere.
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
