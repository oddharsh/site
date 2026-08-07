type SigningSecrets = { RN_SIGNING_KEY_JWK?: string };

export const botName = "AadharshBot";
export const botUserAgent = "AadharshBot/2.0 (+https://aadhar.sh/bot)";
const signatureAgent = "https://aadhar.sh/";

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function botHeaders(target: URL, env: Env, initial?: HeadersInit): Promise<{ headers: Headers; signed: boolean }> {
  const headers = new Headers(initial);
  headers.set("user-agent", botUserAgent);
  if (!headers.has("accept")) headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5");
  headers.set("accept-language", "en-US,en;q=0.8");
  const raw = (env as Env & SigningSecrets).RN_SIGNING_KEY_JWK;
  if (!raw) return { headers, signed: false };

  const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string };
  const created = Math.floor(Date.now() / 1000);
  const parameters = `("@authority" "signature-agent");created=${created};keyid="${jwk.kid || "rn"}";alg="ed25519";tag="web-bot-auth"`;
  const base = new TextEncoder().encode([
    `"@authority": ${target.host}`,
    `"signature-agent": "${signatureAgent}"`,
    `"@signature-params": ${parameters}`,
  ].join("\n"));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, base);
  headers.set("signature-agent", `"${signatureAgent}"`);
  headers.set("signature-input", `sig1=${parameters}`);
  headers.set("signature", `sig1=:${bytesToBase64(signature)}:`);
  return { headers, signed: true };
}
