// ── /lens bot views: a 2xx that is really a wall (src/worker/lens-walls.ts) ──
// The regex knew Cloudflare's own challenge page and nothing else, so a
// DataDome or PerimeterX wall served with a 200 read as an admitted response,
// and a walled CONTROL let every crawler row below it count as evidence about
// user-agent policy. These pin the four promises the module makes: one call per
// scan whatever the view count, identical pages asked once, a missing answer is
// never "no wall", and the sample never reaches JSON.
import { assert, test } from "./contract-shared.ts";
import {
  CLEF_DEADLINE_MS, VIEW_SAMPLE, WALL_MODEL, WALL_THRESHOLD,
  buildWallRequest, classifyWalls, wallCandidates, wallDedupeKey,
} from "../src/worker/lens-walls.ts";
import { lensFieldEvidence } from "../src/worker/lens.ts";

/** One element by key, or a loud failure rather than an undefined to read through. */
function pick(list, key, field = "key") {
  const found = list.find((x) => x[field] === key);
  assert.ok(found, `no ${field} ${key}`);
  return found;
}

const PAGE = "<!doctype html><title>A real page</title><main>Words a reader came for.</main>";
const WALL = "<!doctype html><title>Access to this page has been denied</title><div id=px-captcha></div>";

// Ten identities shaped like LENS_BOT_VIEWS: two controls, eight crawlers.
/** @param {(key: string, i: number) => string} [sampleFor] @param {number} [status] @returns {any[]} */
function scan(sampleFor = () => PAGE, status = 200) {
  const keys = ["Chrome", "curl", "Googlebot", "GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "PerplexityBot", "ChatGPT-User", "Claude-User"];
  return keys.map((key, i) => {
    const v = { key, role: i < 2 ? "control" : "train", status, contentType: "text/html", blocked: false, challenge: false };
    v[VIEW_SAMPLE] = sampleFor(key, i);
    return v;
  });
}

// A Workers AI binding that answers every question with `p`, counting calls.
/** @param {number | ((q: any) => number)} p @param {any[]} [calls] */
function ai(p, calls = []) {
  return {
    calls,
    async run(model, input, options) {
      calls.push({ model, input, options });
      const questions = /** @type {Record<string, any>} */ (input.questions);
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: typeof p === "function" ? p(questions[id]) : p }]));
      return { model: "clef", answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

test("only an answered 2xx with a body, not already flagged, is asked about", () => {
  const views = scan();
  views[0].status = 403;
  views[1].challenge = true;
  views[2].blocked = true;
  views[3].error = "timeout";
  views[4][VIEW_SAMPLE] = "   ";
  views[5].status = 301;
  assert.deepEqual(wallCandidates(views).map((v) => v.key), ["Google-Extended", "PerplexityBot", "ChatGPT-User", "Claude-User"]);
});

test("one question per distinct page, nonces normalised out, the body inside its own question", () => {
  const views = scan((key) => key === "GPTBot" ? WALL : `${PAGE}<!-- rid ${key === "curl" ? "9f8e7d6c5b4a3f2e" : "0a1b2c3d4e5f6a7b"} t=${key.length}000 -->`);
  const { request, groups } = buildWallRequest(wallCandidates(views));
  assert.equal(request.model, WALL_MODEL);
  assert.match(WALL_MODEL, /^(clef|clef-flash)$/);
  assert.equal(groups.length, 2, "nine identical pages plus one wall is two questions");
  assert.deepEqual(groups.map((g) => g.views.length).sort(), [1, 9]);
  for (const g of groups) {
    const q = /** @type {any} */ (request.questions[g.id]);
    assert.equal(q.type, "noul");
    assert.equal(q.instructions.body, g.views[0][VIEW_SAMPLE], "the body rides in the question, so questions never share a state");
  }
  assert.equal(wallDedupeKey("rid 0123456789abcdef at 1700000000"), wallDedupeKey("rid fedcba9876543210 at 1800000000"));
});

test("a wall at or past the threshold flips the view; a page keeps its probability and its verdict", async () => {
  const views = scan((key) => key === "GPTBot" || key === "ClaudeBot" ? WALL : PAGE);
  const binding = ai((q) => q.instructions.body === WALL ? 0.97 : 0.06);
  const out = await classifyWalls(views, { AI: binding, AI_GATEWAY: "default" });
  assert.equal(binding.calls.length, 1, "ten views, one subrequest");
  assert.equal(binding.calls[0].model, `@cf/cloudflare/${WALL_MODEL}`);
  assert.deepEqual(binding.calls[0].options, { gateway: { id: "default", skipCache: true } });
  assert.deepEqual(out, { asked: 10, distinct: 2, flagged: 2, outcome: "ok" });
  const gpt = pick(views, "GPTBot");
  assert.equal(gpt.challenge, true);
  assert.equal(gpt.blocked, true);
  assert.deepEqual(gpt.wall, { p: 0.97, model: WALL_MODEL });
  const google = pick(views, "Googlebot");
  assert.equal(google.challenge, false);
  assert.deepEqual(google.wall, { p: 0.06, model: WALL_MODEL });
  assert.ok(WALL_THRESHOLD > 0.06 && WALL_THRESHOLD <= 0.97);
});

test("a walled control stops counting as admitted, so the crawler rows read as unmeasured", async () => {
  const views = scan(() => WALL);
  const before = pick(lensFieldEvidence({ botViews: views }).components, "sampledBots");
  assert.equal(before.score, 100, "the regex alone reads ten walled 200s as ten successes");
  await classifyWalls(views, { AI: ai(0.98) });
  const after = pick(lensFieldEvidence({ botViews: views }).components, "sampledBots");
  assert.equal(after.score, null);
  assert.match(after.detail, /no control identity/);
});

test("a failed or unreadable answer is never evidence that there was no wall", async () => {
  const views = scan();
  const capacity = { async run() { throw new Error("AiError: Capacity temporarily exceeded, please try again. (3040)"); } };
  assert.deepEqual(await classifyWalls(views, { AI: capacity }), { asked: 10, distinct: 1, flagged: 0, outcome: "ai 3040" });
  assert.ok(views.every((v) => v.wall.p === null && v.wall.error === "ai 3040" && !v.challenge));

  const odd = scan();
  const unparseable = { async run() { return { answers: { b0: { type: "choice", choice: "yes" } } }; } };
  await classifyWalls(odd, { AI: unparseable });
  assert.ok(odd.every((v) => v.wall.p === null && v.wall.error === "unparseable" && !v.challenge));
  assert.ok(CLEF_DEADLINE_MS >= 1000 && CLEF_DEADLINE_MS <= 4500, "under the bot views' own 4.5 s timeout");
});

test("no binding and nothing to ask both leave every view unstamped and call nothing", async () => {
  const views = scan();
  assert.equal((await classifyWalls(views, {})).outcome, "no AI binding");
  assert.ok(views.every((v) => !("wall" in v)));
  const refused = scan(() => PAGE, 403);
  const binding = ai(0.9);
  assert.equal((await classifyWalls(refused, { AI: binding })).outcome, "none");
  assert.equal(binding.calls.length, 0);
});

test("the sample never reaches JSON", async () => {
  const views = scan(() => WALL);
  await classifyWalls(views, { AI: ai(0.99) });
  const json = JSON.stringify(views);
  assert.ok(!json.includes("px-captcha"), "the 2 KB body must not ride into the scan payload, the KV cache or MCP output");
  assert.ok(json.includes('"wall":{"p":0.99'));
});
