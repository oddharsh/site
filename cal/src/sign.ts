// HMAC-SHA256 for signed approve/decline links.
// using WebCrypto in the Worker runtime — no deps.

export async function sign(message, secret) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig).toBase64({ alphabet: "base64url", omitPadding: true });
}

export async function verify(message, signature, secret) {
  try {
    const key = await importKey(secret);
    // base64url alone: a "+" or "/" is a spelling sign() never emits, so it throws
    // here and the link fails closed instead of decoding to the same bytes
    const sig = Uint8Array.fromBase64(signature, { alphabet: "base64url" });
    return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]
  );
}
