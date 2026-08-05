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
// ── the session is query params, not a session ────────────────────────────
// State lives entirely in the URL: ?pane=writing&cursor=3&open=lattice. There is
// no Durable Object, no KV entry, no token, no TTL, and nothing to expire.
//
// That is a deliberate trade against the obvious design (a DO holding a cursor).
// Three things fall out of it, and each one is worth more here than server-side
// state would be:
//
//   1. No round trip. counter.js measures a DO hop at 185-630ms because a DO is
//      one global instance; a TUI is a latency-shaped thing where every keypress
//      pays that. Params cost nothing.
//   2. Sessions FORK. Two agents can explore from the same frame without
//      colliding, and a third can resume a transcript from last week, because a
//      state is a URL rather than a live object someone has to still be holding.
//   3. It is inspectable. A site whose whole argument is "here is what the
//      machine sees" should not hand an agent an opaque blob and ask it to send
//      the blob back. You can read the state, edit it by hand, and bookmark it.
//
// The cost is that a frame can't hold anything the URL can't spell. No scroll
// offsets in pixels, no partial input buffers, no undo stack. Every app here is
// a reader over public data, so that ceiling has not bound yet. It would bind
// the moment one of these apps needed to WRITE something, and at that point the
// answer is a real session rather than a longer query string.
import { readAroundChanges } from "./around.js";
import { readCoffeeAvailability } from "./coffee.js";
import { LENS_BUDGETS, lensInspect, lensObservationSummary, overLensBudget, validateLensTarget } from "./lens.js";
import { lunaPage } from "./lib/chrome.js";
import { escHtml } from "./lib/http.js";
import { AGENT_SURFACES } from "./lib/site-manifest.js";
import {
  COLS, blank, emit, fit, keys as keyHints, kv, meter, pane, rows, rule, s, table, windowFrame, wrap,
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
  } else if (state.app === "lens") {
    put("url", state.url); put("left", state.left); put("right", state.right);
  }
  for (const [key, value] of Object.entries(extra)) put(key, value);
  const qs = params.toString();
  return `/terminal/${state.app}${qs ? `?${qs}` : ""}`;
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
    [s("browse the frames themselves at /terminal/photos", "dim")],
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
      [s("  /terminal/finger?pane=search&q=lattice", "accent")],
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
    [s("  curl aadhar.sh/terminal/finger", "accent")],
    [s("  curl 'aadhar.sh/terminal/finger?keys=2jj<cr>'", "accent")],
    [s("  curl 'aadhar.sh/terminal/finger?pane=search&q=lattice'", "accent")],
    [s("  curl 'aadhar.sh/terminal/photos?film=acros'", "accent")],
    [s("  curl 'aadhar.sh/terminal/lens?url=https://example.com'", "accent")],
  );
}

function quitBody() {
  return rows(
    blank(),
    [s("  connection closed.", "strong")],
    blank(),
    ...wrap("Nothing was stored, so there is nothing to resume — start again at /terminal/finger, or jump straight back to wherever you were with the URL that frame printed.", INNER).map((row) => [s("  " + row, "dim")]),
    blank(),
  );
}

export async function fingerFrame(env, ctx, request, state, tokens) {
  if (state.quit) return { title: "finger — aadharsh@aadhar.sh", body: quitBody(), status: keyHints([["/terminal/finger", "reconnect"]]) };
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
  if (state.quit) return { title: "photos", body: quitBody(), status: keyHints([["/terminal/photos", "reconnect"]]) };

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
      [s("filter with &q= &film= &camera= &lens=  ·  facets at /terminal/finger?pane=photos", "dim")],
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
        [s("  curl 'aadhar.sh/terminal/lens?url=https://example.com'", "accent")],
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
      rule(INNER, "driving"),
      ...wrap("?k=<one key> or ?keys=<up to 32>. Named keys: <cr> <esc> <tab> <sp>. Every frame prints the URL that produced it, so state is a link rather than a session. Add ?plain=1 to drop the ANSI colour.", INNER).map((row) => [s(row, "dim")]),
    ),
    status: keyHints([["/terminal/finger", "start here"], ["?", "help inside any app"]]),
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────
const TERMINAL_APPS = new Set(["finger", "photos", "lens"]);

async function buildFrame(name, request, env, ctx, url) {
  const tokens = tokenizeKeys(url.searchParams.get("keys") ?? url.searchParams.get("k") ?? "");
  if (!name) return indexFrame();
  const state = readState(url, name);
  if (name === "finger") return fingerFrame(env, ctx, request, state, tokens);
  if (name === "photos") return photosFrame(env, ctx, state, tokens);
  if (name === "lens") return lensFrame(env, request, state, ctx);
  return null;
}

