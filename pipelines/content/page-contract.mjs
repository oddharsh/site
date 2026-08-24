// Shared authoring contract for explanatory pages.
//
// The generators own the page chrome. This module owns the promises every
// explanation makes: name the reader's problem, state the model, show the
// evidence and uncertainty, then ask the reader to reconstruct the mechanism.

// The tuple annotation is load-bearing for the checker rather than decoration:
// inferred from the literal alone this is `(string | RegExp)[][]`, so the
// `pattern` destructured out of it below has no `.test`.
/** @type {[RegExp, string][]} */
const BANNED_PATTERNS = [
  [/\u2014|&mdash;|&#8212;/, "em dashes"],
  [/\b(?:delve|leverage|utili[sz]e|robust|game[- ]changer|cutting[- ]edge)\b/i, "AI or marketing filler"],
  [/\b(?:furthermore|additionally|moreover|moving forward)\b/i, "dead transition"],
  [/\bnot\s+(?!(?:in|on|at|for|to|from|by|with|without)\b)[^.!?\n]{1,120},\s+(?!(?:which|because|while|and|but|so|yet)\b)\S/i, "not X, Y negation"],
];

const EDITORIAL_FIELDS = ["reader", "problem", "thesis", "evidence", "uncertainty"];

function fail(context, message) {
  throw new Error(`${context}: ${message}`);
}

function requireText(value, context) {
  if (typeof value !== "string" || !value.trim()) fail(context, "must be a non-empty string");
  return value;
}

export function lintAuthorText(value, context) {
  if (value == null) return;
  requireText(value, context);
  for (const [pattern, label] of BANNED_PATTERNS) {
    if (pattern.test(value)) fail(context, `contains ${label}`);
  }
}

export function validateEditorial(editorial, context = "editorial") {
  if (!editorial || typeof editorial !== "object" || Array.isArray(editorial)) {
    fail(context, "must be an object with reader, problem, thesis, evidence, and uncertainty");
  }
  for (const field of EDITORIAL_FIELDS) {
    if (field === "evidence") {
      if (!Array.isArray(editorial.evidence) || editorial.evidence.length === 0) {
        fail(`${context}.${field}`, "must be a non-empty array of evidence statements");
      }
      editorial.evidence.forEach((item, i) => lintAuthorText(item, `${context}.${field}[${i}]`));
    } else {
      lintAuthorText(editorial[field], `${context}.${field}`);
    }
  }
  return editorial;
}

export function validateUnderstanding(understanding, context = "understanding") {
  if (!understanding || typeof understanding !== "object" || Array.isArray(understanding)) {
    fail(context, "must be an object with intro and questions");
  }
  if (understanding.title != null) lintAuthorText(understanding.title, `${context}.title`);
  if (understanding.intro != null) lintAuthorText(understanding.intro, `${context}.intro`);
  if (!Array.isArray(understanding.questions) || understanding.questions.length < 3 || understanding.questions.length > 7) {
    fail(`${context}.questions`, "must contain 3 to 7 questions");
  }

  understanding.questions.forEach((question, qi) => {
    const qContext = `${context}.questions[${qi}]`;
    if (!question || typeof question !== "object" || Array.isArray(question)) fail(qContext, "must be an object");
    lintAuthorText(question.q, `${qContext}.q`);
    if (!Array.isArray(question.options) || question.options.length < 3 || question.options.length > 6) {
      fail(`${qContext}.options`, "must contain 3 to 6 options");
    }
    const correct = question.options.filter((option) => option && option.ok === true).length;
    if (correct !== 1) fail(`${qContext}.options`, "must contain exactly one option with ok: true");
    question.options.forEach((option, oi) => {
      const oContext = `${qContext}.options[${oi}]`;
      if (!option || typeof option !== "object" || Array.isArray(option)) fail(oContext, "must be an object");
      lintAuthorText(option.t, `${oContext}.t`);
      lintAuthorText(option.why, `${oContext}.why`);
    });
  });
  return understanding;
}

export function validatePageSpec(spec, context = "page", { contentField = "messages" } = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail(context, "must be an object");
  requireText(spec.id, `${context}.id`);
  validateEditorial(spec.editorial, `${context}.editorial`);
  validateUnderstanding(spec.understanding, `${context}.understanding`);

  for (const field of ["description", "buddyStat", "petsLine", "composeNote", "disclosure"]) {
    if (spec[field] != null) lintAuthorText(spec[field], `${context}.${field}`);
  }
  if (contentField === "messages") {
    if (!Array.isArray(spec.messages) || spec.messages.length === 0) fail(`${context}.messages`, "must contain at least one message or content block");
    spec.messages.forEach((message, i) => {
      const mContext = `${context}.messages[${i}]`;
      if (message.html != null) lintAuthorText(message.html, `${mContext}.html`);
      if (message.scrollnote != null) lintAuthorText(message.scrollnote, `${mContext}.scrollnote`);
      if (message.demo) {
        lintAuthorText(message.demo.bar, `${mContext}.demo.bar`);
        lintAuthorText(message.demo.html, `${mContext}.demo.html`);
      }
      if (message.cite) {
        lintAuthorText(message.cite.title, `${mContext}.cite.title`);
        requireText(message.cite.url, `${mContext}.cite.url`);
      }
    });
  } else {
    lintAuthorText(spec[contentField], `${context}.${contentField}`);
  }
  return spec;
}

export function renderUnderstanding(understanding, skin) {
  validateUnderstanding(understanding, "understanding");
  const payload = JSON.stringify({ skin, ...understanding }, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<script type="application/json" id="luq-data">\n${payload}\n</script>\n<script src="/quiz.js" defer></script>`;
}

// AUTHORING GUIDE — the shape every garage/lwe page owes its reader. Prose, not
// code: it was an exported string nothing ever imported, so it now lives where an
// author actually reads it, next to the contract that enforces the rest.
//
// Every page starts with a reader, a problem, and a thesis. The page then shows
// the mechanism, the evidence that supports it, and the uncertainty that remains.
// Keep the prose active and concrete: name the doer, put the point near the front,
// and let the new idea land at the end of the sentence. Use the page's examples and
// demos to make the model testable. End with three to seven questions that ask the
// reader to reconstruct the model. Give every option feedback, including the
// misconceptions. The check diagnoses a second read; it never blocks the page.
