// albums.ts — the registry of photo ALBUMS: named sets of photos that live at
// their own page and stay OUT of the site-wide draw.
//
// Every photo in photo-index.json belongs to one pool. Until 2026-09-12 that
// pool was also the homepage's random twelve and the /photos contact sheet, so
// adding 93 frames from one weekend at a racetrack would have made a third of
// every homepage draw race cars. An album is the way to publish a set without
// that: `add-photos.sh` stamps `album: "<slug>"` on each index entry (ALBUM=),
// derivePhotoPool carries it through, and CURATED_POOL (photos.ts) is the pool
// with album photos removed. The machine surfaces (/images/manifest.json,
// /photos/query.json, the Run palette) still see everything, because a photo
// that exists should be findable by name wherever names are searched.
//
// One entry per album. The slug is the index field AND the route: an album is
// served at `/<slug>`, rendered at deploy (build.ts step 1e) with the dynamic
// handler as the fallback, exactly like /photos. Register it in
// config/site-manifest.json too, or build invariant #8 fails the deploy.
//
// Node-safe on purpose: build.ts imports this from the staged tree, and the
// contract suite imports it under plain bun/node (gotcha 16).

export type Album = {
  slug: string;
  title: string;
  /** the lines under the title, one <br> apart; plain text, escaped at render */
  lede: string[];
  /** the <meta name="description"> and the registry's description */
  description: string;
};

// Empty since 2026-10-07. The first album, /cota-wec (93 frames, each with a
// HEIF original), left the site with its photos so the photo bucket stays
// inside R2's 10 GB free tier once every JPEG original has its JPEG XL twin.
// The machinery stays: the next album is one entry here plus ALBUM= on ingest.
export const ALBUMS: Record<string, Album> = {};

export const albumPath = (album: Album) => `/${album.slug}`;
