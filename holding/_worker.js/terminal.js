// tui.js — the terminal apps at /terminal/*, and the key-driven session model behind
// them. lib/tui.js draws the frames; this file decides what goes in them.
//
// ── what this is for ──────────────────────────────────────────────────────
// Every other agent surface on this site hands back a document or a JSON blob:
// one shot, no follow-up. A TUI is the other shape. An agent arrives knowing
// nothing, reads a frame that names its own controls, presses a key, and reads
// the next frame — which is how a person learns an unfamiliar program, and it
// needs no schema shipped ahead of time. The frame IS the documentation.
//
// ── where the state lives, and why it is split ────────────────────────────
// The PROGRAMS keep their state in the URL: ?pane=writing&cursor=3&open=lattice
// is the whole thing. No Durable Object, no KV entry, no token, no TTL.
// /ask is the ONE exception and it has its own DO — see below.
//
// Four things fall out of the URL model:
//
//   1. Sessions FORK. Two agents explore from the same frame without colliding.
//   2. A state from last week still resolves, because it was never a live object
//      anybody had to keep holding. Bookmarkable, replayable, diffable.
//   3. It is inspectable. A site whose argument is "here is what the machine
//      sees" should not hand an agent an opaque blob and ask for it back.
//   4. Any isolate can serve any frame. No affinity, nothing to fail over.
//
// ── this is the argument MCP's 2026-07-28 revision made ───────────────────
// That revision dropped server-side sessions: no Mcp-Session-Id to mint, no
// session table, and — the part that actually decides deployments — no need to
// route a session back to the same backend. This origin already speaks it;
// lib/mcp-protocol.js serves it, and its "DUAL-ERA" note is that cutover.
//
// /terminal applies the principle ONE LAYER UP. MCP made a single tool CALL
// stateless; this makes a whole session over those tools stateless too, which is
// the harder half, because a session is the thing that looks like it obviously
// needs a server to hold it. The npx/uvx analogy is the useful one: fetch, run,
// discard, reconstruct from the address next time. (Simon Willison on the
// revision, 2026-07-31: https://simonwillison.net/2026/Jul/31/stateless-mcp/)
//
// ── the exception, and the rule that decides it ───────────────────────────
// SMALL AND ADDRESSABLE STAYS IN THE URL. GROWING AND OPAQUE GETS A DO.
//
// A pane and a cursor fit a query string forever. A transcript does not — the
// practical ceiling is ~2KB, which holds a cursor and never holds a three-turn
// exchange. `ask` was single-shot for precisely that reason: there was nowhere
// for "what about the other one?" to live. So ask-session.js gives that ONE
// program a Durable Object, and the other three are untouched.
//
// One correction worth recording, because it was used to argue the wrong thing:
// counter.js's measured 185-630ms DO hop is a SINGLE GLOBAL INSTANCE hit from
// everywhere. A per-session DO lands near whoever opened it — tens of ms, paid
// once per ask, next to a model call. Latency was never the reason the programs
// stay on URLs. Forking, bookmarking, and testability were.
import { ASK_BUDGET, ASK_LIMITS, asAgentCall, runAsk } from "./ask.js";
import { probeRevalidation } from "./cache-lint.js";
import { MEASURED, auditUrl } from "./dict.js";
import { RADAR_LIMITS, radarFrame, readSamples } from "./radar.js";
import { readAroundChanges } from "./around.js";
import { readCoffeeAvailability } from "./coffee.js";
import { LENS_BUDGETS, lensInspect, lensObservationSummary, overLensBudget, validateLensTarget } from "./lens.js";
import { lunaPage } from "./lib/chrome.js";
import { escHtml } from "./lib/http.js";
import { AGENT_SURFACES } from "./lib/site-manifest.js";
import {
  COLS, blank, emit, fit, keys as keyHints, kv, meter, pane, rightTo, rows, rule, s, table, windowFrame, wrap,
} from "./lib/tui.js";
import { photoFacets, queryPhotos } from "./photos.js";
import { RN_FALLBACK, getTracksSWR } from "./rn.js";
import { getCuriusCached } from "./reading.js";
import { searchSite } from "./search.js";
import { readCheckpoints } from "./updates.js";
import { readPosts } from "./writing.js";

// The frame is 80 columns because that is what a terminal is, and because an
// agent's context window pays for every column of padding it never reads.
const INNER = COLS - 4;

// ── keys ──────────────────────────────────────────────────────────────────
// A key sequence arrives as one string. Single code points are single keys;
// the named forms exist because <cr> is typeable in a URL and \r is not, and an
// agent composing a query string should not have to percent-encode a control
// character to press Enter.
const NAMED = { cr: "\r", enter: "\r", esc: "\x1b", tab: "\t", sp: " ", up: "k", down: "j", left: "h", right: "l" };

// 32 keys per request. Enough to drive anywhere in these apps from cold, and
// small enough that no single request can make the pane loader run away — the
// loader is memoized per pane, so the real ceiling is 9 loads, but a bound that
// does not depend on reading the memo table is the one worth stating.
const MAX_KEYS = 32;

export function tokenizeKeys(input) {
  const out = [];
  const text = String(input ?? "").slice(0, 256);
  let i = 0;
  while (i < text.length && out.length < MAX_KEYS) {
    if (text[i] === "<") {
      const close = text.indexOf(">", i);
      const name = close > i ? text.slice(i + 1, close).toLowerCase() : "";
      if (name && Object.hasOwn(NAMED, name)) { out.push(NAMED[name]); i = close + 1; continue; }
    }
    const cp = String.fromCodePoint(text.codePointAt(i));
    out.push(cp);
    i += cp.length;
  }
  return out;
}

// ── state ─────────────────────────────────────────────────────────────────
const FINGER_PANES = ["overview", "writing", "reading", "listening", "photos", "around", "coffee", "deploys", "search"];

const clampInt = (raw, min, max, fallback) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (raw, max) => String(raw ?? "").slice(0, max);

export function readState(url, app) {
  const params = url.searchParams;
  const pane = str(params.get("pane"), 24);
  return {
    app,
    pane: FINGER_PANES.includes(pane) ? pane : FINGER_PANES[0],
    cursor: clampInt(params.get("cursor"), 0, 4999, 0),
    open: str(params.get("open"), 160),
    q: str(params.get("q"), 120),
    url: str(params.get("url"), 512),
    at: str(params.get("at"), 300),
    session: str(params.get("session"), 64),
    left: str(params.get("left"), 512),
    right: str(params.get("right"), 512),
    film: str(params.get("film"), 60),
    camera: str(params.get("camera"), 60),
    lens: str(params.get("lens"), 60),
    page: clampInt(params.get("page"), 0, 200, 0),
    quit: false,
    help: params.get("help") === "1",
  };
}

/** The canonical URL for a state: what the frame tells the caller to send next. */
export function stateUrl(state, extra = {}) {
  const params = new URLSearchParams();
  const put = (key, value, skip) => { if (value !== undefined && value !== null && value !== "" && value !== skip) params.set(key, String(value)); };
  if (state.app === "finger") {
    put("pane", state.pane, FINGER_PANES[0]);
    put("cursor", state.cursor, 0);
    put("open", state.open);
    put("q", state.q);
  } else if (state.app === "photos") {
    put("q", state.q); put("film", state.film); put("camera", state.camera); put("lens", state.lens);
    put("page", state.page, 0); put("cursor", state.cursor, 0); put("open", state.open);
  } else if (state.app === "lens" || state.app === "dict" || state.app === "cache") {
    put("url", state.url); put("left", state.left); put("right", state.right);
  } else if (state.app === "ask") {
    put("q", state.q); put("at", state.at); put("session", state.session);
  }
  for (const [key, value] of Object.entries(extra)) put(key, value);
  const qs = params.toString();
  // The tool's own root path, because that is where it lives. This string is
  // the resumable state a caller sends back, so it has to be the real URL.
  return `/${state.app}${qs ? `?${qs}` : ""}`;
}

/**
 * The status-bar line that prints the current state.
 *
 * LABELLED, because a frame legitimately contains several /terminal/… strings —
 * cross-references between the programs, examples in the help screen — and an
 * agent told to "pass the url back" has to be able to tell which one is the
 * state. Unlabelled, the first match in the frame is whichever URL happens to
 * appear earliest in the body, which is not the state and is not stable.
 */
const stateLine = (state, trailer = "") => [
  s("state ", "label"),
  s(stateUrl(state), "accent"),
  ...(trailer ? [s(`   ${trailer}`, "dim")] : []),
];

// ── finger: the panes ─────────────────────────────────────────────────────
// Each pane declares how to LOAD its data and how to turn that data into a list
// of rows. The list is what j/k moves through and what Enter opens, so a pane
// that has no list (overview) simply returns none and the movement keys become
// no-ops there rather than special cases in the key loop.

