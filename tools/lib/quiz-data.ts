// The understanding check's payload, moved out of the served document at build.

import { closeTagSource } from "./html-raw-text.ts";
import { minifyJsonScript } from "./json-script.ts";

const QUIZ_BLOCK = new RegExp(
  `<script\\b([^>]*?)\\s+id=(?:"luq-data"|luq-data)(?=[\\s>])([^>]*)>([\\s\\S]*?)${closeTagSource("script")}`,
  "gi",
);

export const quizBase = (rel: string): string => {
  const key = rel.replace(/\.html$/, "").replace(/(^|\/)index$/, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return `quiz-${key || "home"}`;
};

export type QuizFile = { url: string; name: string; bytes: Buffer };

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
  const bytes = Buffer.from(minifyJsonScript(`${rel} luq-data`, body));
  const name = `${quizBase(rel)}.${hash8(bytes)}.json`;
  const url = `/a/${name}`;
  const replaced = `<script${before} id="luq-data"${after} data-src="${url}"></script>`;
  return { html: html.replace(block, () => replaced), file: { url, name, bytes } };
}

export function quizReference(html: string): { inline: string; src: string | null } | null {
  const m = [...html.matchAll(QUIZ_BLOCK)][0];
  if (!m) return null;
  const attrs = `${m[1]} ${m[2]}`;
  const src = attrs.match(/\bdata-src=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return { inline: m[3], src: src ? (src[1] ?? src[2] ?? src[3]) : null };
}
