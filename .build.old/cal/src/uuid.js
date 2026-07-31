// short, URL-safe random IDs. ~22 chars of base64url from crypto.randomUUID.
// good enough for booking IDs at personal volume — collisions effectively
// impossible. shorter than a full UUID for prettier email links.
export async function v4() {
  const u = crypto.randomUUID();
  return u.replace(/-/g, "");  // 32 hex chars; cf workers don't have shorter primitive
}
