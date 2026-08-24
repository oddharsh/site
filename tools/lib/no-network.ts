// ── the suite may not touch the network ──────────────────────────────────
//
// Preloaded by `bun run test` and `bun run test:node`. It replaces the global
// `fetch` with one that records the attempt, refuses it, and fails the process
// at exit.
//
// It exists because the suite reached production aadhar.sh 52 times per run and
// nobody noticed for months. That arrived one call site at a time across three
// files and took two PRs to clear (#506, #508), which is the shape of a problem
// that comes back. `validate` is the ONE required check on main, so a test that
// quietly depends on a deployed site being up and fast is a merge gate wired to
// somebody else's uptime.
//
// TWO MECHANISMS, and the second is the load-bearing one.
//
// Refusing the call is the cheap half: no packet leaves, so CI cannot hammer
// production even on a run that is about to fail. On its own it would be a
// tripwire that cannot fire, for the exact reason the escapes went unseen in
// the first place. Every probe in `lens.ts` wraps its fetch in a try/catch and
// degrades to `unreadable`, so a throw is SWALLOWED and the test still passes.
// Measured on the real suite: with `fetch` set to throw, all 47 files pass on
// this commit and on every commit before it. A refusal proves "no network
// needed" and says nothing whatsoever about "no network attempted".
//
// So the record is what actually holds the line. `escaped` is appended before
// the throw, and the exit hook reads it no matter what the caller did with the
// error. A caught refusal still fails the run.
//
// There is deliberately NO opt-out env var. A list of allowed exceptions is an
// invitation to add an entry rather than a stub, which is the same reasoning
// `infra.json` uses for asserting `bypass_actors` EMPTY instead of against a
// declared list. Nothing in `tools/` has a legitimate reason to leave the
// machine: the checks that genuinely read the wire (`infra:check`, `dcz:check`,
// `routes:check:remote`) are their own scripts and never run under `bun test`.
//
// To stub one test, follow the convention already in ~10 files here:
//
//   const realFetch = globalThis.fetch;
//   try { testGlobals.fetch = async () => new Response("...", { status: 200 }); ... }
//   finally { testGlobals.fetch = realFetch; }
//
// That captures THIS wrapper as `realFetch` and puts it back afterwards, which
// is what keeps the tripwire armed for everything after the test.

// State hangs off a global Symbol rather than module scope so a SECOND
// evaluation of this file is a no-op instead of a silent disarm. Measured
// 2026-08-21: a test importing `./lib/no-network.ts` and the `--preload` of
// `./tools/lib/no-network.ts` do resolve to one instance today, under bun and
// node both. The guard is for the day they stop, because the failure would be
// quiet in the worst direction: the second copy installs its own `fetch` and
// its own empty array, and the exit hook reading the FIRST array then reports a
// clean run over any number of escapes.
const KEY = Symbol.for("aadhar.sh/test-network-tripwire");
const glob: any = globalThis;
const state = glob[KEY] ?? (glob[KEY] = { escaped: [], armed: false });
const escaped: string[] = state.escaped;

// `fetch` accepts string | URL | Request, and the platform already owns the
// parse for that union, so this hands the input to `Request` and reads the
// domain value off the result rather than sniffing the representation. The
// fallback catches input `Request` itself rejects, which is still worth naming
// in the report: an escape to something unparseable is an escape.

const urlOf = (input) => {
  try { return new Request(input as any).url; } catch { return String(input); }
};

const arm = () => {
  // `async` so the refusal arrives as a REJECTED PROMISE rather than a
  // synchronous throw. `fetch` returns a promise, and a caller written as
  // `fetch(u).then(...)` with no await would otherwise get an exception from a
  // line it never guarded, which is a different failure than the one reported.
  //
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

    // counts by host, filled as refusals arrive
    const counts = new Map<string, number>();
    for (const url of escaped) {
      let host = "(unparseable)";
      try { host = new URL(url).host; } catch { /* keep the placeholder */ }
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

    // Set rather than thrown: an exception raised in an exit hook is reported
    // as a crash in the harness instead of as this message, and the message is
    // the whole point.
    process.exitCode = 1;
  });
};

if (!state.armed) {
  state.armed = true;
  arm();
}

export { escaped };
