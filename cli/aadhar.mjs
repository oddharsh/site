// aadhar: aadhar.sh from the terminal, over the keyless API that
// https://aadhar.sh/openapi.json describes. No dependencies, Node 18+.
//
// Every command is one GET against a documented endpoint, so anything this does
// an agent can do with curl, and the contract test holds each path to the spec.
// `run` takes its I/O as arguments, which is what lets that test drive it with
// no network.

export const VERSION = "0.1.0";
export const DEFAULT_BASE = "https://aadhar.sh";

const HELP = `aadhar ${VERSION}: read aadhar.sh from the terminal

usage: aadhar <command> [args] [--json] [--base URL]

  search <terms> [--limit N]       search every public page
  ask <question> [--top N]         ask in plain language (NLWeb), ranked pages back
  read <path>                      a page as Markdown, e.g. aadhar read /lwe/fhe
  photos [--q T] [--camera T] [--lens T] [--film T] [--recipe T] [--limit N]
                                   query the photo archive and its Fuji recipes
  lens <url>                       how a machine reads a URL (agent readiness)
  compare <left> <right>           two URLs through Lens, side by side
  playing                          the playlist playing right now
  coffee                           open coffee slots in New York

  --json      print the endpoint's JSON as is
  --base URL  another origin (default ${DEFAULT_BASE}, or $AADHAR_BASE)

No key, no account. Docs: https://aadhar.sh/developers
`;

/** One command: which endpoint, which query, how to print it. */
export const COMMANDS = {
  search: { path: "/search.json", args: ["q"], flags: { limit: "limit" }, print: (d) => d.results.map((r) => `${r.title}\n  https://aadhar.sh${r.url.startsWith("/") ? r.url : `/${r.url}`}\n  ${r.description || r.snippet || ""}`.trimEnd()).join("\n\n") },
  ask: { path: "/ask", args: ["query"], flags: { top: "top_k" }, fixed: { streaming: "0" }, print: (d) => d.results.map((r) => `${String(r.score).padStart(3)}  ${r.name}\n     ${r.url}`).join("\n") },
  photos: { path: "/photos/query.json", args: [], flags: { q: "q", camera: "camera", lens: "lens", film: "film", recipe: "recipe", limit: "limit" }, print: (d) => d.photos.map((p) => `${p.stem}  ${p.metadata?.film || ""}  ${p.alt || ""}\n  ${p.full || p.thumb?.jpg || ""}`.trimEnd()).join("\n") },
  lens: { path: "/lens/fetch", args: ["url"], flags: {}, print: (d) => [`${d.status} ${d.finalUrl || d.url}`, d.readiness ? `readiness: ${JSON.stringify(d.readiness.score ?? d.readiness)}` : "", d.fetchedBy ? `fetched by ${d.fetchedBy}` : ""].filter(Boolean).join("\n") },
  compare: { path: "/lens/compare.json", args: ["left", "right"], flags: {}, print: (d) => d.changes.map((c) => `${c.label}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`).join("\n") || "no differences" },
  playing: { path: "/rn/tracks", args: [], flags: {}, print: (d) => [d.playlist_name, ...d.tracks.map((t) => `  ${t.title} · ${t.artists_text}\n    ${t.song_link_url}`)].join("\n") },
  coffee: { path: "/coffee/availability.json", args: [], flags: {}, print: (d) => d.slots.length ? d.slots.map((s) => `${s.start}  (${s.durationMinutes} min)`).join("\n") + `\nbook at ${d.bookingUrl}` : `no open slots right now; book at ${d.bookingUrl || "https://aadhar.sh/coffee"}` },
};

/** Split argv into positionals and --flags. A flag takes the next word. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "-h" || a === "--help" || a === "--version") flags[a.replace(/^-+/, "")] = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

/** The URL a command calls, or an error sentence. Pure, for the test. */
export function buildUrl(name, rest, flags, base = DEFAULT_BASE) {
  const cmd = COMMANDS[name];
  if (!cmd) return { error: `unknown command "${name}". Try aadhar --help.` };
  const url = new URL(cmd.path, base);
  if (cmd.args.length === 1 && rest.length) url.searchParams.set(cmd.args[0], rest.join(" "));
  else cmd.args.forEach((a, i) => rest[i] !== undefined && url.searchParams.set(a, rest[i]));
  const missing = cmd.args.filter((a) => !url.searchParams.has(a));
  if (missing.length) return { error: `${name} needs ${missing.map((m) => `<${m}>`).join(" ")}` };
  for (const [flag, param] of Object.entries(cmd.flags)) if (flags[flag] !== undefined) url.searchParams.set(param, String(flags[flag]));
  for (const [k, v] of Object.entries(cmd.fixed || {})) url.searchParams.set(k, v);
  return { url };
}

/** Run one command. Returns the exit code: 0 ok, 1 an API error, 2 a usage error. */
export async function run(argv, { fetch, out, err, env = {} }) {
  const { positional, flags } = parseArgs(argv);
  const [name, ...rest] = positional;
  if (flags.version) { out(`${VERSION}\n`); return 0; }
  if (!name || flags.help || flags.h || name === "help") { out(HELP); return name || flags.help || flags.h ? 0 : 2; }
  const base = flags.base || env.AADHAR_BASE || DEFAULT_BASE;

  if (name === "read") {
    if (!rest[0]) { err("read needs <path>, e.g. aadhar read /lwe/fhe\n"); return 2; }
    const res = await fetch(new URL(rest[0], base), { headers: { accept: "text/markdown" } });
    const body = await res.text();
    if (!res.ok) { err(`${res.status}: ${body}`); return 1; }
    out(body.endsWith("\n") ? body : `${body}\n`);
    return 0;
  }

  const built = buildUrl(name, rest, flags, base);
  if (built.error) { err(`${built.error}\n`); return 2; }
  const res = await fetch(built.url, { headers: { accept: "application/json" } });
  let data;
  try { data = await res.json(); } catch { err(`${res.status}: the response was not JSON\n`); return 1; }
  if (!res.ok || data?.ok === false) {
    err(`${res.status}: ${data?.error || "request failed"}${data?.code ? ` (${data.code})` : ""}${data?.hint ? `\n${data.hint}` : ""}\n`);
    return 1;
  }
  out(flags.json ? `${JSON.stringify(data, null, 2)}\n` : `${COMMANDS[name].print(data)}\n`);
  return 0;
}
