import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHome } from "../src/site/pages/home.mjs";
import { directoryMarkdown, renderDirectory } from "../src/site/pages/directory.mjs";
import { photosMarkdown, renderPhotos } from "../src/site/pages/photos.mjs";
import { renderWritingIndex, renderWritingPost, writingMarkdown } from "../src/site/pages/writing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function write(path, contents) {
  const target = join(output, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await cp(join(root, "public"), output, { recursive: true });
await cp(join(root, "holding/i"), join(output, "i"), { recursive: true });
await cp(join(root, "holding/images"), join(output, "images"), { recursive: true });

const css = await readFile(join(root, "src/site/styles/site.css"), "utf8");
const cssName = `site.${digest(css)}.css`;
await write(`assets/${cssName}`, css);

const [home, hashes, alt, posts, siteManifest, photoIndex] = await Promise.all([
  json("content/home.json"),
  json("holding/images/hashes.json"),
  json("holding/images/alt.json"),
  json("content/writing/posts.json"),
  json("site-manifest.json"),
  json("holding/_worker.js/photo-index.json"),
]);

const photos = Object.entries(photoIndex).flatMap(([stem, record]) => {
  const hash = hashes[stem];
  if (!hash?.a || !hash?.j || !hash?.s) return [];
  return [{
    stem,
    alt: alt[stem] ?? "",
    full: record.full,
    size: record.size,
    uploaded: record.uploaded ?? null,
    thumbAvif: `i/${stem}.${hash.a}.avif`,
    thumbJpg: `i/${stem}.${hash.j}.jpg`,
    thumbSmall: `i/${stem}-400.${hash.s}.avif`,
  }];
}).sort((a, b) => a.full < b.full ? -1 : a.full > b.full ? 1 : 0);

const homePhotos = photos.slice(0, 6).map((photo) => ({
  stem: photo.stem,
  alt: photo.alt,
  avif: photo.thumbAvif,
  jpg: photo.thumbJpg,
}));

await write("index.html", renderHome({
  content: home,
  photos: homePhotos,
  stylesheet: `/assets/${cssName}`,
}));

const markdown = `# ${home.name}\n\n${home.role}\n\n**Under construction.**\n\n${home.introduction.join("\n\n")}\n\n${home.contact}\n\n## Links\n\n${home.links.map(({ label, href }) => `- [${label}](${href})`).join("\n")}\n`;
await write("index.md", markdown);

await write("photos.html", renderPhotos({ photos, stylesheet: `/assets/${cssName}` }));
await write("photos.md", photosMarkdown(photos));
await write("images/manifest.json", `${JSON.stringify({
  _address: "handwritten worker at aadhar.sh",
  photos: photos.map((photo) => ({
    full: photo.full,
    thumb_avif: `/${photo.thumbAvif}`,
    thumb_jpg: `/${photo.thumbJpg}`,
    thumb_small: `/${photo.thumbSmall}`,
    stem: photo.stem,
    size: photo.size,
    uploaded: photo.uploaded,
  })),
  count: photos.length,
}, null, 2)}\n`);

await write("writing.html", renderWritingIndex({ posts, stylesheet: `/assets/${cssName}` }));
await write("writing.md", writingMarkdown(posts));
await write("writing/posts.json", `${JSON.stringify(posts, null, 2)}\n`);

for (const post of posts) {
  const text = await readFile(join(root, "content/writing", `${post.slug}.txt`), "utf8");
  await write(`writing/${post.slug}.html`, renderWritingPost({
    post,
    text,
    stylesheet: `/assets/${cssName}`,
  }));
  await write(`writing/${post.slug}.txt`, text);
}

const directorySections = ["/garage", "/lwe"];
for (const sectionPath of directorySections) {
  const section = siteManifest.surfaces.find(({ path }) => path === sectionPath);
  const items = siteManifest.surfaces.filter(({ path, kind }) =>
    kind === "content" && path.startsWith(`${sectionPath}/`)
  );
  const name = sectionPath.slice(1);
  await write(`${name}.html`, renderDirectory({
    section,
    items,
    stylesheet: `/assets/${cssName}`,
  }));
  await write(`${name}.md`, directoryMarkdown(section, items));
}

const manifest = {
  pages: [
    "/",
    "/photos",
    "/writing",
    ...posts.map(({ slug }) => `/writing/${slug}`),
    ...directorySections,
  ],
  assets: [`/assets/${cssName}`, ...photos.flatMap(({ thumbAvif, thumbJpg, thumbSmall }) => [`/${thumbAvif}`, `/${thumbJpg}`, `/${thumbSmall}`])],
};
await write("build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${manifest.pages.length} page and ${manifest.assets.length} assets in dist/`);
