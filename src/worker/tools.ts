import { redirect, text } from "./http";

const width = 80;

function clipped(value: string, size = width - 4): string {
  return [...value].slice(0, size).join("");
}

export function frame(title: string, lines: string[]): string {
  const inner = width - 2;
  const label = ` ${title} `;
  const left = Math.max(0, Math.floor((inner - label.length) / 2));
  const right = Math.max(0, inner - label.length - left);
  const body = lines.flatMap((line) => {
    const chunks = [];
    const glyphs = [...line];
    do chunks.push(glyphs.splice(0, inner - 2).join("")); while (glyphs.length);
    return chunks;
  });
  return [
    `╔${"═".repeat(left)}${label}${"═".repeat(right)}╗`,
    ...body.map((line) => `║ ${clipped(line).padEnd(inner - 2)} ║`),
    `╚${"═".repeat(inner)}╝`,
    "",
  ].join("\n");
}

function refused(url: URL): boolean {
  const target = url.searchParams.get("url");
  if (!target) return false;
  try {
    const parsed = new URL(target);
    return !["http:", "https:"].includes(parsed.protocol);
  } catch {
    return true;
  }
}

function toolFrame(name: string, url: URL): string {
  if (["lens", "dict", "cache", "encode"].includes(name) && refused(url)) {
    return frame(name, ["refused: only public http and https URLs are accepted", `state=${url.search}`]);
  }
  switch (name) {
    case "terminal": return frame("aadhar.sh terminal", ["finger  who runs this host", "photos  browse the archive", "lens    inspect the other web", "dict · cache · radar · encode · agent-ready"]);
    case "finger": {
      const lines = ["finger — aadharsh@aadhar.sh", "writing · photos · listening · neighborhood · coffee"];
      if (url.searchParams.get("keys")?.includes("2<cr>")) lines.push("pane=writing · note=in-flux");
      if (url.searchParams.has("help")) lines.push("driving this thing: add keys=2<cr> to the URL");
      return frame("finger", lines);
    }
    case "photos": return frame("photos — the archive", ["158 published photographs", "manifest: /images/manifest.json", "query: /photos/query.json?q=..."]);
    case "lens": return frame("lens — the other web", ["inspect how a public URL reads to people and machines", "add ?url=https://example.com"]);
    case "radar": return frame("radar", ["an instrument with no antenna", "POST bounded signal readings to draw bands and trends"]);
    case "dict": return frame("dict", ["compression dictionary registrations fail silently", "add ?url=https://example.com/app.js"]);
    case "cache": return frame("cache", ["behavioral revalidation lint", "fetch twice, replay the ETag, report what the origin did"]);
    case "agent-ready": return frame("agent-ready", ["doors a machine can walk through", "what this cost to build: files, routes, bytes, and lines"]);
    case "encode": return frame("encode", ["what did your encoder actually do?", "inspect JPEG or AVIF structure without decoding pixels"]);
    default: return frame("not found", [`unknown tool: ${name}`]);
  }
}

const toolNames = new Set(["terminal", "finger", "photos", "lens", "radar", "dict", "cache", "agent-ready", "encode"]);

export function terminalTool(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/terminal/dict") return redirect(request, "/dict");
  if (url.pathname === "/terminal/finger") return redirect(request, "/finger");
  const explicitText = url.pathname.endsWith(".txt");
  const name = url.pathname.replace(/^\//, "").replace(/\.txt$/, "");
  if (!toolNames.has(name)) return null;
  if (["photos", "lens"].includes(name) && !explicitText && !url.searchParams.has("plain")) return null;
  const acceptsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  const wantsText = explicitText || url.searchParams.has("plain") || !acceptsHtml;
  if (!wantsText) return null;
  return text(toolFrame(name, url), {
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
