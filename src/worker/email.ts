type EmailSecrets = { RESEND_API_KEY?: string };

export async function sendEmail(env: Env, payload: Record<string, unknown>): Promise<void> {
  const token = (env as Env & EmailSecrets).RESEND_API_KEY;
  if (!token) throw new Error("email transport is not configured");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`email transport returned ${response.status}`);
}
