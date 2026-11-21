#!/usr/bin/env bun
// sim.ts: deterministic simulation of the site Worker, the Counter Durable
// Object and KV. One seed picks the events (requests, cron ticks, clock jumps,
// faults) and every interleaving of the I/O they start; tools/lib/sim-world.ts
// owns the fakes and lists what they leave out.
//
//   bun run sim                          # 60 s budget from a random base seed
//   bun run sim -- --budget 10 --seed 1  # 10 s, seeds 1, 2, 3, ...
//   bun run sim -- --seed 7 --steps 400  # one run, printed
//   bun run sim -- --seed 7 --events f   # replay a shrunk event list
//   bun run sim -- --seed 1 --seeds 60   # exactly seeds 1 to 60 (the control)
//
// SIM_TRACE=<file> on a --child run writes its whole trace there, and
// SIM_TRACE_NEW=1 adds a line per op created, which is how a nondeterministic
// seed gets diffed (it changes the hash, so compare runs that both set it).
//
// After every step it asserts:
//   no-5xx       no 500/502/504, thrown fetch, rejected cron or rejected
//                waitUntil unless a fault touched that invocation. 503 is
//                left out: at least 7 handlers answer it on purpose when their
//                data or secret is absent, which an empty world always is, so
//                it is counted per route in stats.unavailable instead.
//   counter      no invocation moves the homepage-visits count by more than 1,
//                or at all unless it should count; the count never falls and
//                never passes the number of visits that asked to count (the
//                oracle reads handleHit's rules from its header, not its code)
//   mirror       the KV mirror never runs ahead of the count, and never falls
//   budget       no invocation tried a 51st subrequest without a `cap` fault
//   liveness     after a full drain, every visit no fault touched was counted
// and, across processes, that one seed gives one trace hash.
//
// A failing seed is shrunk by delta debugging over its event list, then
// printed with a replay command. Each run is its own process, because the
// Worker keeps module-scope caches a second run in the same isolate would see.

import { plugin } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FAULT_KINDS, SUBREQUEST_CAP, createWorld, rng } from "./lib/sim-world.ts";
import type { FaultKind, Invocation } from "./lib/sim-world.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

type SimEvent =
  | { t: "req"; method: "GET" | "HEAD" | "POST"; path: string; ua?: string; purpose?: string; bot?: boolean }
  | { t: "cron"; cron: string }
  | { t: "advance"; ms: number }
  | { t: "fault"; kind: FaultKind }
  | { t: "restart" }
  | { t: "settle" };

interface RunResult {
  ok: boolean;
  seed: number;
  steps: number;
  property?: string;
  message?: string;
  events: SimEvent[];
  traceHash: string;
  traceTail?: string[];
  findings: string[];
  stats: {
    requests: number;
    crons: number;
    faults: number;
    ops: number;
    count: number;
    intended: number;
    maxSubrequests: number;
    maxSubrequestsAt: string;
    unavailable: Record<string, number>;
  };
}

