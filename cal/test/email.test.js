// email.js — Resend payloads + .ics invite generation. These functions call
// the global fetch (Resend's REST API), so we stub globalThis.fetch and inspect
// what would have been sent. Run in-isolate (direct import), so the stub
// applies — no SELF, no network.
//
// Also pins the two unicode-safety fixes:
//   - the .ics attachment is UTF-8→base64 (plain btoa throws on emoji/accents)
//   - DESCRIPTION newlines are single ICS escapes, not double-escaped literals
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendApprovalRequest, sendInvite, sendDecline } from "../src/email.js";

const env = {
  HOST_TIMEZONE: "America/New_York",
  HOST_NAME: "aadharsh",
  HOST_EMAIL: "coffee@aadhar.sh",
  EVENT_TITLE: "coffee with aadharsh",
  RESEND_API_KEY: "test-resend-key",
};

const booking = {
  id: "abc123def456",
  name: "Jordan Lee",
  email: "jordan@example.com",
  topic: "chat about workers",
  start: Date.UTC(2026, 4, 14, 19, 0, 0),  // 2026-05-14 19:00Z
  end:   Date.UTC(2026, 4, 14, 19, 30, 0),
};

// decode a UTF-8 base64 string (the .ics attachment) back to text
const b64ToUtf8 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

let calls;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "resend-msg-id" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("sendApprovalRequest → Resend", () => {
  it("POSTs to Resend with auth, host recipient, and reply-to the requester", async () => {
    const res = await sendApprovalRequest(env, booking, "https://c/approve?t=1&sig=A", "https://c/decline?t=1&sig=B");
    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-resend-key");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(body.to).toEqual(["coffee@aadhar.sh"]);
    expect(body.reply_to).toBe("jordan@example.com");      // hit Reply → goes to requester
    expect(body.html).toContain("https://c/approve?t=1&sig=A");
    expect(body.html).toContain("https://c/decline?t=1&sig=B");
    expect(body.html).toContain("chat about workers");
    expect(res).toEqual({ id: "resend-msg-id" });
  });

  it("escapes attacker-controlled name/topic (no HTML injection into the host's inbox)", async () => {
    await sendApprovalRequest(env, { ...booking, name: "<script>x</script>", topic: "a & b < c" }, "u1", "u2");
    const { body } = calls[0];
    expect(body.html).not.toContain("<script>x</script>");
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).toContain("a &amp; b &lt; c");
  });
});

describe("sendInvite → .ics attachment", () => {
  it("attaches a valid REQUEST VCALENDAR/VEVENT", async () => {
    await sendInvite(env, booking);
    const att = calls[0].body.attachments;
    expect(att).toHaveLength(1);
    expect(att[0].filename).toBe("coffee.ics");
    expect(att[0].content_type).toContain("text/calendar");

    const ics = b64ToUtf8(att[0].content);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("UID:abc123def456@cal.aadhar.sh");
    expect(ics).toContain("DTSTART:20260514T190000Z");
    expect(ics).toContain("DTEND:20260514T193000Z");
    expect(ics).toContain("SUMMARY:coffee with aadharsh");
    expect(ics).toContain("ORGANIZER;CN=aadharsh:mailto:coffee@aadhar.sh");
    expect(ics).toContain("ATTENDEE;CN=Jordan Lee;RSVP=TRUE:mailto:jordan@example.com");
    expect(ics).toContain("\r\n");                          // CRLF line endings
    expect(ics.trim().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("survives an emoji / non-Latin booking (the btoa→UTF-8 fix) and round-trips", async () => {
    const uni = { ...booking, name: "José Núñez", topic: "grab coffee ☕ and talk café plans" };
    await expect(sendInvite(env, uni)).resolves.toBeDefined();
    const ics = b64ToUtf8(calls[0].body.attachments[0].content);
    expect(ics).toContain("café");
    expect(ics).toContain("☕");
    expect(ics).toContain("ATTENDEE;CN=José Núñez");
  });

  it("escapes ICS specials and emits single (not double) newline escapes in DESCRIPTION", async () => {
    await sendInvite(env, { ...booking, topic: "x, y; z" });
    const ics = b64ToUtf8(calls[0].body.attachments[0].content);
    // comma + semicolon escaped inside the value …
    expect(ics).toContain("requested: x\\, y\\; z");
    // … and the structural blank line is a single \n escape, not a literal \\n
    expect(ics).toContain("z\\n\\nbooked via cal.aadhar.sh");
    expect(ics).not.toContain("\\\\n\\\\nbooked");
  });
});

describe("sendDecline + error handling", () => {
  it("sends a decline note to the requester only (no .ics)", async () => {
    await sendDecline(env, booking);
    const { body } = calls[0];
    expect(body.to).toEqual(["jordan@example.com"]);
    expect(body.attachments).toBeUndefined();
    expect(body.subject).toContain("coffee with aadharsh");
  });

  it("throws when Resend returns a non-2xx (so callers/log see the failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("rate limited", { status: 429 })));
    await expect(sendDecline(env, booking)).rejects.toThrow(/resend 429/);
  });
});
