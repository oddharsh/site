// The served paths of every page that loads WebMCP. nav.js imports webmcp.js on
// idle, so a page loads WebMCP exactly when it loads nav.js. Derived from the
// pages themselves, so a new page is covered on arrival. Read by
// contract-webmcp-origin-trial (to keep the list honest) and by routes:check
// (to assert each page is served the origin trial tokens through the Worker).
import { readFileSync, readdirSync } from "node:fs";

export function pagesLoadingWebmcp(root: URL): string[] {
  const pages = new URL("src/pages/", root);
  const paths: string[] = [];
  for (const file of readdirSync(pages, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".html")) continue;
    if (!/\/nav(?:\.[0-9a-f]{8})?\.js/.test(readFileSync(new URL(file, pages), "utf8"))) continue;
    paths.push("/" + file.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, ""));
  }
  return paths.sort();
}
