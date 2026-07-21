// Integration tests for the worker's request flow (src/index.js). Rather than
// SELF (a separate isolate this pool version can't easily inject fetch mocks
// into), we import the worker and call worker.fetch() directly — same isolate,
// so the globalThis.fetch stub intercepts its outbound calls. The calendar feed
// and Resend are both stubbed below. The KV binding + working-hours vars come
// from wrangler.toml via cloudflare:test's `env`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env as baseEnv, createExecutionContext, waitOnExecutionContext, introspectWorkflow } from "cloudflare:test";
import worker from "../src/index.js";
import { sign } from "../src/sign.js";
import { getBooking, listHeld } from "../src/booking.js";

const SECRET = "integration-signing-secret";
const env = {
  ...baseEnv,
  SIGNING_SECRET: SECRET,
  RESEND_API_KEY: "test-key",
  ICAL_URL: "https://calendar.test/availability.ics",
};

const EMPTY_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "END:VCALENDAR",
  "",
].join("\r\n");

let mailCalls;
let bookingWf;
beforeEach(async () => {
  // start every test with an empty booking pool. storage isn't reliably
  // per-test in this pool version, and stale pending bookings from a prior
  // test would hold slots / trip generateSlots' daily+weekly limits, so an
  // assertion like "the slot frees up again" would see a slot suppressed for
  // an unrelated reason. clearing makes each test's preconditions explicit.
  const { keys } = await env.BOOKINGS.list();
  await Promise.all(keys.map((k) => env.BOOKINGS.delete(k.name)));

  // route_book spins up a real expiry-timer instance per booking. Left alone,
  // each would block on a 7-day waitForEvent that the pool rejects at teardown
  // (uncaught) and leaks state between tests. These integration tests exercise
  // the REQUEST flow, not the timer, so we deliver the benign "host decided"
  // event to every instance: the workflow completes immediately as a no-op
  // (it only touches KV on the timeout path), matching what cancelExpiry does
  // in production. The timer's own logic is covered in workflow.test.js.
  bookingWf = await introspectWorkflow(env.BOOKING_WORKFLOW);
  await bookingWf.modifyAll(async (m) => {
    await m.mockEvent({ type: "host-decision", payload: { resolved: true } });
  });

  mailCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === env.ICAL_URL) {
      return new Response(EMPTY_ICS, {
        status: 200,
        headers: { "content-type": "text/calendar" },
      });
    }
    mailCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "m" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await bookingWf.dispose();   // tear down any booking expiry timers this test created
});