// ── events ───────────────────────────────────────────────────────────────────
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const HIT_VISITS: Array<[number, Omit<Extract<SimEvent, { t: "req" }>, "t">]> = [
  [5, { method: "GET", path: "/hit?tick=1&n=1" }],
  [3, { method: "GET", path: "/hit?tick=1" }],
  [2, { method: "GET", path: "/hit" }],
  [2, { method: "GET", path: "/hit?n=1" }],
  [1, { method: "GET", path: "/hit?peek=1" }],
  [1, { method: "HEAD", path: "/hit" }],
  [1, { method: "GET", path: "/hit?tick=1", purpose: "prefetch;prerender" }],
  [1, { method: "GET", path: "/hit?tick=1", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)" }],
  [1, { method: "GET", path: "/hit", bot: true }],
];
const CRONS: Array<[number, string]> = [
  [6, "7,37 * * * *"],
  [1, "17 8 * * 1"],
  [1, "41 5 * * *"],
  [1, "53 5 * * *"],
  [1, "23 */6 * * *"],
];
const weighted = <T>(r: ReturnType<typeof rng>, xs: Array<[number, T]>): T => {
  let roll = r.int(
    1,
    xs.reduce((sum, [w]) => sum + w, 0),
  );
  for (const [w, x] of xs) {
    roll -= w;
    if (roll <= 0) return x;
  }
  return xs[xs.length - 1][1];
};

function generate(seed: number, steps: number, paths: readonly string[]): SimEvent[] {
  // Its own stream, so the event list and the interleavings vary apart.
  const r = rng(seed ^ 0x5eed5eed);
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const roll = r.int(1, 100);
    if (roll <= 30) events.push({ t: "req", ...weighted(r, HIT_VISITS) });
    else if (roll <= 50) events.push({ t: "req", method: r.int(1, 10) === 1 ? "POST" : "GET", path: r.pick(paths) });
    else if (roll <= 55) events.push({ t: "cron", cron: weighted(r, CRONS) });
    else if (roll <= 65) events.push({ t: "advance", ms: r.pick([50, 500, 1_000, 5_000, 61_000, 300_000]) });
    else if (roll <= 72) events.push({ t: "fault", kind: r.pick(FAULT_KINDS) });
    else if (roll <= 74) events.push({ t: "restart" });
    else if (roll <= 76) events.push({ t: "settle" });
    else events.push({ t: "advance", ms: r.int(0, 40) });
  }
  return events;
}

// handleHit's header, as a spec: a visit counts when it reaches the DO
// without peeking. HEAD, ?peek, Sec-Purpose prefetch/prerender, verified bots
// and crawler UAs peek; `?n=1` alone never reaches the DO.
const CRAWLER_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|whatsapp|perplexity|bytespider/i;
function counts(e: Extract<SimEvent, { t: "req" }>): boolean {
  const url = new URL(e.path, "https://aadhar.sh");
  if (url.pathname !== "/hit") return false;
  if (e.method === "HEAD" || url.searchParams.has("peek") || /prefetch|prerender/i.test(e.purpose ?? "") || e.bot || CRAWLER_UA.test(e.ua ?? "")) return false;
  return url.searchParams.has("tick") || !url.searchParams.has("n");
}