/** The frame as plain text: what curl, MCP, and the contract tests all read. */
export function frameText(frame, { color = false } = {}) {
  return emit(windowFrame({ title: frame.title, body: frame.body, status: frame.status }), { color });
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
// FONT NOTE, because it is the one place this departs from design/tokens: the
// console stack leads with Lucida Console, the font PowerShell actually drew in.
// Every entry is a NATIVE system font, so the zero-font-bytes rule is intact and
// no @font-face or preload appears anywhere; what bends is the three-stacks rule,
// for the one element on the site imitating a specific Microsoft application.
//
// Consolas and Menlo sit between it and Courier New for a structural reason
// rather than taste. These frames are drawn in CP437 box characters, and a font
// without those glyphs makes the browser substitute a DIFFERENT font for them —
// which lands at a different advance width and tears every border in the frame.
// Menlo (macOS) and DejaVu Sans Mono (Linux) both carry the full box-drawing
// block at the monospace advance, so the fallback chain degrades in FIDELITY
// rather than in alignment. Measured on macOS: box glyphs and ASCII both at
// 7.2px, all 80 columns landing at one width.
const PS_CSS = `/*min*/
.ps{background:#012456;border:1px solid oklch(35% .02 255);box-shadow:inset 1px 1px 3px #001028;padding:10px 12px;height:34rem;overflow:auto;cursor:text}
.ps-line{font:12px/1.35 "Lucida Console",Consolas,Menlo,"DejaVu Sans Mono","Courier New",Courier,monospace;color:#eeedf0;white-space:pre;min-height:1.35em}
.ps-banner{color:#eeedf0;font-weight:bold}
.ps-dim{opacity:.7}
.ps-err{color:#ff9a9a}
.ps-echo{color:#eeedf0}
.ps-form{display:flex;align-items:baseline;gap:0}
.ps-prompt{font:12px/1.35 "Lucida Console",Consolas,Menlo,"DejaVu Sans Mono","Courier New",Courier,monospace;color:#eeedf0;white-space:pre}
.ps-input{flex:1;background:transparent;border:0;outline:0;padding:0;font:12px/1.35 "Lucida Console",Consolas,Menlo,"DejaVu Sans Mono","Courier New",Courier,monospace;color:#eeedf0;caret-color:#eeedf0}
.ps-note{color:oklch(47% 0 0);font-size:9pt;margin:10px 0 0}
.ps-note code{font-family:"Courier New",Courier,monospace}`;

function frameResponse(frame, path) {
  const text = frameText(frame, { color: false });
  // The boot output is the frame, one <div> per row, so the client script can
  // append to the same scrollback rather than replacing a <pre> it has to parse.
  const scrollback = text.split("\n").map((row) => `<div class="ps-line">${escHtml(row)}</div>`).join("");
  return lunaPage({
    title: `aadhar.sh${path}`,
    path: "Windows PowerShell",
    width: 760,
    description: "A PowerShell console on aadhar.sh: read this site the way an agent does.",
    robots: "noindex",
    cache: "no-store",
    css: PS_CSS,
    headers: { "x-robots-tag": "noindex" },
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
      + `</div>`
      + `<p class="ps-note">Every command here makes the same request an agent would. The same frames answer <code>curl aadhar.sh${path}</code> and the MCP server at <code>/mcp</code>.</p>`,
  });
}

export async function handleTerminal(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" } });
  }
  const rest = url.pathname.replace(/^\/terminal\/?/, "").replace(/\/+$/, "");
  const name = rest.replace(/\.(txt|md)$/, "");
  if (name && !TERMINAL_APPS.has(name)) {
    return new Response(`no such program: ${name}\n\ntry /terminal\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  const frame = await buildFrame(name, request, env, ctx, url);
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html") && !url.searchParams.has("plain") && !rest.endsWith(".txt");

  if (wantsHtml) return frameResponse(frame, url.pathname);
  // ANSI by default over plain HTTP, because the default caller of a text/plain
  // route from a terminal IS a terminal. ?plain=1 drops it, and MCP never asks
  // for it at all.
  const color = url.searchParams.get("plain") !== "1";
  return new Response(frameText(frame, { color }) + "\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Frames are per-query and several are live (playlist, calendar, lens), so
      // no shared cache should hold one. The route is also content-negotiated on
      // Accept, which a URL-keyed edge cache cannot represent — the same trap
      // lib/cache.js documents for the markdown twins.
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      vary: "accept",
    },
  });
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
