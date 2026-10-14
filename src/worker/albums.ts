// Node-safe on purpose: build.ts imports this from the staged tree, and the
// contract suite imports it under plain bun/node (gotcha 16).

export type Album = {
  slug: string;
  title: string;
  lede: string[];
  description: string;
};

export const ALBUMS: Record<string, Album> = {};

export const albumPath = (album: Album) => `/${album.slug}`;
