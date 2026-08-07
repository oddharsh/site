import { json } from "./http";

type Metadata = Record<string, unknown>;
type ManifestPhoto = { stem: string; full: string; thumb_avif: string; thumb_jpg: string; thumb_small: string; uploaded?: string | null };

async function assetJson<T>(env: Env, pathname: string): Promise<T> {
  const response = await env.ASSETS.fetch(new Request(`https://assets.invalid${pathname}`));
  if (!response.ok) throw new Error(`missing build asset ${pathname}`);
  return response.json<T>();
}

function normalizedDate(value: unknown): string {
  return String(value ?? "").slice(0, 10).replaceAll(":", "-");
}

export async function photoQuery(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [metadata, alt, manifest] = await Promise.all([
    assetJson<Record<string, Metadata>>(env, "/images/metadata.json"),
    assetJson<Record<string, string>>(env, "/images/alt.json"),
    assetJson<{ photos: ManifestPhoto[] }>(env, "/images/manifest.json"),
  ]);
  const byStem = new Map(manifest.photos.map((photo) => [photo.stem, photo]));
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 120);
  const filters = Object.fromEntries(["camera", "lens", "film", "recipe"].map((name) => [name, (url.searchParams.get(name) ?? "").trim().toLowerCase()]));
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const rows = Object.entries(metadata).flatMap(([stem, record]) => {
    const photo = byStem.get(stem);
    if (!photo) return [];
    const recipeText = typeof record.recipe === "object" ? JSON.stringify(record.recipe) : String(record.recipe ?? "");
    const searchable = `${stem} ${alt[stem] ?? ""} ${Object.values(record).filter((value) => typeof value !== "object").join(" ")} ${recipeText}`.toLowerCase();
    if (q && !q.split(/\s+/).every((term) => searchable.includes(term))) return [];
    for (const [field, value] of Object.entries(filters)) {
      if (!value) continue;
      const actual = field === "recipe" ? recipeText : String(record[field] ?? "");
      if (!actual.toLowerCase().includes(value)) return [];
    }
    const date = normalizedDate(record.date);
    if (from && date < from) return [];
    if (to && date > to) return [];
    return [{ stem, alt: alt[stem] ?? "", full: `/images/full/${encodeURIComponent(photo.full)}`, thumb: { avif: photo.thumb_avif, jpg: photo.thumb_jpg, small: photo.thumb_small }, metadata: record }];
  }).sort((a, b) => normalizedDate(b.metadata.date).localeCompare(normalizedDate(a.metadata.date)) || a.stem.localeCompare(b.stem));
  return json({ query: { q, ...filters, from, to }, ranking: { mode: q ? (rows.length ? "all-terms" : "no-match") : "no-terms", terms: q.split(/\s+/).filter(Boolean), semantic: false }, total: rows.length, offset, limit, photos: rows.slice(offset, offset + limit) }, { headers: { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
}
