// Read the last build's actual bodies. Run `bun run build` first.
// This is a transfer-body model, not traffic telemetry: every page has equal
// weight, and a hit means the selected exact snapshot has a shipped delta.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, zstdDecompressSync } from "node:zlib";
import { familyDictionaryName, pageSlug, pageSnapshotName, parseDcz, parseFamilyDictionary, parsePageDelta, tagOfDigest } from "../src/worker/lib/dictionary-names.ts";

export type PageBytes = {
  page: string;
  brotli: number;
  family: number;
  exact: number[];
};

export function preferenceModel(pages: PageBytes[], acquisition: number, hitRate: number) {
  if (!pages.length) throw new Error("No pages to measure; run bun run build first");
  if (!Number.isFinite(hitRate) || hitRate < 0 || hitRate > 1) throw new Error("hitRate must be between 0 and 1");
  if (!Number.isFinite(acquisition) || acquisition < 0) throw new Error("Invalid dictionary acquisition size");
  const sum = (value: (p: PageBytes) => number) => pages.reduce((n, p) => n + value(p), 0);
  const brotli = sum(p => p.brotli);
  const family = sum(p => p.family);
  const exactBest = sum(p => p.exact.length ? Math.min(...p.exact) : p.brotli);
  const exactWorst = sum(p => p.exact.length ? Math.max(...p.exact) : p.brotli);
  const threshold = (exact: number) => exact < family ? (brotli - family) / (brotli - exact) : null;
  const meanSaving = (brotli - family) / pages.length;
  return {
    pages: pages.length,
    pagesWithExact: pages.filter(p => p.exact.length).length,
    brotli, family, exactBest, exactWorst, acquisition,
    // Both choices already have the family dictionary. When exact is selected
    // but unavailable, the server receives no second choice and sends Brotli.
    hitRate,
    exactFirstBest: hitRate * exactBest + (1 - hitRate) * brotli,
    exactFirstWorst: hitRate * exactWorst + (1 - hitRate) * brotli,
    exactHitThresholdBest: threshold(exactBest),
    exactHitThresholdWorst: threshold(exactWorst),
    // Acquisition was absent on the first page; savings begin on later pages.
    familyPaybackSubsequentPages: meanSaving > 0 ? Math.ceil(acquisition / meanSaving) : null,
  };
}

export async function measureDictionaryPreference(root = ".build/public", snapshots = "src/dict/p-dict") {
  const files = (await readdir(root, { recursive: true })).sort();
  const families = files.filter(n => n.startsWith("a/") && parseFamilyDictionary(n.slice(2)));
  if (families.length !== 1) throw new Error(`Expected one built family dictionary, found ${families.length}; run bun run build`);
  const dictionary = await readFile(join(root, families[0]));
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
  const familyHash = hash(dictionary);
  const familyTag = tagOfDigest(familyHash);
  const familyTwin = await readFile(join(root, `${families[0]}.br`));
  if (families[0] !== `a/${familyDictionaryName(familyTag.slice(0, 8))}` || !brotliDecompressSync(familyTwin).equals(dictionary)) {
    throw new Error("Family dictionary name or Brotli twin does not match its bytes");
  }
  const acquisition = familyTwin.length;
  const pages: PageBytes[] = [];
  let verifiedDeltas = 0;
  for (const twin of files.filter(n => n.endsWith(".html.br") && !n.endsWith(".src.html.br"))) {
    const page = twin.slice(0, -3);
    const raw = await readFile(join(root, page));
    const compressed = await readFile(join(root, twin));
    if (!brotliDecompressSync(compressed).equals(raw)) throw new Error(`Brotli twin does not reconstruct ${page}`);
    const slug = pageSlug(page);
    const row: PageBytes = { page, brotli: compressed.length, family: compressed.length, exact: [] };
    for (const file of files.filter(n => n.startsWith("pd/") && parsePageDelta(n.slice(3))?.slug === slug)) {
      const { tag } = parsePageDelta(file.slice(3))!;
      const dict = tag === familyTag ? dictionary : brotliDecompressSync(await readFile(join(snapshots, pageSnapshotName(slug, tag))));
      const bytes = await readFile(join(root, file));
      const dcz = parseDcz(bytes);
      if (!dcz || !dcz.digest.equals(hash(dict)) || tagOfDigest(hash(dict)) !== tag) {
        throw new Error(`Invalid dictionary frame: ${file}`);
      }
      if (!zstdDecompressSync(dcz.frame, { dictionary: dict }).equals(raw)) {
        throw new Error(`Delta does not reconstruct ${page}: ${file}`);
      }
      if (bytes.length >= compressed.length) throw new Error(`Delta does not beat Brotli: ${file}`);
      if (tag === familyTag) row.family = bytes.length;
      else row.exact.push(bytes.length);
      verifiedDeltas++;
    }
    pages.push(row);
  }
  return {
    family: families[0],
    verifiedDeltas,
    model: preferenceModel(pages, acquisition, 0.5),
    pages: pages.map(p => ({
      ...p,
      exactHitThresholdWorst: preferenceModel([p], 0, 0.5).exactHitThresholdWorst,
    })),
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await measureDictionaryPreference(), null, 2));
}
