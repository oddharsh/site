import { escapeHtml } from "./document.mjs";

function safeUrl(value) {
  const url = value.trim();
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(url) ? escapeHtml(url) : "#";
}

function inline(value) {
  let html = escapeHtml(value);
  html = html.replace(/&lt;(https?:\/\/[^&]+)&gt;/g, (_, url) => `<a href="${safeUrl(url)}">${url}</a>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, url) =>
    `<a href="${safeUrl(url)}">${label}</a>`
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return html;
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function beginsBlock(lines, index) {
  const line = lines[index] ?? "";
  return !line.trim()
    || /^#{1,6}\s/.test(line)
    || /^```/.test(line)
    || /^\s*(?:[-*_]){3,}\s*$/.test(line)
    || /^>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || (line.includes("|") && isTableDivider(lines[index + 1] ?? ""));
}

export function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, markdown: source };
  const attributes = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { attributes[key] = JSON.parse(raw); } catch { attributes[key] = raw.slice(1, -1); }
    } else {
      attributes[key] = raw;
    }
  }
  return { attributes, markdown: source.slice(match[0].length) };
}

export function renderMarkdown(source) {
  const { markdown } = parseFrontmatter(source.replaceAll("\r\n", "\n"));
  const lines = markdown.split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    const presence = line.match(/^\*\*([^*]+)\*\*(Online,.*)$/);
    if (presence) {
      output.push(`<p class="chat-presence"><strong>${inline(presence[1])}</strong><span>${inline(presence[2])}</span></p>`);
      index += 1;
      continue;
    }

    const chat = line.match(/^\*\*([^*]+)\*\*(\d{1,2}:\d{2})$/);
    if (chat) {
      const speaker = chat[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      output.push(`<p class="chat-meta speaker-${escapeHtml(speaker)}"><strong>${inline(chat[1])}</strong><time>${escapeHtml(chat[2])}</time></p>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:[-*_]){3,}\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      output.push(`<blockquote>${quote.map((item) => inline(item)).join(" ")}</blockquote>`);
      continue;
    }

    const list = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const items = [];
      const matcher = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(matcher);
        if (!item) break;
        items.push(`<li>${inline(item[1])}</li>`);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index++]));
      }
      output.push(`<div class="table-scroll"><table><thead><tr>${headers.map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !beginsBlock(lines, index)) paragraph.push(lines[index++].trim());
    output.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return output.join("\n");
}
