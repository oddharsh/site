// aadhar-counter — the Worker that owns the Counter Durable Object.
//
// The class moved here from aadhar-sh on 2026-09-29 so the site Worker would
// stop implementing a Durable Object, the one thing that denied it preview
// URLs: Cloudflare mints no version URL for a Worker that implements a DO
// (CLAUDE.md, "Preview URLs SERVE since 2026-09-29").
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
