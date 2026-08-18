// agent.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { jsonResponse } from "./lib/http.ts";

export const AGENT_AUTH_SCOPES = ["public.read", "mcp.read", "rn.read", "photos.read", "around.read"];

export async function handleAgentAuthRegister(request) {
  if (request.method === "OPTIONS") return methodResponse(null, 204, "POST, OPTIONS");
  if (request.method !== "POST") return methodResponse({ error: "method_not_allowed" }, 405, "POST, OPTIONS");

  let payload = {};
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_request", error_description: "Request body must be valid JSON." }, 400);
    }
  }

  const type = payload.type || "anonymous";
  if (type !== "anonymous") {
    return jsonResponse({
      error: "unsupported_identity_type",
      error_description: "aadhar.sh currently supports anonymous public agent registration only.",
      identity_types_supported: ["anonymous"],
    }, 400);
  }

  const origin = new URL(request.url).origin;
  const scope = AGENT_AUTH_SCOPES.join(" ");
  return jsonResponse({
    registration_id: randomAgentId("reg"),
    registration_type: "anonymous",
    identity_type: "anonymous",
    credential_type: "bearer_token",
    token_type: "Bearer",
    access_token: randomAgentId("aadhar_public"),
    expires_in: 3600,
    scope,
    scopes: AGENT_AUTH_SCOPES,
    resource: "https://aadhar.sh/",
    claim_uri: `${origin}/agent/auth/claim`,
    revocation_uri: `${origin}/oauth2/revoke`,
    note: "This public bearer credential is optional; current aadhar.sh agent resources and bounded MCP utilities are public. Image outputs are ephemeral and the representation vault stores normalized observations only.",
  }, 201, { "cache-control": "no-store" });
}

export async function handleAgentAuthClaim(request) {
  if (request.method === "OPTIONS") return methodResponse(null, 204, "GET, POST, OPTIONS");
  if (request.method !== "GET" && request.method !== "POST") {
    return methodResponse({ error: "method_not_allowed" }, 405, "GET, POST, OPTIONS");
  }
  return jsonResponse({
    status: "not_required",
    identity_type: "anonymous",
    message: "Anonymous public credentials on aadhar.sh do not require a human claim ceremony.",
  }, 200, { "cache-control": "no-store" });
}

export async function handleAgentAuthToken(request) {
  if (request.method === "OPTIONS") return methodResponse(null, 204, "POST, OPTIONS");
  if (request.method !== "POST") return methodResponse({ error: "method_not_allowed" }, 405, "POST, OPTIONS");

  let grantType = "";
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await request.text());
    grantType = form.get("grant_type") || "";
  } else if (ct.includes("application/json")) {
    try {
      const payload = await request.json();
      grantType = payload.grant_type || "";
    } catch {
      return oauthError("invalid_request", "Request body must be valid JSON or form data.", 400);
    }
  }

  if (grantType !== "urn:workos:agent-auth:grant-type:anonymous") {
    return oauthError("unsupported_grant_type", "Supported grant_type: urn:workos:agent-auth:grant-type:anonymous.", 400);
  }

  return jsonResponse({
    access_token: randomAgentId("aadhar_public"),
    token_type: "Bearer",
    expires_in: 3600,
    scope: AGENT_AUTH_SCOPES.join(" "),
  }, 200, { "cache-control": "no-store" });
}

export async function handleAgentAuthRevoke(request) {
  if (request.method === "OPTIONS") return methodResponse(null, 204, "POST, OPTIONS");
  if (request.method !== "POST") return methodResponse({ error: "method_not_allowed" }, 405, "POST, OPTIONS");
  return new Response(null, {
    status: 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export function methodResponse(body, status, allow) {
  const headers = { allow, "cache-control": "no-store" };
  return body ? jsonResponse(body, status, headers) : new Response(null, { status, headers });
}

export function oauthError(error, errorDescription, status) {
  return jsonResponse({ error, error_description: errorDescription }, status, { "cache-control": "no-store" });
}

export function randomAgentId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
