// dyno.js — /garage/dyno, the site's own performance history as a chart.
//
// A dyno tells you what an engine actually puts down. This one straps the site
// to the rollers once a night and records a pull.
//
// The third tier of the performance story, and the one that would actually have
// caught this repo's real failure. perf-budget.mjs checks a number against a
// constant (catches a number being over a line). perf-snapshot.mjs diffs the
// merge base (catches the STEP a single PR makes). Neither can see DRIFT: the
// worker bundle went 86 -> 129.23 -> 204.24 -> 258.34 -> 261.74 KiB gzip and
// every one of those numbers was discovered by somebody tripping over a stale
// constant. Nobody ever saw the slope, because nothing drew it.
//
// Shape borrowed from commonwarexyz, who run exactly this split: a per-PR gate
// on a deterministic metric, plus a nightly wall-clock series published for
// trend. Theirs goes to a separate repo rendered by a third-party charting
// action. This site is a website, so it renders its own.
//
// SERVER-RENDERED SVG, zero client JS. Not a style choice: the served pages here
// carry no cross-origin assets and inline scripts need per-document CSP hashes,
// so a chart that draws itself on the server costs one <svg> and no exceptions.
import { BOT_UA } from "./lib/botauth.js";
import { swrKV } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { asNumber } from "./lib/parse.js";
import { esc, jsonResponse } from "./lib/http.js";
import { span } from "./lib/trace.js";
import seed from "./dyno-seed.json" with { type: "json" };

// The machine-owned branch. `perf-history.yml` appends one line a night and
// force-pushes nothing; /garage/dyno only ever reads.
//
// A BRANCH rather than D1 or a commit to main, and the reason is the repo's own
// rules rather than preference. `main` carries a ruleset with zero bypass
// actors, so no workflow may push to it; D1 writes need a Cloudflare Edit token,
// and the one that exists is environment-gated behind a required reviewer for
// the ramp. A branch outside both rulesets is the only write target a nightly
// job can reach without weakening something load-bearing.
const HISTORY_URL = "https://raw.githubusercontent.com/oddharsh/site/perf-history/history.jsonl";

const KV_KEY = "dyno:history";
const KV_TTL = 6 * 3600;      // the source updates once a night; 6h is generous
const FETCH_BUDGET_MS = 3000;

// ── data ────────────────────────────────────────────────────────────────────

// Rows come back stale-while-revalidate. The isValid guard is load-bearing: a
// GitHub outage that returned an empty array would otherwise overwrite a good
// cached history with nothing, and this page's entire value is the part of the
// series that already happened.
async function readHistory(env, ctx) {
  const rows = await swrKV(env, ctx, KV_KEY, KV_TTL, () => fetchHistory(), {
    cacheTtl: 300,
    isValid: (v) => Array.isArray(v) && v.length > 0,
  });
  return Array.isArray(rows) ? rows : [];
}

async function fetchHistory() {
  // Attributes are set on the span object rather than passed up front, because
  // the only things worth recording here (how many rows came back, whether
  // GitHub answered) are not known until after the fetch.
  return span("dyno.fetch", async (s) => {
    let res;
    try {
      res = await fetch(HISTORY_URL, {
        headers: { "user-agent": BOT_UA, accept: "text/plain" },
        signal: AbortSignal.timeout(FETCH_BUDGET_MS),
      });
    } catch (e) {
      s.setAttribute("dyno.outcome", "unreachable");
      return null;
    }
    s.setAttribute("dyno.status", res.status);
    if (!res.ok) { s.setAttribute("dyno.outcome", "http-error"); return null; }
    const text = await res.text();
    const rows = [];
    let malformed = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // One malformed line must not cost the whole series. The file is
      // append-only from a single writer, so a bad line means an interrupted
      // push, and the rows around it are still true.
      try { rows.push(JSON.parse(trimmed)); } catch { malformed++; }
    }
    s.setAttribute("dyno.rows", rows.length);
    if (malformed) s.setAttribute("dyno.malformed", malformed);
    s.setAttribute("dyno.outcome", "ok");
    return rows;
  });
}