const dash = (value) => (value === null || value === undefined || value === "" ? [s("—", "dim")] : [s(String(value))]);

const PANES = {
  async overview(env, _ctx, _request, _state) {
    // Every source here is a bundled file or an asset read, deliberately: the
    // first frame of the flagship app should not wait on Spotify, Curius, or a
    // calendar. Those load on the pane that shows them, and nowhere else.
    const [posts, photos, checkpoints] = await Promise.all([
      readPosts(env),
      queryPhotos(env, { limit: 1 }),
      readCheckpoints(env),
    ]);
    return { posts, photos, checkpoints, list: [] };
  },
  async writing(env) {
    const posts = await readPosts(env);
    return { posts, list: posts.map((p) => ({ id: p.slug, label: p.title || p.slug, meta: p.date || "" })) };
  },
  async reading(env, ctx, request) {
    const payload = await getCuriusCached(request, env, ctx).catch(() => null);
    const links = Array.isArray(payload?.links) ? payload.links.slice(0, 200) : [];
    return { links, stale: !!payload?.stale, list: links.map((l, i) => ({ id: String(i), label: l.title, meta: l.domain || "" })) };
  },
  async listening(env, ctx) {
    const stored = env.RN_KV ? await env.RN_KV.get("playlist-id").catch(() => null) : null;
    const pid = /^[0-9A-Za-z]{22}$/.test(stored || "") ? stored : RN_FALLBACK.split("/").pop();
    const payload = await getTracksSWR(env, ctx, pid, { buildOnMiss: true }).catch(() => null);
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    return { tracks, payload, list: tracks.map((t, i) => ({ id: String(i), label: t.name || "", meta: (t.artists || []).map((a) => a.name).join(", ") })) };
  },
  async photos(env) {
    return { facets: await photoFacets(env), list: [] };
  },
  async around(env) {
    const changes = await readAroundChanges(env, 40).catch(() => null);
    const rowsOut = Array.isArray(changes?.changes) ? changes.changes : [];
    return { changes: rowsOut, list: rowsOut.map((c, i) => ({ id: String(i), label: c.host || c.url || "", meta: c.kind || "" })) };
  },
  async coffee(env, ctx) {
    return { availability: await readCoffeeAvailability(env, ctx).catch(() => null), list: [] };
  },
  async deploys(env) {
    const { points } = await readCheckpoints(env);
    const recent = [...(points || [])].reverse().slice(0, 60);
    return { points: recent, list: recent.map((p) => ({ id: String(p.vnum), label: p.title || p.slug || "", meta: p.ymd || "" })) };
  },
  async search(env, _ctx, _request, state) {
    if (!state.q.trim()) return { results: [], list: [] };
    const found = await searchSite(env, state.q, 30).catch(() => null);
    const results = found?.results || [];
    return { results, total: found?.total ?? 0, list: results.map((r, i) => ({ id: String(i), label: r.title, meta: r.kind || "" })) };
  },
};

// ── finger: rendering one pane ────────────────────────────────────────────

/** A selectable list, with the cursor row painted like the title bar. */
function listBody(list, state, { empty = "nothing here yet.", metaWidth = 16 } = {}) {
  if (!list.length) return [[s(empty, "dim")]];
  const cursor = Math.min(state.cursor, list.length - 1);
  // A frame is 24 rows on a classic terminal and the chrome eats 8, so the
  // window scrolls to keep the cursor inside 14 rows rather than emitting all
  // 158 and trusting the caller to scroll. An agent pays for every row.
  const view = 14;
  const start = Math.max(0, Math.min(cursor - Math.floor(view / 2), list.length - view));
  const slice = list.slice(Math.max(0, start), Math.max(0, start) + view);
  const out = slice.map((item, i) => {
    const index = Math.max(0, start) + i;
    const selected = index === cursor;
    const style = selected ? "sel" : null;
    const marker = selected ? "▶ " : "  ";
    const meta = item.meta ? fit([s(String(item.meta), selected ? "sel" : "dim")], metaWidth) : [];
    const label = fit([s(marker + String(item.label ?? ""), style)], INNER - metaWidth);
    return [...label, ...meta];
  });
  if (list.length > view) out.push([s(`  ${cursor + 1} of ${list.length}`, "dim")]);
  return out;
}

function renderOverview(data) {
  const { posts, photos, checkpoints } = data;
  const latest = (checkpoints.points || [])[checkpoints.points.length - 1];
  return rows(
    rule(INNER, "identity"),
    kv("login", "aadharsh", INNER),
    kv("name", "Aadharsh Pannirselvam", INNER),
    kv("host", "aadhar.sh", INNER),
    kv("shell", "a resto-mod Windows XP desktop, served from a Cloudflare Worker", INNER),
    blank(),
    rule(INNER, "plan"),
    ...wrap("Crypto investing at Archetype. This site is the workshop: prototypes in /garage, chat-style explainers in /lwe, photographs shot on a Fuji X-T5, and whatever I am reading. Everything here is public and readable by machines on purpose.", INNER).map((row) => [s(row)]),
    blank(),
    rule(INNER, "what this host knows"),
    kv("writing", `${posts.length} note${posts.length === 1 ? "" : "s"}`, INNER),
    kv("photographs", `${photos.total} published`, INNER),
    kv("public surfaces", `${AGENT_SURFACES.length} listed for agents`, INNER),
    kv("deploys logged", `${(checkpoints.points || []).length}`, INNER),
    latest ? kv("last shipped", `${latest.ymd || ""} — ${latest.title || latest.slug || ""}`, INNER) : blank(),
  );
}

function renderWriting(data, state) {
  if (state.open) {
    const post = data.posts.find((p) => p.slug === state.open);
    if (!post) return [[s("no such note.", "dim")]];
    return rows(
      rule(INNER, post.title || post.slug),
      kv("slug", post.slug, INNER),
      kv("date", post.date, INNER),
      kv("read", `https://aadhar.sh/writing/${post.slug}`, INNER, { style: "accent" }),
      blank(),
      // The note's TEXT is deliberately not inlined. /writing/<slug>.txt already
      // serves it as plain text with no chrome at all, which is strictly better
      // than the same bytes reflowed into an 80-column box, and a frame that
      // duplicated it would make the archive's total size the frame's size.
      ...wrap("The full text is one fetch away, unwrapped and unstyled, at the .txt URL above. This frame is the index card.", INNER).map((row) => [s(row, "dim")]),
    );
  }
  return listBody(data.list, state, { empty: "no notes published yet.", metaWidth: 12 });
}

function renderReading(data, state) {
  if (state.open) {
    const link = data.links[Number(state.open)];
    if (!link) return [[s("no such saved link.", "dim")]];
    return rows(
      ...wrap(link.title || "", INNER).map((row) => [s(row, "strong")]),
      blank(),
      kv("domain", link.domain, INNER),
      kv("url", link.link, INNER, { style: "accent" }),
      kv("saved", link.created || link.date, INNER),
    );
  }
  return rows(
    data.stale ? [s("(showing a cached snapshot; Curius did not answer)", "warn")] : blank(),
    listBody(data.list, state, { empty: "no saved links.", metaWidth: 22 }),
  );
}

function renderListening(data, state) {
  if (!data.tracks.length) return [[s("the playlist is not answering right now.", "dim")]];
  if (state.open) {
    const track = data.tracks[Number(state.open)];
    if (!track) return [[s("no such track.", "dim")]];
    return rows(
      ...wrap(track.name || "", INNER).map((row) => [s(row, "strong")]),
      blank(),
      kv("artists", (track.artists || []).map((a) => a.name).join(", "), INNER),
      kv("album", track.album?.name || track.album, INNER),
      kv("listen", track.url || track.external_url, INNER, { style: "accent" }),
    );
  }
  return listBody(data.list, state, { empty: "nothing playing.", metaWidth: 26 });
}

function renderPhotoFacets(data) {
  const { facets } = data;
  const top = (list, n) => list.slice(0, n);
  const max = (list) => Math.max(1, ...list.map((f) => f.count));
  const section = (title, list, n) => rows(
    rule(INNER, title),
    ...top(list, n).map((f) => meter(f.name, f.count, max(list), INNER, { labelWidth: 26 })),
  );
  return rows(
    kv("archive", `${facets.total} photographs`, INNER),
    blank(),
    section("film simulation", facets.film, 8),
    blank(),
    section("lens", facets.lens, 6),
    blank(),
    section("body", facets.camera, 4),
    blank(),
    [s("browse the frames themselves at /photos", "dim")],
  );
}

