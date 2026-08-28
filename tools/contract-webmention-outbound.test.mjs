// ── webmention (outbound) ───────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  PROFILES,
  SELF_LINK_HOSTS,
  assert,
  citationsIn,
  cronSendWebmentions,
  test,
} from "./contract-shared.ts";

// ── webmention (outbound) ───────────────────────────────────────────────────
test("outbound citations exclude the shell, self-links, and non-public URLs", () => {
  const origin = "https://aadhar.sh";
  const page = `
    <head><link rel="canonical" href="https://aadhar.sh/garage/chunks"><a href="https://head-link.example/nope">head</a></head>
    <body>
      <!-- axp:desktop --><div id="axp-desktop"></div><!-- /axp:desktop -->
      <p>Concepts credit <a href="https://github.com/officialunofficial/mkit">officialunofficial/mkit</a>,
         and the streaming docs at <a href="https://mkit.makechain.net/streaming">makechain</a>.</p>
      <p>See also <a href="https://docs.makechain.net/#anchor">the docs</a> and
         <a href="/garage/encoding">my own page</a> and <a href="mailto:a@b.c">mail</a>.</p>
      <p>Dupe: <a href="https://github.com/officialunofficial/mkit">same repo again</a></p>
      <p>Blocked: <a href="http://127.0.0.1/x">local</a> <a href="http://169.254.169.254/meta">metadata</a></p>
      <p>Hover cards, not citations:
         <a interestfor="pop-singer" href="https://www.google.com/search?q=Singer+Porsche+911" rel="external">Singer</a>
         <a class="car-link" href="https://www.google.com/search?q=Tuthill+911K" rel="external">Tuthill</a></p>
      <!-- axp:shell -->
        <a href="https://github.com/oddharsh">GitHub</a>
        <a href="https://open.spotify.com/user/aadharsh2010">Music</a>
        <a href="https://www.instagram.com/aadharsh.hif">Photos</a>
      <!-- /axp:shell -->
    </body>`;
  const found = citationsIn(page, origin);

  assert.ok(found.includes("https://github.com/officialunofficial/mkit"), "a real citation is sent");
  assert.ok(found.includes("https://mkit.makechain.net/streaming"), "a second real citation is sent");
  assert.ok(found.some((u) => u.startsWith("https://docs.makechain.net/")), "anchors are normalized, not dropped");
  assert.equal(found.filter((u) => u.includes("officialunofficial")).length, 1, "deduped");

  for (const bad of ["oddharsh", "spotify", "instagram", "aadhar.sh/garage", "127.0.0.1", "169.254", "mailto", "head-link",
                     // an anchor that exists to open a hover card is chrome. These
                     // point at Google SEARCH pages, so a webmention to them would
                     // be noise rather than credit.
                     "google.com/search"]) {
    assert.ok(!found.some((u) => u.includes(bad)), `must not send to ${bad}`);
  }
});

test("outbound self-link list stays in sync with the desktop shell profiles", async () => {
  // The filter is only correct while it knows every profile the canonical shell
  // compiler stamps on every page; a new profile must be excluded here too.
  const urls = PROFILES.map((profile) => profile.url);
  assert.ok(urls.length >= 5);
  for (const raw of urls) {
    const u = new URL(raw);
    const bare = (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
    assert.ok(
      SELF_LINK_HOSTS.some((self) => bare === self || bare.startsWith(self + "/")),
      `shell-data.ts PROFILES has ${bare} but webmention-send.js SELF_LINK_HOSTS does not exclude it`
    );
  }
});

// ── the send loop itself ────────────────────────────────────────────────────
// Everything above tests the pure filters. Nothing tested the LOOP, which is how
// the outbound half shipped and then did nothing at all for weeks: fetchOwnPage
// called plain fetch() at our own origin, a Worker cannot do that (error 1042),
// the catch turned it into "", and every page was skipped. Measured 2026-08-28,
// both D1 tables empty since the feature shipped. These pin the loop's four
// load-bearing behaviours: it reads pages through the injected dispatcher, it
// records what every probe learned, it rotates, and it stays inside the platform
// budget.

// A stand-in for `webmentions_sent` alone: enough SQL to answer the two shapes
// this loop issues, and nothing more.
function sentTable() {
  const rows = [];
  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE/i.test(s)) return { meta: { changes: 0 } };
    if (/^SELECT source, target, last_sent_at/i.test(s)) return { results: rows.map((r) => ({ ...r })) };
    if (/^INSERT INTO webmentions_sent/i.test(s)) {
      const [source, target, endpoint, status, last_sent_at] = args;
      const found = rows.find((r) => r.source === source && r.target === target);
      if (found) Object.assign(found, { endpoint, status, last_sent_at });
      else rows.push({ source, target, endpoint, status, last_sent_at });
      return { meta: { changes: 1 } };
    }
    return { results: [], meta: { changes: 0 } };
  };
  return {
    rows,
    prepare(sql) {
      let bound = [];
      const api = {
        bind: (...a) => { bound = a; return api; },
        run: async () => run(sql, bound),
        all: async () => run(sql, bound),
        first: async () => run(sql, bound),
      };
      return api;
    },
  };
}

