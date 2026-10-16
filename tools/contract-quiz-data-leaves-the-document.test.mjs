// ── the understanding check's payload ships as its own /a/ file ─────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assert, test } from "./contract-shared.ts";
import { extractQuizData, quizBase, quizReference } from "./lib/quiz-data.ts";
import { minifyJsonScript } from "./lib/json-script.ts";

const hash8 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

test("extraction moves the payload byte-for-byte and leaves an empty reference", () => {
  const body = `\n{ "skin": "garage", "questions": [ { "q": "a </b> b?", "options": [ { "t": "x", "ok": true, "why": "y" } ] } ] }\n`;
  const html = `<main><section id="luq"></section></main>\n<script type="application/json" id="luq-data">${body}</script>\n<script src="/quiz.js" defer></script>`;
  const out = extractQuizData(html, "garage/fixture.html", hash8);
  assert.ok(out, "a page with a quiz extracts");
  assert.equal(out.file.bytes.toString("utf8"), minifyJsonScript("fixture", body));
  assert.equal(out.file.url, `/a/quiz-garage-fixture.${hash8(out.file.bytes)}.json`);
  assert.doesNotMatch(out.html, /"ok"/, "no answer flag survives in the document");
  const ref = quizReference(out.html);
  assert.deepEqual(ref, { inline: "", src: out.file.url });
  assert.ok(out.html.startsWith(`<main><section id="luq"></section></main>\n<script type="application/json" id="luq-data" data-src="${out.file.url}"></script>`));
  assert.ok(out.html.endsWith(`<script src="/quiz.js" defer></script>`));

  assert.throws(() => extractQuizData(out.html, "garage/fixture.html", hash8), /extracted twice/);
  assert.equal(extractQuizData("<p>no quiz</p>", "garage/plain.html", hash8), null);
  assert.throws(() => extractQuizData(html + html, "garage/twice.html", hash8), /exactly one/);
});

test("the reader recognises the minifier's unquoted, reordered form", () => {
  const served = `<script data-src=/a/quiz-lwe-tee.caa9af0c.json id=luq-data type=application/json></script>`;
  assert.deepEqual(quizReference(served), { inline: "", src: "/a/quiz-lwe-tee.caa9af0c.json" });
  assert.equal(quizReference(`<script type=application/json id=luq-data-x></script>`), null, "a different id is not the quiz");
});

test("names are flat, per page, and fit the /a/ name shape the dictionary tools read", () => {
  assert.equal(quizBase("garage/encoding.html"), "quiz-garage-encoding");
  assert.equal(quizBase("lwe/index.html"), "quiz-lwe");
  for (const rel of ["garage/encoding.html", "lwe/tee.html", "lwe/index.html"]) {
    assert.match(`${quizBase(rel)}.0123abcd.json`, /^[\w-]+\.[0-9a-f]{8}\.json$/);
  }
});

test("quiz.js fetches the payload lazily and still reads an inline one", () => {
  const src = readFileSync(new URL("../src/client/quiz.js", import.meta.url), "utf8");
  // The fetch sits inside start(), which only the observer or its fallback calls.
  // Sliced to start()'s own body, since an unbounded match also reached a later
  // closing brace and passed with the fetch moved out to the top level.
  const from = src.indexOf("function start()");
  const to = src.indexOf("\n  }\n", from);
  assert.ok(from >= 0 && to > from, "quiz.js lost start(); point this test at it");
  assert.ok(src.slice(from, to).includes("fetch(src)"), "the payload fetch lives in start()");
  assert.equal(src.split("fetch(src)").length, 2, "start() is the only place the payload is fetched");
  assert.match(src, /new IntersectionObserver\([\s\S]*rootMargin:/, "start() waits on an observer with a margin");
  assert.match(src, /getAttribute\("data-src"\)/, "the served reference is read");
  assert.match(src, /JSON\.parse\(inline\)/, "the authored inline form still works for dev and the .src.html twin");
  assert.match(src, /\.href\s*=\s*"\/quiz\.css"/, "the quiz.css href keeps the shape step 6 rewrites");
  assert.match(src, /Promise\.all\(\[payload, styled\]\)/);
});

test("the staged tree serves no inline answer key, and every reference resolves", { skip: !existsSync(".build/public/a") && "needs a build" }, () => {
  const pages = readdirSync(".build/public", { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && !rel.startsWith("a/"));
  let checked = 0;
  for (const rel of pages) {
    const html = readFileSync(`.build/public/${rel}`, "utf8");
    const ref = quizReference(html);
    if (!ref) continue;
    assert.equal(ref.inline, "", `${rel}: the quiz payload is still inline`);
    assert.ok(ref.src && /^\/a\/quiz-[\w-]+\.[0-9a-f]{8}\.json$/.test(ref.src), `${rel}: bad quiz reference ${ref.src}`);
    const bytes = readFileSync(`.build/public${ref.src}`);
    assert.equal(ref.src.split(".").at(-2), hash8(bytes), `${rel}: ${ref.src} does not name its own bytes`);
    const data = JSON.parse(bytes.toString("utf8"));
    assert.ok(data.questions?.length, `${rel}: ${ref.src} carries no questions`);
    assert.ok(existsSync(`.build/public${ref.src}.br`), `${rel}: ${ref.src} has no q11 twin`);
    checked++;
  }
  assert.ok(checked >= 30, `only ${checked} quiz references checked; the reader probably stopped matching`);
});
