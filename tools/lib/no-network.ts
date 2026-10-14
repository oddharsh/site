// ── the suite may not touch the network ──────────────────────────────────

const KEY = Symbol.for("aadhar.sh/test-network-tripwire");
const glob: any = globalThis;
const state = glob[KEY] ?? (glob[KEY] = { escaped: [], armed: false });
const escaped: string[] = state.escaped;

const urlOf = (input) => {
  try { return new Request(input as any).url; } catch { return String(input); }
};

const arm = () => {
  // Assigned through the loose alias for the reason contract-shared.mjs gives at
  // `testGlobals`: bun types `globalThis.fetch` as `typeof fetch`, which carries
  // a `preconnect` method, and a double that refuses every request has no
  // business implementing it. This is a partial stand-in being installed on a
  // global, and saying so once beats inventing conformance.
  glob.fetch = async function testSuiteMayNotFetch(input: any) {
    const url = urlOf(input);
    escaped.push(url);
    throw new TypeError(
      `the test suite tried to fetch ${url}. Stub globalThis.fetch for this test ` +
      `(see tools/lib/no-network.ts) rather than letting a required check depend on a live host.`,
    );
  };

  process.on("exit", () => {
    if (escaped.length === 0) return;

    const counts = new Map<string, number>();
    for (const url of escaped) {
      let host = "(unparseable)";
      try { host = new URL(url).host; } catch {}
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }

    process.stderr.write([
      "",
      `NETWORK TRIPWIRE: the suite attempted ${escaped.length} outbound request(s).`,
      "",
      ...[...counts].sort((a, b) => b[1] - a[1]).map(([host, n]) => `  ${String(n).padStart(4)}  ${host}`),
      "",
      "  first few:",
      ...[...new Set(escaped)].slice(0, 5).map((u) => `    ${u}`),
      "",
      "  Every one was REFUSED, so nothing left the machine, and a test that",
      "  caught the refusal may well have passed. That is why this fails at exit",
      "  rather than trusting the throw to be noticed.",
      "  Stub globalThis.fetch in the offending test; the header here says how.",
      "",
    ].join("\n") + "\n");

    process.exitCode = 1;
  });
};

if (!state.armed) {
  state.armed = true;
  arm();
}

export { escaped };
