// lib/outbound.ts: one read of somebody's URL, as AadharshBot or as a named
// unsigned probe.

import { botHeaders, botRequestHeaders, botRobotsPolicy, BotPolicyError } from "./botauth.ts";
import { CANONICAL_HOST } from "./const.ts";
import { fetchFollowingPublicRedirects, validateLensTarget } from "./public-fetch.ts";

export type OutboundIdentity =
  | { as: "aadharshbot"; postQuantum?: boolean }
  | { as: "unsigned-probe" };

export type OutboundRequest = {
  method: "GET" | "POST";
  headers: HeadersInit;
  body?: string;
  signal?: AbortSignal;
  identity: OutboundIdentity;
  maxHops: number;
};

export type OutboundRefusal =
  | { ok: false; reason: "url-policy"; error: string; hop: number; url: string }
  | { ok: false; reason: "robots"; error: string; cause: BotPolicyError };

export type OutboundRead =
  | { ok: true; via: "self" | "network"; response: Response; finalUrl: string; hops: number }
  | OutboundRefusal;

export function selfAdapter(env): ((request: Request) => Promise<Response>) | null {
  if (env?.SELF_FETCH) return (request) => env.SELF_FETCH(request);
  if (env?.ASSETS) return (request) => env.ASSETS.fetch(request);
  return null;
}

export function dispatchesToSelf(hostname, env): boolean {
  return String(hostname || "").toLowerCase() === CANONICAL_HOST && !!(env?.SELF_FETCH || env?.ASSETS);
}

export async function outboundRead(url: string, env, request: OutboundRequest): Promise<OutboundRead> {
  env = env || {};
  const { method, headers, body, signal, identity } = request;
  const withBody = body === undefined ? {} : { body };

  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { }

  const self = dispatchesToSelf(hostname, env) ? selfAdapter(env) : null;
  if (self) {
    const selfHeaders = identity.as === "aadharshbot"
      ? await botHeaders(url, env, { headers, sign: false })
      : headers;
    const response = await self(new Request(url, { method, headers: selfHeaders, ...withBody }));
    return { ok: true, via: "self", response, finalUrl: url, hops: 0 };
  }

  let followed;
  try {
    followed = await fetchFollowingPublicRedirects(
      url,
      async (candidate) => {
        let hopHeaders = headers;
        if (identity.as === "aadharshbot") {
          hopHeaders = await botRequestHeaders(candidate, env, { headers, method, signal, postQuantum: identity.postQuantum });
        } else {
          const policy = await botRobotsPolicy(candidate, env, signal);
          if (!policy.ok) throw new BotPolicyError(policy);
        }
        return { method, headers: hopHeaders, ...withBody, signal, cf: { cacheTtl: 0 } };
      },
      (candidate) => validateLensTarget(candidate),
      request.maxHops,
      env.OUTBOUND_TRANSPORT,
    );
  } catch (error) {
    if (error instanceof BotPolicyError) return { ok: false, reason: "robots", error: error.message, cause: error };
    throw error;
  }
  if (!followed.ok) return { ok: false, reason: "url-policy", error: followed.error, hop: followed.blockedHop, url: followed.url };
  return { ok: true, via: "network", response: followed.response, finalUrl: followed.finalUrl, hops: followed.hops };
}
