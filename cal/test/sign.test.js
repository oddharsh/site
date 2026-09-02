// HMAC-SHA256 signing of the approve/decline links (src/sign.js). These links
// are the worker's only auth surface: clicking the host's "approve" email must
// be unforgeable, and rotating SIGNING_SECRET must invalidate outstanding links.
import { describe, it, expect } from "bun:test";
import { sign, verify } from "../src/sign.js";

const SECRET = "test-signing-secret-deadbeefcafe";

describe("sign/verify — approve/decline link auth", () => {
  it("round-trips a signature", async () => {
    const msg = "approve:abc123";
    const sig = await sign(msg, SECRET);
    expect(await verify(msg, sig, SECRET)).toBe(true);
  });

  it("emits url-safe base64 with no padding (rides in a link query)", async () => {
    const sig = await sign("a".repeat(120), SECRET);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sig).not.toMatch(/[+/=]/);
  });

  it("rejects a tampered message — can't flip approve↔decline or swap the id", async () => {
    const sig = await sign("approve:abc123", SECRET);
    expect(await verify("decline:abc123", sig, SECRET)).toBe(false); // action swapped
    expect(await verify("approve:abc124", sig, SECRET)).toBe(false); // id swapped
  });

  it("rejects a signature made with a different secret (rotation invalidates links)", async () => {
    const sig = await sign("approve:abc123", SECRET);
    expect(await verify("approve:abc123", sig, "a-rotated-secret")).toBe(false);
  });

  it("returns false (never throws) on a malformed/empty signature", async () => {
    expect(await verify("approve:abc123", "!!!not base64!!!", SECRET)).toBe(false);
    expect(await verify("approve:abc123", "", SECRET)).toBe(false);
  });

  it("is deterministic — same message+secret yields the same signature", async () => {
    expect(await sign("approve:x", SECRET)).toBe(await sign("approve:x", SECRET));
  });
});