function renderAround(data, state) {
  if (!data.changes.length) return [[s("no observed changes in the window.", "dim")]];
  if (state.open) {
    const change = data.changes[Number(state.open)];
    if (!change) return [[s("no such observation.", "dim")]];
    return rows(
      kv("host", change.host || change.url, INNER, { style: "accent" }),
      kv("kind", change.kind, INNER),
      kv("seen", change.ts || change.observedAt, INNER),
      blank(),
      ...wrap(change.detail || change.summary || "", INNER).map((row) => [s(row)]),
    );
  }
  return listBody(data.list, state, { empty: "quiet neighborhood.", metaWidth: 18 });
}

function renderCoffee(data) {
  const avail = data.availability;
  if (!avail) return [[s("availability is unavailable right now.", "bad")]];
  if (!avail.available) {
    return rows(
      [s("CLOSED — the calendar could not be read, so no slot is offered.", "warn")],
      blank(),
      ...wrap("This fails closed on purpose: showing every slot as free when the calendar is unreadable is how you double-book a real person.", INNER).map((row) => [s(row, "dim")]),
    );
  }
  const slots = (avail.slots || []).slice(0, 12);
  return rows(
    kv("timezone", avail.timezone || avail.tz, INNER),
    kv("open slots", String((avail.slots || []).length), INNER),
    blank(),
    slots.length
      ? table({ cols: [{ title: "start", width: 26 }, { title: "end" }], rows: slots.map((slot) => [String(slot.start || ""), String(slot.end || "")]), width: INNER })
      : [[s("no slots in the published window.", "dim")]],
    blank(),
    [s("book one at https://aadhar.sh/coffee", "accent")],
  );
}

function renderDeploys(data, state) {
  if (state.open) {
    const point = data.points.find((p) => String(p.vnum) === state.open);
    if (!point) return [[s("no such restore point.", "dim")]];
    return rows(
      kv("version", `v${point.vnum}`, INNER),
      kv("shipped", point.ymd, INNER),
      kv("tag", point.slug, INNER),
      blank(),
      ...wrap(point.title || "", INNER).map((row) => [s(row)]),
    );
  }
  return listBody(data.list, state, { empty: "no deploy log.", metaWidth: 12 });
}

function renderSearch(data, state) {
  if (!state.q.trim()) {
    return rows(
      [s("type a query to search this host.", "dim")],
      blank(),
      [s("  /finger?pane=search&q=lattice", "accent")],
      blank(),
      ...wrap("Searches the public pages, writing, garage notes, and utility descriptions. The same index /search serves.", INNER).map((row) => [s(row, "dim")]),
    );
  }
  if (state.open) {
    const hit = data.results[Number(state.open)];
    if (!hit) return [[s("no such result.", "dim")]];
    return rows(
      ...wrap(hit.title || "", INNER).map((row) => [s(row, "strong")]),
      kv("url", hit.url, INNER, { style: "accent" }),
      kv("kind", hit.kind, INNER),
      blank(),
      ...wrap(hit.snippet || hit.description || "", INNER).map((row) => [s(row)]),
    );
  }
  return rows(
    [s(`${data.total} match${data.total === 1 ? "" : "es"} for "${state.q}"`, "label")],
    blank(),
    listBody(data.list, state, { empty: "nothing matched.", metaWidth: 14 }),
  );
}

const RENDER = {
  overview: renderOverview, writing: renderWriting, reading: renderReading,
  listening: renderListening, photos: renderPhotoFacets, around: renderAround,
  coffee: renderCoffee, deploys: renderDeploys, search: renderSearch,
};

// ── the key loop ──────────────────────────────────────────────────────────
// Pane data is memoized per pane for the life of one request, which is what
// makes a sequence like "2jj5kk1" cost three loads rather than seven. It also
// means a sequence that returns to a pane sees the data it saw the first time,
// which is the correct reading of "these keys were pressed at one moment".
async function driveFinger(env, ctx, request, state, tokens) {
  const loaded = new Map();
  const load = async (name) => {
    if (!loaded.has(name)) loaded.set(name, await PANES[name](env, ctx, request, state));
    return loaded.get(name);
  };

  let data = await load(state.pane);
  for (const key of tokens) {
    const digit = "123456789".indexOf(key);
    if (digit >= 0 && digit < FINGER_PANES.length) {
      state.pane = FINGER_PANES[digit];
      state.cursor = 0; state.open = "";
      data = await load(state.pane);
      continue;
    }
    const list = data.list || [];
    if (key === "j" && list.length) state.cursor = Math.min(state.cursor + 1, list.length - 1);
    else if (key === "k" && list.length) state.cursor = Math.max(state.cursor - 1, 0);
    else if (key === "g") state.cursor = 0;
    else if (key === "G" && list.length) state.cursor = list.length - 1;
    else if ((key === "\r" || key === "l") && list.length) state.open = list[Math.min(state.cursor, list.length - 1)]?.id ?? "";
    else if (key === "h" || key === "\x1b") state.open = "";
    else if (key === "?") state.help = true;
    else if (key === "q") state.quit = true;
    else if (key === "/") state.pane = "search";
    if (state.pane === "search" && key === "/") data = await load("search");
  }
  return data;
}

function fingerStatus(state, data) {
  const index = FINGER_PANES.indexOf(state.pane) + 1;
  const hints = state.open
    ? [["h", "back"], ["j/k", "move"], ["1-9", "pane"], ["q", "quit"]]
    : [["1-9", "pane"], ["j/k", "move"], ["<cr>", "open"], ["/", "search"], ["?", "help"], ["q", "quit"]];
  return [
    keyHints(hints),
    stateLine(state, `pane ${index}/${FINGER_PANES.length} · ${state.pane}`),
  ];
}

function helpBody() {
  return rows(
    rule(INNER, "driving this thing"),
    ...wrap("Every frame is one HTTP request. Send a key with ?k= (one key) or ?keys= (a sequence, up to 32). The state that produced a frame is printed in its status bar, so you can bookmark it, fork it, or hand it to somebody else.", INNER).map((row) => [s(row)]),
    blank(),
    rule(INNER, "keys"),
    kv("1-9", "jump to a pane", INNER, { gutter: 10 }),
    kv("j / k", "move the cursor down / up", INNER, { gutter: 10 }),
    kv("g / G", "first / last row", INNER, { gutter: 10 }),
    kv("<cr>", "open the row under the cursor", INNER, { gutter: 10 }),
    kv("h", "back out of an opened row", INNER, { gutter: 10 }),
    kv("/", "the search pane (add &q=…)", INNER, { gutter: 10 }),
    kv("?", "this screen", INNER, { gutter: 10 }),
    kv("q", "quit", INNER, { gutter: 10 }),
    blank(),
    rule(INNER, "panes"),
    ...FINGER_PANES.map((name, i) => kv(`${i + 1}`, name, INNER, { gutter: 10 })),
    blank(),
    rule(INNER, "examples"),
    [s("  curl aadhar.sh/finger", "accent")],
    [s("  curl 'aadhar.sh/finger?keys=2jj<cr>'", "accent")],
    [s("  curl 'aadhar.sh/finger?pane=search&q=lattice'", "accent")],
    [s("  curl 'aadhar.sh/photos?film=acros'", "accent")],
    [s("  curl 'aadhar.sh/lens?url=https://example.com'", "accent")],
  );
}

function quitBody() {
  return rows(
    blank(),
    [s("  connection closed.", "strong")],
    blank(),
    ...wrap("Nothing was stored, so there is nothing to resume — start again at /finger, or jump straight back to wherever you were with the URL that frame printed.", INNER).map((row) => [s("  " + row, "dim")]),
    blank(),
  );
}

export async function fingerFrame(env, ctx, request, state, tokens) {
  if (state.quit) return { title: "finger — aadharsh@aadhar.sh", body: quitBody(), status: keyHints([["/finger", "reconnect"]]) };
  const data = await driveFinger(env, ctx, request, state, tokens);
  if (state.help) return { title: "finger — help", body: helpBody(), status: keyHints([["any pane key", "leave help"], ["q", "quit"]]) };
  const body = RENDER[state.pane](data, state);
  return { title: `finger — aadharsh@aadhar.sh`, body, status: fingerStatus(state, data) };
}

// ── photos ────────────────────────────────────────────────────────────────
const PAGE = 12;