// ── one run ──────────────────────────────────────────────────────────────────
async function runOne(seed: number, steps: number, given: SimEvent[] | null): Promise<RunResult> {
  plugin({
    name: "sim-cloudflare-workers",
    setup(build) {
      build.module("cloudflare:workers", () => ({
        loader: "object",
        exports: {
          WorkerEntrypoint: class {
            ctx: unknown;
            env: unknown;
            constructor(ctx: unknown, env: unknown) {
              this.ctx = ctx;
              this.env = env;
            }
          },
          WorkflowEntrypoint: class {},
          DurableObject: class {},
          tracing: undefined,
        },
      }));
    },
  });
  const world = createWorld(seed, root);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) console[method] = () => {};
  const { Counter } = await import("../counter/src/counter.ts");
  world.loadCounter(Counter as never);
  const { default: worker } = await import("../src/worker/index.ts");
  const { EXACT_PATHS, PREFIX_ROUTES } = await import("../src/worker/routes.ts");
  const paths = [...EXACT_PATHS, ...PREFIX_ROUTES.map((p) => p.probe), "/", "/no-such-page", "/writing/no-such-post"];
  const events = given ?? generate(seed, steps, paths);

  let intended = 0;
  const unavailable = new Map<string, number>();
  const intendedBy = new Map<number, boolean>();
  let lastCount = 0;
  let lastMirror = -1;
  let opsRun = 0;
  const finished = new Set<number>();
  // A list, not a nullable local: the closure below assigns it, and the
  // compiler narrows a `let` it never sees assigned to its initial null.
  const failures: Array<{ property: string; message: string }> = [];
  const fail = (property: string, message: string) => {
    if (failures.length === 0) failures.push({ property, message });
  };

  const ctxFor = (inv: Invocation) => ({
    waitUntil(p: Promise<unknown>) {
      inv.tails.push(
        Promise.resolve(p).catch((error: unknown) => {
          inv.tailErrors.push(`waitUntil rejected: ${String(error)}`);
        }),
      );
    },
    passThroughOnException() {},
    props: {},
  });
  const finish = async (inv: Invocation) => {
    for (let seen = -1; seen !== inv.tails.length;) {
      seen = inv.tails.length;
      await Promise.allSettled(inv.tails);
    }
    inv.done = true;
  };

  const start = (e: SimEvent) => {
    if (e.t === "req") {
      const inv = world.newInvocation(`${e.method} ${e.path}`);
      if (counts(e)) intended += 1;
      intendedBy.set(inv.id, counts(e));
      const headers: Record<string, string> = { "user-agent": e.ua ?? BROWSER_UA, accept: "text/html,*/*" };
      if (e.purpose) headers["sec-purpose"] = e.purpose;
      const request = new Request(`https://aadhar.sh${e.path}`, { method: e.method, headers, body: e.method === "POST" ? "{}" : undefined });
      Object.defineProperty(request, "cf", {
        value: {
          botManagement: { verifiedBot: e.bot === true, score: e.bot ? 1 : 99 },
          country: "US",
          colo: "EWR",
          asn: 7922,
          httpProtocol: "HTTP/2",
          tlsVersion: "TLSv1.3",
        },
      });
      void world.als.run(inv, async () => {
        try {
          const response: Response = await worker.fetch(request, world.env, ctxFor(inv));
          inv.status = response.status;
          try {
            await response.arrayBuffer();
          } catch (error) {
            inv.error = `response body errored: ${String(error)}`;
          }
        } catch (error) {
          inv.error = `fetch handler threw: ${String(error)}`;
        }
        inv.respondedAt = world.now();
        world.log(`inv${inv.id} ${inv.status ?? "threw"} ${inv.label}`);
        await finish(inv);
      });
    } else if (e.t === "cron") {
      const inv = world.newInvocation(`cron ${e.cron}`);
      intendedBy.set(inv.id, false);
      void world.als.run(inv, async () => {
        try {
          await worker.scheduled({ cron: e.cron, scheduledTime: world.now(), type: "scheduled" }, world.env, ctxFor(inv));
          inv.status = 200;
        } catch (error) {
          inv.error = `scheduled threw: ${String(error)}`;
        }
        inv.respondedAt = world.now();
        world.log(`inv${inv.id} ${inv.error ? "exception" : "ok"} ${inv.label}`);
        await finish(inv);
      });
    } else if (e.t === "fault") {
      world.armed.push(e.kind);
      world.log(`arm ${e.kind}`);
    } else if (e.t === "restart") {
      world.log(`restart ${world.restartObjects()} objects`);
    }
  };

  const check = () => {
    for (const inv of world.invocations) {
      if (inv.overCap.length > 0 && inv.cap === SUBREQUEST_CAP)
        fail("budget", `${inv.label} tried subrequest ${SUBREQUEST_CAP + 1} (${inv.overCap[0]}) with no cap fault`);
      if (!inv.done || finished.has(inv.id)) continue;
      finished.add(inv.id);
      const explained = inv.faults.length > 0;
      if (inv.status === 503) unavailable.set(inv.label, (unavailable.get(inv.label) ?? 0) + 1);
      const bad = (inv.status !== null && inv.status >= 500 && inv.status !== 503) || inv.error !== null || inv.tailErrors.length > 0;
      if (bad && !explained) fail("no-5xx", `${inv.label}: ${inv.error ?? inv.tailErrors[0] ?? `status ${inv.status}`}`);
    }
    // Per visit first, because a lost visit and a doubled one cancel in the
    // total: the first version of this check, total <= visits alone, missed
    // the retry control below in 40 s of seeds.
    for (const inv of world.invocations) {
      const moved = inv.increments.get("homepage-visits") ?? 0;
      if (moved > 1) fail("counter", `counter double-counted: ${inv.label} moved the count by ${moved}`);
      if (moved > 0 && !intendedBy.get(inv.id)) fail("counter", `${inv.label} moved the count, but a peek or ?n=1 alone never should`);
    }
    const count = world.counterValue("homepage-visits");
    if (count < lastCount) fail("counter", `count fell from ${lastCount} to ${count}`);
    if (count > intended) fail("counter", `counter double-counted: ${count} after ${intended} counting visits`);
    lastCount = count;
    const raw = world.kvValue("counter:n");
    if (raw !== null) {
      const mirror = Number(raw);
      if (mirror > count) fail("mirror", `KV mirror ${mirror} ran ahead of the count ${count}`);
      if (mirror < lastMirror) fail("mirror", `KV mirror fell from ${lastMirror} to ${mirror}`);
      lastMirror = mirror;
    }
  };

  let step = 0;
  for (; step < events.length && failures.length === 0; step++) {
    const e = events[step];
    start(e);
    if (e.t === "advance") await world.advance(e.ms);
    else if (e.t === "settle") await world.settle();
    opsRun += await world.step(world.rand.int(0, 3));
    check();
  }
  if (failures.length === 0) {
    await world.settle();
    check();
    const count = world.counterValue("homepage-visits");
    const untouched = world.invocations.filter((inv) => intendedBy.get(inv.id) && inv.faults.length === 0).length;
    const touched = world.invocations.filter((inv) => intendedBy.get(inv.id) && inv.faults.length > 0).length;
    if (count < untouched) fail("liveness", `count ${count} after drain, but ${untouched} counting visits saw no fault (${touched} more did)`);
  }

  if (process.env.SIM_TRACE) await Bun.write(process.env.SIM_TRACE, world.trace.join("\n") + "\n");
  const failure = failures.at(0);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const line of world.trace) hasher.update(line + "\n");
  const worst = world.invocations.reduce(
    (a, b) => (b.subrequests > a.subrequests ? b : a),
    world.invocations[0] ?? ({ subrequests: 0, label: "-" } as Invocation),
  );
  return {
    ok: !failure,
    seed,
    steps: step,
    property: failure?.property,
    message: failure?.message,
    events: events.slice(0, step),
    traceHash: hasher.digest("hex").slice(0, 16),
    traceTail: failure ? world.trace.slice(-25) : undefined,
    findings: [...new Set(world.findings)],
    stats: {
      requests: world.invocations.filter((i) => !i.label.startsWith("cron")).length,
      crons: world.invocations.filter((i) => i.label.startsWith("cron")).length,
      faults: events.filter((e) => e.t === "fault" || e.t === "restart").length,
      ops: opsRun,
      count: world.counterValue("homepage-visits"),
      intended,
      maxSubrequests: worst.subrequests,
      maxSubrequestsAt: worst.label,
      unavailable: Object.fromEntries(unavailable),
    },
  };
}

