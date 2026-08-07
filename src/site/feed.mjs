const SITE = "https://aadhar.sh";
const AUTHOR = "Aadharsh Pannirselvam";

const channels = {
  writing: {
    path: "/writing",
    title: "aadhar.sh · writing",
    description: "Notes in flux, published as durable plain-text documents.",
  },
  garage: {
    path: "/garage",
    title: "aadhar.sh · garage",
    description: "Prototypes, experiments, and implementation studies from the site's workshop.",
  },
  lwe: {
    path: "/lwe",
    title: "aadhar.sh · learning with errors",
    description: "Chat-style explainers and worked examples, at the pace of a 2009 MSN conversation.",
  },
};

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function rfc822(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? ""
    : date.toUTCString();
}

function byNewest(a, b) {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.title.localeCompare(b.title);
}

function itemXml(item) {
  const link = `${SITE}${item.path}`;
  const published = rfc822(item.date);
  return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(item.description)}</description>
      <dc:creator>${escapeXml(AUTHOR)}</dc:creator>${published ? `\n      <pubDate>${published}</pubDate>` : ""}
    </item>`;
}

export function renderFeed(section, entries) {
  const channel = channels[section];
  if (!channel) throw new Error(`Unknown feed section: ${section}`);

  const items = entries
    .filter(({ path, title }) => typeof path === "string" && typeof title === "string")
    .toSorted(byNewest);
  const self = `${SITE}/${section}/feed.xml`;
  const newest = items.map(({ date }) => rfc822(date)).find(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(SITE + channel.path)}</link>
    <description>${escapeXml(channel.description)}</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>
    <generator>aadhar.sh static compiler</generator>${newest ? `\n    <lastBuildDate>${newest}</lastBuildDate>` : ""}
${items.map(itemXml).join("\n")}
  </channel>
</rss>
`;
}
