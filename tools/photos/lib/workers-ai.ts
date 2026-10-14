// tools/photos/lib/workers-ai.ts — the one Workers AI vision call the photo
// scripts share, so gen-alt-text.ts and gen-photo-semantics.ts cannot drift on
// how they authenticate, which gateway they report into, or how a refusal reads.
import fs from "node:fs";

export const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
export const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
export const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "1c99acdb6141579023fb97d24261ea58";
export const AI_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`;
export const GATEWAY = (process.env.CLOUDFLARE_AI_GATEWAY ?? "default").trim();

export class WorkersAiHttpError extends Error {
  status: number;
  constructor(status: number, statusText: string, body: string) {
    super(`HTTP ${status} ${statusText}${body ? ` ${body}` : ""}`);
    this.status = status;
  }
}

export function visionBody(imageFile: string, prompt: string, maxTokens: number): string {
  return JSON.stringify({ image: Array.from(fs.readFileSync(imageFile)), prompt, max_tokens: maxTokens });
}

export async function runVision(body: string, { timeoutMs = 90_000 } = {}): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  if (GATEWAY) headers["cf-aig-gateway-id"] = GATEWAY;
  const response = await fetch(AI_RUN, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new WorkersAiHttpError(response.status, response.statusText, (await response.text()).slice(0, 160));
  const payload = await response.json();
  return payload?.result?.description || payload?.result?.response || "";
}
