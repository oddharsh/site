import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHome } from "../src/site/pages/home.mjs";
import { renderArticle } from "../src/site/pages/article.mjs";
import { directoryMarkdown, renderDirectory } from "../src/site/pages/directory.mjs";
import { photosMarkdown, renderPhotos } from "../src/site/pages/photos.mjs";
import { renderWritingIndex, renderWritingPost, writingMarkdown } from "../src/site/pages/writing.mjs";
import { renderSystemPage } from "../src/site/pages/system.mjs";
import { renderRun, renderSearch } from "../src/site/pages/search.mjs";
import { renderRestore, renderUpdates, restoreMarkdown, updatesMarkdown } from "../src/site/pages/status.mjs";
import { renderAround, renderLedger, renderReading } from "../src/site/pages/live.mjs";
import { renderLens } from "../src/site/pages/lens.mjs";
import { coffeeMarkdown, renderCoffee } from "../src/site/pages/coffee.mjs";

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
await cp(join(root, "holding/garage/enc"), join(output, "garage/enc"), { recursive: true });
await cp(join(root, "holding/lwe/lean"), join(output, "lwe/lean"), { recursive: true });
await cp(join(root, "holding/pixel-peeper/tiles"), join(output, "pixel-peeper/tiles"), { recursive: true });
await cp(join(root, "holding/pixel-peeper/manifest.json"), join(output, "pixel-peeper/manifest.json"));

const css = await readFile(join(root, "src/site/styles/site.css"), "utf8");
const cssName = `site.${digest(css)}.css`;
await write(`assets/${cssName}`, css);
await write("luna.css", `/* axp-desktop compatibility URL; new canonical source: /assets/${cssName} */\n${css}`);

const [home, hashes, alt, posts, siteManifest, photoIndex, checkpoints] = await Promise.all([
  json("content/home.json"),
  json("holding/images/hashes.json"),
  json("holding/images/alt.json"),
  json("content/writing/posts.json"),
  json("site-manifest.json"),
  json("holding/_worker.js/photo-index.json"),
  json("content/data/checkpoints.json"),
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
  for (const surface of items) {
    const slug = surface.path.slice(sectionPath.length + 1);
    const source = await readFile(join(root, "content/pages", name, `${slug}.md`), "utf8");
    await write(`${name}/${slug}.html`, renderArticle({
      surface,
      source,
      stylesheet: `/assets/${cssName}`,
    }));
    await write(`${name}/${slug}.md`, source);
  }
}

const systemSlugs = ["access", "bot", "pixel-peeper", "security", "terminal", "whoareyou"];
for (const slug of systemSlugs) {
  const surface = siteManifest.surfaces.find(({ path }) => path === `/${slug}`);
  const source = await readFile(join(root, "content/system", `${slug}.md`), "utf8");
  await write(`${slug}.html`, renderSystemPage({
    surface,
    source,
    stylesheet: `/assets/${cssName}`,
  }));
  await write(`${slug}.md`, source);
}

await write("updates.html", renderUpdates({ checkpoints, stylesheet: `/assets/${cssName}` }));
await write("updates.md", updatesMarkdown(checkpoints));
await write("updates.json", `${JSON.stringify({
  build: checkpoints.at(-1)?.version ?? "aadhar.sh",
  items: checkpoints.slice(-8).reverse().map(({ slug, title, version, ymd, vnum }) => ({ slug, title, version, ymd, vnum })),
}, null, 2)}\n`);
await write("restore.html", renderRestore({ checkpoints, stylesheet: `/assets/${cssName}` }));
await write("restore.md", restoreMarkdown(checkpoints));
await write("reading.html", renderReading({ stylesheet: `/assets/${cssName}` }));
await write("around.html", renderAround({ stylesheet: `/assets/${cssName}` }));
await write("ledger.html", renderLedger({ stylesheet: `/assets/${cssName}` }));
await write("lens.html", renderLens({ stylesheet: `/assets/${cssName}` }));
await write("coffee.html", renderCoffee({ stylesheet: `/assets/${cssName}` }));
await write("coffee.md", coffeeMarkdown());

const publicSurfaces = siteManifest.surfaces.filter(({ flags }) => flags.run);
await write("search.html", renderSearch({ stylesheet: `/assets/${cssName}` }));
await write("run.html", renderRun({ surfaces: publicSurfaces, stylesheet: `/assets/${cssName}` }));

const searchRecords = [
  ...siteManifest.surfaces.map(({ path, title, description, section }) => ({ path, title, description, section })),
  ...posts.map(({ slug, title, date }) => ({ path: `/writing/${slug}`, title, description: `Writing published ${date}`, section: "writing" })),
];
await write("search-index.json", `${JSON.stringify(searchRecords, null, 2)}\n`);

const llms = `# aadhar.sh\n\nA personal site by Aadharsh Pannirselvam: photographs, writing, explainers, experiments, and bounded public utilities.\n\n## Public surfaces\n\n${siteManifest.surfaces.filter(({ flags }) => flags.agents).map(({ path, title, description }) => `- [${title}](https://aadhar.sh${path}) — ${description}`).join("\n")}\n`;
await write("llms.txt", llms);
await write("llms-full.txt", `${llms}\n## Writing\n\n${writingMarkdown(posts)}\n\n## Garage\n\n${directoryMarkdown(siteManifest.surfaces.find(({ path }) => path === "/garage"), siteManifest.surfaces.filter(({ path, kind }) => kind === "content" && path.startsWith("/garage/")))}\n`);

const manifest = {
  pages: [
    "/",
    "/photos",
    "/writing",
    ...posts.map(({ slug }) => `/writing/${slug}`),
    ...directorySections,
    ...siteManifest.surfaces.filter(({ kind }) => kind === "content").map(({ path }) => path),
    ...systemSlugs.map((slug) => `/${slug}`),
    "/updates",
    "/restore",
    "/reading",
    "/around",
    "/ledger",
    "/lens",
    "/coffee",
    "/search",
    "/run",
  ],
  assets: [`/assets/${cssName}`, ...photos.flatMap(({ thumbAvif, thumbJpg, thumbSmall }) => [`/${thumbAvif}`, `/${thumbJpg}`, `/${thumbSmall}`])],
};
await write("build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${manifest.pages.length} page and ${manifest.assets.length} assets in dist/`);
