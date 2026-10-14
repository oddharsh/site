// redact.ts — no message this repo's tools print may carry a credential.
import { asText } from "../../src/worker/lib/parse.ts";

export const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|_KEY$/;

const FLOOR = 12;

export function credentialValues(env = process.env) {
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(name)) continue;
    const value = asText(raw);
    if (value !== null && value.length >= FLOOR) seen.add(value);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

export function redactCredentials(message: string, env = process.env) {
  let out = message;
  for (const value of credentialValues(env)) out = out.replaceAll(value, "[redacted]");
  return out;
}