// dispatch a request through the worker and flush ctx.waitUntil (the emails)
async function dispatch(path, init = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://cal.aadhar.sh" + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function postBook(fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return dispatch("/book", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}
// pick a slot from the MIDDLE of the list, not slots[0]: the earliest slot sits
// on the now+MIN_NOTICE boundary and can roll off as the wall clock advances
// during a test, making assertions about it flaky. a mid-list slot is days out
// and stable across the test's runtime.
const firstSlot = async () => {
  const { slots } = await (await dispatch("/slots")).json();
  return slots[Math.floor(slots.length / 2)];
};
const statusOf = async (id) => (await getBooking(env, id))?.status;
// the host's approval email carries the only handle to the booking id (t=<id>):
// there's no pending-index to scan anymore, so tests read the id the same way
// the host does — off the signed link in the mail we just captured.
const lastBookingId = () => {
  const link = mailCalls.at(-1).body.html.match(/href="([^"]*\/approve[^"]*)"/)[1];
  return new URL(link).searchParams.get("t");
};

describe("routing", () => {
  it("GET / renders the booking page with browser revalidation", async () => {
    const res = await dispatch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30");
    expect((await res.text()).length).toBeGreaterThan(100);
  });

  it("GET /slots returns a non-empty slots array", async () => {
    const res = await dispatch("/slots");
    expect(res.status).toBe(200);
    const { slots } = await res.json();
    expect(Array.isArray(slots)).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("serves identically under the /coffee prefix (BASE_PATH detection)", async () => {
    expect((await dispatch("/coffee")).status).toBe(200);
    const res = await dispatch("/coffee/slots");
    expect(res.status).toBe(200);
    expect((await res.json()).slots.length).toBeGreaterThan(0);
  });

  it("unknown path → 404", async () => {
    expect((await dispatch("/nope")).status).toBe(404);
  });
});

describe("POST /book validation", () => {
  it("rejects missing fields with 400", async () => {
    expect((await postBook({ name: "", email: "a@b.co", topic: "hi", start: 123 })).status).toBe(400);
    expect((await postBook({ name: "A", email: "a@b.co", topic: "", start: 123 })).status).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    expect((await postBook({ name: "A", email: "nope", topic: "hi", start: 123 })).status).toBe(400);
  });

  it("rejects a slot that isn't currently open with 409", async () => {
    expect((await postBook({ name: "A", email: "a@b.co", topic: "hi", start: 999 })).status).toBe(409);
  });

  it("honeypot: a filled 'website' field is accepted but creates no booking and sends no mail", async () => {
    const slot = await firstSlot();
    const res = await postBook({ name: "Bot", email: "b@b.co", topic: "spam", start: slot.start, website: "http://x" });
    expect(res.status).toBe(200);
    expect(await listHeld(env)).toHaveLength(0);   // no slot held
    expect(mailCalls).toHaveLength(0);
  });
});

describe("book → approve / decline lifecycle", () => {
  it("books, emails the host signed links, and holds the slot", async () => {
    const slot = await firstSlot();
    const res = await postBook({ name: "Dana", email: "dana@x.dev", topic: "workers chat", start: slot.start });
    expect(res.status).toBe(200);

    // approval email to the host, carrying the signed approve link
    expect(mailCalls).toHaveLength(1);
    expect(mailCalls[0].body.to).toEqual([env.HOST_EMAIL]);
    const id = lastBookingId();

    // the booking record is pending and its slot is held
    expect(await getBooking(env, id)).toMatchObject({ name: "Dana", status: "pending", start: slot.start });
    expect(await listHeld(env)).toContainEqual({ start: slot.start, end: slot.end });

    // the slot is no longer offered while the booking is pending
    const after = (await (await dispatch("/slots")).json()).slots;
    expect(after.find((s) => s.start === slot.start)).toBeUndefined();
  });

  it("approving via the emailed link confirms it and sends the .ics invite", async () => {
    const slot = await firstSlot();
    await postBook({ name: "Dana", email: "dana@x.dev", topic: "hi", start: slot.start });
    const id = lastBookingId();
    mailCalls.length = 0;

    const sig = await sign(`${id}|approve`, SECRET);
    const res = await dispatch(`/approve?t=${id}&sig=${sig}`);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("confirmed");
    expect(mailCalls).toHaveLength(1);
    expect(mailCalls[0].body.attachments[0].filename).toBe("coffee.ics");
  });

  it("declining frees the slot again and sends a decline note (no invite)", async () => {
    const slot = await firstSlot();
    await postBook({ name: "Eve", email: "eve@x.dev", topic: "hi", start: slot.start });
    const id = lastBookingId();
    mailCalls.length = 0;

    const sig = await sign(`${id}|decline`, SECRET);
    const res = await dispatch(`/decline?t=${id}&sig=${sig}`);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("declined");
    expect(mailCalls).toHaveLength(1);
    expect(mailCalls[0].body.attachments).toBeUndefined();

    const after = (await (await dispatch("/slots")).json()).slots;
    expect(after.find((s) => s.start === slot.start)).toBeDefined();
  });

  it("rejects an approve link with a bad signature (401)", async () => {
    expect((await dispatch("/approve?t=anything&sig=forged")).status).toBe(401);
  });

  it("a validly-signed link for an unknown id → 404", async () => {
    const sig = await sign("ghost|approve", SECRET);
    expect((await dispatch(`/approve?t=ghost&sig=${sig}`)).status).toBe(404);
  });

  it("re-approving an already-confirmed booking is idempotent — no duplicate invite", async () => {
    const slot = await firstSlot();
    await postBook({ name: "Sam", email: "sam@x.dev", topic: "hi", start: slot.start });
    const id = lastBookingId();
    const sig = await sign(`${id}|approve`, SECRET);
    await dispatch(`/approve?t=${id}&sig=${sig}`);   // first approve → invite
    mailCalls.length = 0;
    const res = await dispatch(`/approve?t=${id}&sig=${sig}`); // second
    expect(res.status).toBe(200);
    expect(mailCalls).toHaveLength(0);
  });
});
