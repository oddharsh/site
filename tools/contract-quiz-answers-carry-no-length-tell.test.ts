// ── a reader who skipped the page can't pass the quiz on option length ──────
//
// On 2026-10-14 the right answer was the longest option on 191 of the site's
// 202 questions, and ran a median 1.40x the length of the wrong ones. Authors
// wrote the right answer with its justification attached and the distractors
// as bare claims, so "pick the longest" scored 95% without reading a word.
// validateUnderstanding (pipelines/content/page-contract.ts) caps each page;
// these hold the whole site to chance, where a single page is too small to
// say anything. Gotcha 66.
import { readdirSync, readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { lengthGuesses, validateUnderstanding } from "../pipelines/content/page-contract.ts";
import { quizReference } from "./lib/quiz-data.ts";

const ROOT = new URL("../", import.meta.url);

function authoredQuizzes() {
  const quizzes: any[] = [];
  for (const family of ["garage", "lwe"]) {
    const dir = new URL(`src/pages/${family}/`, ROOT);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".html"))
      .sort()) {
      const ref = quizReference(readFileSync(new URL(file, dir), "utf8"));
      if (ref) quizzes.push({ page: `${family}/${file}`, data: JSON.parse(ref.inline) });
    }
  }
  return quizzes;
}

test("the length guessers score near chance across the site", () => {
  const quizzes = authoredQuizzes();
  // The instrument found the quizzes. A parse that silently matched nothing
  // would pass every bound below.
  assert.ok(quizzes.length >= 35, `found ${quizzes.length} quizzes`);
  let questions = 0;
  let longest = 0;
  let shortest = 0;
  let chance = 0;
  const ratios: any[] = [];
  for (const { data } of quizzes) {
    const g = lengthGuesses(data);
    questions += g.questions;
    longest += g.longest;
    shortest += g.shortest;
    ratios.push(...g.ratios);
    for (const q of data.questions) chance += 1 / q.options.length;
  }
  assert.ok(questions >= 150, `found ${questions} questions`);
  // Chance is about 27% with the site's mix of three- and four-option
  // questions. The ceiling leaves room for honest variation and none for a
  // habit.
  const ceiling = chance / questions + 0.08;
  assert.ok(longest / questions <= ceiling, `pick-the-longest scores ${longest}/${questions}; chance is ${((chance / questions) * 100).toFixed(0)}%`);
  assert.ok(shortest / questions <= ceiling, `pick-the-shortest scores ${shortest}/${questions}; an over-correction is its own tell`);
  ratios.sort((a, b) => a - b);
  const median = ratios[ratios.length >> 1];
  assert.ok(median >= 0.85 && median <= 1.15, `the right answer runs a median ${median.toFixed(2)}x the wrong ones`);
});

test("every page holds its own length guessers to half", () => {
  for (const { page, data } of authoredQuizzes()) {
    const { skin, ...understanding } = data;
    validateUnderstanding(understanding, page);
  }
});

test("the per-page cap fails a quiz written the old way", () => {
  // The control: three questions shaped like the 2026-10-14 pages, where the
  // right answer carries its reason and the wrong ones do not.
  const q = (n) => ({
    q: `Question ${n}?`,
    options: [
      { t: "The generator emits the shared contract for every page it renders.", ok: true, why: "Right." },
      { t: "Every experiment is correct.", why: "No." },
      { t: "A quiz replaces the body.", why: "No." },
    ],
  });
  assert.throws(() => validateUnderstanding({ questions: [q(1), q(2), q(3)] }, "fixture"), /longest option on 3 of 3/);
  const flipped = (n) => {
    const base = q(n);
    base.options[0].t = "Generator output.";
    return base;
  };
  assert.throws(() => validateUnderstanding({ questions: [flipped(1), flipped(2), flipped(3)] }, "fixture"), /shortest option on 3 of 3/);
});
