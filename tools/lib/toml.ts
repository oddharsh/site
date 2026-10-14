// toml.ts: the TOML reader for the repository's own TOML files.

export type TomlValue = string | number | bigint | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const NUMBER = /^(true|false|[+-]?(?:inf|nan)|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+)(?=[\s,\]}#]|$)/;

export function parse(src: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`toml: ${what} at line ${src.slice(0, i).split("\n").length}`);
  };
  const space = () => { while (src[i] === " " || src[i] === "\t") i++; };
  const gap = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "#") return;
      while (i < src.length && src[i] !== "\n") i++;
    }
  };
  const string = (): string => {
    const q = src[i++];
    let out = "";
    while (src[i] !== q) {
      if (i >= src.length || src[i] === "\n") fail("unterminated string");
      if (q === '"' && src[i] === "\\") {
        const e = src[i + 1] ?? "";
        if (e === "u" || e === "U") {
          const n = e === "u" ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + n), 16));
          i += 2 + n;
          continue;
        }
        const escaped = ESCAPES[e];
        if (escaped === undefined) fail(`bad escape \\${e}`);
        out += escaped;
        i += 2;
        continue;
      }
      out += src[i++];
    }
    i++;
    return out;
  };
  const key = (): string => {
    space();
    if (src[i] === '"' || src[i] === "'") return string();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
    if (!m) return fail("expected a key");
    i += m[0].length;
    return m[0];
  };
  const path = (): string[] => {
    const parts = [key()];
    space();
    while (src[i] === ".") { i++; parts.push(key()); space(); }
    return parts;
  };
  const descend = (from: TomlTable, keys: string[]): TomlTable => {
    let at = from;
    for (const k of keys) {
      const next = (at[k] ??= {});
      const table = Array.isArray(next) ? next.at(-1) : next;
      if (!(table instanceof Object) || Array.isArray(table)) return fail(`${keys.join(".")} is not a table`);
      at = table as TomlTable;
    }
    return at;
  };
  const set = (obj: TomlTable, keys: string[], v: TomlValue) => {
    const into = descend(obj, keys.slice(0, -1));
    const last = keys.at(-1) as string;
    if (last in into) fail(`duplicate key ${keys.join(".")}`);
    into[last] = v;
  };
  const value = (): TomlValue => {
    space();
    const c = src[i];
    if (c === '"' || c === "'") {
      if (src.startsWith(c.repeat(3), i)) fail("multi-line strings aren't read");
      return string();
    }
    if (c === "[") {
      i++;
      const out: TomlValue[] = [];
      for (gap(); src[i] !== "]"; gap()) {
        if (i >= src.length) fail("unclosed array");
        out.push(value());
        gap();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail("expected , or ]");
      }
      i++;
      return out;
    }
    if (c === "{") {
      i++;
      const out: TomlTable = {};
      space();
      while (src[i] !== "}") {
        if (i >= src.length) fail("unclosed inline table");
        const k = path();
        if (src[i++] !== "=") fail("expected =");
        set(out, k, value());
        space();
        if (src[i] === ",") { i++; space(); }
      }
      i++;
      return out;
    }
    const m = NUMBER.exec(src.slice(i));
    if (!m) return fail("unreadable value (dates and times aren't read)");
    i += m[0].length;
    const t = m[0].replace(/_/g, "");
    if (t === "true" || t === "false") return t === "true";
    if (/inf|nan/.test(t)) return t.includes("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
    if (/^0[xob]/.test(t)) return Number(t);
    if (/[.eE]/.test(t)) return parseFloat(t);
    return Number.isSafeInteger(Number(t)) ? Number(t) : BigInt(t);
  };

  while (i < src.length) {
    gap();
    if (i >= src.length) break;
    if (src[i] === "[") {
      const many = src[i + 1] === "[";
      i += many ? 2 : 1;
      const keys = path();
      if (!src.startsWith(many ? "]]" : "]", i)) fail("unclosed table header");
      i += many ? 2 : 1;
      const parent = descend(root, keys.slice(0, -1));
      const last = keys.at(-1) as string;
      if (many) {
        const list = (parent[last] ??= []);
        if (!Array.isArray(list)) fail(`${keys.join(".")} is not an array of tables`);
        (list as TomlValue[]).push((table = {}));
      } else {
        table = descend(parent, [last]);
      }
      continue;
    }
    const k = path();
    if (src[i++] !== "=") fail("expected =");
    set(table, k, value());
    space();
    if (src[i] === "#") while (i < src.length && src[i] !== "\n") i++;
    if (i < src.length && src[i] !== "\n" && src[i] !== "\r") fail("expected a new line");
  }
  return root;
}
