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
import { readdir } from "node:fs/promises";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { loadTokenValueMap, normalizeColor, styleBlocksOf, tokenCopiesIn, tokenValueMap } from "./lib/token-literals.ts";

const read = (rel) => readFile(new URL(rel, ROOT), "utf8");
/** The one page that does not link luna.css, so a var() there would resolve to nothing. */
const NO_LUNA = new Set(["garage/vt-b.html"]);

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
});

test("no page <style>, Worker CSS literal or luna.css rule carries a token's value as a literal", async () => {
  const map = loadTokenValueMap(ROOT);
  assert.ok(map.size >= 25, `only ${map.size} token values resolved; the colors.css parse has collapsed`);
  const offenders = [];
  const pages = (await readdir(new URL("src/pages", ROOT), { recursive: true })).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 40, `walked ${pages.length} pages`);
  for (const rel of pages) {
    if (NO_LUNA.has(rel)) continue;
    const html = await read(`src/pages/${rel}`);
    for (const css of styleBlocksOf(html)) {
      for (const c of tokenCopiesIn(css, map)) offenders.push(`src/pages/${rel}: ${c.literal} is var(${c.token})`);
    }
  }
  // The generators author INTO src/pages, so a copy there is a copy on the next
  // page anyone generates. The first sweep missed the garage one because it
  // spells the stops `.15` rather than `0.15`, which normalizeColor now folds.
  for (const rel of ["pipelines/lwe/generate.mjs", "pipelines/garage/generate.mjs"]) {
    for (const c of tokenCopiesIn(await read(rel), map)) offenders.push(`${rel}: ${c.literal} is var(${c.token})`);
  }
  for (const family of ["lwe", "garage"]) {
    const specs = (await readdir(new URL(`pipelines/${family}/specs`, ROOT))).filter((f) => f.endsWith(".json"));
    for (const f of specs) {
      const spec = JSON.parse(await read(`pipelines/${family}/specs/${f}`));
      for (const c of tokenCopiesIn(spec.pageCss ?? "", map)) offenders.push(`pipelines/${family}/specs/${f}: ${c.literal} is var(${c.token})`);
    }
  }
  // Worker-rendered pages: every one goes through lunaPage, which links
  // luna.css, and cal links it by absolute URL, so the tokens resolve there
  // too. 63 copies sat in these template strings on 2026-09-15 (around.ts 19,
  // whoareyou.ts 15, reading.ts 9, bot.ts 8, ...), each read by hand before
  // the swap because a TS file holds CSS beside things that are not CSS.
  const workerFiles = [];
  for (const dir of ["src/worker", "cal/src", "serendipity"]) {
    for (const f of await readdir(new URL(dir, ROOT), { recursive: true })) {
      if (/\.(ts|js)$/.test(f) && !/(^|\/)test\//.test(f) && !f.endsWith(".d.ts")) workerFiles.push(`${dir}/${f}`);
    }
  }
  assert.ok(workerFiles.length >= 60, `walked ${workerFiles.length} Worker sources`);
  for (const rel of workerFiles) {
    for (const c of tokenCopiesIn(await read(rel), map)) offenders.push(`${rel}: ${c.literal} is var(${c.token})`);
  }
  // luna.css after its verbatim token blocks: the definitions themselves are literals by nature.
  const luna = await read("src/styles/luna.css");
  const typo = (await read("design/tokens/typography.css")).trim();
  const body = luna.slice(luna.indexOf(typo) + typo.length);
  assert.ok(body.length > 20000, "luna.css body after the token blocks is missing");
  for (const c of tokenCopiesIn(body, map)) offenders.push(`src/styles/luna.css: ${c.literal} is var(${c.token})`);
  assert.deepEqual(offenders, [], `hand-resolved token copies, which the knobs cannot reach:\n  ${offenders.join("\n  ")}`);
});

test("the title-bar gradient is consumed as a token, not resolved by hand", async () => {
  const luna = await read("src/styles/luna.css");
  assert.ok(/--grad-title:\s*linear-gradient/.test(luna), "the token is defined");
  assert.ok(luna.includes("var(--grad-title)"), "luna.css's own :where(.title-bar) consumes it");
  const sources = ["src/pages/index.html", "src/pages/garage/index.html", "src/worker/writing.ts"];
  for (const rel of sources) assert.ok((await read(rel)).includes("var(--grad-title)"), `${rel} should paint its title bar from the token`);
  const resolved = /linear-gradient\(180deg,\s*oklch\(70% 0\.15 258\)/;
  for (const rel of [...sources, "src/styles/luna.css"]) assert.doesNotMatch(await read(rel), resolved, `${rel} carries the gradient resolved by hand`);
});
