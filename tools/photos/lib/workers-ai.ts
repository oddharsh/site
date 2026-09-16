// tools/photos/lib/workers-ai.ts — the one Workers AI vision call the photo
// scripts share, so gen-alt-text.ts and gen-photo-semantics.ts cannot drift on
// how they authenticate, which gateway they report into, or how a refusal reads.
//
// Both scripts ask the same model (@cf/llava-hf/llava-1.5-7b-hf) about the same
// bytes (the committed public/i/<stem>.<hash8>.jpg, which is exactly what
// production serves), under different prompts. Until 2026-09-15 they were two
// copies of this call in two languages, one of them Python, and the prompt
// comment in each said "keep in sync" with the other. A shared function is the
// version of that instruction that cannot be forgotten.
import fs from "node:fs";

export const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
export const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
export const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "1c99acdb6141579023fb97d24261ea58";
export const AI_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`;
// Route through AI Gateway so each script's spend lands in the same per-model
// log as the worker's, rather than as an unattributed dent in the daily neuron
// budget. Empty string disables it, matching cf-garage's AI_GATEWAY var; a
// gateway id that does not exist is a hard 2001 error, never a silent passthrough.
export const GATEWAY = (process.env.CLOUDFLARE_AI_GATEWAY ?? "default").trim();

export class WorkersAiHttpError extends Error {
  status: number;
  constructor(status: number, statusText: string, body: string) {
    super(`HTTP ${status} ${statusText}${body ? ` ${body}` : ""}`);
    this.status = status;
  }
}

/** The request body for one vision call. Exposed so a --dry-run can report the
 *  byte count without touching the endpoint: that URL embeds the account id
 *  from the environment, and dry-run output is what gets pasted into issues. */
export function visionBody(imageFile: string, prompt: string, maxTokens: number): string {
  return JSON.stringify({ image: Array.from(fs.readFileSync(imageFile)), prompt, max_tokens: maxTokens });
}

/** POST one image and prompt to Workers AI and return the model's raw text.
 *  Observability only, deliberately no cf-aig-cache-ttl: both callers are
 *  resumable and re-running a stem is how a bad answer gets replaced, which a
 *  cache keyed on the identical request would make impossible. */
export async function runVision(body: string, { timeoutMs = 90_000 } = {}): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  // Omitted rather than sent empty: an empty `cf-aig-gateway-id` is not the same
  // request as one that names no gateway.
  if (GATEWAY) headers["cf-aig-gateway-id"] = GATEWAY;
  const response = await fetch(AI_RUN, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new WorkersAiHttpError(response.status, response.statusText, (await response.text()).slice(0, 160));
  const payload = await response.json();
  return payload?.result?.description || payload?.result?.response || "";
}