export async function photosFrame(env, ctx, state, tokens) {
  for (const key of tokens) {
    if (key === "n") { state.page += 1; state.cursor = 0; state.open = ""; }
    else if (key === "p") { state.page = Math.max(0, state.page - 1); state.cursor = 0; state.open = ""; }
    else if (key === "h" || key === "\x1b") state.open = "";
    else if (key === "q") state.quit = true;
  }
  if (state.quit) return { title: "photos", body: quitBody(), status: keyHints([["/photos", "reconnect"]]) };

  const result = await queryPhotos(env, {
    q: state.q, film: state.film, camera: state.camera, lens: state.lens,
    limit: PAGE, offset: state.page * PAGE,
  }, ctx);

  // j/k move within the page that was just fetched, so the cursor is applied
  // AFTER the query rather than before it — otherwise a cursor from the previous
  // page's length could point past the end of this one.
  for (const key of tokens) {
    if (key === "j") state.cursor = Math.min(state.cursor + 1, Math.max(0, result.photos.length - 1));
    else if (key === "k") state.cursor = Math.max(0, state.cursor - 1);
    else if (key === "\r" || key === "l") state.open = result.photos[Math.min(state.cursor, result.photos.length - 1)]?.stem || "";
  }

  const filters = [
    state.q && `q=${state.q}`, state.film && `film=${state.film}`,
    state.camera && `camera=${state.camera}`, state.lens && `lens=${state.lens}`,
  ].filter(Boolean).join("  ") || "none";

  if (state.open) {
    const photo = result.photos.find((p) => p.stem === state.open)
      || (await queryPhotos(env, { q: state.open, limit: 1 }, ctx)).photos[0];
    if (!photo) return { title: "photos", body: [[s("no such frame.", "dim")]], status: keyHints([["h", "back"]]) };
    const meta = photo.metadata || {};
    const recipe = meta.recipe || {};
    return {
      title: `photos — ${photo.stem}`,
      body: rows(
        ...wrap(photo.alt || "", INNER).map((row) => [s(row)]),
        blank(),
        rule(INNER, "exposure"),
        kv("body", meta.camera, INNER), kv("lens", meta.lens, INNER),
        kv("shutter", meta.shutter, INNER), kv("aperture", meta.aperture, INNER),
        kv("iso", meta.iso, INNER), kv("focal length", meta.focal, INNER),
        kv("shot", meta.date, INNER),
        blank(),
        rule(INNER, "recipe"),
        // The recipe card is the whole point of publishing this metadata: it is
        // the set of in-camera settings a look was made with, so somebody can
        // re-shoot it. Rendered verbatim, in the camera's own field names.
        ...(Object.keys(recipe).length
          ? Object.entries(recipe).map(([field, value]) => kv(field, value, INNER, { gutter: 24 }))
          : [[s("no recipe recorded for this frame.", "dim")]]),
        blank(),
        kv("full size", photo.full, INNER, { style: "accent" }),
      ),
      status: [keyHints([["h", "back"], ["q", "quit"]]), stateLine(state)],
    };
  }

  const shown = result.photos;
  const from = result.offset + 1;
  const to = Math.min(result.offset + shown.length, result.total);
  return {
    title: "photos — the archive",
    body: rows(
      kv("filters", filters, INNER, { gutter: 10 }),
      kv("showing", result.total ? `${from}-${to} of ${result.total}` : "0 of 0", INNER, { gutter: 10 }),
      blank(),
      shown.length
        ? table({
          cols: [{ title: "", width: 2 }, { title: "frame", width: 16 }, { title: "film", width: 17 }, { title: "caption" }],
          rows: shown.map((photo, i) => {
            const sel = i === Math.min(state.cursor, shown.length - 1);
            const style = sel ? "sel" : null;
            return [[s(sel ? "▶" : "", style)], [s(photo.stem, style)], [s(photo.metadata?.film || "—", sel ? "sel" : "dim")], [s(photo.alt || "", style)]];
          }),
          width: INNER,
        })
        : [[s("no frame matches those filters.", "dim")]],
      blank(),
      [s("filter with &q= &film= &camera= &lens=  ·  facets at /finger?pane=photos", "dim")],
    ),
    status: [
      keyHints([["j/k", "move"], ["<cr>", "open"], ["n/p", "page"], ["q", "quit"]]),
      stateLine(state),
    ],
  };
}

// ── lens ──────────────────────────────────────────────────────────────────
const verdictStyle = (level) => (level >= 4 ? "ok" : level >= 2 ? "warn" : "bad");

function lensReadout(obs) {
  const doorNames = Object.entries(obs.surfaces || {}).filter(([, on]) => on).map(([name]) => name);
  return rows(
    kv("url", obs.finalUrl || obs.url, INNER, { style: "accent" }),
    obs.redirected ? kv("redirected", "yes, from " + obs.url, INNER) : blank(),
    kv("status", obs.status, INNER),
    kv("content type", obs.contentType, INNER),
    kv("title", obs.title, INNER),
    blank(),
    rule(INNER, "how it reads to a machine"),
    kv("readiness", obs.levelName ? [s(`${obs.levelName} (${obs.readiness})`, verdictStyle(obs.level))] : dash(null), INNER),
    kv("tier", obs.tier, INNER),
    kv("words", obs.wordCount, INNER),
    kv("bytes", obs.bytes, INNER),
    obs.parseTruncated
      ? kv("parsed", [s(`first ${Math.round(obs.parsedBytes / 1024)} KB of ${Math.round(obs.bytes / 1024)} KB — words and cost are for that prefix`, "warn")], INNER)
      : blank(),
    kv("fetch", obs.elapsedMs == null ? null : `${obs.elapsedMs} ms`, INNER),
    blank(),
    rule(INNER, "agent doors"),
    kv("open", obs.doors ? `${obs.doors}` : "0", INNER),
    kv("which", doorNames.length ? doorNames.join(", ") : null, INNER),
    blank(),
    obs.cost
      ? kv("cost to read", `$${obs.cost.usdPerRead} per scan (${obs.cost.tokens.toLocaleString()} tokens, ${obs.cost.model})`, INNER, { gutter: 14 })
      : [s("cost is only priced for HTML bodies.", "dim")],
  );
}

export async function lensFrame(env, request, state, ctx) {
  if (!state.url) {
    return {
      title: "lens — the other web",
      body: rows(
        ...wrap("Inspect any public URL the way a machine does: what it returns, how much of it is readable, and which agent doors it leaves open.", INNER).map((row) => [s(row)]),
        blank(),
        [s("  curl 'aadhar.sh/lens?url=https://example.com'", "accent")],
        blank(),
        ...wrap("Private, local, and non-HTTP targets are refused. Lookups are rate-limited to 30/min per address, shared with /lens/fetch — knocking on the cheaper door does not buy a second budget.", INNER).map((row) => [s(row, "dim")]),
      ),
      status: keyHints([["&url=", "inspect a target"]]),
    };
  }
  const target = validateLensTarget(state.url);
  if (!target.ok) {
    return { title: "lens — refused", body: [[s(target.error, "bad")]], status: keyHints([["&url=", "try another target"]]) };
  }
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env, ctx)) {
    return { title: "lens — rate limited", body: [[s("30 lookups a minute, shared with /lens/fetch. Try again shortly.", "warn")]], status: [] };
  }
  let obs;
  try {
    obs = lensObservationSummary(await lensInspect(target.url, env, { skipBotViews: true }));
  } catch {
    return { title: "lens — failed", body: [[s("the target could not be inspected.", "bad")]], status: [] };
  }
  return { title: `lens — ${obs.finalUrl || obs.url}`, body: lensReadout(obs), status: [keyHints([["&url=", "another target"]]), stateLine(state)] };
}

// ── ask: the natural-language door ────────────────────────────────────────
// The frame leads with WHAT THE AGENT DID, not with the answer. That ordering
// is the whole point of putting this in a console rather than in a chat box:
// the interesting artifact is a machine choosing among seven tools and being
// wrong or right in public, and an answer printed on its own hides exactly that.
// The reproduce section closes the loop by naming the request an agent would
// have sent to get the same thing without a model in the way.

/** A compact rendering of one tool result, for the no-model path. */
function resultRows(tool, out) {
  if (!out || out._error) return [[s(out?._error || "the tool failed.", "bad")]];
  const list = (items, line) => (items.length ? items.slice(0, 8).map(line) : [[s("nothing matched.", "dim")]]);
  if (tool === "search_site") return list(out.results || [], (r) => [...fit([s(r.title || "")], INNER - 30), s(r.url || "", "accent")]);
  if (tool === "photo_query") return list(out.photos || [], (p) => [...fit([s(p.stem, "strong")], 18), s(p.alt || "", "dim")]);
  if (tool === "now_playing") return list(out.tracks || [], (t) => [...fit([s(t.name || "")], INNER - 26), s((t.artists || []).map((a) => a.name).join(", "), "dim")]);
  if (tool === "coffee_availability") return out.available
    ? list(out.slots || [], (slot) => [s(String(slot.start || ""))])
    : [[s("no bookable slots published right now.", "warn")]];
  if (tool === "change_radar") return list(out.changes || [], (c) => [...fit([s(c.host || c.url || "")], 32), s(c.kind || "", "dim")]);
  if (tool === "lens_inspect") return lensReadout(out);
  return [[s("done.", "dim")]];
}

