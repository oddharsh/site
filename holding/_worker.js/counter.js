// counter.js — the homepage visit counter, now an in-house Durable Object.
//
// Migrated off cf-garage's cross-script Counter (Pages couldn't host DOs; Workers
// can). Same wire protocol home.js already speaks: GET https://do/ increments and
// returns {n}; ?peek=1 reads without bumping (bots/prerender). Storage is the
// per-DO SQLite-backed KV (state.storage), one instance named "homepage-visits".
//
// Continuity: an in-house DO is a fresh namespace, so it would start at 0. On the
// first wake it self-seeds once from env.COUNTER_SEED (the count carried over from
// the old cf-garage DO) so the number doesn't reset. Idempotent + guarded in memory
// so it costs at most one storage read per DO lifetime, never per request.
export class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._checked = false;   // in-memory: seed-check runs once per DO instance, not per request
  }

  async fetch(request) {
    if (!this._checked) {
      this._checked = true;
      const seeded = await this.state.storage.get("seeded");
      if (!seeded && this.env && this.env.COUNTER_SEED != null) {
        await this.state.storage.put("n", parseInt(this.env.COUNTER_SEED, 10) || 0);
        await this.state.storage.put("seeded", true);
      }
    }

    const url = new URL(request.url);
    let n = (await this.state.storage.get("n")) || 0;

    // read-only: bots + speculative prerenders see the value without bumping it
    if (url.searchParams.has("peek")) return Response.json({ n });

    // default: atomic increment (classic-90s-counter behavior, no session dedup)
    n += 1;
    await this.state.storage.put("n", n);
    return Response.json({ n });
  }
}