// One own page carrying one citation, plus a target that advertises an endpoint
// and an endpoint that accepts. The third-party halves go through global fetch,
// which is what discoverEndpoint and postMention use.
const CITED = "https://example.org/cited";
const ENDPOINT = "https://example.org/wm";

function outboundHarness({ selfFetch = true, assets = false } = {}) {
  const posted = [];
  const page = (path) =>
    new Response(`<html><body><p>credit <a href="${CITED}">them</a></p></body></html>`,
      { headers: { "content-type": "text/html" } });
  const env = {
    SOCIAL_DB: sentTable(),
    ASSETS: {
      fetch: async (input) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/writing/posts.json") return Response.json([]);
        return assets ? page(path) : new Response("not found", { status: 404 });
      },
    },
  };
  if (selfFetch) env.SELF_FETCH = async (req) => page(new URL(req.url).pathname);

  const realFetch = globalThis.fetch;
  // annotated because `typeof fetch` carries Bun's `preconnect` and a bare arrow
  // does not; the stub is a stand-in for the call, not for the whole interface.
  const stub = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === CITED) {
      return new Response(`<html><head><link rel="webmention" href="${ENDPOINT}"></head></html>`,
        { headers: { "content-type": "text/html" } });
    }
    if (url === ENDPOINT) { posted.push(String(init?.body || "")); return new Response("", { status: 202 }); }
    throw new Error(`unexpected outbound fetch to ${url}`);
  }));
  globalThis.fetch = stub;
  return { env, posted, restore: () => { globalThis.fetch = realFetch; } };
}

test("outbound cron reads its own pages through the injected dispatcher", async () => {
  const h = outboundHarness();
  try {
    const out = await cronSendWebmentions(h.env, "https://aadhar.sh");
    assert.ok(out.pagesRead > 0, "a run must actually read its own pages");
    assert.ok(out.sent > 0, "and send the citations it found");

    const cite = h.env.SOCIAL_DB.rows.find((r) => r.target === CITED);
    assert.ok(cite, "every probe is recorded, so the next run can skip it");
    assert.equal(cite.endpoint, ENDPOINT);
    assert.equal(cite.status, 202, "the receiver's own verdict is what gets stored");
    assert.ok(h.posted.some((b) => b.includes("source=") && b.includes("target=")),
      "the POST carries the spec's two parameters");
  } finally { h.restore(); }
});

test("outbound cron with no dispatcher records nothing rather than pretending", async () => {
  // The failure mode being pinned: a page read that returns "" must not look like
  // a page with no citations. With neither seam present the run is a clean no-op.
  const h = outboundHarness({ selfFetch: false, assets: false });
  try {
    const out = await cronSendWebmentions(h.env, "https://aadhar.sh");
    assert.equal(out.pagesRead, 0);
    assert.equal(out.sent, 0);
    assert.ok(!h.env.SOCIAL_DB.rows.some((r) => r.target === CITED),
      "a page that could not be read must not be recorded as swept");
  } finally { h.restore(); }
});

test("outbound cron stays inside the Workers subrequest budget and rotates", async () => {
  // Workers Free allows 50 per invocation and the full sweep is far larger than
  // that, so a run has to stop early — and the next one has to resume somewhere
  // new rather than re-sweeping the same first pages forever.
  const h = outboundHarness();
  try {
    const first = await cronSendWebmentions(h.env, "https://aadhar.sh");
    assert.ok(first.spent <= 40, `a run spent ${first.spent} subrequests, over the declared budget`);

    const firstPages = new Set(h.env.SOCIAL_DB.rows.filter((r) => r.source === r.target).map((r) => r.source));
    assert.ok(firstPages.size > 0, "a swept page is marked by its self-pair, which no citation can collide with");

    const second = await cronSendWebmentions(h.env, "https://aadhar.sh");
    const secondPages = new Set(h.env.SOCIAL_DB.rows.filter((r) => r.source === r.target).map((r) => r.source));
    assert.ok(secondPages.size > firstPages.size,
      "the second run must advance to pages the first never reached");
    assert.ok(second.spent <= 40);
  } finally { h.restore(); }
});