/**
 * The session line. Prints the id to send back for a follow-up, and says loudly
 * when a transcript is TAINTED — because a tainted session silently answering
 * without tools would look like the model simply choosing not to use them.
 */
const sessionLine = (result) => {
  if (!result.session) return [s("")];
  const head = [s("session ", "label"), s(result.session.slice(0, 8), "accent"),
    s(result.turns ? `  turn ${result.turns}` : "", "dim")];
  return result.tainted
    ? [...head, s("  TAINTED — third-party text is in this transcript, so tools stay off", "warn")]
    : head;
};

const MODE_NOTE = {
  model: "a model chose the tools",
  router: "NO MODEL IS BOUND HERE, so the tool was chosen by keyword",
  "router-fallback": "the model was unavailable, so the tool was chosen by keyword",
  limited: "rate limited",
  "model-notools": "tools withheld: this session has read a third party",
  empty: "",
};

export async function askFrame(env, request, state, ctx) {
  // `at=` alone is a real request — read that origin's doors and stop — so the
  // usage screen only stands in when there is neither a question nor a target.
  if (!state.q.trim() && !state.at.trim()) {
    return {
      title: "ask — plain language, real tools",
      body: rows(
        ...wrap("Ask this site something in plain language. It picks from the same seven tools an external agent gets at /mcp, calls them, and answers from what came back — and prints every call it made, so you can see the machine work rather than take its word.", INNER).map((row) => [s(row)]),
        blank(),
        [s("  curl 'aadhar.sh/ask?q=what+does+he+write+about'", "accent")],
        [s("  curl 'aadhar.sh/ask?q=photos+shot+on+classic+chrome'", "accent")],
        [s("  curl 'aadhar.sh/ask?q=when+can+i+get+coffee'", "accent")],
        blank(),
        ...wrap("Point it at somebody else's origin with &at= and it reads THEIR agent doors the same way — llms.txt, a markdown twin, an agent card, a real MCP tools/list. Add a question and a model answers from what it found.", INNER).map((row) => [s(row)]),
        blank(),
        [s("  curl 'aadhar.sh/ask?at=https://example.com'", "accent")],
        [s("  curl 'aadhar.sh/ask?at=https://example.com&q=what+do+they+offer'", "accent")],
        blank(),
        rule(INNER, "the rules it runs under"),
        kv("grounding", "answers only from tool results; says so when the site is silent", INNER, { gutter: 12 }),
        kv("bounds", `${ASK_LIMITS.query} chars in, ${ASK_LIMITS.calls} tool calls, ${ASK_LIMITS.rounds} rounds`, INNER, { gutter: 12 }),
        kv("rate", `${ASK_BUDGET.max}/min per address — the tools underneath are not limited by this`, INNER, { gutter: 12 }),
      ),
      status: keyHints([["&q=", "ask something"]]),
    };
  }

  const result = await runAsk(state.q, request, env, ctx, state.at, state.session);

  // Reading somebody else's origin: show which doors opened before anything
  // else. A door that is shut is as informative as one that is open, so every
  // one is listed either way rather than only the hits.
  if (result.doors || result.mode === "refused") {
    const doors = result.doors;
    // Three states, not two. "shut" is a finding; "unread" is an absence of one,
    // and painting the second as the first is how a reader starts lying.
    const door = (label, probe, detail) => {
      const mark = probe.ok ? ["  open ", "ok"] : probe.unreadable ? ["unread ", "warn"] : ["  shut ", "dim"];
      return [...fit([s(mark[0], mark[1]), s(label)], 30), s(detail || "", "dim")];
    };
    const body = doors ? rows(
      rule(INNER, `doors at ${doors.origin}`),
      door("llms.txt", doors.llms, doors.llms.ok ? `${doors.llms.bytes} bytes` : doors.llms.why || doors.llms.wrongType),
      door("markdown twin", doors.markdown, doors.markdown.ok ? `${doors.markdown.bytes} bytes` : doors.markdown.wrongType ? `answered ${doors.markdown.wrongType}` : doors.markdown.why),
      door("agent card", doors.agentCard, doors.agentCard.ok ? "present" : doors.agentCard.why || doors.agentCard.wrongType),
      door("api catalog", doors.apiCatalog, doors.apiCatalog.ok ? "present" : doors.apiCatalog.why || doors.apiCatalog.wrongType),
      door("mcp tools/list", doors.mcp, doors.mcp.ok ? `${doors.mcp.count} tools` : doors.mcp.detail || "no server"),
      blank(),
      // The foreign catalog is INFORMATION. Nothing here can invoke it, and the
      // frame says so, because a list of tools next to an answer invites the
      // assumption that the answer came from calling them.
      doors.mcp.ok && doors.mcp.tools.length ? rows(
        rule(INNER, "their tools — listed, never called"),
        ...doors.mcp.tools.slice(0, 6).map((tool) => [...fit([s(tool.name, "strong")], 24), s(tool.description, "dim")]),
        blank(),
      ) : blank(),
      rule(INNER, "answer"),
      result.answer
        ? rows(...wrap(result.answer, INNER).map((row) => [s(row)]))
        : [[s(result.mode === "doors" && !state.q ? "no question asked — doors only." : "no model available to read this, so the doors above are the answer.", "dim")]],
    ) : [[s(result.answer || "refused.", "bad")]];

    return {
      title: `ask — ${doors ? doors.origin : state.at}`,
      body,
      status: [
        [s("mode ", "label"), s(result.mode, result.mode === "foreign" ? "ok" : result.mode === "refused" ? "bad" : "warn"),
          s(result.mode === "foreign" ? `  ${result.corpusChars} chars read as UNTRUSTED data, no tools offered on that turn` : "", "dim")],
        sessionLine(result),
        stateLine({ ...state, session: result.session || state.session }),
      ],
    };
  }
  const steps = result.steps || [];
  const trace = steps.length
    ? steps.map((step, i) => {
      const args = JSON.stringify(step.args || {});
      const head = `${String(i + 1).padStart(2)} `;
      return [
        s(head, "dim"),
        ...fit([s(step.tool, step.refused ? "bad" : "strong"), s(" " + (args === "{}" ? "" : args), "dim")], INNER - head.length - 22),
        ...rightTo([s(step.summary, "label")], 22),
      ];
    })
    : [[s("no tool was called.", "dim")]];

  return {
    title: `ask — ${state.q}`,
    body: rows(
      rule(INNER, "what the agent did"),
      trace,
      blank(),
      rule(INNER, "answer"),
      // Two shapes, and which one appears says which mode ran. With a model the
      // answer is prose it wrote from the results; without one there is no prose
      // to write, so the RESULT itself stands in rather than a fabricated
      // sentence. A router that invented an answer would be the one thing this
      // whole surface is built not to do.
      result.answer
        ? rows(...wrap(result.answer, INNER).map((row) => [s(row)]))
        : (steps.length && result.result ? resultRows(steps[0].tool, result.result) : [[s("no answer.", "dim")]]),
      blank(),
      rule(INNER, "reproduce this without a model"),
      ...(steps.filter((step) => !step.refused).slice(0, 2).map((step) =>
        [s(asAgentCall(step.tool, step.args), "accent")])),
    ),
    status: [
      [s("mode ", "label"), s(result.mode, result.mode === "model" ? "ok" : "warn"),
        s(`  ${MODE_NOTE[result.mode] || ""}`, "dim")],
      sessionLine(result),
      stateLine({ ...state, session: result.session || state.session }),
    ],
  };
}

// ── radar: the instrument for a sensor somebody else is holding ───────────
function radarIdleFrame() {
  return {
    title: "radar — post readings, get an instrument",
    body: rows(
      ...wrap("A server has no antenna and neither does an agent, so this half does not sense anything. POST signal readings and it draws them: concentric bands by strength, a meter and a trend per source.", INNER).map((row) => [s(row)]),
      blank(),
      [s("  node holding/scripts/radar-sample.mjs --at https://aadhar.sh", "accent")],
      [s("  curl -X POST aadhar.sh/radar -d '{\"samples\":[{\"name\":\"AP\",\"rssi\":-58}]}'", "accent")],
      blank(),
      rule(INNER, "the shape"),
      kv("name", "whatever you want on the label", INNER, { gutter: 10 }),
      kv("rssi", "dBm, negative; anything else is dropped rather than fatal", INNER, { gutter: 10 }),
      kv("kind", "optional tag, e.g. wifi or ble", INNER, { gutter: 10 }),
      kv("history", "optional trailing readings, for the trend sparkline", INNER, { gutter: 10 }),
      blank(),
      rule(INNER, "what it will not pretend to know"),
      ...wrap("RSSI is a scalar: it carries distance-ish information and no bearing. The rings are real; the angles are a hash of the name, stable so nothing jumps between frames, and meaningless. Bands are findphone's field calibration.", INNER).map((row) => [s(row, "dim")]),
      blank(),
      ...wrap("Nothing is stored. Post the whole set each time — which also means device names travel in the request, so use --anonymize when pointing the sampler at a public host.", INNER).map((row) => [s(row, "dim")]),
    ),
    status: keyHints([["POST", "readings"], [`${RADAR_LIMITS.samples}`, "max sources"]]),
  };
}

