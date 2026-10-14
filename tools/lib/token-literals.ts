// Which literal colours in served CSS are hand-resolved COPIES of a design token.
import { readFileSync, readdirSync } from "node:fs";

export function normalizeColor(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?<![\d.])\.(\d)/g, "0.$1")
    .replace(/(\d+)\.0+(?=[ %)])/g, "$1")
    .replace(/(\d+\.\d*[1-9])0+(?=[ %)])/g, "$1");
}

export function tokenValueMap(colorsCss: string): Map<string, string> {
  const p3 = colorsCss.indexOf("@media (color-gamut: p3)");
  const root = p3 === -1 ? colorsCss : colorsCss.slice(0, p3);
  const knobs = new Map<string, number>();
  for (const m of root.matchAll(/(--hue-[a-z]+|--chroma-[a-z]+)\s*:\s*([\d.]+)/g)) {
    if (!knobs.has(m[1])) knobs.set(m[1], Number(m[2]));
  }
  const resolve = (v: string): string | null => {
    let out = v;
    let unknown = false;
    out = out.replace(/var\((--[a-z-]+)\)/g, (_, n: string) => {
      const k = knobs.get(n);
      if (k === undefined) unknown = true;
      return k === undefined ? _ : String(k);
    });
    if (unknown) return null;
    out = out.replace(/calc\(\s*([\d.]+)\s*([-+])\s*([\d.]+)\s*\)/g, (_, a: string, op: string, b: string) =>
      String(Math.round((Number(a) + (op === "+" ? 1 : -1) * Number(b)) * 1e4) / 1e4),
    );
    return normalizeColor(out);
  };
  const byValue = new Map<string, string[]>();
  for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*(oklch\([^;]*?\))\s*;/g)) {
    const value = resolve(m[2]);
    if (value === null) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), m[1]]);
  }
  const map = new Map<string, string>();
  for (const [value, names] of byValue) if (names.length === 1) map.set(value, names[0]);
  return map;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export function parseOklch(s: string): { lab: Lab; alpha: string | null } | null {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(s.trim());
  if (!m) return null;
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  return { lab: { L, a: C * Math.cos(h), b: C * Math.sin(h) }, alpha: m[5] ?? null };
}

export const deltaEOK = (x: Lab, y: Lab): number => Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);

export const COPY_DE = 0.004;

export interface TokenCopy {
  literal: string;
  token: string;
  index: number;
  dE: number;
  fix: string;
}

/** sRGB 0-255 to OKLab, by Björn Ottosson's published matrices. */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [r, g, b].map((v) => lin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function parseSrgb(s: string): { lab: Lab; alpha: string | null } | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].replace(/./g, "$&$&") : hex[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { lab: srgbToOklab(n(0), n(2), n(4)), alpha: h.length === 8 ? String(Math.round((n(6) / 255) * 100) / 100) : null };
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (rgb) return { lab: srgbToOklab(+rgb[1], +rgb[2], +rgb[3]), alpha: rgb[4] ?? null };
  return null;
}

function inDeclaration(css: string, index: number): boolean {
  if (css.lastIndexOf("/*", index) > css.lastIndexOf("*/", index)) return false;
  const start = Math.max(css.lastIndexOf("{", index), css.lastIndexOf(";", index), css.lastIndexOf("}", index), css.lastIndexOf('"', index));
  return css.slice(start + 1, index).includes(":");
}

