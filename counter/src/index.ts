// aadhar-counter — the Worker that owns the Counter Durable Object.
//
// The class moves here from aadhar-sh so the site Worker stops exporting a
// Durable Object, which is the one thing that denies it preview URLs:
// Cloudflare mints no version URL for a Worker that implements a DO, and every
// aadhar-sh version reads `has_preview: false` for that reason alone (measured
// 2026-09-28, CLAUDE.md "Preview URLs are configured ON and have NEVER SERVED").
//
// The class was re-exported from the site tree during the transfer, so the code
// running the odometer and the coffee slot claims never changed while it moved.
// It lives in this directory since step 5 (./counter.ts).
//
// This Worker has no route. It is reached only through aadhar-sh's COUNTER
// binding (`script_name: "aadhar-counter"`), so its own fetch handler answers
// 404 to anything that finds it some other way.
export { Counter } from "./counter.ts";

export default {
  fetch(): Response {
    return new Response("aadhar-counter has no routes; it hosts a Durable Object.\n", { status: 404 });
  },
};
