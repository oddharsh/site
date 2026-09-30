// ── the understanding check's payload ships as its own /a/ file ─────────────
// Split-file convention: shared imports live in contract-shared.ts.
//
// build.ts step 5d moves each page's inline luq-data JSON into
// /a/quiz-<page>.<hash8>.json and leaves an empty element with a data-src, and
// quiz.js fetches the file as the reader nears the end. These pin the three
// claims that change makes: the file holds exactly the bytes the page used to
// ship, the served page carries no answer key, and quiz.js reads the new shape
// lazily while still accepting the authored inline form.
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
  // The file is what the inline block used to ship: the same serializer, so the
  // same bytes, and the answer key with it.
  assert.equal(out.file.bytes.toString("utf8"), minifyJsonScript("fixture", body));
  assert.equal(out.file.url, `/a/quiz-garage-fixture.${hash8(out.file.bytes)}.json`);
  assert.doesNotMatch(out.html, /"ok"/, "no answer flag survives in the document");
  const ref = quizReference(out.html);
  assert.deepEqual(ref, { inline: "", src: out.file.url });
  // Everything else in the page is untouched.
  assert.ok(out.html.startsWith(`<main><section id="luq"></section></main>\n<script type="application/json" id="luq-data" data-src="${out.file.url}"></script>`));
  assert.ok(out.html.endsWith(`<script src="/quiz.js" defer></script>`));

  // A second pass is a build-order bug, and it says so rather than no-op.
  assert.throws(() => extractQuizData(out.html, "garage/fixture.html", hash8), /extracted twice/);
  // No quiz, nothing to do.
  assert.equal(extractQuizData("<p>no quiz</p>", "garage/plain.html", hash8), null);
  // Two blocks break the one-quiz contract.
  assert.throws(() => extractQuizData(html + html, "garage/twice.html", hash8), /exactly one/);
});

test("the reader recognises the minifier's unquoted, reordered form", () => {
  // minify-html sorts attributes and unquotes them; this is the shape the build
  // actually serves, taken from a real staged page.
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
  assert.match(src, /function start\(\)[\s\S]*fetch\(src\)[\s\S]*\n {2}\}/, "the payload fetch lives in start()");
  assert.match(src, /new IntersectionObserver\([\s\S]*rootMargin:/, "start() waits on an observer with a margin");
  assert.match(src, /getAttribute\("data-src"\)/, "the served reference is read");
  assert.match(src, /JSON\.parse\(inline\)/, "the authored inline form still works for dev and the .src.html twin");
  // The build repoints this exact shape to the hashed sheet (STRING_ASSETS).
  assert.match(src, /\.href\s*=\s*"\/quiz\.css"/, "the quiz.css href keeps the shape step 6 rewrites");
  // Rendering waits for both halves: never unstyled, never without data.
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
  // Count what was checked, so a reader that stopped matching fails here rather
  // than passing over nothing.
  assert.ok(checked >= 30, `only ${checked} quiz references checked; the reader probably stopped matching`);
});