const COLOR = /oklch\([^()]*\)|(?<![\w&#-])#[0-9a-fA-F]{3,8}(?![\w-])|rgba?\([^()]*\)/g;

export interface ColorLiteral {
  literal: string;
  index: number;
  lab: Lab;
  alpha: string | null;
}

export function colorLiteralsIn(css: string): ColorLiteral[] {
  const out: ColorLiteral[] = [];
  for (const m of css.matchAll(COLOR)) {
    if (/\b[a-z-]+=["']$/.test(css.slice(Math.max(0, m.index - 24), m.index))) continue;
    const isOklch = m[0].startsWith("oklch(");
    if (!isOklch && !inDeclaration(css, m.index)) continue;
    if (/var\(\s*--[\w-]+\s*,[^()]*$/.test(css.slice(Math.max(0, m.index - 80), m.index))) continue;
    const parsed = isOklch ? parseOklch(m[0]) : parseSrgb(m[0]);
    if (parsed) out.push({ literal: m[0], index: m.index, lab: parsed.lab, alpha: parsed.alpha });
  }
  return out;
}

export function tokenCopiesIn(css: string, map: Map<string, string>): TokenCopy[] {
  const labs: [string, Lab][] = [];
  for (const [value, token] of map) {
    const p = parseOklch(value);
    if (p) labs.push([token, p.lab]);
  }
  const out: TokenCopy[] = [];
  for (const parsed of colorLiteralsIn(css)) {
    const m = { 0: parsed.literal, index: parsed.index };
    const opaque = m[0].startsWith("oklch(") ? normalizeColor(m[0].replace(/\s*\/\s*[\d.]+%?\s*\)$/, ")")) : "";
    let token = opaque ? map.get(opaque) : undefined;
    let dE = 0;
    if (!token) {
      const near = labs.map(([t, lab]) => [t, deltaEOK(parsed.lab, lab)] as const).filter(([, d]) => d < COPY_DE);
      if (near.length === 1) [token, dE] = near[0];
    }
    if (!token) continue;
    const fix = parsed?.alpha ? `oklch(from var(${token}) l c h / ${parsed.alpha})` : `var(${token})`;
    out.push({ literal: m[0], token, index: m.index, dE: Math.round(dE * 1e4) / 1e4, fix });
  }
  return out;
}

const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;

export function loadTokenValueMap(root: URL): Map<string, string> {
  return tokenValueMap(readFileSync(new URL("design/tokens/colors.css", root), "utf8"));
}

export const NO_LUNA = new Set(["garage/vt-b.html"]);

export const EMAIL_TEMPLATES = new Set(["cal/src/email.ts", "src/worker/webmention.ts"]);

export interface CssSource {
  file: string;
  css: string;
  kind: "page" | "generator" | "spec" | "worker" | "stylesheet";
  offset: number | null;
}

export function cssSources(root: URL): CssSource[] {
  const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");
  const ls = (rel: string, recursive = false) => readdirSync(new URL(rel, root), { recursive }) as string[];
  const out: CssSource[] = [];
  for (const rel of ls("src/pages", true).filter((f) => f.endsWith(".html"))) {
    if (NO_LUNA.has(rel)) continue;
    for (const m of read(`src/pages/${rel}`).matchAll(STYLE_BLOCK)) {
      out.push({ file: `src/pages/${rel}`, css: m[1], kind: "page", offset: m.index + m[0].indexOf(">") + 1 });
    }
  }
  for (const rel of ["pipelines/lwe/generate.mjs", "pipelines/garage/generate.mjs"]) out.push({ file: rel, css: read(rel), kind: "generator", offset: 0 });
  for (const family of ["lwe", "garage"]) {
    for (const f of ls(`pipelines/${family}/specs`).filter((f) => f.endsWith(".json"))) {
      const spec = JSON.parse(read(`pipelines/${family}/specs/${f}`)) as { pageCss?: string; demoCss?: string };
      for (const css of [spec.pageCss, spec.demoCss]) {
        if (css) out.push({ file: `pipelines/${family}/specs/${f}`, css, kind: "spec", offset: null });
      }
    }
  }
  for (const dir of ["src/worker", "cal/src", "serendipity"]) {
    for (const f of ls(dir, true)) {
      if (/\.(ts|js)$/.test(f) && !/(^|\/)test\//.test(f) && !f.endsWith(".d.ts") && !EMAIL_TEMPLATES.has(`${dir}/${f}`)) out.push({ file: `${dir}/${f}`, css: read(`${dir}/${f}`), kind: "worker", offset: 0 });
    }
  }
  const luna = read("src/styles/luna.css");
  const typo = read("design/tokens/typography.css").trim();
  const body = luna.indexOf(typo) + typo.length;
  out.push({ file: "src/styles/luna.css", css: luna.slice(body), kind: "stylesheet", offset: body });
  for (const f of ls("src/styles").filter((f) => f.endsWith(".css") && f !== "luna.css")) {
    out.push({ file: `src/styles/${f}`, css: read(`src/styles/${f}`), kind: "stylesheet", offset: 0 });
  }
  return out;
}
