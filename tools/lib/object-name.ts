// object-name.ts: the name build step 1g2 prints in a page's address bar and
// in its task pane's Details box.
//
// The h1 arrives as HTML source and leaves through the `html` tagged template,
// which escapes it. Anything still escaped here is escaped twice there:
// /garage/gpt56 printed `Sol&apos;s` as literal text until 2026-10-17.
// Decoding runs after the tags go, so `&lt;b&gt;` stays text.
import { decodeEntities } from "./html-to-md.ts";

// Read the object's own name out of its h1, minus the status pill the garage
// marks each experiment with: the pill is state, not name, and sweeping it up
// published "Thumbnail encoding study shipped" as a breadcrumb.
export function objectNameOf(html: string): string {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!h1) return "";
  return decodeEntities(h1[1]
    .replace(/<span\b[^>]*\bclass="[^"]*\bstatus\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
