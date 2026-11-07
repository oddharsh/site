// ── /garage/av2 and /pixel-peeper describe the 600px tier that ships ─────────
//
// Both pages say where AV2's win falls on this site's own thumbnails: how many
// shipped 600px AVIF tiles sit in each bits-per-pixel band, how many sit under
// the half-bit flip, and the tier's median. Those figures are hand-written, and
// the tier moves under them whenever photos come or go. #1222 took 93 photos
// off the site on 2026-10-07, the tier fell from 255 colour tiles (median 0.67)
// to 162 (median 0.53), and /garage/av2 kept the old numbers for a month.
//
// So this test measures the tier from the committed tiles and holds every one
// of those figures to it. When it fails after adding or removing photos, the
// message names the new figure; update the prose around it too, since words
// like "almost on the flip" were written against a median of 0.53.
//
// The tier here is colour tiles only. Every AV2 figure on both pages comes from
// Fuji colour originals, and the Monochrom tiles ship as a different encode
// (4:0:0), so counting them would describe a tier the study never sampled.
import { readFileSync, statSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

const TILE_PX = 600 * 600;
const BANDS: [label: string, below: number][] = [
  ["under 0.3", 0.3],
  ["0.3 to 0.5", 0.5],
  ["0.5 to 0.8", 0.8],
  ["0.8 to 1.2", 1.2],
  ["over 1.2", Infinity],
];

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const hashes: Record<string, { a: string }> = JSON.parse(read("public/images/hashes.json"));
const metadata: Record<string, { camera: string | null }> = JSON.parse(read("public/images/metadata.json"));

const bpp = Object.entries(hashes)
  .filter(([stem]) => !/MONOCHROM/i.test(metadata[stem]?.camera ?? ""))
  .map(([stem, h]) => (statSync(new URL(`../../public/i/${stem}.${h.a}.avif`, import.meta.url)).size * 8) / TILE_PX)
  .sort((x, y) => x - y);
const tiles = bpp.length;
const mid = tiles >> 1;
const median = (tiles % 2 ? bpp[mid] : (bpp[mid - 1] + bpp[mid]) / 2).toFixed(2);
const perBand = BANDS.map(([, below], i) => bpp.filter((b) => b >= (i ? BANDS[i - 1][1] : 0) && b < below).length);
const underHalf = bpp.filter((b) => b < 0.5).length;

const AV2_PAGE = read("src/pages/garage/av2.html");
const AV2_SPEC = JSON.parse(read("pipelines/garage/specs/av2.json"));
const PEEPER = read("src/pages/pixel-peeper/index.html");

const pick = (text: string, re: RegExp, where: string) => {
  const m = re.exec(text);
  assert.ok(m, `${where}: no match for ${re}; reword the test with the copy`);
  return m.slice(1);
};

for (const [where, body] of [
  ["src/pages/garage/av2.html", AV2_PAGE],
  ["pipelines/garage/specs/av2.json bodyHtml", AV2_SPEC.bodyHtml],
]) {
  test(`${where}: the bits-per-pixel table counts the shipped tier`, () => {
    const [box] = pick(body, /<div class="dd-box dd-bpp">([\s\S]*?)\n<\/div>/, where);
    const rows = [
      ...box.matchAll(/<div class="dd-row"><span>([^<]+)<\/span>(?:<span[^>]*>[^<]*<\/span>){3}<span class="dd-num">(\d+) of (\d+)<\/span><\/div>/g),
    ];
    assert.deepEqual(
      rows.map(([, label, n, of]) => `${label}: ${n} of ${of}`),
      BANDS.map(([label], i) => `${label}: ${perBand[i]} of ${tiles}`),
    );
    const [counted] = pick(body, /counts\s+this\s+site's\s+(\d+)\s+shipped\s+600\s+px\s+colour\s+tiles/, where);
    assert.equal(Number(counted), tiles);
  });

  test(`${where}: the prose states the tier's median and thin end`, () => {
    const [thin, of, med] = pick(
      body,
      /(\d+)\s+of\s+this\s+site's\s+(\d+)\s+shipped\s+colour\s+thumbnails\s+live\s+at\s+the\s+thin\s+end,[^.]*?the\s+median,\s+(\d\.\d\d),/,
      where,
    );
    assert.deepEqual(
      [Number(thin), Number(of), med],
      [underHalf, tiles, median],
      `${where}: the thin end, tier size and median must match the shipped 600px tier`,
    );
    const [covers, coversOf] = pick(body, /covers\s+(\d+)\s+of\s+this\s+site's\s+(\d+)\s+colour\s+thumbnails/, where);
    assert.deepEqual([Number(covers), Number(coversOf)], [underHalf, tiles]);
  });
}

test("pipelines/garage/specs/av2.json: the editorial card states the tier", () => {
  const evidence = AV2_SPEC.editorial.evidence.join("\n");
  const [of, med, thin] = pick(
    evidence,
    /the (\d+) shipped 600px colour tiles have a median of (\d\.\d\d), and (\d+) of them sit under 0\.5/,
    "editorial.evidence",
  );
  assert.deepEqual([Number(of), med, Number(thin)], [tiles, median, underHalf]);
});

test("src/pages/pixel-peeper/index.html: AV2_BANDS and the quiz count the shipped tier", () => {
  const [bands] = pick(PEEPER, /const AV2_BANDS=(\[.*?\]);\n/, "pixel-peeper");
  assert.deepEqual(
    (JSON.parse(bands) as [string, string, number][]).map(([label, , n]) => `${label}: ${n}`),
    BANDS.map(([label], i) => `${label}: ${perBand[i]}`),
  );
  const [of] = pick(PEEPER, /<td>\$\{n\} of (\d+)<\/td>/, "pixel-peeper");
  assert.equal(Number(of), tiles);
  const [thin, thinOf] = pick(PEEPER, /(\d+) of this site's (\d+) colour photos sit there/, "pixel-peeper");
  assert.deepEqual([Number(thin), Number(thinOf)], [underHalf, tiles]);
});