// Seed rows are hand-entered history from perf-budget.mjs's baseline comment;
// nightly rows are measured. Merging them here rather than seeding the branch
// keeps every hand-entered number in the repo, where a PR review can see it.
// Dedupe on ts so a nightly row always wins over a seeded one for the same day.
export function mergeHistory(nightly) {
  const byTs = new Map();
  for (const r of seed) byTs.set(r.ts, r);
  for (const r of nightly) if (r && r.ts) byTs.set(r.ts, r);
  return [...byTs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// ── chart ───────────────────────────────────────────────────────────────────

const W = 620, H = 210, PAD_L = 46, PAD_R = 12, PAD_T = 14, PAD_B = 26;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const kib = (b) => b / 1024;
const day = (ts) => Date.parse(`${ts}T00:00:00Z`);

// Time-proportional X, not index-proportional. A gap in the series is a gap in
// the chart, which is the honest rendering: the nightly job skips days with no
// commits (it should — measuring an unchanged tree twice adds a point and no
// information), so evenly spacing the points would draw a steady cadence the
// data does not have.
function scales(rows, pick) {
  const xs = rows.map((r) => day(r.ts));
  const ys = rows.map(pick).filter((v) => asNumber(v) !== null);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = Math.max(...ys) * 1.12;
  return {
    x: (ts) => PAD_L + (x1 === x0 ? PLOT_W : ((day(ts) - x0) / (x1 - x0)) * PLOT_W),
    y: (v) => PAD_T + PLOT_H - (v / yMax) * PLOT_H,
    yMax,
  };
}

function polyline(rows, sc, pick, cls) {
  const pts = rows.filter((r) => asNumber(pick(r)) !== null)
    .map((r) => `${sc.x(r.ts).toFixed(1)},${sc.y(pick(r)).toFixed(1)}`);
  return pts.length < 2 ? "" : `<polyline class="${cls}" points="${pts.join(" ")}"/>`;
}

// Every point carries a <title>, which is the whole hover story on a chart with
// no JavaScript: the browser draws the tooltip natively. Hand-entered points get
// a wider dot because they are the ones with a note worth reading.
function dots(rows, sc, pick, cls) {
  return rows.filter((r) => asNumber(pick(r)) !== null).map((r) =>
    `<circle class="${cls}" cx="${sc.x(r.ts).toFixed(1)}" cy="${sc.y(pick(r)).toFixed(1)}" r="${r.source === "baseline-note" ? "3.2" : "1.7"}"><title>${esc(`${r.ts} · ${kib(pick(r)).toFixed(1)} KiB · ${r.sha}${r.note ? ` — ${r.note}` : ""}`)}</title></circle>`
  ).join("");
}

function chart(rows) {
  // Three series on one axis. They span 57-466 KiB, which is close enough that a
  // shared axis reads fine and far better than three stacked charts: the whole
  // question this page answers is how the parts move against each other.
  const series = [
    { key: "pages_br",    cls: "s-pages",  label: "all pages, Brotli" },
    { key: "worker_gzip", cls: "s-worker", label: "worker bundle, gzip" },
    { key: "assets_br",   cls: "s-assets", label: "client assets, Brotli" },
  ];
  const sc = scales(rows, (r) => Math.max(r.pages_br ?? 0, r.worker_gzip ?? 0, r.assets_br ?? 0));

  // The seeded prefix is drawn dashed. A number typed into a code comment and a
  // number a runner measured last night are not the same kind of fact, and a
  // chart that renders them identically is lying about which half of its own
  // history it can stand behind.
  const seeded = rows.filter((r) => r.source === "baseline-note");
  const measured = rows.filter((r) => r.source !== "baseline-note");
  // Join the two so the line does not break at the handover.
  const bridge = seeded.length && measured.length ? [seeded[seeded.length - 1], measured[0]] : [];

  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = sc.yMax * f;
    const y = sc.y(v).toFixed(1);
    return `<line class="grid" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"/>`
      + `<text class="ytick" x="${PAD_L - 6}" y="${(+y + 3).toFixed(1)}">${Math.round(kib(v))}</text>`;
  }).join("");

  const first = rows[0], last = rows[rows.length - 1];
  const xTicks = [
    `<text class="xtick" x="${PAD_L}" y="${H - 8}" text-anchor="start">${esc(first.ts)}</text>`,
    `<text class="xtick" x="${W - PAD_R}" y="${H - 8}" text-anchor="end">${esc(last.ts)}</text>`,
  ].join("");

  const lines = series.map((s) => {
    const pick = (r) => r[s.key];
    return polyline(seeded, sc, pick, `${s.cls} dashed`)
      + polyline(bridge, sc, pick, `${s.cls} dashed`)
      + polyline(measured, sc, pick, s.cls)
      + dots(rows, sc, pick, s.cls);
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `Wire size over time, ${first.ts} to ${last.ts}. Worker bundle ${kib(last.worker_gzip ?? 0).toFixed(0)} KiB gzip.`
  )}">
  ${gridY}
  <line class="axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>
  ${lines}
  ${xTicks}
  <text class="yunit" x="${PAD_L - 6}" y="${PAD_T - 4}" text-anchor="end">KiB</text>
</svg>
<ul class="legend">
  ${series.map((s) => `<li><i class="${s.cls}"></i>${esc(s.label)}</li>`).join("\n  ")}
  <li><i class="s-dash"></i>dashed: recorded by hand before this series existed</li>
</ul>`;
}

// ── page ────────────────────────────────────────────────────────────────────

const delta = (rows, key) => {
  const have = rows.filter((r) => asNumber(r[key]) !== null);
  if (have.length < 2) return null;
  const a = have[0][key], b = have[have.length - 1][key];
  return { a, b, pct: ((b - a) / a) * 100, from: have[0].ts, to: have[have.length - 1].ts };
};

export function renderDyno(rows) {
  const empty = rows.length < 2;
  const worker = delta(rows, "worker_gzip");
  const last = rows[rows.length - 1];

  // An em dash for a row that carries no number, which is what a JSONL row
  // written before that column existed looks like. asNumber also refuses NaN,
  // so a corrupt cell reads as absent rather than plotting as zero.
  const cell = (v) => (asNumber(v) === null ? "—" : kib(asNumber(v)).toFixed(1));
  const table = rows.slice(-14).reverse().map((r) => `<tr>
      <td class="mono">${esc(r.ts)}</td>
      <td class="mono sha">${esc(r.sha)}</td>
      <td class="num">${cell(r.worker_gzip)}</td>
      <td class="num">${cell(r.pages_br)}</td>
      <td class="num">${cell(r.assets_br)}</td>
      <td class="src">${r.source === "baseline-note" ? "by hand" : "measured"}</td>
    </tr>`).join("\n    ");

  return lunaPage({
    title: "Dyno · aadhar.sh",
    path: "Dyno",
    route: "/garage/dyno",
    width: 700,
    description: "The site on the rollers: worker bundle, pages, and client assets weighed nightly, charted over time.",
    explorerName: "Dyno",
    explorerDetails: [
      `${rows.length} pull${rows.length === 1 ? "" : "s"} recorded`,
      last ? `latest ${last.ts}` : "no data",
    ],
    css: `
h1{margin:0 0 3px}
.lede{font-size:9pt;color:#4a5568;margin:0 0 13px;line-height:1.5}
.chart{width:100%;height:auto;display:block;margin:2px 0 4px;overflow:visible}
.chart .grid{stroke:#e2e8f0;stroke-width:1}
.chart .axis{stroke:#b6c2d2;stroke-width:1}
.chart .ytick,.chart .xtick,.chart .yunit{font-family:var(--font-mono);font-size:7.5px;fill:#7a8798}
.chart .ytick{text-anchor:end}
/* Element-qualified on purpose. A bare .s-worker setting both stroke and fill
   outranks a plain \`polyline{fill:none}\` on specificity, which fills every line
   down to the axis and draws three coloured blobs instead of a chart. Splitting
   by element keeps one colour per series without an !important. */
.chart polyline{stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.chart polyline.dashed{stroke-dasharray:4 3;opacity:.62}
.chart polyline.s-worker{stroke:#7a4eb0;fill:none}
.chart polyline.s-pages{stroke:#2f6fb5;fill:none}
.chart polyline.s-assets{stroke:#3c8f24;fill:none}
.chart circle.s-worker{fill:#7a4eb0}
.chart circle.s-pages{fill:#2f6fb5}
.chart circle.s-assets{fill:#3c8f24}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 13px;padding:0;font-size:8pt;color:#5a6a7d}
.legend li{display:flex;align-items:center;gap:5px}
.legend i{width:13px;height:3px;border-radius:2px;flex:0 0 13px}
.legend i.s-worker{background:#7a4eb0}
.legend i.s-pages{background:#2f6fb5}
.legend i.s-assets{background:#3c8f24}
.legend i.s-dash{background:repeating-linear-gradient(90deg,#8b98a8 0 4px,transparent 4px 7px)}
.callout{border:1px solid #c7d4e4;background:linear-gradient(180deg,#f4f8fd,#e8f0f9);border-radius:4px;padding:10px 12px;margin:0 0 13px;font-size:9pt;color:#33415c;line-height:1.55}
.callout b{font-family:var(--font-caption);color:#1e3a5f}
table{width:100%;border-collapse:collapse;font-size:8.5pt}
th{text-align:left;font-family:var(--font-caption);font-size:8pt;color:#5a6a7d;border-bottom:1px solid #c7d4e4;padding:4px 6px}
th.num,td.num{text-align:right}
td{padding:4px 6px;border-bottom:1px solid #eef2f7;color:#33415c}
.mono{font-family:var(--font-mono);font-size:8pt}
td.sha{color:#7a4eb0}
td.src{font-size:7.5pt;color:#8b98a8}
.foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:9px;margin-top:13px;line-height:1.55}
`,
    body: `
    <h1>Dyno</h1>
    <p class="lede">A dyno tells you what an engine actually puts down. The spec sheet is a claim; the rollers
    are a measurement. This one straps the site down every night: a GitHub Action builds <code>main</code>,
    weighs what would go over the wire, and records a pull.</p>
    ${empty ? `<div class="callout">No pulls recorded yet, or the series could not be read just now. The
    hand-entered points below come from the baseline history in <code>perf-budget.mjs</code>, which is what
    this page exists to replace.</div>` : ""}
    ${rows.length ? chart(rows) : ""}
    ${worker ? `<div class="callout"><b>The worker bundle is the pull worth watching.</b>
    It went from ${kib(worker.a).toFixed(0)} to ${kib(worker.b).toFixed(0)} KiB gzip between ${esc(worker.from)} and
    ${esc(worker.to)}, ${worker.pct > 0 ? "up" : "down"} ${Math.abs(worker.pct).toFixed(0)}%. Every one of those numbers
    got found by somebody tripping over a stale threshold rather than by anyone watching the slope, which is the
    specific failure a per-change check cannot catch and a series can.</div>` : ""}
    <h2>Recent pulls</h2>
    <table>
      <thead><tr><th>date</th><th>commit</th><th class="num">worker gzip</th><th class="num">pages br</th><th class="num">assets br</th><th>source</th></tr></thead>
      <tbody>
    ${table || `<tr><td colspan="6">No pulls recorded.</td></tr>`}
      </tbody>
    </table>
    <p class="foot">Every number here is deterministic: identical source bytes weigh the same every time, so a
    flat line means nothing changed rather than that nothing was measured. Sampled figures are deliberately
    absent, because <code>wrangler check startup</code> read 9.6, 7.6, 6.4 and 16.4&nbsp;ms across bytes nobody
    touched, and charting that would draw weather. A dyno with a wandering needle is a decoration. Raw series at
    <a href="/garage/dyno.json">/garage/dyno.json</a>.</p>
`,
  });
}

export async function handleDyno(request, env, ctx) {
  const rows = mergeHistory(await readHistory(env, ctx));
  return renderDyno(rows);
}

export async function handleDynoJson(request, env, ctx) {
  const rows = mergeHistory(await readHistory(env, ctx));
  return jsonResponse({
    generated: new Date().toISOString(),
    source: HISTORY_URL,
    count: rows.length,
    points: rows,
  }, 200, { "cache-control": "public, max-age=300, s-maxage=300" });
}
