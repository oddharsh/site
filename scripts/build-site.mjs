import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHome } from "../src/site/pages/home.mjs";

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

const css = await readFile(join(root, "src/site/styles/site.css"), "utf8");
const cssName = `site.${digest(css)}.css`;
await write(`assets/${cssName}`, css);

const [home, hashes, alt] = await Promise.all([
  json("content/home.json"),
  json("holding/images/hashes.json"),
  json("holding/images/alt.json"),
]);

const photoStems = Object.keys(hashes).slice(0, 6);
const photos = [];
for (const stem of photoStems) {
  const names = {
    avif: `i/${stem}.${hashes[stem].a}.avif`,
    jpg: `i/${stem}.${hashes[stem].j}.jpg`,
  };
  for (const name of Object.values(names)) {
    await mkdir(join(output, dirname(name)), { recursive: true });
    await cp(join(root, "holding", name), join(output, name));
  }
  photos.push({ stem, alt: alt[stem] ?? "", ...names });
}

await write("index.html", renderHome({
  content: home,
  photos,
  stylesheet: `/assets/${cssName}`,
}));

const markdown = `# ${home.name}\n\n${home.role}\n\n**Under construction.**\n\n${home.introduction.join("\n\n")}\n\n${home.contact}\n\n## Links\n\n${home.links.map(({ label, href }) => `- [${label}](${href})`).join("\n")}\n`;
await write("index.md", markdown);

const manifest = {
  pages: ["/"],
  assets: [`/assets/${cssName}`, ...photos.flatMap(({ avif, jpg }) => [`/${avif}`, `/${jpg}`])],
};
await write("build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${manifest.pages.length} page and ${manifest.assets.length} assets in dist/`);
