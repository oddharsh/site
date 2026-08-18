// pool.ts — run spawn-heavy per-photo work N at a time, pulling from one queue.
//
// The photo scripts are a chain of subprocesses per photo (phase 1 alone is 6
// sips, 1 zenc and 3 avifenc), and every one of them ran one photo at a time on
// a 14-core machine at about 85% of a single core. Measured on 24 real photos
// through that chain:
//
//   serial   836 ms/photo        8   159 ms/photo
//   4        228 ms/photo       10   163 ms/photo
//   6        184 ms/photo       12   150 ms/photo
//
// The knee is 8, and past it the numbers sit inside run-to-run noise because
// avifenc already takes `--jobs 4`, so the box is oversubscribed either way.
//
// THE ENCODER FLAGS ARE NOT TOUCHED BY ANY OF THIS, deliberately. Threading
// changes inside an encoder are exactly the kind of thing that can move output
// bytes, and /i/ is content-addressed, so a moved byte re-mints a URL. Only the
// OUTER loop changed. Controlled before the change landed: 8 photos through the
// full chain serially and through this pool, all 32 encoded outputs (600 JPG,
// 600/400/200 AVIF) byte-identical.
//
// A QUEUE RATHER THAN BATCHES. The helper this replaces was
//   for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
// which puts a barrier at every batch: nobody starts item n+1 until the slowest
// of the first n finishes. Photos are not uniform (a 40MB HIF costs several
// times a JPG), so a batch runs at the speed of its worst member. Workers
// pulling from one queue have no barrier and no such coupling.
import { availableParallelism } from "node:os";

// Two cores left for the machine, capped at the measured knee. PHOTO_JOBS
// overrides it for a box with a different shape.
export const PHOTO_JOBS = Math.max(1, Number(process.env.PHOTO_JOBS) || Math.max(2, Math.min(8, availableParallelism() - 2)));

// Network rather than CPU: R2 uploads keep their own smaller number, because
// what bounds them is the far end.
export const UPLOAD_JOBS = Math.max(1, Number(process.env.UPLOAD_JOBS) || 4);

/**
 * Runs `fn` over `items` with at most `n` in flight. Rejects on the first job
 * that throws, so callers that want per-item degradation keep their own
 * try/catch inside `fn` — which is what every photo script already does, since
 * one unreadable file should cost one photo rather than the run.
 */
export async function pool<T>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await fn(next.item, next.index);
    }
  });
  await Promise.all(workers);
}
