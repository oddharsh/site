#!/usr/bin/env node
// Generate the three RSS 2.0 feeds from the site's existing registries.
// The XML is committed so local dev and production serve the same static bytes;
// build.mjs regenerates it in memory and fails if a source edit leaves it stale.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SITE = "https://aadhar.sh";
const AUTHOR = "Aadharsh Pannirselvam";

export const FEED_SECTIONS = {
  writing: {
    path: "/writing",
    title: "aadhar.sh · writing",
    description: "Notes, in flux. Written in a Notepad window that reverts on reload.",
  },
  garage: {
    path: "/garage",
    title: "aadhar.sh · garage",
    description: "Prototypes and experiments: the site's workshop, with live demos.",
  },
  lwe: {
    path: "/lwe",
    title: "aadhar.sh · learning with errors",
    description: "Chat-style explainers with live demos, at the pace of a 2009 MSN conversation.",
  },
};

export async function buildFeedDocuments(root = ".") {
  const [{ surfaces }, posts, sitemap] = await Promise.all([
    readJson(`${root}/site-manifest.json`),
    readJson(`${root}/holding/writing/posts.json`),
    readFile(`${root}/holding/sitemap.xml`, "utf8"),
  ]);
  const bodies = new Map(await Promise.all(posts.map(async ({ slug }) => [
    slug,
    await readFile(`${root}/holding/writing/${slug}.txt`, "utf8"),
  ])));
  const dates = sitemapDates(sitemap);

  return new Map(Object.keys(FEED_SECTIONS).map((section) => [
    section,
    renderFeed(section, { surfaces, posts, bodies, dates }),
  ]));
}

export function renderFeed(section, { surfaces, posts, bodies, dates }) {
  const meta = FEED_SECTIONS[section];
  if (!meta) throw new Error(`unknown feed section: ${section}`);

  const items = section === "writing"
    ? writingItems(posts, bodies)
    : sectionItems(section, surfaces, dates);
  const newest = items.map((item) => rfc822(item.date)).find(Boolean);
  const self = `${SITE}/${section}/feed.xml`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(meta.title)}</title>
    <link>${esc(SITE + meta.path)}</link>
    <description>${esc(meta.description)}</description>
    <language>en-us</language>
    <atom:link href="${esc(self)}" rel="self" type="application/rss+xml"/>
    <generator>aadhar.sh</generator>${newest ? `\n    <lastBuildDate>${newest}</lastBuildDate>` : ""}
${items.map(itemXml).join("\n")}
  </channel>
</rss>
`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function writingItems(posts, bodies) {
  return posts
    .filter((post) => post && typeof post.slug === "string")
    .map((post) => ({
      path: `/writing/${post.slug}`,
      title: post.title || post.slug,
      description: String(bodies.get(post.slug) || "").replace(/\s+/g, " ").trim(),
      date: post.date || "",
    }))
    .sort(byDateDesc)
    .slice(0, 20);
}

function sectionItems(section, surfaces, dates) {
  const prefix = `/${section}/`;
  return surfaces
    .filter((surface) => surface.path.startsWith(prefix) && surface.kind === "content")
    .map((surface) => ({
      path: surface.path,
      title: surface.title,
      description: surface.description,
      date: dates.get(surface.path) || "",
    }))
    .sort(byDateDesc);
}

function sitemapDates(xml) {
  const dates = new Map();
  for (const match of xml.matchAll(/<url>\s*<loc>https:\/\/aadhar\.sh([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g)) {
    dates.set(match[1] || "/", match[2].trim());
  }
  return dates;
}

function itemXml(item) {
  const link = SITE + item.path;
  const pubDate = rfc822(item.date);
  return `    <item>
      <title>${esc(item.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <description>${esc(item.description)}</description>
      <dc:creator>${esc(AUTHOR)}</dc:creator>${pubDate ? `\n      <pubDate>${pubDate}</pubDate>` : ""}
    </item>`;
}

function byDateDesc(a, b) {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.title.localeCompare(b.title);
}

function rfc822(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return "";
  const date = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== ymd) return "";
  return date.toUTCString();
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function main() {
  const feeds = await buildFeedDocuments();
  for (const [section, xml] of feeds) {
    await mkdir(`holding/${section}`, { recursive: true });
    await writeFile(`holding/${section}/feed.xml`, xml);
  }
  console.log(`feeds: ${feeds.size} RSS 2.0 documents`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
