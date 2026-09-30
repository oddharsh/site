// The understanding check's payload, moved out of the served document at build.
//
// Authoring does not change. Every garage and LWE page carries its quiz as one
// inline `<script type="application/json" id="luq-data">` block, because that is
// where `bun run pages:check` lints the question text and where a buildless
// `bun run dev` reads it. What changes is the SERVED copy: build.ts step 5d
// lifts each block into its own content-hashed file,
// `/a/quiz-<page>.<hash8>.json`, and leaves the element in place, empty, with a
// `data-src` naming that file. quiz.js fetches it when the reader nears the end
// of the page.
//
// The reason is first-view bytes. Measured 2026-09-30 over the 70 built pages at
// brotli q11, leave-one-out: the 38 inline payloads cost 66.3 KiB of 630.6 KiB,
// and each is unique to its page, so the family dictionary cannot discount them.
// The quiz renders at the very bottom, and a reader who never gets there paid for
// the whole answer key.
//
// The element stays rather than moving the URL onto the mount because the LWE
// skin has no mount (its quiz continues the chat in `.log`), so the data block is
// the one element both skins share, and quiz.js already finds it by id.

import { closeTagSource } from "./html-raw-text.ts";
import { minifyJsonScript } from "./json-script.ts";

// The capture groups are the attributes on either side of the id and the body.
// Same close-tag rule as tools/check-page-contracts.ts, so the authoring check
// and the extraction agree on where a payload ends.
const QUIZ_BLOCK = new RegExp(
  `<script\\b([^>]*?)\\s+id=(?:"luq-data"|luq-data)(?=[\\s>])([^>]*)>([\\s\\S]*?)${closeTagSource("script")}`,
  "gi",
);

// One page, one file, and the name says which. `garage/encoding.html` becomes
// `quiz-garage-encoding`, an `index.html` takes its directory's name. Flat,
// because the shell dictionary tooling reads /a/ names as [\w-]+.
export const quizBase = (rel: string): string => {
  const key = rel.replace(/\.html$/, "").replace(/(^|\/)index$/, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return `quiz-${key || "home"}`;
};

// The staged path the served document references. `name` is the file under
// public/a/, `hash8` the content hash that names it.
export type QuizFile = { url: string; name: string; bytes: Buffer };

// Pull one page's payload out. Returns null for a page with no quiz, throws for a
// page with two (the browser would read the first; the contract says one) or for
// one that was already extracted, since running this twice over a staged tree is
// a build-order bug rather than a no-op.
export function extractQuizData(
  html: string,
  rel: string,
  hash8: (bytes: Buffer) => string,
): { html: string; file: QuizFile } | null {
  const matches = [...html.matchAll(QUIZ_BLOCK)];
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error(`${rel}: ${matches.length} luq-data blocks; the quiz contract is exactly one`);
  const [block, before, after, body] = matches[0];
  if (/\bdata-src\s*=/i.test(before + after)) throw new Error(`${rel}: luq-data already carries a data-src; was the payload extracted twice?`);
  if (!body.trim()) throw new Error(`${rel}: luq-data block is empty`);
  // The same serializer the inline block went through when it shipped in the
  // document (json-script.ts), so the file holds exactly the bytes the page used
  // to, and every guard that pass re-proves still runs.
  const bytes = Buffer.from(minifyJsonScript(`${rel} luq-data`, body));
  const name = `${quizBase(rel)}.${hash8(bytes)}.json`;
  const url = `/a/${name}`;
  const replaced = `<script${before} id="luq-data"${after} data-src="${url}"></script>`;
  return { html: html.replace(block, () => replaced), file: { url, name, bytes } };
}

// What a served document says about its quiz, read back from any shape the
// minifier leaves (quoted or bare attributes). `inline` is the element's body,
// which must be empty once the build has run; `src` is the file it names.
export function quizReference(html: string): { inline: string; src: string | null } | null {
  const m = [...html.matchAll(QUIZ_BLOCK)][0];
  if (!m) return null;
  const attrs = `${m[1]} ${m[2]}`;
  const src = attrs.match(/\bdata-src=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return { inline: m[3], src: src ? (src[1] ?? src[2] ?? src[3]) : null };
}