// ── dict: will a browser ever actually use your dictionary? ───────────────
const VERDICT_STYLE = { ok: "ok", warn: "warn", veto: "bad" };
const VERDICT_MARK = { ok: "  ok  ", warn: " warn ", veto: " VETO " };

export async function dictFrame(env, request, state, ctx) {
  if (!state.url.trim()) {
    return {
      title: "dict — compression dictionary lint",
      body: rows(
        ...wrap("Compression dictionaries fail silently. Chromium declines to register a perfectly good one because of a cache directive on it, and nothing tells you: no console warning, no header, no failed request. Your site just serves full responses forever while you believe it is serving deltas.", INNER).map((row) => [s(row)]),
        blank(),
        [s("  curl 'aadhar.sh/dict?url=https://example.com/app.js'", "accent")],
        blank(),
        rule(INNER, "what it checks"),
        ...wrap("The rules that decide registration, applied to the response headers of the resource you point it at, plus the other half of the handshake: whether a delta-serving response varies on available-dictionary. A cache that does not is not a slow page, it is ERR_CONTENT_DECODING_FAILED.", INNER).map((row) => [s(row, "dim")]),
        blank(),
        rule(INNER, "measured on this origin"),
        ...MEASURED.map(([label, value]) => kv(label, value, INNER, { gutter: 26 })),
        blank(),
        ...wrap("There is deliberately no delta calculator here. workerd's node:zlib has zstdCompressSync and SILENTLY IGNORES its dictionary option — measured 2026-08-05, identical byte counts with the right dictionary, a wrong one, and none. A delta computed here would be plain zstd reporting a saving that does not exist.", INNER).map((row) => [s(row, "dim")]),
      ),
      status: keyHints([["&url=", "audit a resource"]]),
    };
  }

  const target = validateLensTarget(state.url);
  if (!target.ok) return { title: "dict — refused", body: [[s(target.error, "bad")]], status: [] };
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env, ctx)) {
    return { title: "dict — rate limited", body: [[s("Shares Lens's 30/min budget. Try again shortly.", "warn")]], status: [] };
  }

  const audit = await auditUrl(target.url, env);
  if (!audit.ok) {
    return {
      title: "dict — unreadable",
      body: [[s(audit.unreadable ? `could not reach it: ${audit.why}` : audit.why, audit.unreadable ? "warn" : "bad")]],
      status: stateLine(state),
    };
  }

  const { dictionary, consumer } = audit;
  return {
    title: `dict — ${target.url}`,
    body: rows(
      kv("status", audit.status, INNER, { gutter: 16 }),
      kv("cache-control", dictionary.cacheControl || "(none)", INNER, { gutter: 16 }),
      blank(),
      rule(INNER, "as a dictionary"),
      // Every rule prints, including the ones that passed. A lint that shows only
      // failures leaves you unsure whether it looked.
      ...dictionary.results.map((r) => [
        s(VERDICT_MARK[r.verdict], VERDICT_STYLE[r.verdict]),
        ...fit([s(r.title, "strong")], 26),
        s(r.detail, "dim"),
      ]),
      blank(),
      dictionary.registers
        ? [s(dictionary.warns.length
          ? "  Chromium will register this, but read the warnings above."
          : "  Chromium will register this.", dictionary.warns.length ? "warn" : "ok")]
        : [s(`  Chromium will NOT register this: ${dictionary.vetoes.map((v) => v.title).join(", ")}.`, "bad")],
      blank(),
      rule(INNER, "as a delta-served response"),
      kv("content-encoding", consumer.encoding || "(none)", INNER, { gutter: 20 }),
      kv("vary", consumer.vary || "(none)", INNER, { gutter: 20 }),
      consumer.isDelta && !consumer.variesOnDictionary
        ? [s("  serving a delta WITHOUT vary: available-dictionary — a shared cache will hand", "bad")]
        : blank(),
      consumer.isDelta && !consumer.variesOnDictionary
        ? [s("  this to a client with no dictionary: ERR_CONTENT_DECODING_FAILED, not a slow page.", "bad")]
        : blank(),
    ),
    status: [
      [s("verdict ", "label"), s(dictionary.registers ? "registers" : "never registers", dictionary.registers ? "ok" : "bad")],
      stateLine(state),
    ],
  };
}

// ── cache: does your validator actually revalidate? ───────────────────────
const CACHE_MARK = { ok: "  ok  ", warn: " warn ", veto: " VETO ", "bad-but-explained": " 200  " };
const CACHE_STYLE = { ok: "ok", warn: "warn", veto: "bad", "bad-but-explained": "warn" };

export async function cacheFrame(env, request, state, ctx) {
  if (!state.url.trim()) {
    return {
      title: "cache — a behavioral revalidation lint",
      body: rows(
        ...wrap("Plenty of origins serve an ETag that can never match: compression or a template nonce varies per response, so every If-None-Match comes back 200 with a full body. The headers look perfect and nothing warns — your cache revalidates forever and never once succeeds.", INNER).map((row) => [s(row)]),
        blank(),
        [s("  curl 'aadhar.sh/cache?url=https://example.com/app.css'", "accent")],
        blank(),
        rule(INNER, "what it does"),
        ...wrap("No header grading. It fetches the target twice to see whether the validator survives two identical requests, then replays it with If-None-Match and reports what the origin actually did. For HTML it also asks for a second representation and checks the Vary header against the answer — the shared-cache trap this site hit in production (#195).", INNER).map((row) => [s(row, "dim")]),
        blank(),
        kv("cost", "3-4 subrequests, headers only; bodies are cancelled unread", INNER, { gutter: 8 }),
        kv("shares", "Lens's 30/min per-address budget", INNER, { gutter: 8 }),
      ),
      status: keyHints([["&url=", "probe a resource"]]),
    };
  }

  const target = validateLensTarget(state.url);
  if (!target.ok) return { title: "cache — refused", body: [[s(target.error, "bad")]], status: [] };
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env, ctx)) {
    return { title: "cache — rate limited", body: [[s("Shares Lens's 30/min budget. Try again shortly.", "warn")]], status: [] };
  }

  const probe = await probeRevalidation(target.url, env);
  if (!probe.ok) {
    return {
      title: "cache — unreadable",
      body: [[s(probe.unreadable ? `could not reach it: ${probe.why}` : probe.why, probe.unreadable ? "warn" : "bad")]],
      status: stateLine(state),
    };
  }

  const { verdict } = probe;
  return {
    title: `cache — ${target.url}`,
    body: rows(
      kv("status", probe.status, INNER, { gutter: 16 }),
      kv("cache-control", probe.observations.first.headers["cache-control"] || "(none)", INNER, { gutter: 16 }),
      blank(),
      rule(INNER, "what the origin actually did"),
      ...verdict.findings.map((f) => [
        s(CACHE_MARK[f.verdict] || "  ??  ", CACHE_STYLE[f.verdict] || "dim"),
        ...fit([s(f.id, "strong")], 16),
        s(f.detail, "dim"),
      ]),
      blank(),
      verdict.healthy
        ? [s("  Revalidation works: a warm client pays headers, not bodies.", "ok")]
        : [s(`  Revalidation is broken here: ${verdict.vetoes.map((v) => v.id).join(", ")}.`, "bad")],
    ),
    status: [
      [s("verdict ", "label"), s(verdict.healthy ? "revalidates" : "never revalidates", verdict.healthy ? "ok" : "bad")],
      stateLine(state),
    ],
  };
}

