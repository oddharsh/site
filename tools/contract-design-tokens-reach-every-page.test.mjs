// design/tokens/colors.css is built around a few knobs (`--hue-luna`,
// `--chroma-luna`) so that turning one retunes the whole site. That is only
// true where served CSS says `var(--blue-40)`. Where it says the resolved
// literal, the knob stops at that rule, and nothing said so: measured
// 2026-09-15, 345 hand-resolved copies across 43 pages, 43 more inside
// luna.css itself, and `--grad-title` (the title-bar gradient) resolved by hand
// in 30 pages and in luna.css's own :where(.title-bar) while the token had
// ZERO consumers. Turning `--hue-luna` moved 23 rules and left every title bar
// where it was. DESIGN.md's DO list has said "pull every color from tokens;
// don't re-hardcode literals" the whole time; this is the check behind it.
//
// Two pins. The verbatim one holds luna.css's token blocks to the design
// files byte for byte, since luna.css claims "verbatim" in its header and
// nothing asserted it. The copies one is a ZERO rather than a ratchet: after
// the sweep there is no ledger to hold, and the rule for a page that wants a
// token's colour is to write the token.
//
// The first version compared text, and on 2026-10-06 that turned out to have
// missed 149 copies in 31 files: the token under an alpha (`--frame / .3`),
// the token retyped at another rounding (`--link` as `0.2353`), and every
// stylesheet beside luna.css. The check now matches by OKLab distance under
// COPY_DE and walks src/styles whole. The band above COPY_DE is a person's
// call, so `bun run colors:drift` lists it and nothing here gates on it.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { cssSources, loadTokenValueMap, normalizeColor, tokenCopiesIn, tokenValueMap } from "./lib/token-literals.ts";

const read = (rel) => readFile(new URL(rel, ROOT), "utf8");

test("luna.css carries design/tokens/{colors,bevels,typography}.css verbatim", async () => {
  const luna = await read("src/styles/luna.css");
  for (const t of ["colors", "bevels", "typography"]) {
    const tokens = (await read(`design/tokens/${t}.css`)).trim();
    assert.ok(tokens.length > 1000, `${t}.css read as ${tokens.length} bytes, which is not a token file`);
    assert.ok(luna.includes(tokens), `luna.css no longer carries design/tokens/${t}.css verbatim; edit the design file and re-copy, never the copy`);
  }
});

test("the resolver sees the knobs, and refuses an ambiguous value", () => {
  const map = tokenValueMap(`:root{--hue-luna:263;--chroma-luna:0.225;
    --blue-65: oklch(51% var(--chroma-luna) var(--hue-luna));
    --blue-95: oklch(70% 0.150 calc(var(--hue-luna) - 5));
    --a: oklch(100% 0 0); --b: oklch(100% 0 0);
    --outside: oklch(50% var(--not-a-knob) 10);}`);
  assert.equal(map.get("oklch(51% 0.225 263)"), "--blue-65", "a knob-derived value resolves through var()");
  assert.equal(map.get("oklch(70% 0.15 258)"), "--blue-95", "calc() on a knob resolves, and 0.150 normalises to 0.15");
  assert.equal(map.get("oklch(100% 0 0)"), undefined, "a value two tokens share is never reported");
  assert.equal(map.size, 2, "a token resolving through a non-knob var() is skipped, not guessed");
  assert.equal(normalizeColor("oklch(100.00% 0 0)"), "oklch(100% 0 0)");
  assert.equal(normalizeColor("oklch(70% .15 258)"), "oklch(70% 0.15 258)", "the generator's bare .15 spelling is the same colour");
  // A copy in a fixture IS found, so an empty report below means clean and not blind.
  assert.deepEqual(tokenCopiesIn(".x{color:oklch(51% 0.225 263)}", map).map((c) => c.token), ["--blue-65"]);
  // The two spellings text equality missed: the token under an alpha, and the token retyped at another rounding.
  assert.deepEqual(
    tokenCopiesIn(".x{box-shadow:0 0 0 1px oklch(51% 0.225 263 / .3)}", map).map((c) => c.fix),
    ["oklch(from var(--blue-65) l c h / .3)"],
    "an alpha copy is a copy, and its fix keeps the alpha",
  );
  assert.deepEqual(tokenCopiesIn(".x{color:oklch(51.2% 0.224 263.3)}", map).map((c) => c.token), ["--blue-65"], "a rounding copy within COPY_DE is a copy");
  assert.deepEqual(tokenCopiesIn(".x{color:oklch(55% 0.225 263)}", map), [], "four points of lightness is a different colour, not a copy");
  assert.deepEqual(tokenCopiesIn('<text fill="oklch(51% 0.225 263)">', map), [], "an SVG presentation attribute cannot take var(), so it is never a copy");
  // Inside COPY_DE of two tokens names neither, like an ambiguous value.
  const twins = tokenValueMap(`:root{--p: oklch(50% 0.1 250); --q: oklch(50.3% 0.1 250);}`);
  assert.deepEqual(tokenCopiesIn(".x{color:oklch(50.15% 0.1 250)}", twins), [], "a literal between two near tokens is never reported");
});

test("no page <style>, Worker CSS literal or stylesheet rule carries a token's value as a literal", () => {
  const map = loadTokenValueMap(ROOT);
  assert.ok(map.size >= 25, `only ${map.size} token values resolved; the colors.css parse has collapsed`);
  const sources = cssSources(ROOT);
  const count = (kind) => new Set(sources.filter((s) => s.kind === kind).map((s) => s.file)).size;
  // Floors on the walk itself, so a moved directory reads as blind rather than clean.
  assert.ok(count("page") >= 40, `walked ${count("page")} pages`);
  assert.ok(count("worker") >= 60, `walked ${count("worker")} Worker sources`);
  assert.ok(count("stylesheet") >= 7, `walked ${count("stylesheet")} stylesheets`);
  const luna = sources.find((s) => s.file === "src/styles/luna.css");
  assert.ok(luna && luna.css.length > 20000, "luna.css body after the token blocks is missing");
  const offenders = sources.flatMap((s) => tokenCopiesIn(s.css, map).map((c) => `${s.file}: ${c.literal} is ${c.fix}`));
  assert.deepEqual(offenders, [], `hand-resolved token copies, which the knobs cannot reach:\n  ${offenders.join("\n  ")}`);
});

test("the title-bar gradient is consumed as a token, not resolved by hand", async () => {
  const luna = await read("src/styles/luna.css");
  assert.ok(/--grad-title:\s*linear-gradient/.test(luna), "the token is defined");
  assert.ok(luna.includes("var(--grad-title)"), "luna.css's own :where(.title-bar) consumes it");
  // The two title bars luna.css does not draw: the homepage (luna loads without
  // blocking its first paint) and Notepad's .np-titlebar. Every other window,
  // garage/index included, takes luna's :where(.title-bar) and paints nothing itself.
  const sources = ["src/pages/index.html", "src/worker/writing.ts"];
  for (const rel of sources) assert.ok((await read(rel)).includes("var(--grad-title)"), `${rel} should paint its title bar from the token`);
  const resolved = /linear-gradient\(180deg,\s*oklch\(70% 0\.15 258\)/;
  for (const rel of [...sources, "src/pages/garage/index.html", "src/styles/luna.css"]) assert.doesNotMatch(await read(rel), resolved, `${rel} carries the gradient resolved by hand`);
});
