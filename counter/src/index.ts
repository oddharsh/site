// aadhar-counter — the Worker that will own the Counter Durable Object.
//
// The class moves here from aadhar-sh so the site Worker stops exporting a
// Durable Object, which is the one thing that denies it preview URLs:
// Cloudflare mints no version URL for a Worker that implements a DO, and every
// aadhar-sh version reads `has_preview: false` for that reason alone (measured
// 2026-09-28, CLAUDE.md "Preview URLs are configured ON and have NEVER SERVED").
//
// The class is RE-EXPORTED from the site tree rather than copied, so the code
// that runs the odometer and the coffee slot claims during the transfer is the
// code production runs today, byte for byte. It moves into this directory in
// the last step, once the site no longer exports it.
//
// This Worker has no route. It is reached only through aadhar-sh's COUNTER
// binding (`script_name: "aadhar-counter"`), so its own fetch handler answers
// 404 to anything that finds it some other way.
export { Counter } from "../../src/worker/counter.ts";

export default {
  fetch(): Response {
    return new Response("aadhar-counter has no routes; it hosts a Durable Object.\n", { status: 404 });
  },
};