// ── the driver ───────────────────────────────────────────────────────────────
const scratch = join(tmpdir(), "aadhar-sim");

async function child(seed: number, steps: number, events: SimEvent[] | null): Promise<RunResult> {
  const args = ["bun", fileURLToPath(import.meta.url), "--child", "--seed", String(seed), "--steps", String(steps)];
  if (events) {
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, `events-${seed}-${process.pid}-${Bun.hash(JSON.stringify(events)).toString(16)}.json`);
    writeFileSync(file, JSON.stringify(events));
    args.push("--events", file);
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: root });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = out.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as RunResult;
  } catch {
    throw new Error(`sim child for seed ${seed} printed no result (exit ${proc.exitCode}):\n${err.slice(-2000)}`);
  }
}

// Delta debugging (Zeller's ddmin) over the event list: keep any subset that
// still fails the same property, at most `limit` runs.
async function shrink(seed: number, failing: RunResult, limit = 400): Promise<RunResult> {
  let best = failing;
  let events = failing.events;
  let n = 2;
  let runs = 0;
  while (events.length >= 2 && runs < limit) {
    const size = Math.ceil(events.length / n);
    let reduced = false;
    for (let i = 0; i < n && runs < limit; i++) {
      const complement = [...events.slice(0, i * size), ...events.slice((i + 1) * size)];
      if (complement.length === 0) continue;
      runs += 1;
      const r = await child(seed, complement.length, complement);
      if (!r.ok && r.property === failing.property) {
        best = r;
        events = r.events;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= events.length) break;
      n = Math.min(events.length, n * 2);
    }
  }
  return best;
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string" },
      steps: { type: "string", default: "400" },
      events: { type: "string" },
      budget: { type: "string" },
      jobs: { type: "string" },
      child: { type: "boolean" },
      "stop-on-fail": { type: "boolean" },
      seeds: { type: "string" },
    },
  });
  const steps = Number(values.steps);
  const given: SimEvent[] | null = values.events ? JSON.parse(readFileSync(values.events, "utf8")) : null;

  if (values.child) {
    const result = await runOne(Number(values.seed), steps, given);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  }

  if (values.budget === undefined && values.seed !== undefined) {
    const [a, b] = await Promise.all([child(Number(values.seed), steps, given), child(Number(values.seed), steps, given)]);
    const { events: _events, ...shown } = a;
    console.log(JSON.stringify({ ...shown, events: a.events.length }, null, 2));
    if (a.traceHash !== b.traceHash) {
      console.log(`nondeterminism: seed ${a.seed} gave trace ${a.traceHash} then ${b.traceHash}`);
      process.exit(1);
    }
    process.exit(a.ok ? 0 : 1);
  }

  const budgetMs = Number(values.budget ?? 60) * 1000;
  const base = values.seed !== undefined ? Number(values.seed) : crypto.getRandomValues(new Uint32Array(1))[0];
  const jobs = Number(values.jobs ?? Math.max(1, availableParallelism() - 2));
  const started = Date.now();
  let nextSeed = base;
  // --seeds N runs exactly base .. base + N - 1 (inside the budget), so a
  // control sees the same seeds on every machine.
  const lastSeed = values.seeds !== undefined ? base + Number(values.seeds) - 1 : null;
  let seeds = 0;
  let totalSteps = 0;
  const failures = new Map<string, RunResult>();
  const findings = new Map<string, number>();
  const nondeterminism: string[] = [];
  let maxSub = { n: 0, at: "-" };

  const worker = async () => {
    while (Date.now() - started < budgetMs && !(values["stop-on-fail"] && failures.size > 0)) {
      if (lastSeed !== null && nextSeed > lastSeed) break;
      const seed = nextSeed++ >>> 0;
      const r = await child(seed, steps, null);
      seeds += 1;
      totalSteps += r.steps;
      if (r.stats.maxSubrequests > maxSub.n) maxSub = { n: r.stats.maxSubrequests, at: r.stats.maxSubrequestsAt };
      for (const f of r.findings) findings.set(f, (findings.get(f) ?? 0) + 1);
      // Replay every failure and one passing seed in 8; a different hash is
      // a hole in the world, and nothing else it reports can be trusted.
      if (!r.ok || seed % 8 === 0) {
        const again = await child(seed, steps, null);
        if (again.traceHash !== r.traceHash) nondeterminism.push(`seed ${seed} gave trace ${r.traceHash} then ${again.traceHash}`);
      }
      if (!r.ok) {
        const key = r.property ?? "?";
        const prev = failures.get(key);
        if (!prev || r.steps < prev.steps) failures.set(key, r);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `sim: ${seeds} seeds from ${base}, ${totalSteps} steps, ${elapsed.toFixed(1)} s, ${jobs} jobs; most subrequests in one invocation: ${maxSub.n} (${maxSub.at})`,
  );
  for (const [f, n] of findings) console.log(`finding (${n} seeds): ${f}`);
  for (const line of nondeterminism) console.log(`nondeterminism: ${line}`);
  for (const [property, r] of failures) {
    const small = await shrink(r.seed, r);
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, `shrunk-${property}-${r.seed}.json`);
    writeFileSync(file, JSON.stringify(small.events, null, 1));
    console.log(`\nFAIL ${property}: ${small.message}`);
    console.log(`  seed ${r.seed}, ${r.steps} steps, shrunk to ${small.events.length} events:`);
    for (const e of small.events) console.log(`    ${JSON.stringify(e)}`);
    console.log(`  trace tail:`);
    for (const line of small.traceTail ?? []) console.log(`    ${line}`);
    console.log(`  replay: bun run sim -- --seed ${r.seed} --events ${file}`);
  }
  process.exit(failures.size > 0 || nondeterminism.length > 0 ? 1 : 0);
}

await main();
