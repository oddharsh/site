// One Clef call through the Workers AI binding, shared by every decision this
// site asks Clef for (serendipity/event-tags.ts, lens-walls.ts).
//
// Clef speaks TypeSafe's System One API: a state, typed questions, typed answers
// with calibrated probabilities. What lives here is the transport the callers
// would otherwise each hand-roll: the gateway argument, a deadline, and an error
// classification. The request and the parsing stay with each caller, since the
// questions are the part that differs.
//
// Never throws. A caller counts outcomes by cause, because "the gateway is
// missing", "Free's daily allocation ran out" and "Clef was slow" need different
// fixes and must not blur into one "failed". Node-safe (gotcha 16).

/** The slice of the Workers AI binding a Clef call uses. Narrower than `Ai`,
 *  whose `run` is typed by a model catalog that may not name Clef yet, and it is
 *  what a test hands in. */
export type AiRunner = { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> };
export type ClefEnv = { AI?: AiRunner | null, AI_GATEWAY?: string };
export type ClefModel = "clef" | "clef-flash";

/** The binding's third argument: through the named gateway, uncached, or no
 *  gateway at all when AI_GATEWAY is empty. A wrong or deleted gateway FAILS the
 *  call rather than falling back (gotcha 23). No gateway cache: each caller
 *  stores its own answer, and a cache hit would make the gateway's log disagree
 *  with what the call actually asked. */
export function clefRunOptions(env: { AI_GATEWAY?: string } | null | undefined) {
  const id = env?.AI_GATEWAY?.trim();
  return id ? { gateway: { id, skipCache: true } } : {};
}

/** The binding THROWS where a fetch returned a status, so the cause is read off
 *  the error: Workers AI messages carry a four-digit code. Measured on the day
 *  Clef launched: 3040 is "Capacity temporarily exceeded", which 29 concurrent
 *  calls met at once. Which other code means which is deliberately not
 *  hardcoded; the count keyed by code is what to read when a pass stalls. */
export function classifyAiError(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  const message = err instanceof Error ? err.message : String(err);
  const code = /\b(\d{4})\b/.exec(message)?.[1];
  return code ? `ai ${code}` : "ai error";
}

/** One call, raced against `timeoutMs`. The body is returned unparsed, since
 *  each caller validates the answers against its own options. */
export async function runClef(env: ClefEnv, model: ClefModel, request: unknown, timeoutMs: number):
  Promise<{ body: unknown } | { error: string }> {
  if (!env.AI) return { error: "no AI binding" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Clef did not answer in time"), { name: "TimeoutError" })), timeoutMs);
  });
  try {
    return { body: await Promise.race([env.AI.run(`@cf/cloudflare/${model}`, request, clefRunOptions(env)), timeout]) };
  } catch (err) {
    return { error: classifyAiError(err) };
  } finally {
    clearTimeout(timer);
  }
}