// ── the index frame ───────────────────────────────────────────────────────
function indexFrame() {
  const app = (name, line) => rows(
    [s(`  /terminal/${name}`, "accent")],
    ...wrap(line, INNER - 4).map((row) => [s("    " + row)]),
    blank(),
  );
  return {
    title: "aadhar.sh — terminal utilities",
    body: rows(
      ...wrap("Three programs, drawn as terminal frames. Each one answers a plain GET, so curl works and so does an agent with nothing but an HTTP client. The same frames are callable over MCP at /mcp.", INNER).map((row) => [s(row)]),
      blank(),
      rule(INNER, "programs"),
      blank(),
      app("finger", "Who runs this host: writing, reading, listening, photographs, neighborhood, availability, deploy log, and a search over all of it. Drivable — send keys, get the next frame."),
      app("photos", "The photo archive, filterable by film simulation, body, lens, and caption. Opening a frame shows its exposure and the in-camera recipe it was shot with."),
      app("lens", "Inspect any public URL the way a machine does: readability, agent doors, and what one scan of it costs to read."),
      app("cache", "Does your ETag ever actually 304? Fetches twice, replays the validator, and reports what the origin DID — the failure header-reading graders cannot see."),
      app("dict", "Will a browser ever actually use the compression dictionary you are serving? The registration rules are undocumented, unguessable, and fail in total silence. This encodes them, measured."),
      app("radar", "An instrument with no antenna: POST signal readings from a machine that has one and it draws them as bands, meters and trends. The sensor is yours; the display is here."),
      app("ask", "Plain language in, real tool calls out. Picks from the same seven tools /mcp exposes, calls them, answers from what came back, and prints every call it made."),
      rule(INNER, "driving"),
      ...wrap("?k=<one key> or ?keys=<up to 32>. Named keys: <cr> <esc> <tab> <sp>. Every frame prints the URL that produced it, so state is a link rather than a session. Add ?plain=1 to drop the ANSI colour.", INNER).map((row) => [s(row, "dim")]),
    ),
    status: keyHints([["/finger", "start here"], ["?", "help inside any app"]]),
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────
const TERMINAL_APPS = new Set(["finger", "photos", "lens", "ask", "radar", "dict", "cache"]);

async function buildFrame(name, request, env, ctx, url) {
  const tokens = tokenizeKeys(url.searchParams.get("keys") ?? url.searchParams.get("k") ?? "");
  if (!name) return indexFrame();
  const state = readState(url, name);
  if (name === "finger") return fingerFrame(env, ctx, request, state, tokens);
  if (name === "photos") return photosFrame(env, ctx, state, tokens);
  if (name === "lens") return lensFrame(env, request, state, ctx);
  if (name === "ask") return askFrame(env, request, state, ctx);
  if (name === "radar") return radarIdleFrame();
  if (name === "dict") return dictFrame(env, request, state, ctx);
  if (name === "cache") return cacheFrame(env, request, state, ctx);
  return null;
}

const frameLines = (frame) => windowFrame({ title: frame.title, body: frame.body, status: frame.status });

/** The frame as plain text: what curl, MCP, and the contract tests all read. */
export function frameText(frame, { color = false } = {}) {
  return emit(frameLines(frame), { color });
}

/**
 * The frame as classed HTML, for the boot output the server renders into the
 * console.
 *
 * This exists so the FIRST frame you see is coloured like every frame after it.
 * The obvious alternatives were both worse: emitting ANSI into the document
 * would show raw escapes with JavaScript off, and having the client re-fetch the
 * frame on boot would buy a wasted request and a visible flash.
 *
 * It reads the same span model emit() reads, so there is no second palette and
 * no ANSI parser on this side — a span's style NAME becomes a class, and the CSS
 * carries the colour. The client keeps its own SGR parser because it receives
 * frames over the wire as text; the two agree because the class colours below
 * are the xterm-256 values the escape codes resolve to.
 */
function frameMarkup(frame) {
  return frameLines(frame).map((spans) => {
    const inner = spans.map(([text, style]) =>
      (style ? `<span class="c-${style}">${escHtml(text)}</span>` : escHtml(text))).join("");
    return `<div class="ps-line">${inner}</div>`;
  }).join("");
}

// ── the browser view: a Windows PowerShell window ─────────────────────────
// The frame is SERVER-RENDERED into the console as boot output, and terminal.js
// then turns that scrollback into a shell you can type into. Two things fall out
// of doing it in that order rather than shipping an empty console and fetching:
// the route stays readable with JavaScript off, and an agent that asks for the
// HTML still gets the frame instead of a mount point. The same argument the rest
// of this site makes about SSR, applied to a terminal.
//
// PowerShell rather than cmd.exe, and that IS period-correct rather than a
// stretch: PowerShell 1.0 shipped for Windows XP in October 2006, on Luna. The
// #012456 blue and the copyright banner are the real ones.
//
// FONT NOTE, and the answer here is to stay on the design system rather than
// grow a stack. The console is `"Lucida Console", var(--font-mono)`: one native
// Windows font (the one PowerShell actually drew in, absent elsewhere and
// therefore free) in front of the token every other mono surface on this site
// already uses. No @font-face, no url(), no preload, no bytes.
//
// The thing to know before touching it: these frames are drawn in CP437 box
// characters, and a font missing those glyphs makes the browser substitute a
// DIFFERENT font for exactly them. If that substitute is not monospace-matched,
// every border in the frame tears. Measured on macOS with this stack (where
// Lucida Console is absent, so it is the token doing the work): box glyphs and
// ASCII both 7.2px, all 80 columns landing at one width. Re-measure if the
// stack changes; do not assume.
const PS_CSS = `/*min*/
.ps-window>.content{padding:0!important;overflow:hidden!important;display:flex;background:#012456}
.ps-window .title-bar .icon{background:#012456;border:1px solid #86a9e4;border-radius:2px;position:relative;overflow:hidden}
.ps-window .title-bar .icon::before{content:"";position:absolute;left:3px;top:50%;width:0;height:0;border:3px solid transparent;border-left-color:#fff;border-right-width:0;transform:translateY(-50%)}
.ps-window .title-bar .icon::after{content:"";position:absolute;left:8px;bottom:3px;width:5px;height:1px;background:#fff}
/* The font lives on .ps, not on .ps-line, so that the ch unit below resolves in
   the CONSOLE's font rather than the inherited UI one. 80ch in Tahoma is not 80
   columns of anything. */
.ps{flex:1 1 auto;min-height:0;overflow-y:scroll;overflow-x:auto;background:#012456;padding:6px 8px;cursor:text;font:12px/1.35 "Lucida Console",var(--font-mono)}
/* The window is sized to hold exactly 80 columns, the width a real console
   opens at: 576px of text (80 x 7.2) + 16px padding + 16px scrollbar + 16px of
   window chrome = 624, set as the lunaPage width. Left at the 760px page
   default it carried 136px of dead field to the right of every frame, which is
   the tell that a terminal is really a div.
   A pixel width and not 80ch, though ch is the honest unit here: max-content on
   the window collapsed it to 4px, because .content is overflow:hidden and
   contributes no intrinsic width, and resolving ch on the window itself would
   read the Tahoma caption font rather than the console's. So the width assumes
   the mono fallback measures 7.2px at 12px, which it does on the stacks in
   play. A machine that disagrees gets a few px of slack or a horizontal
   scrollbar, never a broken frame -- that is what overflow-x:auto above is
   for. */
.ps-line{color:#eeedf0;white-space:pre;min-height:1.35em}
.ps-banner{font-weight:bold}
/* The span palette, server side. Each colour is the xterm-256 value the matching
   SGR escape in lib/tui.js resolves to, so a frame rendered here and a frame
   parsed from the wire by terminal.js land on the same colour. Change one, change
   both -- and the 80-column contract test will not catch it, because colour is
   not width. */
.c-bar,.c-sel{color:#eee;background:#005faf;font-weight:bold}
.c-barDim{color:#afd7ff;background:#005faf}
.c-border,.c-label{color:#5f8787}
.c-key{color:#af8700;font-weight:bold}
.c-accent{color:#4f9fd8}
.c-ok{color:#00875f}
.c-warn{color:#af8700}
.c-bad{color:#af0000}
.c-dim{opacity:.65}
.c-strong{font-weight:bold}
.ps-dim{opacity:.7}
.ps-err{color:#ff9a9a}
.ps-form{display:flex;align-items:baseline;gap:0}
.ps-prompt{color:#eeedf0;white-space:pre}
.ps-input{flex:1;min-width:0;background:transparent;border:0;outline:0;padding:0;font:inherit;color:#eeedf0;caret-color:#eeedf0}
/* The classic Luna scrollbar, drawn on the console itself. A console window has
   its scrollbar INSIDE the frame against the dark field, which is a detail the
   eye reads before it reads any text; the page-level bar the rest of the site
   uses would sit outside the illusion. overflow-y is scroll rather than auto,
   for the same reason the real one is always drawn: a track that appears and
   disappears as output grows makes the whole window twitch.
   Two things about scrollbar-color, and BOTH are load-bearing here.
   Chromium IGNORES every ::-webkit-scrollbar rule on an element whose used
   scrollbar-color is not auto. The two mechanisms are mutually exclusive, and
   the failure is silent: you get the platform default, which on macOS is an
   overlay bar of ZERO width, reading as "my CSS did not load" rather than as a
   conflict.
   The trap is that scrollbar-color INHERITS, and xpChromeCss sets it on html
   for the whole site. So this element inherited a non-auto value it never
   declared, and every rule below was being discarded. Resetting to auto is what
   turns them back on -- measured here, 0px to 16px. If a console ever loses its
   scrollbar again, check the inherited value first.
   Firefox needs the standard property and does not support
   selector(::-webkit-scrollbar), so that query hands it the colours instead.
   NO BACKTICKS in here. This comment lives inside a JS template literal, so one
   would end the literal early -- which is exactly what happened, and what the
   build's post-substitution re-parse is there to catch. */
.ps{scrollbar-color:auto}
@supports not selector(::-webkit-scrollbar){.ps{scrollbar-color:oklch(62% .14 255) oklch(91% .02 248)}}
.ps::-webkit-scrollbar{width:16px}
.ps::-webkit-scrollbar-track{background:oklch(91% .02 248);border-left:1px solid oklch(78% .04 250)}
.ps::-webkit-scrollbar-thumb{background:linear-gradient(90deg,oklch(76% .10 253) 0%,oklch(66% .14 255) 45%,oklch(58% .16 257) 100%);border:1px solid oklch(45% .13 258);border-radius:2px}
.ps::-webkit-scrollbar-thumb:hover{background:linear-gradient(90deg,oklch(80% .11 253) 0%,oklch(70% .15 255) 45%,oklch(62% .17 257) 100%)}
.ps::-webkit-scrollbar-button:vertical{height:16px;background:oklch(91% .02 248) no-repeat center;border:1px solid oklch(78% .04 250)}
.ps::-webkit-scrollbar-button:vertical:decrement{background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%227%22%20height=%224%22%3E%3Cpath%20d=%22M3.5%200L7%204H0z%22%20fill=%22%23264f8c%22/%3E%3C/svg%3E")}
.ps::-webkit-scrollbar-button:vertical:increment{background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%227%22%20height=%224%22%3E%3Cpath%20d=%22M3.5%204L0%200h7z%22%20fill=%22%23264f8c%22/%3E%3C/svg%3E")}
.ps::-webkit-scrollbar-button:vertical:start:increment,.ps::-webkit-scrollbar-button:vertical:end:decrement{display:none}`;

function frameResponse(frame, path) {
  // One <div> per row, so the client script appends to the same scrollback
  // rather than replacing a <pre> it would have to parse.
  const scrollback = frameMarkup(frame);
  return lunaPage({
    title: `aadhar.sh${path}`,
    // The caption is the APPLICATION's, not the site's. Every other window here
    // is captioned with its path ("aadhar.sh/lens") because every other window
    // is a document; this one is a program, and a program's title bar says which
    // program it is. "Administrator:" is the real prefix an elevated console
    // carries, which is the state you would be in to go poking at a machine.
    path: "Administrator: Windows PowerShell",
    width: 624,
    description: "A PowerShell console on aadhar.sh: read this site the way an agent does.",
    robots: "noindex",
    cache: "no-store",
    css: PS_CSS,
    headers: { "x-robots-tag": "noindex" },
    windowClass: "ps-window",
    // No Back and Forward on this window — see the opt-out in nav.js. They are
    // BROWSER controls, and a console carrying them reads as a terminal running
    // inside Internet Explorer. Drag, resize, maximize and close all stay: those
    // are OS chrome, which a console window genuinely has.
    windowAttrs: "data-no-histnav",
    scripts: `<script src="/terminal.js" defer></script>`,
    body: `<div class="ps" data-ps-console tabindex="0">`
      + `<div class="ps-out">`
      + `<div class="ps-line ps-banner">Windows PowerShell</div>`
      + `<div class="ps-line ps-dim">Copyright (C) 2006 Microsoft Corporation. All rights reserved.</div>`
      + `<div class="ps-line"></div>`
      + scrollback
      + `</div>`
      // hidden until the script boots: a prompt you cannot type into is worse
      // than no prompt, because it looks broken rather than static.
      + `<form class="ps-form" hidden autocomplete="off">`
      + `<span class="ps-prompt">PS aadhar.sh\\&gt; </span>`
      + `<input class="ps-input" name="c" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`
      + `</form>`
      + `</div>`,
    // Nothing sits below the window. There WAS a paragraph here explaining that
    // the same frames answer curl and /mcp, and it was the single strongest tell
    // that this was a web page with a terminal pasted into it — real console
    // windows do not come with a caption underneath. The same sentence lives in
    // the console's own boot output, where a terminal would actually say it.
  });
}

// ── routing: a tool is a SERVICE, the frame is a REPRESENTATION ───────────
// Tools live at the ROOT, next to /lens and /photos and /coffee, because that is
// where this site has always put utilities — site-manifest.json has twelve of
// them and eleven are top-level, while all twenty-nine content pages nest. They
// were briefly filed under /terminal/*, which organised them by how they RENDER
// rather than by what they are, and taught exactly the wrong lesson for a site
// whose argument is "here is how you expose services to agents".
//
// So the frame joins .md as a REPRESENTATION rather than a location, and every
// tool answers three ways from one URL:
//
//   /dict                       Accept: text/html  -> the page
//   /dict                       anything else      -> the frame (curl, agents)
//   /dict.txt                                      -> the frame, explicitly
//
// Exactly the markdown-twin contract this site already runs on. /terminal keeps
// its own route because it is not their parent, it is a CONSOLE that drives
// them — the interaction is the product there, not the namespace.
export const TOOL_NAMES = TERMINAL_APPS;

/** Shared by the console and by every tool route. */
async function serveFrame(name, request, env, ctx, { explicitText = false } = {}) {
  const url = new URL(request.url);

  // radar is the ONE tool that takes a POST, because it is the one whose input
  // this server cannot produce: the readings come from a machine with an
  // antenna. Everything else stays GET-only, so the surface does not quietly
  // become writable.
  if (request.method === "POST" && name === "radar") {
    let payload = null;
    try { payload = await request.json(); } catch { payload = null; }
    const samples = readSamples(payload);
    const frame = radarFrame(samples, { source: String(payload?.source || "").slice(0, 60) });
    return new Response(frameText(frame, { color: url.searchParams.get("plain") !== "1" }) + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", {
      status: 405,
      headers: { allow: name === "radar" ? "GET, HEAD, POST" : "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const frame = await buildFrame(name, request, env, ctx, url);
  const wantsHtml = !explicitText
    && (request.headers.get("accept") || "").includes("text/html")
    && !url.searchParams.has("plain");

  if (wantsHtml) return frameResponse(frame, url.pathname);
  // ANSI by default over plain HTTP, because the usual caller of a text/plain
  // route from a terminal IS a terminal. ?plain=1 drops it; MCP never asks for it.
  return new Response(frameText(frame, { color: url.searchParams.get("plain") !== "1" }) + "\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Frames are per-query and several are live (playlist, calendar, lens), so
      // no shared cache should hold one. The route also negotiates on Accept,
      // which a URL-keyed edge cache cannot represent — the trap lib/cache.js
      // documents for the markdown twins.
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      vary: "accept",
    },
  });
}

/** /finger, /ask, /radar, /dict, /cache — and their .txt representations. */
export async function handleTool(request, env, ctx) {
  const url = new URL(request.url);
  const raw = url.pathname.replace(/^\//, "").replace(/\/+$/, "");
  const explicitText = raw.endsWith(".txt");
  const name = raw.replace(/\.txt$/, "");
  if (!TOOL_NAMES.has(name)) {
    return new Response(`no such tool: ${name}\n\ntry /terminal\n`, {
      status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return serveFrame(name, request, env, ctx, { explicitText });
}

/** /terminal — the PowerShell console that drives the tools above. */
export async function handleTerminal(request, env, ctx) {
  const url = new URL(request.url);
  return serveFrame("", request, env, ctx, { explicitText: url.pathname.endsWith(".txt") });
}

/** The MCP entry point: a frame as plain text, never coloured. */
export async function terminalToolFrame(app, args, request, env, ctx) {
  const url = new URL(`https://aadhar.sh/terminal/${app}`);
  for (const [key, value] of Object.entries(args || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value).slice(0, 512));
  }
  const frame = await buildFrame(app, request, env, ctx, url);
  if (!frame) return { _error: `unknown tui program: ${app}` };
  return { frame: frameText(frame, { color: false }), url: url.pathname + url.search };
}
