// article-ld.ts — the schema.org Article every Garage and LWE page carries,
// generated at build (build.ts step 1g4) from facts the build already holds.

export const SITE = "https://aadhar.sh";
export const PERSON = {
  "@type": "Person",
  "@id": `${SITE}/#person`,
  name: "Aadharsh Pannirselvam",
  url: `${SITE}/`,
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const meta = (html: string, attr: "name" | "property", key: string): string | null => {
  const tag = new RegExp(`<meta\\s[^>]*${attr}=["']?${key}["']?[^>]*>`, "i").exec(html);
  const content = tag && /\scontent="([^"]*)"/i.exec(tag[0]);
  return content ? decodeEntities(content[1]).trim() : null;
};

export function topicOf(ogTitle: string | null): string | null {
  if (!ogTitle) return null;
  const dot = ogTitle.indexOf(" · ");
  if (dot !== -1) return ogTitle.slice(dot + 3).trim() || null;
  const colon = ogTitle.indexOf(": ");
  if (colon !== -1 && ogTitle.startsWith("aadhar.sh/")) return ogTitle.slice(colon + 2).trim() || null;
  return null;
}

export function h1Of(html: string): string | null {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!h1) return null;
  const text = decodeEntities(h1[1]
    .replace(/<span\b[^>]*\bclass="[^"]*\b(?:badge|status)\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
  return text || null;
}

export type ArticleLd = {
  "@context": string; "@type": string; headline: string; description?: string;
  url: string; mainEntityOfPage: string; datePublished: string; inLanguage: string;
  image?: string; author: typeof PERSON; publisher: { "@id": string }; isPartOf: { "@id": string };
};

export function articleLd({ path, section, html, date }: { path: string; section: string; html: string; date: string | undefined }): ArticleLd {
  const headline = topicOf(meta(html, "property", "og:title")) || h1Of(html);
  if (!headline) throw new Error(`article-ld: ${path} has neither an og:title topic nor an h1 to name it`);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`article-ld: ${path} has no sitemap date (got ${JSON.stringify(date)})`);
  const description = meta(html, "name", "description");
  const image = meta(html, "property", "og:image");
  const head = { "@context": "https://schema.org", "@type": section === "garage" ? "TechArticle" : "Article", headline };
  const described: Pick<ArticleLd, "@context" | "@type" | "headline" | "description"> = { ...head };
  if (description) described.description = description;
  const dated = { ...described, url: `${SITE}${path}`, mainEntityOfPage: `${SITE}${path}`, datePublished: date, inLanguage: "en" };
  const pictured: Omit<ArticleLd, "author" | "publisher" | "isPartOf"> = { ...dated };
  if (image) pictured.image = image;
  return { ...pictured, author: PERSON, publisher: { "@id": PERSON["@id"] }, isPartOf: { "@id": `${SITE}/#website` } };
}

export function articleLdScript(ld: object): string {
  return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

export function injectArticleLd(html: string, script: string): string {
  if (/"@type"\s*:\s*"(?:Tech)?Article"/.test(html)) return html;
  const at = html.search(/<\/head>/i);
  if (at === -1) throw new Error("article-ld: page has no </head>");
  return html.slice(0, at) + script + "\n" + html.slice(at);
}
